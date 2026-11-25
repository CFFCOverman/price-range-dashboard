/**
 * 压力位 / 支撑位(纯函数,不碰 fs)。每个价位带来源、强度、数据日期;几个来源落在同一价格带(±zone_pct%)的合成「共振区」。
 * 只描述价位在哪、有多强,不报触及概率(旧面板的触及概率未通过事先写死的校准判据,见根 README)。
 * 参数全部在 config/params.json § levels。
 */
const n = v => (v === '' || v == null ? NaN : Number(v));
const r2 = v => Math.round(v * 100) / 100;
const pctDist = (p, spot) => r2((p / spot - 1) * 100);

/* ---------- 期权:OI 墙与净 gamma ---------- */
/** 按行权价汇总(只取 max_dte 天内到期);优先用次日确认的收盘 OI(*_oi_eod),没有就用当晚读数 */
export function strikeBook(rows, asof, maxDte) {
  const lim = Date.parse(asof) + maxDte * 864e5;
  const by = new Map();
  let eod = 0, total = 0;
  for (const r of rows) {
    const exp = Date.parse(r.expiry);
    if (!(exp > Date.parse(asof)) || exp > lim) continue;
    total++;
    const useEod = r.call_oi_eod !== '' && r.call_oi_eod != null;
    if (useEod) eod++;
    const k = n(r.strike);
    const b = by.get(k) || { strike: k, call_oi: 0, put_oi: 0, gex: 0 };
    const c = n(useEod ? r.call_oi_eod : r.call_oi) || 0, p = n(useEod ? r.put_oi_eod : r.put_oi) || 0;
    b.call_oi += c; b.put_oi += p;
    const cg = n(r.call_gamma), pg = n(r.put_gamma);
    if (isFinite(cg)) b.gex += cg * c; if (isFinite(pg)) b.gex -= pg * p;
    by.set(k, b);
  }
  return { strikes: [...by.values()].sort((a, b) => a.strike - b.strike), oiBasis: total && eod === total ? 'eod' : eod ? 'mixed' : 'evening' };
}
/** 上方看涨墙(压力)、下方看跌墙(支撑);ΔOI 对比上一快照 */
export function oiWalls(book, prevBook, spot, { walls_per_side, min_wall_share }) {
  const prev = new Map((prevBook?.strikes || []).map(s => [s.strike, s]));
  const totC = book.strikes.reduce((a, s) => a + s.call_oi, 0), totP = book.strikes.reduce((a, s) => a + s.put_oi, 0);
  const pick = (side) => book.strikes
    .filter(s => side === 'call' ? s.strike >= spot : s.strike <= spot)
    .map(s => ({ s, oi: side === 'call' ? s.call_oi : s.put_oi, share: (side === 'call' ? s.call_oi / totC : s.put_oi / totP) }))
    .filter(x => x.share >= min_wall_share).sort((a, b) => b.oi - a.oi).slice(0, walls_per_side)
    .map(x => {
      const p = prev.get(x.s.strike); const before = p ? (side === 'call' ? p.call_oi : p.put_oi) : null;
      return { price: x.s.strike, role: side === 'call' ? 'resistance' : 'support', source: side === 'call' ? '看涨 OI 墙' : '看跌 OI 墙',
        strength: r2(x.share * 100), detail: { oi: x.oi, share_pct: r2(x.share * 100), d_oi: before == null ? null : x.oi - before } };
    });
  return [...pick('call'), ...pick('put')];
}
/** 净 gamma 翻转位【推算】:假设做市商持有客户的反向头寸(多看涨 gamma、空看跌 gamma 的常用约定),按行权价累计,符号翻转处 */
export function gammaFlip(book, spot) {
  let cum = 0, flip = null, prevStrike = null;
  for (const s of book.strikes) {
    const before = cum; cum += s.gex;
    if (prevStrike != null && Math.sign(before) !== Math.sign(cum) && before !== 0) { flip = Math.abs(s.strike - spot) < Math.abs((flip ?? Infinity) - spot) ? s.strike : flip; }
    prevStrike = s.strike;
  }
  return flip == null ? [] : [{ price: flip, role: flip >= spot ? 'resistance' : 'support', source: 'gamma 翻转位【推算】', strength: null,
    detail: { assumption: '做市商与客户反向;未知真实持仓', net_gex_sign: Math.sign(cum) } }];
}

/* ---------- 价格:均线、前高前低 ---------- */
export function priceLevels(prices, spot, { ma_days, swing_days, high_low_days }) {
  const closes = prices.map(r => n(r.close)).filter(isFinite);
  const out = [];
  for (const d of ma_days) {
    if (closes.length < d) continue;
    const ma = closes.slice(-d).reduce((a, b) => a + b, 0) / d;
    out.push({ price: r2(ma), role: ma >= spot ? 'resistance' : 'support', source: `${d} 日均线`, strength: null, detail: {} });
  }
  for (const d of [...swing_days, high_low_days]) {
    const w = closes.slice(-d); if (w.length < Math.min(d, 20)) continue;
    const hi = Math.max(...w), lo = Math.min(...w);
    const tag = d === high_low_days ? '52 周' : `${d} 日`;
    out.push({ price: r2(hi), role: 'resistance', source: `${tag}收盘高点`, strength: null, detail: {} });
    out.push({ price: r2(lo), role: 'support', source: `${tag}收盘低点`, strength: null, detail: {} });
  }
  return out;
}

