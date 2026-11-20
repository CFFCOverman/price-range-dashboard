import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'valuation-fetch-'));
process.env.FS_OUT=root;
const { fetchValuationHistory, valuationExpressions }=await import('../fetcher/steps/valuation.mjs');
const { assetPath }=await import('../fetcher/lib/config.mjs');
const { splitCsvLine }=await import('../fetcher/steps/news.mjs');
try {
  const requests=[];
  const request=async(symbols,exprs)=>{
    requests.push(exprs);
    return {status:200,json:exprs.map(expression=>({$symbol:symbols[0],$expression:expression,$error:0,
      $value:[[expression.startsWith('P_PRICE')?100:expression.startsWith('FE_VALUATION')?20:5]]}))};
  };
  await fetchValuationHistory('TST-US',{asOf:'2026-09-29',request});
  const file=assetPath('TST-US NTM Valuation History.csv'),good=fs.readFileSync(file,'utf8');
  const rows=good.trim().split('\n').map(splitCsvLine);
  assert.equal(rows.length,122,'full 10y window written on the very first call');
  assert.equal(rows[1][1],'2016-09-30');
  assert.equal(rows.at(-1)[1],'2026-09-29');
  assert.equal(Number(rows[1][2]),20);
  assert.ok(requests.flat().includes(valuationExpressions('2016-09-30').eps));
  assert.ok(requests.flat().every(e=>!e.includes('NOW')),'historical estimates never use current forecasts');
  requests.length=0;
  await fetchValuationHistory('TST-US',{asOf:'2026-09-29',request});
  assert.equal(requests.flat().length,6,'repeat run refreshes current and comparison dates only, with no freshness skip');
  const beforeFailure=fs.readFileSync(file,'utf8');
  for(const badRequest of [async()=>({status:403}),async()=>({status:200,json:[]}),async(s,e)=>({status:200,json:e.map(x=>({$symbol:s[0],$expression:x,$error:0,$value:[['NA']]}))})]) {
    await assert.rejects(fetchValuationHistory('TST-US',{asOf:'2026-09-29',request:badRequest}));
    assert.equal(fs.readFileSync(file,'utf8'),beforeFailure,'failed candidate cannot overwrite last valid history');
  }
  requests.length=0;
  await fetchValuationHistory('TST-US',{asOf:'2026-10-01',request});
  assert.equal(requests.flat().length,6,'month roll fetches newly completed month and current snapshot');
  const rolled=fs.readFileSync(file,'utf8').trim().split('\n').map(splitCsvLine);
  assert.equal(rolled.length,122,'incremental refresh does not overweight recent months with daily rows');
  assert.equal(rolled.at(-2)[1],'2026-09-30');
  assert.equal(rolled.at(-1)[1],'2026-10-01');
  requests.length=0;
  await fetchValuationHistory('TST-US',{asOf:'2026-10-01',request,forceHistory:true});
  assert.equal(requests.flat().length,363,'explicit force refreshes the whole history');
  console.log('PASS valuation fetch integration: complete first-run backfill, as-of formulas, CSV roundtrip, failed update preserves valid file');
} finally {
  if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())) throw new Error('Unexpected test cleanup path');
  fs.rmSync(root,{recursive:true,force:true});
}
