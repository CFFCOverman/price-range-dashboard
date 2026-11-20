import fs from 'node:fs';
import { assetPath, OUT_DIR } from '../fetcher/lib/config.mjs';
import { splitCsvLine } from '../fetcher/steps/news.mjs';
import { buildOptionSignal } from '../fetcher/lib/option-flow-signal.mjs';
const read=f=>{const lines=fs.readFileSync(f,'utf8').trim().split(/\r?\n/),h=splitCsvLine(lines.shift());return lines.map(l=>{const v=splitCsvLine(l);return Object.fromEntries(h.map((k,i)=>[k,v[i]??'']))})};
for(const file of fs.readdirSync(`${OUT_DIR}/options`).filter(f=>f.endsWith(' Options Flow.csv'))){
  const ticker=file.replace(' Options Flow.csv',''),rows=read(assetPath(file)),groups=new Map();
  for(const r of rows){if(!groups.has(r.timestamp))groups.set(r.timestamp,[]);groups.get(r.timestamp).push(r)}
  const times=[...groups.keys()].sort(),saved=read(assetPath(`${ticker} Options Signals.csv`)),byTime=new Map(saved.map(r=>[r.timestamp,r]));
  let comparable=0,resets=0,duplicates=0,missing=0,changed=0,unmatched=0;
  for(const group of groups.values())duplicates+=group.length-new Set(group.map(r=>`${r.expiry}|${r.strike}`)).size;
  for(let i=1;i<times.length;i++){
    const a=groups.get(times[i-1]),b=groups.get(times[i]);if(a[0].asof!==b[0].asof||a[0].source!==b[0].source)continue;
    const prev=new Map(a.map(r=>[`${r.expiry}|${r.strike}`,r]));
    for(const r of b){const p=prev.get(`${r.expiry}|${r.strike}`);if(!p){unmatched++;continue}for(const k of ['call_volume','put_volume'])if(r[k]!==''&&p[k]!==''&&+r[k]<+p[k])resets++}
    const s=buildOptionSignal(ticker,a,b);if(!s)continue;comparable++;
    const old=byTime.get(s.timestamp);if(!old)missing++;else if(['direction','quality','net_delta_shares'].some(k=>String(s[k])!==old[k]))changed++;
  }
  console.log(JSON.stringify({ticker,snapshots:times.length,signals:saved.length,latest:times.at(-1),comparable,missing,changed,volumeRegressions:resets,duplicateContracts:duplicates,newlyVisibleContracts:unmatched}));
}
