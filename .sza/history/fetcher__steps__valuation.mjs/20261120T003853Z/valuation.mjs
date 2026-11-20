import fs from 'node:fs';
import path from 'node:path';
import { assetPath } from '../lib/config.mjs';
import { marketDate } from '../lib/companies.mjs';
import { atomicText } from '../lib/atomic-csv.mjs';
import { phase } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { valuationDates, scalarFql, valuationVerdict, VALUATION_YEARS } from '../lib/valuation-history.mjs';
import { apiFql } from './options.mjs';
import { csvCell, splitCsvLine } from './news.mjs';

export const valuationFile = ticker => `${ticker} NTM Valuation History.csv`;
// Live verified 2026-09-30: NTMA is FactSet's annual-estimate-based NTM
// basis. The literal NTM is rejected by FQL; ANN_ROLL,+1 is FY1, not NTM.
export function valuationExpressions(date) {
  const d=date.replaceAll('-','');
  return {price:`P_PRICE(${d})`,eps:`FE_ESTIMATE(EPS,MEAN,NTMA,,${d})`,pe:`FE_VALUATION(PE,MEAN,NTMA,,${d})`};
}
export function cachedValuation(file, ticker) {
  try {
    const lines=fs.readFileSync(file,'utf8').trim().split(/\r?\n/), header=splitCsvLine(lines.shift());
    const numeric=v=>v==null||v===''?null:Number(v);
    const rows=lines.map(line=>Object.fromEntries(splitCsvLine(line).map((v,i)=>[header[i],v])))
      .map(r=>({...r,price:numeric(r.price),eps_ntm:numeric(r.eps_ntm),pe_ntm:numeric(r.pe_ntm)}));
    if(rows.some(r=>r.ticker!==ticker||r.valuation_basis!=='ntm'||!/^\d{4}-\d{2}-\d{2}$/.test(r.date))) return [];
    rows.sort((a,b)=>a.date.localeCompare(b.date));
    if(new Set(rows.map(r=>r.date)).size!==rows.length || !valuationVerdict(rows).ok) return [];
    return rows;
  } catch { return []; }
}
export async function fetchValuationHistory(ticker,{asOf=marketDate(),years=VALUATION_YEARS,request=apiFql,forceHistory=false}={}) {
  const schedule=valuationDates(asOf,years), file=assetPath(valuationFile(ticker));
  const cached=new Map((forceHistory?[]:cachedValuation(file,ticker)).map(r=>[r.date,r]));
  // Refresh the comparison month as well, so its EPS/price uses the same
  // current split adjustments as today's snapshot. Historical PE is invariant.
  const comparisonDate=schedule.at(-2);
  const dates=schedule.filter(date=>date===asOf||date===comparisonDate||!cached.has(date));
  const records=new Map(schedule.filter(date=>cached.has(date)).map(date=>[date,cached.get(date)]));
  const retrievedAt=new Date().toISOString();
  phase('取滚动 NTM 历史');
  for(let offset=0;offset<dates.length;offset+=24) {
    const batch=dates.slice(offset,offset+24),exprs=batch.flatMap(d=>Object.values(valuationExpressions(d)));
    const response=await request([ticker],exprs);
    if(response.status!==200) throw new Error(`NTM 历史接口 HTTP ${response.status}`);
    for(const date of batch) {
      const e=valuationExpressions(date);
      const price=scalarFql(response.json,ticker,e.price),eps=scalarFql(response.json,ticker,e.eps),pe=scalarFql(response.json,ticker,e.pe);
      records.set(date,{ticker,date,pe_ntm:eps>0&&pe>0?pe:null,price,eps_ntm:eps,
        valuation_basis:'ntm',source:'FactSet FQL: '+e.pe+'; '+e.price+'; '+e.eps,retrieved_at:retrievedAt});
    }
    log(`  · ${ticker} NTM 更新 ${Math.min(offset+24,dates.length)}/${dates.length} 个日期已返回`);
  }
  phase('校验历史覆盖');
  const rows=schedule.map(date=>records.get(date));
  const verdict=valuationVerdict(rows);
  if(!verdict.ok) throw new Error(verdict.reason);
  const columns=['ticker','date','pe_ntm','price','eps_ntm','valuation_basis','source','retrieved_at'];
  const csv=columns.join(',')+'\n'+rows.map(r=>columns.map(k=>csvCell(r[k]??'')).join(',')).join('\n')+'\n';
  phase('写文件');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  atomicText(file,csv);
  log(`  ✔ ${valuationFile(ticker)}：${verdict.positive} 个有效点，${verdict.from} ~ ${verdict.to}（请求近${years}年）`);
  return true;
}
