/**
 * 一年前瞻估值区间(纯函数)。方法与理由见 process/README.md § 估值区间;参数只在 config/params.json § valuation。
 *   一年后价格 = 一年后那一时点的「未来 12 个月 EPS」× 退出市盈率
 *   EPS:按财年结束月份把 FY1–FY4 一致预期(均值 ∓ 1 个标准差 / 均值 / 均值 + 1 个标准差)按与 [今天+1 年, 今天+2 年] 的重叠天数加权
 *   市盈率:自身过去 36 个月 NTM P/E 的 25 / 50 / 75 分位(10 年分位并列作对照)
 *   第二个锚「估值不变」:同样的一年后 EPS × 今天的市盈率 —— 只算盈利增长、不假设估值回归;
 *     现价市盈率处在 3 年历史极端(< regime_pctile 或 > 100−regime_pctile)时标 regime_gap,提醒回归假设可能不成立
 *   交叉核对(只并排,不进公式):卖方 12 个月目标价分布、1 年历史波动区间【推算】、现价市盈率的历史分位
 */
import { percentile } from './levels.mjs';
const n = v => (v === '' || v == null ? NaN : Number(v));
const r2 = v => (isFinite(v) ? Math.round(v * 100) / 100 : null);
const DAY = 864e5;
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "Jan '27E" → 2027-01-31(该财年最后一天,UTC 毫秒) */
export function fyEnd(label) {
  const m = /^([A-Z][a-z]{2}) '(\d{2})/.exec(String(label || '').trim());
  if (!m || !(m[1] in MON)) return NaN;
  return Date.UTC(2000 + Number(m[2]), MON[m[1]] + 1, 0);
}
/** 窗口 [start, end) 与 FY1..FY4 的重叠权重(和为 1);FYk 覆盖 (fy1End+(k-2)年, fy1End+(k-1)年] */
export function fyWeights(asof, fy1End, horizonDays) {
  const start = Date.parse(asof) + horizonDays * DAY, end = start + 365 * DAY;
  const w = [];
  for (let k = 1; k <= 4; k++) {
    const hi = new Date(fy1End); hi.setUTCFullYear(hi.getUTCFullYear() + (k - 1));
    const lo = new Date(hi); lo.setUTCFullYear(lo.getUTCFullYear() - 1);
    w.push(Math.max(0, Math.min(end, hi.getTime()) - Math.max(start, lo.getTime())) / DAY);
  }
  const tot = w.reduce((a, b) => a + b, 0);
  return tot > 0 ? w.map(x => x / tot) : w;
}
/** 一年后的前瞻 EPS(low/mean/high)。band='sd':低/高 = 各财年均值 ∓ 1 个标准差(不被单个极端分析师带偏,缺 sd 时退回最低/最高);
 *  band='minmax':直接用最低/最高。FY4 缺而又要用时按 FY3/FY2 增速外推(标记 extrapolated) */
export function forwardEps(cons, weights, extrapolate, band = 'sd') {
  const get = (k, st) => {
    const mean = n(cons[`eps_fy${k}`]), sd = n(cons[`eps_fy${k}_sd`]);
    if (st === 'mean') return mean;
    if (band === 'sd' && isFinite(mean) && sd >= 0) return st === 'low' ? mean - sd : mean + sd;
    return n(cons[`eps_fy${k}_${st}`]);
  };
  const out = {}; let extrapolated = false;
  for (const st of ['low', 'mean', 'high']) {
    const fy = [1, 2, 3, 4].map(k => get(k, st));
    if (weights[3] > 0 && !isFinite(fy[3]) && extrapolate && fy[1] > 0 && fy[2] > 0) { fy[3] = fy[2] * fy[2] / fy[1]; extrapolated = true; }
    let s = 0, ok = true;
    weights.forEach((w, i) => { if (w > 0) { if (isFinite(fy[i])) s += w * fy[i]; else ok = false; } });
    out[st] = ok ? s : NaN;
  }
  return { ...out, extrapolated, band };
}
/** 年化历史波动率(日对数收益的标准差 × √252) */
export function realizedVol(closes) {
  const r = []; for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 20) return NaN;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252);
}
const pctRank = (sorted, v) => r2(sorted.filter(x => x <= v).length / sorted.length * 100);

