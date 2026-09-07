import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { loadDaily } from '../tools/backtest.mjs';
import { fyTag } from '../fetcher/steps/estimates.mjs';
const c = vm.createContext({console, Map, Date});
for (const f of ['core/state','core/utils','core/i18n','ingest/companies','ingest/estimates','ingest/resolve','ingest/charting','ingest/files']) vm.runInContext(fs.readFileSync(`src/js/${f}.js`,'utf8'),c);
const run = s => vm.runInContext(s,c);
for (const name of ['Assets/_logs/last-good-estimates/A FY1.xlsx','A Daily Charting.xlsx.pending.xlsx','_to_delete','_logs']) { c.name=name; assert.equal(run('isImportArtifact(name)'),false); }
assert.equal(run("isImportArtifact('A-US Daily Charting.xlsx')"),true);
vm.runInContext(fs.readFileSync('src/js/ingest/folder.js','utf8').split("$('dirBtn').addEventListener")[0],c);
const file = name => ({kind:'file',name,getFile:async()=>({name})});
const dir = (name, entries) => ({kind:'directory',name,async *values(){yield* entries;}});
c.root=dir('Assets',[dir('_logs',[file('A FY1.xlsx')]),file('A.xlsx.pending.xlsx'),dir('charting',[file('A.xlsx')])]);
assert.equal(await run('(async()=>{const out=[];await collectDirFiles(root,0,out);return out.map(f=>f.name).join()})()'),'A.xlsx');
run("state.companies.set('A-US',{ticker:'A-US',price:100,priceSrc:'file',priceDate:'2026-09-07',rev:{n:20,up:5,down:1},eps:{fy1:{},fy2:{}}})");
run("ingestCompanies([{ticker:' A-US ',price:'1,714.88',price_date:'2026-09-07'}])");
assert.equal(run("state.companies.get('A-US').price"),1714.88);
assert.equal(run("state.companies.get('A-US').rev.up"),5);
run("ingestCompanies([{ticker:'A-US',price:'0',price_date:'2026-09-08'}])");
assert.equal(run("state.companies.get('A-US').price"),1714.88);
run("ingestCompanies([{ticker:'A-US',price:'50',price_date:'2020-01-01'}])");
assert.equal(run("state.companies.get('A-US').price"),1714.88);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pipeline-audit-'));
try {
  const rows=[['Date','Close'],...Array.from({length:45},(_,i)=>[45000+i,'1,714.88'])];
  rows.push([45044,'1,800.00']);
  c.rows=rows;run("ingestChartingSheet('A',rows,'A-US Daily Charting.xlsx')");
  assert.equal(run("state.priceHist.get('A-US').at(-1).price"),1800);
  const write=(name,a)=>{const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(a),'Sheet');XLSX.writeFile(w,path.join(tmp,name));};
  write('A-US Daily Charting.xlsx',rows);
  write('B-US Daily Charting.xlsx',[['Date','B - Close'],...Array.from({length:45},(_,i)=>[45000+7*i,100+i])]);
  write('C-US Daily Charting.xlsx.pending.xlsx',rows);
  const all=loadDaily(tmp);assert.equal(all.cos.size,2);assert.equal(all.cos.get('A-US').length,45);assert.equal(all.cos.get('A-US').at(-1).price,1800);
  const daily=loadDaily(tmp,{requireDaily:true});assert.equal(daily.cos.size,1);assert.equal(daily.cos.has('A-US'),true);
  const scoped=path.join(tmp,'scoped'); fs.mkdirSync(path.join(scoped,'charting'),{recursive:true}); fs.mkdirSync(path.join(scoped,'summary'));
  fs.copyFileSync(path.join(tmp,'A-US Daily Charting.xlsx'),path.join(scoped,'charting','A-US Daily Charting.xlsx'));
  fs.writeFileSync(path.join(scoped,'summary','roster.csv'),'ticker,role,active\nA-US,bench,1\n');
  assert.equal(loadDaily(path.join(scoped,'charting'),{requireDaily:true}).cos.size,0);

} finally {fs.rmSync(tmp,{recursive:true,force:true});}
assert.equal(fyTag("Sep '27E",new Date(2026,8,1)),'FY2');
assert.equal(fyTag("Aug '27E",new Date(2026,8,1)),'FY1');
assert.equal(fyTag(null),null);
console.log('PASS pipeline: quarantine isolation, folder scan, company metadata, stale/invalid prices, formatted Close, duplicate dates, daily backtest gate, fiscal boundary');