/* ---------- 估值:NTM EPS × 历史市盈率分位 ---------- */
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
export function valuationLevels(valRows, spot, { pe_percentiles }) {
  const pes = valRows.map(r => n(r.pe_ntm)).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b);
  const last = valRows.at(-1); const eps = n(last?.eps_ntm);
  if (pes.length < 12 || !(eps > 0)) return [];
  return pe_percentiles.map(p => {
    const pe = percentile(pes, p), price = pe * eps;
    return { price: r2(price), role: price >= spot ? 'resistance' : 'support', source: `估值 ${p} 分位(NTM P/E ${r2(pe)}×)`, strength: null,
      detail: { pe: r2(pe), eps_ntm: eps, months: pes.length, asof: last.date } };
  });
}

/* ---------- 卖方目标价 ---------- */
export function targetLevels(brokers, spot) {
  const t = brokers.filter(r => r.broker && r.broker !== 'Mean').map(r => n(r.tgt_price)).filter(v => v > 0).sort((a, b) => a - b);
  if (t.length < 3) return [];
  const mk = (price, name) => ({ price: r2(price), role: price >= spot ? 'resistance' : 'support', source: `卖方目标价${name}`, strength: null, detail: { n: t.length } });
  return [mk(t[0], '最低'), mk(percentile(t, 25), '下四分位'), mk(percentile(t, 50), '中位'), mk(percentile(t, 75), '上四分位'), mk(t.at(-1), '最高')];
}

/* ---------- 合成 ---------- */
/** 按价格排序后,相邻价位相距 ≤ zone_pct% 的并成一个区;来源 ≥2 种类别才算共振 */
export function zones(levels, spot, zonePct) {
  const sorted = [...levels].sort((a, b) => a.price - b.price), out = [];
  for (const l of sorted) {
    const z = out.at(-1);
    if (z && (l.price / z.hi - 1) * 100 <= zonePct) { z.items.push(l); z.hi = l.price; } else out.push({ lo: l.price, hi: l.price, items: [l] });
  }
  const cat = s => (/OI|gamma/.test(s) ? '期权' : /均线|高点|低点/.test(s) ? '价格' : /估值/.test(s) ? '估值' : '卖方');
  return out.map(z => {
    const cats = [...new Set(z.items.map(i => cat(i.source)))];
    const mid = (z.lo + z.hi) / 2;
    return { lo: z.lo, hi: z.hi, role: mid >= spot ? 'resistance' : 'support', distance_pct: pctDist(mid, spot), categories: cats, confluence: cats.length >= 2, sources: z.items.map(i => i.source) };
  });
}

/** 当前 NTM P/E 在自身历史里的位置(0–100),以及各分位对应的价格(不论远近都给,远的不进价位表) */
export function valuationContext(valRows, { pe_percentiles }) {
  const pes = valRows.map(r => n(r.pe_ntm)).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b);
  const last = valRows.at(-1), pe = n(last?.pe_ntm), eps = n(last?.eps_ntm);
  if (pes.length < 12 || !(pe > 0)) return null;
  const rank = r2(pes.filter(v => v <= pe).length / pes.length * 100);
  return { asof: last.date, pe_ntm: r2(pe), eps_ntm: eps, pe_pctile_now: rank, months: pes.length,
    bands: pe_percentiles.map(p => ({ pctile: p, pe: r2(percentile(pes, p)), price: r2(percentile(pes, p) * eps) })) };
}

export function buildLevels({ symbol, asof, spot, optRows, prevOptRows, optAsof, prices, valuation, brokers }, P) {
  const levels = [];
  let options = null;
  if (optRows?.length) {
    const book = strikeBook(optRows, optAsof, P.options_max_dte);
    const prev = prevOptRows?.length ? strikeBook(prevOptRows, optAsof, P.options_max_dte) : null;
    levels.push(...oiWalls(book, prev, spot, P), ...gammaFlip(book, spot));
    options = { asof: optAsof, oi_basis: book.oiBasis, strikes: book.strikes.length };
  }
  levels.push(...priceLevels(prices, spot, P), ...valuationLevels(valuation, spot, P), ...targetLevels(brokers, spot));
  const near = levels.filter(l => isFinite(l.price) && Math.abs(pctDist(l.price, spot)) <= P.max_distance_pct)
    .map(l => ({ ...l, distance_pct: pctDist(l.price, spot) }));
  return { symbol, asof, spot, options, valuation: valuationContext(valuation, P), levels: near.sort((a, b) => b.price - a.price), zones: zones(near, spot, P.zone_pct).sort((a, b) => b.lo - a.lo) };
}
