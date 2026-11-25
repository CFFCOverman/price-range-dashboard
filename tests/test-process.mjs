/** process/ 纯函数自检:价位、估值区间、交接数据包 */
import assert from 'node:assert/strict';
const L = await import('../process/levels.mjs');
const V = await import('../process/valuation.mjs');
const H = await import('../process/handoff.mjs');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✔ ' + name); };

t('strikeBook 优先用收盘 OI,只算窗口内到期', () => {
  const rows = [{ expiry: '2026-12-18', strike: '100', call_oi: '10', put_oi: '5', call_oi_eod: '12', put_oi_eod: '6', call_gamma: '0.01', put_gamma: '0.02' },
    { expiry: '2027-06-18', strike: '100', call_oi: '999', put_oi: '999' }];
  const b = L.strikeBook(rows, '2026-11-24', 45);
  assert.equal(b.strikes.length, 1); assert.equal(b.strikes[0].call_oi, 12); assert.equal(b.oiBasis, 'eod');
});
t('oiWalls:上方看涨墙、下方看跌墙,带 ΔOI', () => {
  const book = { strikes: [{ strike: 90, call_oi: 0, put_oi: 50 }, { strike: 110, call_oi: 80, put_oi: 0 }, { strike: 120, call_oi: 20, put_oi: 0 }] };
  const prev = { strikes: [{ strike: 110, call_oi: 60, put_oi: 0 }] };
  const w = L.oiWalls(book, prev, 100, { walls_per_side: 1, min_wall_share: 0.01 });
  assert.deepEqual(w.map(x => [x.price, x.role]), [[110, 'resistance'], [90, 'support']]);
  assert.equal(w[0].detail.d_oi, 20);
});
t('zones:相距 ≤1.5% 合并,跨类别才算共振', () => {
  const z = L.zones([{ price: 100, source: '看涨 OI 墙' }, { price: 101, source: '50 日均线' }, { price: 120, source: '20 日均线' }], 90, 1.5);
  assert.equal(z.length, 2); assert.equal(z[0].confluence, true); assert.equal(z[1].confluence, false);
});
t('fyEnd / fyWeights:一月财年与十月财年(已结束未公布)', () => {
  assert.equal(new Date(V.fyEnd("Jan '27E")).toISOString().slice(0, 10), '2027-01-31');
  const w1 = V.fyWeights('2026-11-24', V.fyEnd("Jan '27E"), 365);
  assert.ok(Math.abs(w1.reduce((a, b) => a + b, 0) - 1) < 1e-9 && w1[0] === 0 && w1[2] > w1[1]);
  const w2 = V.fyWeights('2026-11-24', V.fyEnd("Oct '26E"), 365);
  assert.ok(w2[3] > 0, '窗口越过 FY3 时用到 FY4');
});
t('forwardEps:FY4 缺时按 FY3/FY2 外推并标记', () => {
  const e = V.forwardEps({ eps_fy2: 10, eps_fy3: 12, eps_fy2_low: 9, eps_fy3_low: 10, eps_fy2_high: 11, eps_fy3_high: 14 }, [0, 0, 0.5, 0.5], true, 'minmax');
  assert.equal(e.extrapolated, true); assert.equal(Math.round(e.mean * 100) / 100, 13.2);
});
const cons = { eps_fy1: 9, eps_fy1_low: 8, eps_fy1_high: 10, eps_fy2: 16, eps_fy2_low: 12, eps_fy2_high: 18, eps_fy3: 22, eps_fy3_low: 15, eps_fy3_high: 27 };
const valRows = Array.from({ length: 40 }, (_, i) => ({ date: `x${i}`, pe_ntm: String(20 + (i % 10)), eps_ntm: '15' }));
const prices = Array.from({ length: 300 }, (_, i) => ({ close: String(100 + Math.sin(i / 5) * 5) }));
const P = { horizon_days: 365, pe_window_months: 36, pe_window_long_months: 120, pe_min_months: 12, pe_pctiles: { bear: 25, base: 50, bull: 75 }, vol_days: 252, fy_extrapolate: true, regime_pctile: 10 };
t('buildValuation:矩阵、主区间、估值不变锚、交叉核对', () => {
  const v = V.buildValuation({ symbol: 'X', asof: '2026-11-24', spot: 100, cons, fy1Label: "Jan '27E", valRows, prices, brokers: [{ broker: 'A', tgt_price: '90' }, { broker: 'B', tgt_price: '110' }, { broker: 'C', tgt_price: '130' }, { broker: 'Mean', tgt_price: '1' }] }, P);
  assert.equal(v.applicable, true);
  assert.ok(v.range.bear < v.range.base && v.range.base < v.range.bull);
  assert.equal(v.range.base, v.matrix.base.base);
  assert.equal(v.checks.sell_side_12m.n, 3, 'Mean 行不计入');
  assert.ok(v.hold_pe.base > 0 && v.checks.vol_band_1y.low < 100);
});
t('buildValuation:亏损或历史太短 → 不适用', () => {
  const loss = V.buildValuation({ symbol: 'X', asof: '2026-11-24', spot: 10, cons: { ...cons, eps_fy2: -1, eps_fy3: -0.5 }, fy1Label: "Dec '26E", valRows, prices, brokers: [] }, P);
  assert.equal(loss.applicable, false);
  const young = V.buildValuation({ symbol: 'X', asof: '2026-11-24', spot: 10, cons, fy1Label: "Dec '26E", valRows: valRows.slice(0, 5), prices, brokers: [] }, P);
  assert.match(young.reason, /不适用/);
});
t('交接:内容不变编号不变;变化逐条列出', () => {
  const lv = { spot: 100, levels: [{ price: 110, distance_pct: 10, source: 'a' }, { price: 90, distance_pct: -10, source: 'b' }], zones: [], options: null };
  const s1 = { X: H.symbolSummary(lv, { applicable: true, range: { bear: 1, base: 100, bull: 2 }, upside_pct: {}, hold_pe: null, regime_gap: false, now: {}, forward_eps: {}, checks: {} }) };
  const a = H.buildHandoff({ asof: 'd', symbols: s1, prev: null, minPct: 3 }), b = H.buildHandoff({ asof: 'd', symbols: s1, prev: null, minPct: 3 });
  assert.equal(a.id, b.id);
  const s2 = JSON.parse(JSON.stringify(s1)); s2.X.valuation.range.base = 110; s2.X.nearest_support.price = 95;
  const c = H.buildHandoff({ asof: 'e', symbols: s2, prev: a, minPct: 3 });
  assert.notEqual(c.id, a.id);
  assert.deepEqual(c.changes.map(x => x.what), ['估值中性值', '最近支撑位']);
});
t('forwardEps:sd 档用均值 ∓ σ,缺 σ 退回最低/最高', () => {
  const e = V.forwardEps({ eps_fy3: 20, eps_fy3_sd: 2, eps_fy3_low: 5, eps_fy3_high: 30 }, [0, 0, 1, 0], true, 'sd');
  assert.deepEqual([e.low, e.mean, e.high], [18, 20, 22]);
  const f = V.forwardEps({ eps_fy3: 20, eps_fy3_low: 5, eps_fy3_high: 30 }, [0, 0, 1, 0], true, 'sd');
  assert.deepEqual([f.low, f.high], [5, 30]);
});
console.log(`process 自检 ${n} 项全部通过`);
