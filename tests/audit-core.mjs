import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { buildOptionSignal } from '../fetcher/lib/option-flow-signal.mjs';
import { chartHasPrices } from '../fetcher/steps/charting.mjs';

const html=fs.readFileSync('options-dashboard.html','utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({console,Map,Date,document:{getElementById:()=>({})}});
vm.runInContext(script.slice(0,script.indexOf("$('files').onchange")),context);
const run=code=>vm.runInContext(code,context);
const leg={expiry:'2026-09-18',strike:230,asof:'2026-09-04',spot:230,source:'options-montage-live',call_volume:100,put_volume:100,call_last:1.1,call_bid:1,call_ask:1.1,put_last:1.05,put_bid:1,put_ask:1.1,call_delta:.5,put_delta:-.5};
const a={...leg,timestamp:'2026-09-04T18:00:00Z'},b={...leg,timestamp:'2026-09-04T18:05:00Z',call_volume:120};
function pageFlow(rows){context.fixture=rows;return run("flows.set('TEST',fixture.map(flowRow));flowMap('TEST','2026-09-18')");}
let f=pageFlow([a,b]);assert.equal(f.map.get(230).legs[0].dv,20);
assert.equal(buildOptionSignal('TEST',[a],[b]).net_delta_shares,1000);
assert.equal(pageFlow([a,{...b,source:'daily'}]).map.size,0);
assert.equal(buildOptionSignal('TEST',[a],[{...b,source:'daily'}]),null);
assert.equal(pageFlow([{...a,call_volume:''},b]).map.get(230).legs[0].dv,0);
assert.equal(pageFlow([a,{...b,timestamp:'2026-09-04T21:00:00Z'}]).map.size,0);
f=pageFlow([a,b,{...a,strike:235},{...b,strike:235,call_last:1}]);
assert.equal(f.map.get(230).legs[0].spread,true);
context.ev=f.map.get(230);assert.match(run('direction(ev,null,null).label'),/疑似组合/);
console.log('PASS options: signed delta, source isolation, missing volume, time window, spread propagation');

// Load the actual PE ingestion/calculation functions, not reimplemented formulas.
const peContext=vm.createContext({console,Map,Date});
vm.runInContext(['src/js/core/state.js','src/js/core/utils.js','src/js/core/i18n.js','src/js/ingest/companies.js','src/js/ingest/estimates.js','src/js/valuation/calc.js'].map(p=>fs.readFileSync(p,'utf8')).join('\n'),peContext);
const peRun=code=>vm.runInContext(code,peContext);
const outputs=[];
for(const file of fs.readdirSync('Assets/estimates').filter(x=>/\.xlsx$/.test(x))){
 const w=XLSX.readFile('Assets/estimates/'+file);peContext.input={file,sheet:w.SheetNames[0],aoa:XLSX.utils.sheet_to_json(w.Sheets[w.SheetNames[0]],{header:1,raw:true})};
 peRun('ingestEstimateSheet(input.sheet,input.aoa,input.file)');
}
const cos=fs.readFileSync('Assets/summary/companies.csv','utf8').trim().split(/\r?\n/);const head=cos.shift().split(',');
peContext.cos=cos.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[head[i],v])));peRun('ingestCompanies(cos)');
console.log(JSON.stringify(peRun("[...state.companies.values()].map(c=>({ticker:c.ticker,price:c.price,priceDate:c.priceDate,eps:c.eps,pe:peStats(c.ticker),range:calcRange(c,'fy1')})).map(x=>({...x,pe:x.pe?{src:x.pe.src,n:x.pe.series?.length,last:x.pe.series?.at(-1),p25:x.pe.p25,p50:x.pe.p50,p75:x.pe.p75}:null,range:x.range?{low:x.range.coreLow,mid:x.range.mid,high:x.range.coreHigh,gap:x.range.baseGap}:null}))"),null,2));
// Equal-length refreshed series must replace historical PE values.
peRun("state.history.set('REFRESH',[{date:'2026-08-01',pe:10}])");
peContext.input={sheet:'REFRESH',file:'REFRESH FY1.xlsx',aoa:[['REFRESH'],['Estimate History',"Dec '26E"],['Date','Mean','Low','High','P/E (x)'],["1 Sep '26",2,1,3,20]]};
peRun('ingestEstimateSheet(input.sheet,input.aoa,input.file)');assert.equal(peRun("state.history.get('REFRESH')[0].pe"),20);
console.log('PASS PE same-length refresh');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chart-validation-'));
try {
 const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet([['Date',' - Close'],...[1,2,3].map(x=>[45000+x])]),'Sheet');
 const f=path.join(temp,'empty.xlsx');XLSX.writeFile(w,f);assert.equal(chartHasPrices(f),false);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
assert.equal(chartHasPrices('Assets/charting/NVDA-US Daily Charting.xlsx'),true);
console.log('PASS chart validation rejects date-only export and accepts valid NVDA');
