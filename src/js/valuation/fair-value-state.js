/* Private model/evidence imports. Historical multiples never fill missing fair value. */
function fairToday() {
  return fairDateAt(new Date());
}
function fairDateAt(value) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}
function fairPeriod(label) {
  const m=FY_LABEL.exec(label||'');
  return m ? (2000+Number(m[2]))+'-'+MONTHS[m[1].toLowerCase()] : null;
}
function fairCompanies() {
  const companies=visibleCompanies();
  for(const ticker of state.roster||[]) if(!state.companies.has(ticker)) companies.push({ticker,currency:'',price:NaN});
  return companies;
}
function ingestFairDocument(doc) {
  if (doc?.document_type!=='fair-value-inputs-v1') throw new Error('仅支持 fair-value-inputs-v1 估值输入文件');
  for (const k of ['models','observations','events']) if (doc[k]!==undefined && !Array.isArray(doc[k])) throw new Error(k+' 必须为列表');
  const models=new Map([...state.fairModels].map(([k,v])=>[k,[...v]])), observations=new Map(state.fairObservations), events=new Map(state.fairEvents);
  for (const m of doc.models||[]) {
    const errors=FairValue.validate(m); if(errors.length) throw new Error(errors.join('；'));
    const versions=models.get(m.ticker)||[], old=versions.find(v=>v.model_id===m.model_id);
    if(old && JSON.stringify(old)!==JSON.stringify(m)) throw new Error('模型版本号重复且内容不同：'+m.model_id);
    if(!old) versions.push(m);
    if(versions.some(v=>v.model_id!==m.model_id && v.reviewed_at===m.reviewed_at)) throw new Error('同一复核时间对应多个模型版本');
    models.set(m.ticker,versions.sort((a,b)=>a.reviewed_at.localeCompare(b.reviewed_at)));
  }
  for (const o of doc.observations||[]) {
    if(!o || !/^[A-Z0-9.-]+$/.test(o.ticker||'') || !/^\d{4}-(0[1-9]|1[0-2])$/.test(o.period||'') || !Number.isFinite(o.mean)
      || !/^\d{4}-\d{2}-\d{2}$/.test(o.date||'') || !Number.isFinite(Date.parse(o.date)) || new Date(o.date).toISOString().slice(0,10)!==o.date
      || !Number.isFinite(Date.parse(o.observed_at)) || o.date>fairDateAt(o.observed_at) || !o.source || !o.currency || !o.basis)
      throw new Error('盈利核验记录缺少代码、财年、数值、口径、币种、来源或时间');
    const key=o.ticker+'|'+o.period, old=observations.get(key);
    if(!old || o.date>old.date || (o.date===old.date && o.observed_at>old.observed_at)) observations.set(key,o);
  }
  for(const e of doc.events||[]) {
    if(!e?.id || !e.ticker || !e.title || !e.source || !Number.isFinite(Date.parse(e.observed_at)) || typeof e.requires_review!=='boolean') throw new Error('事件缺少标识、来源、时间或复核标志');
    if(events.has(e.id) && JSON.stringify(events.get(e.id))!==JSON.stringify(e)) throw new Error('事件 ID 重复且内容不同：'+e.id);
    events.set(e.id,e);
  }
  state.fairModels=models; state.fairObservations=observations; state.fairEvents=events;
  return '估值模型／盈利核验／事件已导入（保留旧版本）';
}
function fairAssessment(co,asOf=fairToday()) {
  const versions=(state.fairModels.get(co.ticker)||[]).filter(m=>m.as_of<=asOf && fairDateAt(m.reviewed_at)<=asOf), model=versions.at(-1);
  const earnings=Object.values(co.estimateMeta||{}).map(m=>({period:fairPeriod(m.label),mean:m.latestMean,date:m.date,basis:'EPS majority',currency:co.currency})).filter(m=>m.period);
  for(const o of state.fairObservations.values()) {
    if(o.ticker!==co.ticker || o.date>asOf || fairDateAt(o.observed_at)>asOf) continue;
    const i=earnings.findIndex(e=>e.period===o.period);
    if(i<0) earnings.push(o); else if(o.date>=earnings[i].date) earnings[i]=o;
  }
  const events=[...state.fairEvents.values()].filter(e=>fairDateAt(e.observed_at)<=asOf);
  const observation={asOf,currency:co.currency,earnings,events,checkedOn:state.fairImportedAt ? fairDateAt(state.fairImportedAt) : null};
  const assessment=FairValue.assess(model,observation);
  if(model && assessment.status!=='invalid') {
    if(state.fairImportErrors.length) assessment.reasons.push('数据导入失败：'+state.fairImportErrors.join('、'));
    for(const e of earnings.filter(e=>model.earnings_checks.some(c=>c.period===e.period))) {
      if(e.currency!==model.currency) assessment.reasons.push(e.period+' 盈利币种不一致');
      const check=model.earnings_checks.find(c=>c.period===e.period);
      if(check.basis!==e.basis) assessment.reasons.push(e.period+' 盈利口径改变或未核实');
    }
    if(assessment.reasons.length) assessment.status='review';
  }
  return {...assessment,model,observation,versions,revisions:fairEarningsChanges(co.ticker,earnings)};
}
const FAIR_LEDGER_KEY='prd-fair-value-ledger-v1';
let fairLedgerError='';
let fairPendingLedger=null;
function readFairLedger() {
  if(fairPendingLedger) return fairPendingLedger;
  try { const rows=JSON.parse(localStorage.getItem(FAIR_LEDGER_KEY)||'[]'); if(!Array.isArray(rows)) throw new Error('记录格式错误'); return rows; }
  catch(e) { fairLedgerError='估值记录无法读取：'+e.message; return null; }
}
function fairEarningsChanges(ticker,earnings) {
  const records=(readFairLedger()||[]).filter(r=>r.ticker===ticker).reverse(), changes=[];
  for(const current of earnings) {
    for(const record of records) {
      const previous=record.earnings?.find(e=>e.period===current.period);
      if(!previous) continue;
      // A basis/currency change breaks comparability; do not search past it.
      if(previous.basis!==current.basis || previous.currency!==current.currency || previous.date>current.date) break;
      if(previous.mean===current.mean) continue;
      changes.push({period:current.period,from:previous.mean,to:current.mean,from_date:previous.date,to_date:current.date,
        change:previous.mean>0?current.mean/previous.mean-1:null});
      break;
    }
  }
  return changes;
}
function recordFairSnapshots() {
  if(!state.fairImportedAt) return;
  const rows=readFairLedger(); if(!rows) return;
  for(const co of fairCompanies()) {
    if(co.ticker.startsWith('DEMO-')) continue;
    const a=fairAssessment(co), r=a.status==='ready'?a.result:null;
    const snapshot={date:a.observation.asOf,ticker:co.ticker,currency:co.currency,model_id:a.model?.model_id||null,status:a.status,
      reasons:a.reasons,low:r?.low??null,mid:r?.mid??null,high:r?.high??null,
      price:co.price,price_date:co.priceDate,earnings:a.observation.earnings,
      model:a.model||null,events:a.observation.events.filter(e=>e.ticker===co.ticker)};
    const fingerprint=JSON.stringify(snapshot), last=rows.filter(x=>x.ticker===co.ticker).at(-1);
    if(!last || last.fingerprint!==fingerprint) rows.push({...snapshot,fingerprint,recorded_at:new Date().toISOString()});
  }
  try { localStorage.setItem(FAIR_LEDGER_KEY,JSON.stringify(rows)); fairLedgerError=''; fairPendingLedger=null; }
  catch(e) { fairPendingLedger=rows; fairLedgerError='估值记录未保存，请导出备份：'+e.message; }
}
function exportFairLedger() {
  const rows=readFairLedger(); if(!rows) return;
  const blob=new Blob([JSON.stringify({document_type:'fair-value-ledger-v1',exported_at:new Date().toISOString(),rows:rows.map(({fingerprint,...r})=>r)},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download='fair-value-ledger-'+fairToday()+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
