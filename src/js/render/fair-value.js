function renderFairOverview() {
  const panel=$('fairOverview'); panel.replaceChildren();
  const say=(cn,en)=>LANG==='en'?en:cn;
  panel.appendChild(el('h2','',say('今日合理估值 · 股东现金流折现','Daily fair value · discounted equity cash flows')));
  panel.appendChild(el('p','hint',say('合理价值由现金流、稀释和风险假设决定。盈利修订或重大事件出现后，旧模型进入待复核状态；不会用历史 PE 区间自动补成新合理价值。','Fair value depends on cash flows, dilution and risk. Earnings revisions or material events flag the old model for review; historical multiples never substitute for a missing fair value.')));
  const table=el('table','ov'), head=el('tr');
  for(const label of [say('公司','Company'),say('状态','Status'),say('悲观 / 基准 / 乐观','Bear / Base / Bull'),say('模型日期','Model date'),say('说明','Notes')]) head.appendChild(el('th','',label));
  table.appendChild(head);
  for(const co of fairCompanies()) {
    const a=fairAssessment(co), row=el('tr','rowc'), labels={ready:say('可用','Ready'),review:say('待复核','Review needed'),missing:say('待建模','Model needed'),invalid:say('模型无效','Invalid model')};
    row.appendChild(el('td','',co.ticker)); row.appendChild(el('td',a.status==='ready'?'':'neg',labels[a.status]));
    row.appendChild(el('td','',a.status==='ready'?[a.result.low,a.result.mid,a.result.high].map(fmtN).join(' / ')+' '+co.currency:'—'));
    row.appendChild(el('td','',a.model?.as_of||'—'));
    const notes=el('td','',a.reasons.join('；')||say('已通过已导入数据核验','Checked against imported data'));
    for(const rev of a.revisions)notes.appendChild(el('div',rev.to<rev.from?'neg':'',`${rev.period} EPS ${rev.from} → ${rev.to} (${rev.change===null?'—':fmtPct(rev.change*100)}) · ${rev.from_date} → ${rev.to_date}`));
    row.appendChild(notes);
    if(state.companies.has(co.ticker))row.addEventListener('click',()=>{state.selected=co.ticker;renderAll();$('fairDetail').scrollIntoView({behavior:'smooth'});}); table.appendChild(row);
  }
  const wrap=el('div');wrap.style.overflowX='auto';wrap.appendChild(table);panel.appendChild(wrap);
  panel.appendChild(el('p','hint',say('估值日（纽约）：','Valuation date (New York): ')+fairToday()+say('；最近导入：','; last import: ')+(state.fairImportedAt||'—')));
  panel.appendChild(el('p','hint',say('页面打开且已连接文件夹时，每60秒检查本地文件变化；这不等于 FactSet 实时订阅，关闭页面后不会继续监控。','While open with a connected folder, checks local file changes every 60 seconds. This is not a live FactSet subscription and stops when the page closes.')));
  const button=el('button','',say('导出每日／修订记录','Export daily / revision log'));button.addEventListener('click',exportFairLedger);panel.appendChild(button);
  if(fairLedgerError) panel.appendChild(el('p','neg',fairLedgerError));
}
function renderFairDetail(co) {
  const panel=$('fairDetail');panel.replaceChildren();
  const a=fairAssessment(co), say=(cn,en)=>LANG==='en'?en:cn;
  panel.appendChild(el('h3','',say('合理估值依据','Fair-value assumptions')));
  for(const o of a.observation.earnings)panel.appendChild(el('p','hint',`${o.period} EPS ${fmtN(o.mean)} ${o.currency||'—'} · ${o.basis} · ${o.date}`));
  if(!a.model) {panel.appendChild(el('p','hint',say('尚缺经核验的每股股东现金流、预测期、股权激励／稀释处理、折现率及稳定期假设。下方历史倍数仅供对照。','Verified per-share equity cash flows, timing, dilution, discount rate and terminal assumptions are missing. Historical multiples below are reference only.')));return;}
  panel.appendChild(el('p','hint',`${a.model.model_id} · ${a.model.source} · ${say('复核截止','Review due')} ${a.model.review_due}`));
  for(const key of ['equity_basis_note','normalization_note','cash_flow_timing_note'])panel.appendChild(el('p','hint',a.model[key]));
  for(const reason of a.reasons) panel.appendChild(el('p','neg',reason));
  if(a.result) {
    panel.appendChild(el('p','hint',say('模型基准 EPS 对应的隐含合理 PE：','Implied fair P/E at model baseline EPS: ')+fmtX(a.result.fairPE)+say('；待复核时以下仅是旧假设计算结果。','; when flagged, figures below reflect old assumptions only.')));
    const table=el('table','ov'),header=el('tr');
    for(const s of [say('情景','Scenario'),say('价值','Value'),say('股权折现率','Cost of equity'),say('永续增长','Terminal growth'),say('终值占比','Terminal share'),say('依据','Rationale')]) header.appendChild(el('th','',s));table.appendChild(header);
    for(const key of ['bear','base','bull']) {const s=a.model.scenarios[key],r=a.result.scenarios[key],row=el('tr');for(const v of [key,fmtN(r.value),fmtPct(s.cost_of_equity*100),fmtPct(s.terminal_growth*100),fmtPct(r.terminalShare*100),s.rationale]) row.appendChild(el('td','',v));table.appendChild(row);}
    panel.appendChild(table);
  }
  if(a.versions.length>1) {const prev=a.versions.at(-2),d=FairValue.attribution(prev,a.model,prev.as_of,a.model.as_of);if(d)panel.appendChild(el('p','hint',say('较前版（顺序替换分解）：时间 ','Versus prior version (ordered attribution): time ')+fmtN(d.time)+' / '+say('现金流 ','cash flows ')+fmtN(d.cashflow)+' / '+say('风险及增长 ','risk and growth ')+fmtN(d.riskAndGrowth)));}
}