export function buildValuation({ symbol, asof, spot, cons, fy1Label, valRows, prices, brokers }, P) {
  const base = { symbol, asof, spot, method: 'forward_1y_pe', params: { horizon_days: P.horizon_days, pe_window_months: P.pe_window_months, pe_pctiles: P.pe_pctiles } };
  const pesAll = valRows.map(r => n(r.pe_ntm)).filter(v => v > 0);
  const pes3 = pesAll.slice(-P.pe_window_months).sort((a, b) => a - b), pes10 = pesAll.slice(-P.pe_window_long_months).sort((a, b) => a - b);
  const last = valRows.at(-1), peNow = n(last?.pe_ntm), epsNtm = n(last?.eps_ntm);
  const fy1End = fyEnd(fy1Label);
  const notApplicable = reason => ({ ...base, applicable: false, reason });
  if (!cons) return notApplicable('没有一致预期快照');
  if (!isFinite(fy1End)) return notApplicable(`FY1 财年标签认不出:${fy1Label || '缺'}`);
  if (pes3.length < P.pe_min_months) return notApplicable(`有效 NTM P/E 只有 ${pes3.length} 个月(亏损或上市不久),不适用市盈率法`);
  const w = fyWeights(asof, fy1End, P.horizon_days);
  const eps = forwardEps(cons, w, P.fy_extrapolate, P.eps_band);
  if (!(eps.mean > 0)) return notApplicable(`一年后前瞻 EPS 均值 ${r2(eps.mean)} ≤ 0,不适用市盈率法`);
  const pe = Object.fromEntries(Object.entries(P.pe_pctiles).map(([k, p]) => [k, percentile(pes3, p)]));
  const epsBy = { bear: eps.low, base: eps.mean, bull: eps.high };
  const matrix = {}; for (const [ek, ev] of Object.entries(epsBy)) { matrix[ek] = {}; for (const [pk, pv] of Object.entries(pe)) matrix[ek][pk] = r2(ev * pv); }
  const range = { bear: matrix.bear.bear, base: matrix.base.base, bull: matrix.bull.bull };
  const closes = prices.map(r => n(r.close)).filter(v => v > 0);
  const vol = realizedVol(closes.slice(-(P.vol_days + 1)));
  const t = brokers.filter(r => r.broker && r.broker !== 'Mean').map(r => n(r.tgt_price)).filter(v => v > 0).sort((a, b) => a - b);
  return {
    ...base, applicable: true,
    forward_eps: { low: r2(eps.low), mean: r2(eps.mean), high: r2(eps.high), extrapolated_fy4: eps.extrapolated, band: eps.band,
      fy_weights: w.map(x => r2(x)), fy1_label: fy1Label, n_fy3: n(cons.eps_fy3_n) || null },
    exit_pe_3y: Object.fromEntries(Object.entries(pe).map(([k, v]) => [k, r2(v)])), pe_months_3y: pes3.length,
    matrix, range,
    hold_pe: isFinite(peNow) && peNow > 0 ? { pe: r2(peNow), bear: r2(eps.low * peNow), base: r2(eps.mean * peNow), bull: r2(eps.high * peNow) } : null,
    regime_gap: isFinite(peNow) && (pctRank(pes3, peNow) < P.regime_pctile || pctRank(pes3, peNow) > 100 - P.regime_pctile),
    upside_pct: Object.fromEntries(Object.entries(range).map(([k, v]) => [k, r2((v / spot - 1) * 100)])),
    now: { pe_ntm: r2(peNow), eps_ntm: r2(epsNtm), pe_pctile_3y: isFinite(peNow) ? pctRank(pes3, peNow) : null, pe_pctile_10y: isFinite(peNow) && pes10.length ? pctRank(pes10, peNow) : null,
      fair_now: isFinite(epsNtm) && epsNtm > 0 ? Object.fromEntries(Object.entries(pe).map(([k, v]) => [k, r2(v * epsNtm)])) : null },
    checks: {
      sell_side_12m: t.length >= 3 ? { n: t.length, min: r2(t[0]), q1: r2(percentile(t, 25)), median: r2(percentile(t, 50)), q3: r2(percentile(t, 75)), max: r2(t.at(-1)) } : null,
      vol_band_1y: isFinite(vol) ? { sigma: r2(vol), low: r2(spot * Math.exp(-vol)), high: r2(spot * Math.exp(vol)), note: '【推算】现价 × e^(±1 年历史波动率),不是预测' } : null,
    },
  };
}
