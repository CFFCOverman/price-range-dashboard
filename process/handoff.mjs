/**
 * 交接数据包(纯函数):每晚把各标的的价位与估值,以及上一个包之后的新增读数(新闻、修订、目标价/评级、空头、修订广度)
 * 压成一份带编号的 JSON,给 Research OS 早晚两轮读。这里只做机械过滤(去重、阈值),不分层、不分级:归层与筛选由 OS 做。
 * 编号 = 内容(不含生成时间)的 SHA-256 前 12 位:内容不变编号就不变,OS 见到同一编号直接跳过。
 * 字段契约见 schema/README.md § handoff。
 */
import crypto from 'node:crypto';
const r2 = v => (isFinite(v) ? Math.round(v * 100) / 100 : null);

/** 一只标的的摘要:最近的压力/支撑、共振区、估值区间 */
export function symbolSummary(levels, valuation) {
  const res = levels.levels.filter(l => l.price > levels.spot).sort((a, b) => a.price - b.price);
  const sup = levels.levels.filter(l => l.price < levels.spot).sort((a, b) => b.price - a.price);
  const pick = l => l && { price: l.price, distance_pct: l.distance_pct, source: l.source };
  return {
    spot: levels.spot,
    nearest_resistance: pick(res[0]), nearest_support: pick(sup[0]),
    confluence_zones: levels.zones.filter(z => z.confluence).map(z => ({ lo: z.lo, hi: z.hi, role: z.role, distance_pct: z.distance_pct, sources: z.sources })),
    options_oi_basis: levels.options?.oi_basis ?? null, options_asof: levels.options?.asof ?? null,
    valuation: !valuation ? null : valuation.applicable
      ? { range: valuation.range, upside_pct: valuation.upside_pct, hold_pe: valuation.hold_pe, regime_gap: valuation.regime_gap, pe_now: valuation.now.pe_ntm, pe_pctile_3y: valuation.now.pe_pctile_3y,
          pe_pctile_10y: valuation.now.pe_pctile_10y, forward_eps_mean: valuation.forward_eps.mean, sell_side_median: valuation.checks.sell_side_12m?.median ?? null }
      : { not_applicable: valuation.reason || '缺数据' },
  };
}
/** 与上一份比:估值中性值变动 ≥ minPct%、最近压力/支撑换了价位、共振区数量变化 */
export function diffSummaries(prev, cur, minPct) {
  const out = [];
  for (const [sym, c] of Object.entries(cur)) {
    const p = prev?.[sym];
    if (!p) { out.push({ symbol: sym, what: '新标的' }); continue; }
    const pb = p.valuation?.range?.base, cb = c.valuation?.range?.base;
    if (isFinite(pb) && isFinite(cb) && Math.abs(cb / pb - 1) * 100 >= minPct) out.push({ symbol: sym, what: '估值中性值', from: pb, to: cb, change_pct: r2((cb / pb - 1) * 100) });
    for (const k of ['nearest_resistance', 'nearest_support']) {
      if (p[k]?.price !== c[k]?.price) out.push({ symbol: sym, what: k === 'nearest_resistance' ? '最近压力位' : '最近支撑位', from: p[k]?.price ?? null, to: c[k]?.price ?? null, source: c[k]?.source ?? null });
    }
    if ((p.confluence_zones?.length || 0) !== (c.confluence_zones?.length || 0)) out.push({ symbol: sym, what: '共振区数量', from: p.confluence_zones?.length || 0, to: c.confluence_zones?.length || 0 });
  }
  return out;
}
/* ---------- 交接包 2:新增读数(feed) ---------- */
const num = v => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
/** 日期统一成 YYYY-MM-DD(接受 YYYY-MM-DD、MM/DD/YYYY、M/D/YY) */
export function isoDate(v) {
  const t = String(v || '').trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t))) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}
const pct = (a, b) => (isFinite(a) && isFinite(b) && b !== 0 ? r2((a / b - 1) * 100) : null);

