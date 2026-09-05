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
  renderDecisionContext(co);
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
    if (pe && isFinite(pe.current)) tile(t('tPe'), fmtX(pe.current), t('histPct')(rankPct(pe.sorted, pe.current)), '');
    const ex = co.extra;
    if (ex && isFinite(ex.target)) {
      const d = isFinite(co.price) ? (ex.target / co.price - 1) * 100 : NaN;
      tile(t('tTgt'), fmtN(ex.target), (ex.rating ? ex.rating + ' · ' : '') + fmtPct(d) + t('vsPrice'), isFinite(d) && d >= 0 ? 'pos' : isFinite(d) ? 'neg' : '');
    }
  } else {
    const manual = !state.history.has(co.ticker) || (state.history.get(co.ticker) || []).length < 12;
    kp.appendChild(el('div', 'empty', manual && !peStats(co.ticker) ? t('needPct') : t('needEps')));
  }
}
function signalOutcomeSummary(rows, field) {
  // Non-overlapping observations per horizon; selection never uses outcomes.
  const gap=field==='future_1h_return'?90*60000:2*86400000;
  let last=-Infinity;const chosen=[];
  for(const r of rows){const stamp=Date.parse(r.timestamp);
    if(r.signal_version!=='2'||r.quality!=='usable'||!['bullish','bearish'].includes(r.direction)||stamp-last<gap)continue;
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
  const add=(label,value)=>panel.appendChild(el('p','hint',label+' '+value));
  panel.appendChild(el('h3','',say('现价隐含预期与观察条件','Implied expectations and observation conditions')));
  const x=impliedExpectations(co),pct=x=>x===null?'—':fmtPct(x*100);
  if(x){
    add(say('现价对应 PE：','Current-price PE:'),`FY1 ${x.fy1===null?'—':fmtX(x.fy1)} · FY2 ${x.fy2===null?'—':fmtX(x.fy2)}`);
    add(say('历史中位估值下所需 EPS：','EPS required at median valuation:'),`${x.required===null?'—':fmtN(x.required)} · ${say('相对 FY1 共识','vs FY1 consensus')} ${pct(x.gap)}`);
    add(say('盈利增长与修订：','Earnings growth and revisions:'),`FY2/FY1 ${pct(x.growth)} · ${say('FY1 约30日前至最新修订','FY1 revision from ~30d prior')} ${pct(x.revision)}`);
    add(say('估值观察：','Valuation observation:'),x.gap===null?say('盈利或估值不足，暂不判断。','Insufficient earnings or valuation data.'):
      x.gap>0?say('现价需要高于 FY1 共识的盈利，或高于历史中位数的估值支撑。','Price requires earnings above FY1 consensus or a multiple above the historical median.'):
      say('FY1 共识在中位估值下可覆盖现价；仍需观察盈利是否下修。','FY1 consensus supports price at the median multiple; monitor downward revisions.'));
    add(say('时点与口径：','Dates and basis:'),`${say('价格','Price')} ${co.priceDate||'—'} · EPS ${x.epsDate||'—'} · PE ${x.peDate||'—'} · ${say('固定财年/所导入历史，非严格滚动 NTM；手工覆盖改变假设。','Fixed fiscal year / imported history, not necessarily rolling NTM; overrides change assumptions.')}`);
  }
  const rows=state.optionSignals.get(co.ticker)||[],latest=rows.at(-1);
  panel.appendChild(el('h3','',say('期权方向 × 价格响应','Options direction × price response')));
  if(!latest){add('',say('尚无信号文件：连接 Assets 文件夹并重新扫描，读入 Options Signals.csv。','No signals: rescan Assets to import Options Signals.csv.'));return;}
  const stale=Date.now()-Date.parse(latest.timestamp)>2*3600000;
  const status=stale||latest.signal_version!=='2'?'watch':latest.condition_state||'watch';
  add(say('状态：','State:'),({watch:say('观察','Watch'),confirmed:say('条件成立：同向响应','Condition met: aligned response'),invalidated:say('判断失效：价格反向','Invalidated: opposing price')})[status]);
  add(say('数据时点：','Observation:'),`${latest.timestamp} · ${stale?say('历史记录，不能作当前触发','Historical observation, not a current trigger'):say('最近快照','Latest snapshot')}`);
  add('Net Delta Flow',`${latest.net_delta_shares} ${say('股','shares')} · ${latest.direction} · ${latest.quality}`);
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
