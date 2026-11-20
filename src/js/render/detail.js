/* ================= render: detail ================= */
function renderDetail() {
  const co = state.companies.get(state.selected);
  if (!co) { $('detCard').hidden = true; return; }
  $('detCard').hidden = false;
  const sel = $('coSel'); sel.replaceChildren();
  /* 下拉里也只列画得出来的那批 —— 表格里没有的公司出现在下拉里,是另一种"藏了但没藏干净" */
  for (const c of visibleCompanies()) {
    const o = el('option', '', c.name + ' (' + c.ticker + ')'); o.value = c.ticker;
    if (c.ticker === state.selected) o.selected = true;
    sel.appendChild(o);
  }
  for (const b of $('hzTabs').children) b.classList.toggle('on', b.dataset.h === state.horizon);
  const eps = epsFor(co.ticker, state.horizon) || {};
  $('epsLow').value = isFinite(eps.low) ? eps.low : '';
  $('epsMean').value = isFinite(eps.mean) ? eps.mean : '';
  $('epsHigh').value = isFinite(eps.high) ? eps.high : '';
  const pe = peStats(co.ticker);
  const manual = !state.history.has(co.ticker) || (state.history.get(co.ticker) || []).length < 12;
  $('peManualRow').hidden = !manual;
  if (manual) {
    const m = state.peManual.get(co.ticker) || {};
    $('peP25').value = isFinite(m.p25) ? m.p25 : '';
    $('peP50').value = isFinite(m.p50) ? m.p50 : '';
    $('peP75').value = isFinite(m.p75) ? m.p75 : '';
  }
  renderPeManualStatus(co.ticker);
  $('pxInput').value = isFinite(co.price) ? co.price : '';
  renderHead(co);
  const r = calcRange(co, state.horizon);
  renderKpis(co, r);
  renderMatrix(co, r);
  renderBullet(co, r);
  renderOptionsBehavior(co);
  renderCompare(co, r);
  renderPressure(co, r);
  renderSim(co);
  renderDirection(co, r);
  renderCandles(co);
  renderPEBand(co, pe);
}
const PRICE_DATE_KEYS = { '@snap': 'priceSnap', '@derived': 'priceDerived', '@manual': 'priceManual' };
function renderHead(co) {
  const head = $('detHead'); head.replaceChildren();
  head.appendChild(el('span', 'price', isFinite(co.price) ? fmtN(co.price) : t('priceWait')));
  const pd = PRICE_DATE_KEYS[co.priceDate] ? t(PRICE_DATE_KEYS[co.priceDate]) : co.priceDate;
  head.appendChild(el('span', 'cur', (co.currency || '—') + (pd ? ' · ' + pd : '') + ' · ' + co.name + ' ' + co.ticker));
}
function renderKpis(co, r) {
  renderFairDetail(co);
  renderLatestValuation(co);
  renderDecisionContext(co);
  renderValuationWindows(co);
  const pe = peStats(co.ticker);
  const kp = $('detKpis'); kp.replaceChildren();
  const tile = (lb, vl, dt, cls) => {
    const t = el('div', 'tile'); t.appendChild(el('div', 'lb', lb)); t.appendChild(el('div', 'vl', vl));
    if (dt) t.appendChild(el('div', 'dt ' + (cls || ''), dt));
    kp.appendChild(t);
  };
  if (r) {
    tile(t('tMid'), fmtN(r.mid), fmtPct(r.midPct) + t('vsPrice'), isFinite(r.midPct) && r.midPct >= 0 ? 'pos' : isFinite(r.midPct) ? 'neg' : '');
    tile(t('tCore'), fmtN(r.coreLow) + ' ~ ' + fmtN(r.coreHigh), fmtPct(r.downPct) + ' ~ ' + fmtPct(r.upPct), '');
    if (isFinite(r.extLow)) tile(t('tExt'), fmtN(r.extLow) + ' ~ ' + fmtN(r.extHigh), fmtPct((r.extLow / co.price - 1) * 100) + ' ~ ' + fmtPct((r.extHigh / co.price - 1) * 100), '');
    if (pe && isFinite(pe.current)) tile(LANG === 'en' ? 'Last historical P/E' : '历史文件末点 PE', fmtX(pe.current), t('histPct')(rankPct(pe.sorted, pe.current)), '');
    const ex = co.extra;
    if (ex && isFinite(ex.target)) {
      const d = isFinite(co.price) ? (ex.target / co.price - 1) * 100 : NaN;
      tile(t('tTgt'), fmtN(ex.target), (ex.rating ? ex.rating + ' · ' : '') + fmtPct(d) + t('vsPrice'), isFinite(d) && d >= 0 ? 'pos' : isFinite(d) ? 'neg' : '');
    }
  } else {
    const manual = !state.history.has(co.ticker) || (state.history.get(co.ticker) || []).length < 12;
    kp.appendChild(el('div', 'empty', state.horizon === 'ntm' ? noRangeReason(co, state.horizon) : manual && !peStats(co.ticker) ? t('needPct') : t('needEps')));
  }
}
function renderLatestValuation(co) {
  const panel = $('latestValuation'); panel.replaceChildren();
  const say = (cn, en) => LANG === 'en' ? en : cn;
  const x = latestValuation(co), point = x.point;
  const pct = v => v === null || v === undefined ? '—' : fmtPct(v * 100);
  const add = text => panel.appendChild(el('p', 'hint', text));
  panel.appendChild(el('h3', '', say('最新 PE 与盈利变化', 'Latest P/E and earnings changes')));
  panel.appendChild(el('strong', '', say('当前 NTM PE：', 'Current NTM P/E: ') + (x.current === null ? '—' : fmtX(x.current))));
  const priceDate = PRICE_DATE_KEYS[co.priceDate] ? t(PRICE_DATE_KEYS[co.priceDate]) : co.priceDate || '—';
  add(`${say('当前价格', 'Current price')} ${fmtN(co.price)} ÷ NTM EPS ${fmtN(point?.mean)} · ${say('价格日', 'Price date')} ${priceDate} · ${say('盈利日', 'EPS date')} ${point?.date || '—'}`);
  add(say('本栏只使用原始 NTM 共识，手工情景不改变这里的当前 PE。', 'This panel uses imported NTM consensus; manual scenarios do not change current P/E.'));
  if (point?.retrievedAt) add(say('数据取得时间：', 'Retrieved: ') + point.retrievedAt);
  if (x.current === null) add(say('缺少有效价格或 NTM 盈利非正／缺失，不能计算 PE；不会退回 FY1 或旧正盈利。', 'Price or positive NTM EPS unavailable; no FY1 or old positive earnings substitution.'));
  if (x.change !== null) {
    add(`${say('相对历史观测', 'Versus historical observation')} ${x.prior.date}：PE ${pct(x.change)} · ${say('价格', 'Price')} ${pct(x.priceChange)} · NTM EPS ${pct(x.epsChange)}`);
    add(`${say('先只更新价格', 'Update price first')}：${fmtX(x.prior.pe)} → ${fmtX(x.priceOnly)}；${say('再更新盈利', 'then earnings')}：${fmtX(x.priceOnly)} → ${fmtX(x.current)} (${pct(x.earningsEffect)})`);
  }
  add(say('比较按上方实际日期进行，不称作日变化。NTM 盈利变化包含时间滚动，不能全部解释成分析师上调／下调。', 'Changes span the dates shown, not necessarily one day. NTM earnings changes include time roll and are not pure analyst revisions.'));
  for (const hz of ['fy1', 'fy2']) {
    const m = co.estimateMeta?.[hz];
    add(`${hz.toUpperCase()} ${say('固定财年盈利修订', 'fixed-fiscal-year earnings revision')}：${FY_LABEL.exec(m?.label || '')?.[0] || '—'} · ${m?.previousDate || '—'} → ${m?.date || '—'} · EPS ${fmtN(m?.previousMean)} → ${fmtN(m?.latestMean)} (${pct(m?.recentRevision)})`);
  }
  add(say('价格下跌会降低 PE，盈利下修会抬高 PE；当前 PE 不是合理目标倍数。数据延迟取决于 FactSet 更新及本地拉取、扫描时间。', 'A price drop lowers P/E; an earnings cut raises it. Current P/E is not a fair-value target multiple. Latency depends on FactSet, fetching and folder rescanning.'));
}
function renderValuationWindows(co) {
  const panel = $('valuationWindows'); panel.replaceChildren();
  const say = (cn, en) => LANG === 'en' ? en : cn;
  const ntm = state.horizon === 'ntm', manual = state.overrides.has(co.ticker + '|' + state.horizon);
  const point = state.ntmEstimates.get(co.ticker);
  const meta = co.estimateMeta?.[state.horizon];
  const eps = epsFor(co.ticker, state.horizon);
  panel.appendChild(el('h3', '', say('历史窗口对照 · 同一盈利假设', 'History windows · same earnings assumption')));
  panel.appendChild(el('p', 'hint', `${state.horizon.toUpperCase()} EPS ${fmtN(eps?.mean)} · ${say('盈利数据日', 'EPS date')} ${manual ? say('手工假设', 'Manual assumption') : (ntm ? point?.date : meta?.date) || '—'} · ${say('价格日', 'Price date')} ${PRICE_DATE_KEYS[co.priceDate] ? t(PRICE_DATE_KEYS[co.priceDate]) : co.priceDate || '—'}`));
  panel.appendChild(el('p', 'hint', manual
    ? say('已手工修改盈利；下面各窗口均使用当前自设 EPS 情景。', 'Earnings overridden; all windows use the current manual EPS scenarios.')
    : ntm
      ? say('来源：NTM 历史文件最新 EPS。当前仅有平均预测，没有 NTM 悲观／乐观预测；上下沿均使用同一个 EPS，只改变 PE。缺失时不使用 FY1 补齐。', 'Source: latest EPS in the NTM history file. Only mean EPS is available; both endpoints use that same EPS and vary P/E only. Missing NTM EPS is never filled with FY1.')
      : say('财年情景：将历史倍数应用于指定财年的盈利，并非未来十二个月估值。', 'Fiscal scenario: historical multiples applied to the selected fiscal year, not a next-12-month valuation.')));
  if (ntm && point?.date && co.priceDate && /^\d{4}-/.test(co.priceDate) && point.date !== co.priceDate)
    panel.appendChild(el('p', 'hint', say('价格与盈利快照日期不同；这里使用最新已导入数据，并非实时预测。', 'Price and earnings snapshots have different dates; these are the latest imported data, not live estimates.')));
  const table = el('table', 'ov'), head = el('tr');
  for (const label of [say('窗口', 'Window'), say('实际样本', 'Actual coverage'), 'PE P25 / P50 / P75', say('下沿 / 中枢 / 上沿', 'Low / Mid / High'), say('中枢空间', 'Mid vs price')]) head.appendChild(el('th', '', label));
  table.appendChild(head);
  for (const years of [3, 5, 10]) {
    const pe = peStats(co.ticker, years), r = calcRange(co, state.horizon, years), row = el('tr', years === state.peYears ? 'sel' : '');
    const h = pe?.series;
    const coverage = pe?.src === 'manual' ? say('手工倍数（不随窗口变化）', 'Manual multiples (unchanged across windows)')
      : h ? `${peBasisLabel(pe)} · ${h[0].date} ~ ${h.at(-1).date} · ${h.length}${say('点', ' observations')}` : say('不足12个有效点', 'Fewer than 12 usable points');
    for (const value of [`${years}${say('年', 'y')}`, coverage, pe ? ['p25','p50','p75'].map(k=>fmtX(pe[k])).join(' / ') : '—', r ? [r.coreLow,r.mid,r.coreHigh].map(v=>fmtN(v)).join(' / ') : '—', r ? fmtPct(r.midPct) : '—']) row.appendChild(el('td', '', value));
    table.appendChild(row);
  }
  const wrap = el('div'); wrap.style.overflowX = 'auto'; wrap.appendChild(table); panel.appendChild(wrap);
  panel.appendChild(el('p', 'hint', say('窗口按历史文件最新日期回看，实际覆盖可能短于所选年数。历史分位不是目标价保证，也不代表股价落在区间内的概率。', 'Windows look back from the latest history date; coverage may be shorter than requested. Percentiles are conditional references, not guaranteed targets or price probabilities.')));
}
function signalOutcomeSummary(rows, field) {
  // Non-overlapping observations per horizon; selection never uses outcomes.
  const gap=field==='future_1h_return'?90*60000:2*86400000;
  let last=-Infinity;const chosen=[];
  for(const r of rows){const stamp=Date.parse(r.timestamp);
    if(r.signal_version!=='3'||r.quality!=='usable'||!['bullish','bearish'].includes(r.direction)||stamp-last<gap)continue;
    last=stamp;chosen.push(r);
  }
  const matured=chosen.filter(r=>r[field]!==''&&r[field]!=null&&isFinite(+r[field]));
  const n=matured.length;
  return {n,pending:chosen.length-n,hit:n?matured.filter(r=>(r.direction==='bullish'?1:-1)*+r[field]>0).length/n:null,
    longHit:n?matured.filter(r=>+r[field]>0).length/n:null,
    momentumN:matured.filter(r=>r.interval_price_return!==''&&r.interval_price_return!=null&&+r.interval_price_return!==0).length,
    momentumHit:(()=>{const a=matured.filter(r=>r.interval_price_return!==''&&r.interval_price_return!=null&&+r.interval_price_return!==0);return a.length?a.filter(r=>Math.sign(+r.interval_price_return)*+r[field]>0).length/a.length:null})(),
    mean:n?matured.reduce((s,r)=>s+(r.direction==='bullish'?1:-1)*+r[field],0)/n:null};
}
function renderDecisionContext(co) {
  let panel=$('decisionContext');
  if(!panel){panel=el('section','');panel.id='decisionContext';$('detKpis').insertAdjacentElement('afterend',panel);}
  panel.replaceChildren();
  const en=LANG==='en',say=(cn,eng)=>en?eng:cn;
  const basis=state.horizon.toUpperCase();
  const add=(label,value)=>panel.appendChild(el('p','hint',label+' '+value));
  panel.appendChild(el('h3','',say('现价隐含预期与观察条件','Implied expectations and observation conditions')));
  const x=impliedExpectations(co),pct=x=>x===null?'—':fmtPct(x*100);
  if(x){
    add(say('现价对应 PE：','Current-price PE:'),`FY1 ${x.fy1===null?'—':fmtX(x.fy1)} · FY2 ${x.fy2===null?'—':fmtX(x.fy2)}`);
    add(say('历史中位估值下所需 EPS：','EPS required at median valuation:'),`${x.required===null?'—':fmtN(x.required)} · ${say('相对当前盈利假设','vs selected earnings assumption')} (${basis}) ${pct(x.gap)}`);
    add(say('盈利增长与修订：','Earnings growth and revisions:'),`FY2/FY1 ${pct(x.growth)} · ${say('FY1 约30日前至最新修订','FY1 revision from ~30d prior')} ${pct(x.revision)}`);
    add(say('估值观察：','Valuation observation:'),x.gap===null?say('盈利或估值不足，暂不判断。','Insufficient earnings or valuation data.'):
      x.gap>0?say('现价需要高于当前盈利假设的盈利，或高于历史中位数的估值支撑。','Price requires earnings above the selected assumption or a multiple above the historical median.'):
      say('当前盈利假设在中位估值下可覆盖现价；仍需观察盈利是否下修。','Selected earnings support price at the median multiple; monitor downward revisions.'));
    add(say('时点与口径：','Dates and basis:'),`${say('价格','Price')} ${co.priceDate||'—'} · ${basis} EPS ${state.overrides.has(co.ticker+'|'+state.horizon)?say('手工','Manual'):x.epsDate||'—'} · PE ${x.peDate||'—'} · ${peBasisLabel(peStats(co.ticker))}`);
  }
  const rows=state.optionSignals.get(co.ticker)||[],latest=rows.at(-1);
  panel.appendChild(el('h3','',say('期权方向 × 价格响应','Options direction × price response')));
  if(!latest){add('',say('尚无信号文件：连接 Assets 文件夹并重新扫描，读入 Options Signals.csv。','No signals: rescan Assets to import Options Signals.csv.'));return;}
  const stale=Date.now()-Date.parse(latest.timestamp)>2*3600000;
  const status=stale||latest.signal_version!=='3'?'watch':latest.condition_state||'watch';
  add(say('状态：','State:'),({watch:say('观察','Watch'),confirmed:say('条件成立：同向响应','Condition met: aligned response'),invalidated:say('判断失效：价格反向','Invalidated: opposing price')})[status]);
  add(say('数据时点：','Observation:'),`${latest.timestamp} · ${stale?say('历史记录，不能作当前触发','Historical observation, not a current trigger'):say('最近快照','Latest snapshot')}`);
  add('Net Delta Flow',`${latest.net_delta_shares} ${say('股','shares')} · ${latest.direction} · ${latest.quality}`);
  add(say('计算范围：','Scope:'),`${latest.sampled_rows||'—'} ${say('行；匹配','rows; matched')} ${latest.matched_rows||'—'} · ${latest.expiry_count||'—'} ${say('个到期日','expiries')} (${latest.expiry_from||'—'} → ${latest.expiry_to||'—'})`);
  add(say('质量与排除：','Quality and exclusions:'),`${say('匹配覆盖','match coverage')} ${latest.match_coverage==null||latest.match_coverage===''?'—':pct(+latest.match_coverage)} · ${say('有效成交覆盖','usable volume coverage')} ${latest.usable_coverage==null||latest.usable_coverage===''?'—':pct(+latest.usable_coverage)} · Spread ${latest.spread_suspect_contracts||0} · ${say('无法分类','unclassified')} ${latest.unclassified_contracts??'—'} · ${say('缺失/无效Delta','missing/invalid delta')} ${latest.missing_delta_contracts??'—'}`);
  add('',say('匹配覆盖低于80%或有效成交覆盖低于35%不输出可用方向。标准合约乘数暂按100；调整合约尚未支持。所有合约仅指采集范围，Spread识别为启发式。','Direction withheld below 80% match or 35% usable-volume coverage. Standard multiplier assumed 100; adjusted contracts unsupported. Scope is sampled contracts only; spread detection is heuristic.'));
  add(say('区间价格变化：','Interval price return:'),latest.interval_price_return===''||latest.interval_price_return==null?'—':pct(+latest.interval_price_return));
  add(say('预设条件：','Rule:'),say('可用方向代理且价格同向变化至少 0.10% → 条件成立；反向至少 0.10% → 判断失效；其余观察。阈值为待验证规则，不是买卖指令。','Usable directional proxy and aligned price move ≥0.10%: condition met; opposing move ≥0.10%: invalidated; otherwise watch. Experimental rule, not an order.'));
  for(const [field,label] of [['future_1h_return','1h'],['future_1d_return','1d']]){
    const s=signalOutcomeSummary(rows,field);
    add(label+say(' 后续验证：',' forward validation:'),`${s.n} ${say('成熟样本','mature samples')} / ${s.pending} ${say('待观察','pending')} · ${say('方向命中','direction hit')} ${pct(s.hit)} · ${say('同期只看上涨基线','always-up baseline')} ${pct(s.longHit)} · ${say('有符号平均收益','signed mean return')} ${pct(s.mean)}`);
    add('',`${say('只看本区间价格方向的基线','Price-direction-only baseline')}: ${pct(s.momentumHit)} (${s.momentumN})`);
  }
  add('',say('同一时段价格响应不是预测结果。1h 为至少60分钟后的首个可用点（最多90分钟）；1d 为下一交易日相近时刻。样本隔离仍不等于统计有效，未计交易成本。','Contemporaneous response is not prediction. 1h uses the first point 60–90 minutes later; 1d uses a similar time next session. Spacing observations does not establish significance; costs excluded.'));
}
function partialRefresh() {
  const rows = overviewRows(); renderOvTable(rows); renderOvChart(rows);
  const co = state.companies.get(state.selected); if (!co) return;
  const r = calcRange(co, state.horizon);
  renderHead(co); renderKpis(co, r); renderMatrix(co, r); renderBullet(co, r); renderOptionsBehavior(co); renderCompare(co, r); renderPressure(co, r); renderSim(co); scheduleDirection(co, r);
}
function renderPeManualStatus(ticker) {
  const msg = $('peManualError'); if (!msg) return;
  const m = state.peManual.get(ticker);
  const complete = m && isFinite(m.p25) && isFinite(m.p50) && isFinite(m.p75);
  msg.hidden = !complete || peManualValid(m);
  msg.textContent = msg.hidden ? '' : t('peOrderError');
  for (const id of ['peP25', 'peP50', 'peP75']) $(id).setAttribute('aria-invalid', msg.hidden ? 'false' : 'true');
}
function renderMatrix(co, r) {
  const wrap = $('mxWrap'); wrap.replaceChildren();
  if (!r) { wrap.appendChild(el('div', 'empty', '—')); return; }
  const pe = r.pe, eps = r.eps;
  /* 只显示为正的分位:负 P/E 乘出来的"价格"没有意义(与 calcRange 同一把尺子) */
  const cols = [['p10', 'PE P10'], ['p25', 'PE P25'], ['p50', t('mxMedian')], ['p75', 'PE P75'], ['p90', 'PE P90']]
    .filter(([k]) => pePos(pe, k));
  /* 行序沿用"乐观在上",但 EPS 取的是 calcRange 清洗后的同一份情景 */
  const rows = [['opt', t('mxOpt'), eps.high], ['base', t('mxBase'), eps.mean], ['pes', t('mxPes'), eps.low]];
  const rowMap = Object.fromEntries(rows.map(x => [x[0], x]));
  const colMap = Object.fromEntries(cols.map(x => [x[0], x]));
  if (!rowMap[state.mxPick.eps]) state.mxPick.eps = 'base';
  if (!colMap[state.mxPick.pe]) state.mxPick.pe = cols.some(x => x[0] === 'p50') ? 'p50' : cols[0][0];

  /* 先回答“什么情景会让数字变”：两个下拉分别只动盈利或估值，结果与下方被高亮格完全同源。 */
  const ctl = el('div', 'mxControls');
  const makeSelect = (label, values, picked, onChange) => {
    const box = el('label', 'mxControl'); box.appendChild(el('span', 'lb', label));
    const sel = el('select');
    for (const [value, text] of values) {
      const o = el('option', '', text); o.value = value; o.selected = value === picked; sel.appendChild(o);
    }
    sel.addEventListener('change', ev => {
      onChange(ev.target.value);
      renderMatrix(co, calcRange(co, state.horizon));
      renderCandles(co); // Matrix 所选隐含价也是走势图的一条估值参考；选择变化必须同屏更新。
    });
    box.appendChild(sel); ctl.appendChild(box);
  };
  makeSelect(t('mxEpsPick'), rows.map(([k, lb, v]) => [k, lb + fmtN(v)]), state.mxPick.eps, v => { state.mxPick.eps = v; });
  makeSelect(t('mxPePick'), cols.map(([k, lb]) => [k, lb + ' ' + fmtX(pe[k])]), state.mxPick.pe, v => { state.mxPick.pe = v; });
  const pickedValue = rowMap[state.mxPick.eps][2] * pe[state.mxPick.pe];
  const pickedPct = (pickedValue / co.price - 1) * 100;
  const out = el('div', 'mxResult ' + (pickedPct >= 0 ? 'pos' : 'neg'));
  out.appendChild(el('span', 'lb', t('mxPicked')));
  out.appendChild(el('strong', '', fmtN(pickedValue)));
  out.appendChild(el('span', 'sub', fmtPct(pickedPct) + t('vsPrice')));
  ctl.appendChild(out); wrap.appendChild(ctl);
  /* 核心区间就是矩阵里的两个角:悲观×P25 = 核心下沿,乐观×P75 = 核心上沿。标出来,读者一眼看到两处同源 */
  const isCore = (rk, k) => (rk === 'pes' && k === 'p25') || (rk === 'opt' && k === 'p75');
  const tb = el('table', 'mx'), trh = el('tr');
  trh.appendChild(el('th', '', t('mxCorner')));
  for (const [k, lb] of cols) trh.appendChild(el('th', '', lb + ' ' + fmtX(pe[k])));
  tb.appendChild(trh);
  for (const [rk, lb, e] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', '', lb + fmtN(e)));
    for (const [k] of cols) {
      const v = e * pe[k], d = (v / co.price - 1) * 100;
      const td = el('td', k === 'p50' ? 'med' : '');
      if (rk === state.mxPick.eps && k === state.mxPick.pe) td.classList.add('picked');
      if (rk === 'base' && k === 'p50') td.classList.add('base');
      if (isCore(rk, k)) { td.classList.add('core'); td.title = t('mxCoreTip'); }
      td.appendChild(document.createTextNode(fmtN(v)));
      td.appendChild(el('span', 'sub ' + (isFinite(d) ? (d >= 0 ? 'pos' : 'neg') : ''), fmtPct(d)));
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  wrap.appendChild(tb);
  const legend = el('p', 'hint');
  legend.appendChild(el('span', 'mxKey base', ''));
  legend.appendChild(document.createTextNode(' ' + t('mxLegBase') + '   '));
  legend.appendChild(el('span', 'mxKey core', ''));
  legend.appendChild(document.createTextNode(' ' + t('mxLegCore')));
  wrap.appendChild(legend);
  /* 数据可疑时明说,不悄悄替换 */
  if (r.baseGap) wrap.appendChild(el('p', 'hint warn', t('mxBaseGap')(r.baseGap.implied, r.baseGap.dev)));
  for (const fl of (r.flags || [])) wrap.appendChild(el('p', 'hint warn', t('mxFlag')[fl] || fl));
  wrap.appendChild(el('p', 'hint', t('mxUnit')(co.currency || '—')));
}
function renderBullet(co, r) {
  const box = $('bulletChart'); box.replaceChildren();
  if (!r) return;
  const W = 560, H = 118, L = 14, R = 14, yc = 56;
  const cand = [r.coreLow, r.coreHigh, r.extLow, r.extHigh, co.price].filter(isFinite);
  const lo0 = Math.min(...cand), hi0 = Math.max(...cand);
  const span = (hi0 - lo0) || 1, mn = lo0 - span * .08, mx = hi0 + span * .08;
  const x = v => L + (v - mn) / (mx - mn) * (W - L - R);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '价格区间与现价位置' });
  svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: yc, y2: yc, stroke: 'var(--grid)', 'stroke-width': 1 }));
  if (isFinite(r.extLow)) {
    svg.appendChild(svgEl('rect', { x: x(r.extLow), y: yc - 11, width: x(r.extHigh) - x(r.extLow), height: 22, rx: 4, fill: 'var(--wash)' }));
    svg.appendChild(svgEl('text', { x: x(r.extLow), y: yc + 34, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' }, fmtN(r.extLow)));
    svg.appendChild(svgEl('text', { x: x(r.extHigh), y: yc + 34, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' }, fmtN(r.extHigh)));
  }
  svg.appendChild(svgEl('rect', { x: x(r.coreLow), y: yc - 11, width: Math.max(2, x(r.coreHigh) - x(r.coreLow)), height: 22, rx: 4, fill: 'var(--wash-strong)' }));
  svg.appendChild(svgEl('text', { x: x(r.coreLow), y: yc - 18, 'text-anchor': 'middle', 'font-size': 11.5, fill: 'var(--text-secondary)' }, fmtN(r.coreLow)));
  svg.appendChild(svgEl('text', { x: x(r.coreHigh), y: yc - 18, 'text-anchor': 'middle', 'font-size': 11.5, fill: 'var(--text-secondary)' }, fmtN(r.coreHigh)));
  svg.appendChild(svgEl('line', { x1: x(r.mid), x2: x(r.mid), y1: yc - 14, y2: yc + 14, stroke: 'var(--series-1)', 'stroke-width': 2.5 }));
  svg.appendChild(svgEl('text', { x: x(r.mid), y: yc - 18, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 650, fill: 'var(--text-primary)' }, t('blMid') + fmtN(r.mid)));
  if (isFinite(co.price)) {
    svg.appendChild(svgEl('circle', { cx: x(co.price), cy: yc, r: 6, fill: 'var(--series-2)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    svg.appendChild(svgEl('text', { x: x(co.price), y: yc + 34, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 650, fill: 'var(--text-primary)' }, t('blPrice') + fmtN(co.price)));
  }
  box.appendChild(svg);
}
