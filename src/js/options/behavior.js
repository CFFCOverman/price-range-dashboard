/* ================= options behavior: snapshot facts by horizon ================= */
const OPT_BEHAVIOR_BUCKETS = [
  { id: 'short', lo: 1, hi: 7 },
  { id: 'mid', lo: 8, hi: 45 },
  { id: 'long', lo: 46, hi: 180 },
];
function optDte(asof, expiry) {
  const a = Date.parse(asof + 'T00:00:00Z'), b = Date.parse(expiry + 'T00:00:00Z');
  return isFinite(a) && isFinite(b) ? Math.round((b - a) / 86400000) : NaN;
}
function optionSnapshotSeries(ticker) {
  const byDate = new Map();
  for (const r of (state.options.get(ticker) || [])) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.asof || '')) continue;
    if (!byDate.has(r.asof)) byDate.set(r.asof, []);
    byDate.get(r.asof).push(r);
  }
  return [...byDate].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([asof, rows]) => ({ asof, rows }));
}
function optionBehavior(ticker) {
  const snaps = optionSnapshotSeries(ticker);
  if (!snaps.length) return null;
  const cur = snaps[snaps.length - 1], prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const prevMap = new Map((prev ? prev.rows : []).map(r => [r.expiry + '|' + r.strike, r]));
  const buckets = OPT_BEHAVIOR_BUCKETS.map(def => {
    const rows = cur.rows.filter(r => { const d = optDte(cur.asof, r.expiry); return d >= def.lo && d <= def.hi; });
    const callOI = rows.reduce((s, r) => s + r.callOI, 0), putOI = rows.reduce((s, r) => s + r.putOI, 0);
    let comparable = 0, callDelta = 0, putDelta = 0;
    for (const r of rows) {
      const old = prevMap.get(r.expiry + '|' + r.strike); if (!old) continue;
      comparable++; callDelta += r.callOI - old.callOI; putDelta += r.putOI - old.putOI;
    }
    const byExp = new Map();
    for (const r of rows) byExp.set(r.expiry, (byExp.get(r.expiry) || 0) + r.callOI + r.putOI);
    const expiry = [...byExp].sort((a, b) => b[1] - a[1])[0] || null;
    const topCall = rows.slice().sort((a, b) => b.callOI - a.callOI)[0] || null;
    const topPut = rows.slice().sort((a, b) => b.putOI - a.putOI)[0] || null;
    return { ...def, rows: rows.length, callOI, putOI, totalOI: callOI + putOI,
      callDelta, putDelta, totalDelta: callDelta + putDelta, comparable,
      coverage: rows.length ? comparable / rows.length : 0, expiry, topCall, topPut };
  });
  return { ticker, snaps: snaps.length, from: snaps[0].asof, asof: cur.asof, prev: prev && prev.asof,
    rows: cur.rows.length, buckets };
}
function optionMacroPeers(selected) {
  const ids = ['SPY-US', 'QQQ-US', 'IWM-US', 'IEF-US', 'TLT-US', 'HYG-US'];
  return ids.filter(x => x !== selected).map(optionBehavior).filter(x => x && x.snaps >= 2);
}
