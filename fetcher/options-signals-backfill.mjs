/* Rebuild compact long-lived signal rows from retained Options Flow snapshots. */
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR, assetPath, ensureAssetDirs } from './lib/config.mjs';
import { SIGNAL_FIELDS, buildOptionSignal, resolveOneHourReturns } from './lib/option-flow-signal.mjs';
import { csvCell, splitCsvLine } from './steps/news.mjs';

function readCsv(file){
  const lines=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean),head=splitCsvLine(lines.shift()||'');
  return lines.map(line=>{const cells=splitCsvLine(line);return Object.fromEntries(head.map((h,i)=>[h,cells[i]??'']))});
}
function filesUnder(dir,out=[]){
  if(!fs.existsSync(dir))return out;
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const f=path.join(dir,e.name);if(e.isDirectory()&&!/_logs|options-signals/.test(e.name))filesUnder(f,out);
    else if(e.isFile()&&/ Options Flow\.csv$/i.test(e.name))out.push(f);
  }
  return out;
}

ensureAssetDirs();
for(const file of filesUnder(OUT_DIR)){
  const ticker=path.basename(file).replace(/ Options Flow\.csv$/i,''),rows=readCsv(file);
  const byTime=new Map();for(const r of rows){if(!byTime.has(r.timestamp))byTime.set(r.timestamp,[]);byTime.get(r.timestamp).push(r)}
  const times=[...byTime.keys()].sort(),built=[];
  for(let i=1;i<times.length;i++){
    const prev=byTime.get(times[i-1]),cur=byTime.get(times[i]);
    if(prev[0]?.asof!==cur[0]?.asof)continue;
    const signal=buildOptionSignal(ticker,prev,cur);if(signal)built.push(signal);
  }
  const target=assetPath(`${ticker} Options Signals.csv`),merged=new Map();
  if(fs.existsSync(target))for(const r of readCsv(target))merged.set(r.timestamp,r);
  for(const r of built)merged.set(r.timestamp,r);
  const signals=resolveOneHourReturns([...merged.values()]).slice(-100000);
  fs.writeFileSync(target,SIGNAL_FIELDS.join(',')+'\n'+signals.map(r=>SIGNAL_FIELDS.map(k=>csvCell(r[k])).join(',')).join('\n')+'\n');
  console.log(`✔ ${ticker}: ${built.length} 个历史区间 → ${target}`);
}
