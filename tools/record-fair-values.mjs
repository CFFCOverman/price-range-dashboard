// Local-only snapshot: no network, fetcher, signals, or trading actions.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import XLSX from 'xlsx';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'Assets','fair-value');
fs.mkdirSync(out,{recursive:true});
const ledgerFile=path.join(out,'ledger.json');
let ledger=fs.existsSync(ledgerFile)?fs.readFileSync(ledgerFile,'utf8'):'[]';
// Validate before any writes. Never replace a corrupt audit trail with an empty one.
if(!Array.isArray(JSON.parse(ledger)))throw new Error('Invalid existing ledger');
const ctx=vm.createContext({console,Date,Intl,Map,Set,localStorage:{getItem:()=>ledger,setItem:(_,s)=>{ledger=s;}}});
for(const f of ['core/utils','core/csv','core/state','core/i18n','ingest/companies','ingest/estimates','ingest/roster','valuation/fair-value','valuation/fair-value-state'])
  vm.runInContext(fs.readFileSync(path.join(root,'src/js',f+'.js'),'utf8'),ctx);
const run=s=>vm.runInContext(s,ctx);
const sourceManifest=[];
function read(file) {const bytes=fs.readFileSync(file);sourceManifest.push({file:path.relative(root,file),modified_at:fs.statSync(file).mtime.toISOString()});return bytes;}
ctx.csv=read(path.join(root,'Assets/summary/companies.csv')).toString();run('ingestCompanies(parseCSV(csv))');
ctx.roster=fs.readFileSync(path.join(root,'fetcher/tickers.txt'),'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
run('state.roster=new Set(roster);for(const tk of roster) if(!state.companies.has(tk)) state.companies.set(tk,{ticker:tk,name:tk,currency:"",price:NaN,eps:{fy1:{},fy2:{}}})');
const estDir=path.join(root,'Assets/estimates');
for(const name of fs.readdirSync(estDir).filter(n=>/ FY[12] Estimate History\.xlsx$/i.test(n)).sort()) {
  const wb=XLSX.read(read(path.join(estDir,name)),{type:'buffer'});
  for(const sn of wb.SheetNames) {ctx.sheet=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,raw:true});ctx.name=name;ctx.sn=sn;run('ingestEstimateSheet(sn,sheet,name)');}
}
for(const name of fs.readdirSync(out).filter(n=>/Fair Value Inputs\.json$/i.test(n)).sort()) {
  ctx.doc=JSON.parse(read(path.join(out,name)));run('ingestFairDocument(doc)');
}
run('state.fairImportedAt=new Date().toISOString();recordFairSnapshots()');
const latest=JSON.parse(run('JSON.stringify(visibleCompanies().map(co=>({ticker:co.ticker,...fairAssessment(co)})))'));
const report={recorded_at:new Date().toISOString(),scope:'Local imported evidence only; no live monitoring',sourceManifest,companies:latest};
// Write current report and ledger via same-directory temporary replacements.
for(const [target,body] of [[ledgerFile,ledger],[path.join(out,'latest-review.json'),JSON.stringify(report,null,2)]]) {
  const temp=target+'.pending.'+process.pid;
  fs.writeFileSync(temp,body,{flag:'wx'});fs.renameSync(temp,target);
}
const counts={};for(const c of latest)counts[c.status]=(counts[c.status]||0)+1;
console.log(JSON.stringify({companies:latest.length,statuses:counts,records:JSON.parse(ledger).length,output:out}));
