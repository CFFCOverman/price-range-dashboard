/**
 * 交接数据包(纯函数):每晚把各标的的价位与估值压成一份带编号的 JSON,给 Research OS 早晚两轮读。
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
export function buildHandoff({ asof, symbols, prev, minPct }) {
  const changes = diffSummaries(prev?.symbols, symbols, minPct);
  const body = { schema: 'prd-handoff/1', asof, symbols, changes };
  const id = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  return { id, ...body, generated_at: new Date().toISOString() };
}