/** 新闻:上一个包之后的新条目(按 id 去重),最新在前,最多 max 条;摘要截断,不带全文 */
export function newsFeed(rows, { since, prevIds = [], max, chars }) {
  const seen = new Set(prevIds);
  return rows.filter(r => r.id && !String(r.id).startsWith('legacy:') && !seen.has(r.id) && String(r.datetime) >= since)
    .sort((a, b) => String(b.datetime).localeCompare(String(a.datetime))).slice(0, max)
    .map(r => ({ id: r.id, datetime_et: r.datetime, headline: r.headline, subjects: r.subjects || '',
      summary: String(r.body || '').replace(/\s+/g, ' ').slice(0, chars), source: 'FactSet StreetAccount' }));
}
/** 一致预期修订:最新一行的 30 天变化(同源序列) */
/** 30 天变化:正负号相同且基数非零才给 %;亏损转盈或反之只给绝对变化(避免 -2308% 这类无意义的百分比) */
export function rev(a, b) {
  if (!isFinite(a) || !isFinite(b) || a === null || b === null) return { pct: null, abs: null };
  const abs = r2(a - b);
  return { pct: a > 0 && b > 0 ? pct(a, b) : null, abs };
}
export function revisionReading(cons) {
  if (!cons) return null;
  const f = k => num(cons[k]);
  const e1 = rev(f('eps_fy1'), f('eps_fy1_30d')), e2 = rev(f('eps_fy2'), f('eps_fy2_30d')), eq = rev(f('eps_nq'), f('eps_nq_30d'));
  return { asof: cons.date, unit: 'EPS 为报价币种;_pct 为 %,_abs 为 EPS 绝对变化(正负号翻转或非正时只给 _abs)', basis: 'FactSet 一致预期均值,对比 30 天前同一口径',
    eps_fy1: f('eps_fy1'), eps_fy1_30d_pct: e1.pct, eps_fy1_30d_abs: e1.abs, eps_fy1_n: f('eps_fy1_n'),
    eps_fy2: f('eps_fy2'), eps_fy2_30d_pct: e2.pct, eps_fy2_30d_abs: e2.abs,
    eps_nq: f('eps_nq'), eps_nq_30d_pct: eq.pct, eps_nq_30d_abs: eq.abs,
    target_mean: f('target_mean'), target_30d_pct: pct(f('target_mean'), f('target_30d')), target_n: f('target_n') };
}
/** 券商目标价/评级:日期晚于 since 的逐家变动 */
export function brokerChanges(brokers, since) {
  /* 列名见 schema/README.md § raw 的 targets 行 */
  return brokers.filter(r => r.broker && r.broker !== 'Mean' && r.broker !== 'Excluded' && (isoDate(r.tgt_price_date) > since || isoDate(r.rating_date) > since))
    .map(r => ({ broker: r.broker, rating: r.rating || null, rating_date: isoDate(r.rating_date) || null, target: num(r.tgt_price), target_date: isoDate(r.tgt_price_date) || null }));
}
/** 空头:最新一行与上一行 */
export function shortReading(rows) {
  const a = rows.at(-1), b = rows.at(-2);
  if (!a) return null;
  return { asof: a.date, unit: '天数;% 流通盘', basis: 'FactSet 持股统计(交易所双周空头数据)',
    short_days: num(a.short_days), short_pct_float: num(a.short_pct_float),
    prev: b ? { asof: b.date, short_days: num(b.short_days), short_pct_float: num(b.short_pct_float) } : null };
}
/** 修订广度:一个组的最新一天,NTM EPS 30 天上调/下调家数与 FY1/FY2 上下调合计 */
export function breadthSummary(rows) {
  const d = rows.map(r => r.date).sort().at(-1);
  const t = rows.filter(r => r.date === d);
  if (!t.length) return null;
  const sum = k => t.reduce((s, r) => s + (num(r[k]) || 0), 0);
  const up = t.filter(r => num(r.eps_ntm) > num(r.eps_ntm_30d)).length, dn = t.filter(r => num(r.eps_ntm) < num(r.eps_ntm_30d)).length;
  return { asof: d, members: t.length, unit: '家数', basis: 'FactSet NTM EPS 均值对比 30 天前;UP/DOWN 为 FactSet 默认统计窗口',
    ntm_up: up, ntm_down: dn, fy1_up: sum('up_fy1'), fy1_down: sum('down_fy1'), fy2_up: sum('up_fy2'), fy2_down: sum('down_fy2') };
}
/** feed 的变化:修订、目标价、空头超过阈值,券商变动有新条目 */
export function diffFeeds(feeds, P) {
  const out = [];
  for (const [sym, f] of Object.entries(feeds || {})) {
    const rv = f.revisions;
    for (const [k, label] of [['eps_fy1_30d_pct', 'FY1 EPS 30 天修订'], ['eps_fy2_30d_pct', 'FY2 EPS 30 天修订'], ['target_30d_pct', '目标价均值 30 天变化']])
      if (rv && isFinite(rv[k]) && Math.abs(rv[k]) >= P.revision_min_pct) out.push({ symbol: sym, what: label, to: rv[k], unit: '%' });
    if (f.broker_changes?.length) out.push({ symbol: sym, what: '券商目标价/评级变动', to: f.broker_changes.length, unit: '家' });
    const sh = f.short, c = sh && pct(sh.short_pct_float, sh.prev?.short_pct_float);
    if (isFinite(c) && Math.abs(c) >= P.short_change_min_pct) out.push({ symbol: sym, what: '空头占流通盘变化', from: sh.prev.short_pct_float, to: sh.short_pct_float, change_pct: c });
    if (f.news?.length) out.push({ symbol: sym, what: '新闻', to: f.news.length, unit: '条' });
  }
  return out;
}
/** 入账字段:symbols 各部分的单位、口径与来源类型(feeds 各项自带 asof/unit/basis) */
export const BASIS = {
  source: 'FactSet(用户本机 price-range-dashboard 生成)', time: 'asof = 纽约交易日收盘后数据日期', unit: '价格为报价币种;distance_pct、upside_pct 为 %',
  nearest_resistance: '最近压力位;source 写明来自期权 OI 墙(数据)、均线/收盘高低点(由收盘计算)、卖方目标价(数据)或 gamma 翻转/共振区(推算)',
  nearest_support: '同 nearest_resistance',
  confluence_zones: '推算:相距 ≤ params.levels.zone_pct% 且来自 ≥2 类来源的价位合并',
  valuation: '推算:一年后前瞻 EPS × 退出市盈率(A:自身 params.valuation.pe_window_months 个月 NTM P/E 分位;B:今天的 P/E);输入为 FactSet 一致预期与估值史;方法见 process/README.md § 估值区间',
};
export function buildHandoff({ asof, symbols, prev, minPct, feeds = null, breadth = null, P = null, schema = 'prd-handoff/1' }) {
  const changes = [...diffSummaries(prev?.symbols, symbols, minPct), ...(feeds && P ? diffFeeds(feeds, P) : [])];
  const body = { schema, asof, basis: BASIS, symbols, changes, ...(feeds ? { feeds } : {}), ...(breadth ? { breadth } : {}) };
  const id = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { id, ...body, generated_at: new Date().toISOString() };
}
