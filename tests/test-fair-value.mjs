import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export function fixture() {
  const s={rationale:'Synthetic test assumptions; no security recommendation',cost_of_equity:.10,terminal_growth:0,terminal_fcfe_next:10,
    cashflows:[2027,2028,2029,2030,2031].map(y=>({date:y+'-10-01',fcfe_per_share:10,source:'Synthetic test'}))};
  return {schema:'fcfe-v1',ticker:'TEST-US',currency:'USD',model_id:'v1',as_of:'2026-10-01',reviewed_at:'2026-10-01T12:00:00Z',review_due:'2026-10-08',status:'reviewed',
    source:'Synthetic test',equity_basis_note:'Current diluted shares; no second debt deduction',normalization_note:'No growth or dilution in synthetic fixture',cash_flow_timing_note:'Cash paid at specified annual dates',
    max_data_age_days:3,eps_ntm:10,eps_date:'2026-10-01',earnings_checks:[{period:'2027-01',date:'2026-10-01',mean:10,basis:'EPS majority'}],scenarios:{bear:structuredClone(s),base:structuredClone(s),bull:structuredClone(s)}};
}
let saved='[]';
const c=vm.createContext({console,Date,Intl,Map,Set,localStorage:{getItem:()=>saved,setItem:(_,v)=>{saved=v;}}});
for(const f of ['core/state','ingest/estimates','ingest/roster','valuation/fair-value','valuation/fair-value-state'])vm.runInContext(fs.readFileSync('src/js/'+f+'.js','utf8'),c);
const run=s=>vm.runInContext(s,c), engine=run('FairValue'), m=fixture();
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const r=engine.calculate(m,'2026-10-01');assert.equal(r.ok,true);
// Independent date-discount formula, rather than identical hard-coded output.
const t=d=>(Date.parse(d)-Date.parse('2026-10-01'))/86400000/365.25;
const expected=m.scenarios.base.cashflows.reduce((v,cf)=>v+10/1.1**t(cf.date),0)+100/1.1**t('2031-10-01');near(r.mid,expected);
const cut=structuredClone(m);for(const s of Object.values(cut.scenarios)){for(const cf of s.cashflows)cf.fcfe_per_share/=2;s.terminal_fcfe_next/=2;}near(engine.calculate(cut,m.as_of).mid,r.mid/2);
const obs={asOf:m.as_of,currency:'USD',checkedOn:m.as_of,earnings:[{period:'2027-01',date:m.as_of,mean:10}],events:[]};
assert.equal(engine.assess(m,obs).status,'ready');
assert.equal(engine.assess(m,{...obs,earnings:[{...obs.earnings[0],mean:8}]}).status,'review');
assert.equal(engine.assess(m,{...obs,asOf:'2026-10-05'}).status,'review','stale evidence cannot be refreshed by rendering');
assert.equal(engine.assess(m,{...obs,events:[{id:'e',ticker:'TEST-US',title:'Guidance cut',requires_review:true}]}).status,'review');
assert.equal(engine.calculate(m,'2027-10-01').ok,false,'roll model after cash payment date');
assert.equal(engine.calculate(m,'2026-09-30').ok,false,'no lookahead');
for(const bad of [{...m,earnings_checks:{}},{...m,eps_date:'2026-10-02'},{...m,reviewed_event_ids:{}},{...m,max_data_age_days:99}])assert.equal(engine.calculate(bad,m.as_of).ok,false);
const bad=structuredClone(m);bad.scenarios.base.terminal_growth=.1;assert.equal(engine.calculate(bad,m.as_of).ok,false);
const reverse=structuredClone(m);reverse.scenarios.bear.cashflows[0].fcfe_per_share=999;assert.equal(engine.calculate(reverse,m.as_of).ok,false);
const d=engine.attribution(m,cut,m.as_of,m.as_of);near(d.time+d.cashflow+d.riskAndGrowth,d.total);near(d.total,-r.mid/2);
c.doc={document_type:'fair-value-inputs-v1',models:[m]};run('ingestFairDocument(doc)');
c.co={ticker:'TEST-US',currency:'USD',price:100,estimateMeta:{fy1:{label:"Jan '27E",date:m.as_of,latestMean:10}}};
run("state.companies.set(co.ticker,co);state.fairImportedAt='2026-10-01T12:00:00Z'");
near(run("fairAssessment(co,'2026-10-01').result.mid"),r.mid);
run('co.price=20');near(run("fairAssessment(co,'2026-10-01').result.mid"),r.mid,'market price must not set intrinsic value');
c.doc={document_type:'fair-value-inputs-v1',models:[{...m,source:'edited without new id'}]};assert.throws(()=>run('ingestFairDocument(doc)'),/版本号/);
c.doc={document_type:'fair-value-inputs-v1',observations:[{ticker:'TEST-US',period:'2027-01',date:'2026-10-01',mean:8,observed_at:'2026-10-01T13:00:00Z',basis:'EPS majority',currency:'USD',source:'Synthetic'}]};
run('ingestFairDocument(doc)');assert.equal(run("fairAssessment(co,'2026-10-01').status"),'review');
run("fairToday=()=> '2026-10-01';recordFairSnapshots();recordFairSnapshots()");assert.equal(JSON.parse(saved).length,1,'duplicate scan does not fabricate revisions');assert.equal(JSON.parse(saved)[0].mid,null,'stale model is not a current value in audit trail');
run("co.price=25;recordFairSnapshots()");assert.equal(JSON.parse(saved).length,2,'same-day new observation retained');
run("state.fairModels.clear();co.estimateMeta.fy1.latestMean=6;co.estimateMeta.fy1.date='2026-10-02';state.fairObservations.clear()");
assert.equal(run("fairAssessment(co,'2026-10-02').revisions[0].from"),8,'earnings alert works before a model exists');
assert.equal(run("fairAssessment(co,'2026-10-02').revisions[0].to"),6);
run("fairToday=()=> '2026-10-02';recordFairSnapshots()");assert.equal(JSON.parse(saved).length,3,'daily snapshot retained');
console.log('PASS fair-value: independent discount calculation, revisions, events, stale data, model versions, price independence and audit trail');
