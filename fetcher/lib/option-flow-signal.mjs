/* Pure option-flow signal construction. No filesystem and no network. */
export const SIGNAL_FIELDS = [
  'timestamp','asof','ticker','spot','interval_seconds','total_new_contracts','classified_contracts',
  'classification_coverage','spread_suspect_contracts','net_delta_shares','gross_delta_shares',
  'delta_imbalance','delta_notional','core_net_delta_shares','core_gross_delta_shares','core_imbalance',
  'quality','direction','future_1h_return','future_1d_return',
];

const n = x => x === '' || x == null ? null : Number.isFinite(+x) ? +x : null;
const key = r => `${r.expiry}|${r.strike}`;
const dte = (asof, expiry) => Math.round((Date.parse(expiry+'T00:00:00Z')-Date.parse(asof+'T00:00:00Z'))/86400000);
function leg(prev, cur, kind) {
  const volume=n(cur[`${kind}_volume`]), oldVolume=n(prev[`${kind}_volume`]);
  const dv=volume===null||oldVolume===null?0:Math.max(0,volume-oldVolume),delta=n(cur[`${kind}_delta`]);
  const last=n(cur[`${kind}_last`]),bid=n(cur[`${kind}_bid`]),ask=n(cur[`${kind}_ask`]);
  let action='unknown',position=null,reason=dv?'unclassified':'no-volume';
  if(dv>0&&bid!==null&&ask!==null&&last!==null&&bid>=0&&ask>bid){
    const width=ask-bid,mid=(ask+bid)/2;position=(last-bid)/width;
    if(position<-.2||position>1.2)reason='stale-last';
    else if(mid>.1&&width/mid>.35)reason='wide-spread';
    else if(position>=.8){action='buy';reason='ask-side'}
    else if(position<=.2){action='sell';reason='bid-side'}
    else reason='mid-market';
  }
  const q=action==='buy'?1:action==='sell'?-1:0;
  return {kind,dv,delta,action,position,reason,spread:false,flow:q*dv*100*(delta??0)};
}

export function buildOptionSignal(ticker, previousRows, currentRows) {
  if(!previousRows?.length||!currentRows?.length)return null;
  if(previousRows[0].asof!==currentRows[0].asof || (previousRows[0].source||'')!==(currentRows[0].source||''))return null;
  const timestamp=currentRows[0].timestamp,priorTimestamp=previousRows[0].timestamp;
  const seconds=Math.round((Date.parse(timestamp)-Date.parse(priorTimestamp))/1000);
  if(!Number.isFinite(seconds)||seconds<30||seconds>7200)return null;
  const prev=new Map(previousRows.map(r=>[key(r),r])),items=[];
  for(const cur of currentRows){const p=prev.get(key(cur));if(!p)continue;for(const kind of ['call','put'])items.push({cur,...leg(p,cur,kind)});}
  const active=items.filter(x=>x.dv>0&&x.action!=='unknown');
  for(const x of active)x.spread=active.some(y=>y!==x&&y.kind===x.kind&&y.cur.expiry===x.cur.expiry&&y.action!==x.action&&Math.abs(y.dv/x.dv-1)<=.25);
  const total=items.reduce((s,x)=>s+x.dv,0),classified=active.reduce((s,x)=>s+x.dv,0),spread=active.filter(x=>x.spread).reduce((s,x)=>s+x.dv,0);
  const usable=active.filter(x=>!x.spread&&x.delta!==null),net=usable.reduce((s,x)=>s+x.flow,0),gross=usable.reduce((s,x)=>s+Math.abs(x.flow),0);
  const spot=n(currentRows[0].spot),asof=currentRows[0].asof;
  const core=usable.filter(x=>dte(asof,x.cur.expiry)>=0&&dte(asof,x.cur.expiry)<=7&&spot>0&&Math.abs(+x.cur.strike/spot-1)<=.02);
  const coreNet=core.reduce((s,x)=>s+x.flow,0),coreGross=core.reduce((s,x)=>s+Math.abs(x.flow),0);
  const coverage=total?classified/total:0,imbalance=gross?net/gross:0,coreImbalance=coreGross?coreNet/coreGross:0;
  const quality=total===0?'no-new-volume':coverage<.35?'low-coverage':spread/classified>.5?'spread-heavy':gross===0?'missing-delta':'usable';
  const direction=quality!=='usable'||gross===0?'unavailable':imbalance>=.2?'bullish':imbalance<=-.2?'bearish':'mixed';
  const row={timestamp,asof,ticker,spot:spot??'',interval_seconds:seconds,total_new_contracts:total,
    classified_contracts:classified,classification_coverage:coverage,spread_suspect_contracts:spread,
    net_delta_shares:Math.round(net),gross_delta_shares:Math.round(gross),delta_imbalance:imbalance,
    delta_notional:spot===null?'':Math.round(net*spot),core_net_delta_shares:Math.round(coreNet),
    core_gross_delta_shares:Math.round(coreGross),core_imbalance:coreImbalance,quality,direction,
    future_1h_return:'',future_1d_return:''};
  return Object.fromEntries(SIGNAL_FIELDS.map(f=>[f,row[f]??'']));
}

/* Label matured 1h observations using the first later signal at or after +55 minutes. */
export function resolveOneHourReturns(rows) {
  const ordered=[...(rows||[])].sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
  for(let i=0;i<ordered.length;i++){
    if(ordered[i].future_1h_return!==''&&ordered[i].future_1h_return!=null)continue;
    const start=Date.parse(ordered[i].timestamp),spot=n(ordered[i].spot);if(!Number.isFinite(start)||!spot)continue;
    const later=ordered.slice(i+1).find(r=>Date.parse(r.timestamp)-start>=55*60000&&Date.parse(r.timestamp)-start<=90*60000&&n(r.spot));
    if(later)ordered[i].future_1h_return=n(later.spot)/spot-1;
  }
  return ordered;
}
