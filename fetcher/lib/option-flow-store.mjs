/* 盘中期权快照单独滚存。Volume 是当日累计值，相邻快照之差才是区间成交量。 */
export const FLOW_FIELDS = ['timestamp', 'asof', 'ticker', 'spot', 'expiry', 'strike',
  'call_oi', 'put_oi', 'call_volume', 'put_volume', 'call_last', 'put_last',
  'call_bid', 'call_ask', 'put_bid', 'put_ask', 'call_delta', 'put_delta'];
export const FLOW_RETAIN_DAYS = 10;

function nyDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(timestamp));
  const get = type => parts.find(x => x.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function flowRows(ticker, snapshot, timestamp = new Date().toISOString()) {
  const asof = nyDate(timestamp);
  return (snapshot?.rows || []).map(r => {
    const out = { timestamp, asof, ticker, spot: snapshot.spot, ...r };
    return Object.fromEntries(FLOW_FIELDS.map(k => [k, out[k] ?? '']));
  });
}

export function retainFlowRows(rows, now = new Date(), days = FLOW_RETAIN_DAYS) {
  const cutoff = +now - days * 86400000;
  return (rows || []).filter(r => {
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
}
