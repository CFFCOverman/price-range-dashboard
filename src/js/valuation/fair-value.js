/* Pure, shared FCFE model. Market price never enters intrinsic value.
 * Cash flows are per CURRENT diluted share, after reinvestment/financing and
 * future dilution. Equity cash flows are discounted at cost of equity; no
 * second net-debt deduction. Scenario bounds are not confidence intervals. */
const FairValue = (() => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0,10) === s;
  const years = (a,b) => (Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z')) / (365.25*86400000);
  const text = v => typeof v === 'string' && v.trim().length > 0;
  function validate(model) {
    const errors=[];
    if (!model || model.schema !== 'fcfe-v1') return ['需要 fcfe-v1 模型'];
    for (const key of ['ticker','currency','model_id','source','equity_basis_note','normalization_note','cash_flow_timing_note'])
      if (!text(model[key])) errors.push('缺少 '+key);
    if (!date(model.as_of) || !date(model.review_due) || model.review_due < model.as_of) errors.push('模型日期／复核截止日无效');
    if (model.status !== 'reviewed') errors.push('现金流假设尚未复核');
    if (!text(model.reviewed_at) || !Number.isFinite(Date.parse(model.reviewed_at)) || model.reviewed_at.slice(0,10)<model.as_of) errors.push('缺少模型复核时间');
    if (!(finite(model.eps_ntm) && model.eps_ntm>0) || !date(model.eps_date) || model.eps_date>model.as_of) errors.push('缺少同口径的模型基准 NTM EPS／日期');
    if (!Number.isInteger(model.max_data_age_days) || model.max_data_age_days<0 || model.max_data_age_days>7) errors.push('数据有效期须明确为 0–7 个日历日');
    if (model.reviewed_event_ids!==undefined && (!Array.isArray(model.reviewed_event_ids) || model.reviewed_event_ids.some(id=>!text(id)))) errors.push('已复核事件列表无效');
    if (!Array.isArray(model.earnings_checks) || !model.earnings_checks.length) errors.push('缺少固定财年盈利修订基准');
    for (const check of Array.isArray(model.earnings_checks) ? model.earnings_checks : []) {
      if (!check || !/^\d{4}-(0[1-9]|1[0-2])$/.test(check.period) || !text(check.basis) || !finite(check.mean) || !date(check.date) || check.date > model.as_of) errors.push('盈利修订基准无效');
    }
    for (const name of ['bear','base','bull']) {
      const s=model.scenarios?.[name];
      if (!s) { errors.push('缺少 '+name+' 情景'); continue; }
      if (!text(s.rationale)) errors.push(name+' 缺少情景依据');
      if (!(finite(s.cost_of_equity) && s.cost_of_equity>0 && s.cost_of_equity<1)) errors.push(name+' 股权折现率无效');
      if (!(finite(s.terminal_growth) && s.terminal_growth>=0 && s.terminal_growth<s.cost_of_equity)) errors.push(name+' 永续增长率必须低于股权折现率');
      if (!(finite(s.terminal_fcfe_next) && s.terminal_fcfe_next>0)) errors.push(name+' 缺少正的稳定期下一年 FCFE');
      if (!Array.isArray(s.cashflows) || s.cashflows.length<2) { errors.push(name+' 至少需要两期明确预测'); continue; }
      let previous=model.as_of;
      for (const cf of s.cashflows) {
        if (!cf) { errors.push(name+' 现金流记录无效'); continue; }
        if (!date(cf.date) || cf.date<=previous || !finite(cf.fcfe_per_share) || !text(cf.source)) errors.push(name+' 现金流日期／数值／来源无效');
        previous=cf.date;
      }
    }
    return errors;
  }
  function scenario(s, asOf) {
    const discounted=s.cashflows.map(cf=>({...cf,years:years(asOf,cf.date),pv:cf.fcfe_per_share/(1+s.cost_of_equity)**years(asOf,cf.date)}));
    const explicit=discounted.reduce((a,cf)=>a+cf.pv,0);
    const terminal=s.terminal_fcfe_next/(s.cost_of_equity-s.terminal_growth)/(1+s.cost_of_equity)**discounted.at(-1).years;
    const value=explicit+terminal;
    return {value,explicit,terminal,terminalShare:value>0?terminal/value:null,discounted};
  }
  function calculate(model, asOf) {
    const errors=validate(model);
    if (!date(asOf)) errors.push('估值日期无效');
    if (date(asOf) && model && asOf<model.as_of) errors.push('不得在模型信息可得日前估值');
    if (errors.length) return {ok:false,errors};
    if (['bear','base','bull'].some(k=>model.scenarios[k].cashflows.some(cf=>cf.date<=asOf))) return {ok:false,errors:['预测现金流日期已过，需要滚动模型后重估']};
    const results=Object.fromEntries(['bear','base','bull'].map(k=>[k,scenario(model.scenarios[k],asOf)]));
    const values=['bear','base','bull'].map(k=>results[k].value);
    if (!values.every(v=>finite(v)&&v>0) || values[0]>values[1] || values[1]>values[2]) return {ok:false,errors:['情景估值非正或顺序不一致；不能自动交换掩盖输入问题']};
    return {ok:true,asOf,scenarios:results,low:values[0],mid:values[1],high:values[2],fairPE:values[1]/model.eps_ntm};
  }
  function assess(model, observation) {
    const reasons=[],asOf=observation.asOf;
    if (!model) return {status:'missing',reasons:['尚无已复核的现金流、稀释和折现率模型'],result:null};
    const result=calculate(model,asOf);
    if (!result.ok) return {status:'invalid',reasons:result.errors,result:null};
    if (model.currency !== observation.currency) reasons.push('价格与模型币种不一致');
    if (asOf>model.review_due) reasons.push('已超过模型复核截止日');
    if (!date(observation.checkedOn) || observation.checkedOn>asOf || years(observation.checkedOn,asOf)*365.25>model.max_data_age_days) reasons.push('缺少有效期内的数据核验记录');
    for (const check of model.earnings_checks) {
      const now=observation.earnings?.find(e=>e.period===check.period);
      if (!now || !finite(now.mean) || !date(now.date) || now.date<check.date || now.date>asOf || years(now.date,asOf)*365.25>model.max_data_age_days) reasons.push(check.period+' 缺少足够新的同财年盈利核验');
      else if (Math.abs(now.mean-check.mean)>1e-8*Math.max(1,Math.abs(check.mean))) reasons.push(check.period+' 盈利已从 '+check.mean+' 更新到 '+now.mean+'，现金流假设待复核');
    }
    for (const event of observation.events || []) {
      if (event.ticker===model.ticker && event.requires_review && !(model.reviewed_event_ids||[]).includes(event.id)) reasons.push('未处理事件：'+event.title);
    }
    return {status:reasons.length?'review':'ready',reasons,result};
  }
  // Ordered replacement attribution; no causal claim. Timing is separated
  // from new cash-flow and discount/terminal assumptions.
  function attribution(oldModel,newModel,oldDate,newDate) {
    const old=calculate(oldModel,oldDate),rolled=calculate(oldModel,newDate),next=calculate(newModel,newDate);
    if (!old.ok||!rolled.ok||!next.ok||oldModel.ticker!==newModel.ticker||oldModel.currency!==newModel.currency) return null;
    if (JSON.stringify(oldModel.scenarios.base.cashflows.map(c=>c.date))!==JSON.stringify(newModel.scenarios.base.cashflows.map(c=>c.date))) return null;
    const mixed={...oldModel.scenarios.base,cashflows:newModel.scenarios.base.cashflows,terminal_fcfe_next:newModel.scenarios.base.terminal_fcfe_next};
    const cash=scenario(mixed,newDate).value;
    return {time:rolled.mid-old.mid,cashflow:cash-rolled.mid,riskAndGrowth:next.mid-cash,total:next.mid-old.mid};
  }
  return {validate,calculate,assess,attribution};
})();
