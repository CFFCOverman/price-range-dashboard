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
  $('pxInput').value = isFinite(co.price) ? co.price : '';
  renderHead(co);
  const r = calcRange(co, state.horizon);
  renderKpis(co, r);
  renderMatrix(co, r);
  renderBullet(co, r);
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
function partialRefresh() {
  const rows = overviewRows(); renderOvTable(rows); renderOvChart(rows);
  const co = state.companies.get(state.selected); if (!co) return;
  const r = calcRange(co, state.horizon);
  renderHead(co); renderKpis(co, r); renderMatrix(co, r); renderBullet(co, r); renderCompare(co, r); renderPressure(co, r); renderSim(co); renderDirection(co, r);
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
