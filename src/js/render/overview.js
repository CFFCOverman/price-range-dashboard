/* ================= render: overview ================= */
function overviewRows() {
  const rows = [];
  /* 不是 state.companies.values() —— 不在拉取清单里的公司数据照常载入,只是默认不画。见 ingest/roster.js */
  for (const co of visibleCompanies()) {
    const r = calcRange(co, state.horizon);
    rows.push({ co, r });
  }
  const k = state.sortKey, d = state.sortDir;
  rows.sort((a, b) => {
    if (k === 'name') return d * a.co.name.localeCompare(b.co.name, 'zh');
    const value = row => k === 'price' ? row.co.price : k === 'currentPE' ? latestValuation(row.co).current ?? -Infinity : row.r?.[k] ?? -Infinity;
    let va = value(a), vb = value(b);
    if (!isFinite(va)) va = -Infinity;
    if (!isFinite(vb)) vb = -Infinity;
    return d * (va - vb);
  });
  return rows;
}
const OV_COLS = [
  ['name', 'colCompany'], ['price', 'colPrice'], ['currentPE', 'colCurrentPE'], ['downPct', 'colLow'], ['upPct', 'colHigh'],
  ['midPct', 'colMid'], ['pos', 'colPos'],
];
function renderOvTable(rows) {
  $('valuationBasis').value = state.horizon;
  $('peWindow').value = state.peYears;
  $('valuationMethod').textContent = LANG === 'en'
    ? `${state.horizon.toUpperCase()} × ${state.peYears}y historical P/E. NTM uses the same mean EPS at P25/P50/P75 unless manually overridden; FY1/FY2 use fiscal EPS scenarios. These are conditional ranges, not probability intervals. Click a company for dates and 3/5/10y comparison.`
    : `${state.horizon === 'ntm' ? '未来十二个月 NTM' : state.horizon.toUpperCase() + ' 财年情景'} × 近${state.peYears}年历史 PE。NTM 默认用同一平均 EPS 乘 PE 第25／50／75分位，只反映倍数变化；手工修改 EPS 后为自设情景。FY1／FY2 使用财年盈利上下限。区间不代表概率；点击公司查看日期和3／5／10年对照。`;
  const wrap = $('ovTableWrap'); wrap.replaceChildren();
  const tb = el('table', 'ov'), thead = el('thead'), trh = el('tr');
  for (const [key, labelKey] of OV_COLS) {
    const th = el('th', state.sortKey === key ? 'sorted' : '', t(labelKey) + (state.sortKey === key ? (state.sortDir < 0 ? ' ↓' : ' ↑') : ''));
    if (key !== 'pos') th.addEventListener('click', () => {
      if (state.sortKey === key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = key === 'name' ? 1 : -1; }
      renderAll();
    });
    trh.appendChild(th);
  }
  thead.appendChild(trh); tb.appendChild(thead);
  const tbody = el('tbody');
  for (const { co, r } of rows) {
    const tr = el('tr', 'rowc' + (state.selected === co.ticker ? ' sel' : ''));
    const td0 = el('td'); td0.appendChild(el('span', 'nm', co.name)); td0.appendChild(el('span', 'tk', co.ticker));
    tr.appendChild(td0);
    tr.appendChild(el('td', '', fmtN(co.price)));
    const latest = latestValuation(co), peCell = el('td', '', latest.current === null ? '—' : fmtX(latest.current));
    peCell.title = (LANG === 'en' ? 'Price date / NTM EPS date: ' : '价格日 / NTM EPS 日：') + (co.priceDate || '—') + ' / ' + (latest.point?.date || '—');
    tr.appendChild(peCell);
    if (r) {
      const pc = v => isFinite(v) ? (v >= 0 ? 'pos' : 'neg') : '';
      const cLow = el('td', pc(r.downPct), fmtN(r.coreLow) + ' (' + fmtPct(r.downPct) + ')');
      const cHigh = el('td', pc(r.upPct), fmtN(r.coreHigh) + ' (' + fmtPct(r.upPct) + ')');
      const cMid = el('td', pc(r.midPct), fmtPct(r.midPct));
      cMid.style.fontWeight = '650';
      tr.append(cLow, cHigh, cMid);
      const tdm = el('td');
      if (isFinite(co.price)) {
        const lo = Math.min(r.coreLow, co.price), hi = Math.max(r.coreHigh, co.price);
        const span = (hi - lo) || 1, pad = span * 0.06;
        const x = v => ((v - lo + pad) / (span + 2 * pad)) * 100;
        const mini = el('span', 'mini');
        mini.appendChild(el('span', 'track'));
        const band = el('span', 'band');
        band.style.left = x(r.coreLow) + '%'; band.style.width = (x(r.coreHigh) - x(r.coreLow)) + '%';
        mini.appendChild(band);
        const now = el('span', 'now'); now.style.left = x(co.price) + '%';
        mini.appendChild(now);
        tdm.appendChild(mini);
      } else {
        tdm.textContent = t('noPx');
        tdm.style.color = 'var(--text-muted)';
      }
      tr.appendChild(tdm);
    } else {
      const td = el('td', '', noRangeReason(co, state.horizon)); td.colSpan = 4; td.style.color = 'var(--text-muted)';
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => { state.selected = co.ticker; renderAll(); $('detCard').scrollIntoView({ behavior: 'smooth' }); });
    tbody.appendChild(tr);
  }
  tb.appendChild(tbody); wrap.appendChild(tb);
  renderOffRoster(wrap);
}
/* 表格下方那一行:"另有 N 家不在拉取清单里,已隐藏"。点一下展开,再点收起。
 * 之所以不是设置项而是就摆在表格底下:被藏起来的东西必须在藏它的地方留下痕迹,
 * 否则下次你数了数只有 4 家、明明记得有 6 家,只能怀疑是数据丢了。 */
function renderOffRoster(wrap) {
  const n = offRosterCount();
  if (!n) return;
  const line = el('div', 'offroster', state.showOffRoster ? t('ovHiddenOn')(n) : t('ovHidden')(n));
  line.addEventListener('click', () => { state.showOffRoster = !state.showOffRoster; renderAll(); });
  wrap.appendChild(line);
}
function renderOvChart(rows) {
  const box = $('ovChart'); box.replaceChildren();
  const usable = rows.filter(x => x.r && isFinite(x.r.downPct) && isFinite(x.r.upPct) && isFinite(x.r.midPct));
  if (!usable.length) return;
  const W = 1100, GL = 190, GR = 70, rowH = 36, top = 8;
  const H = top + usable.length * rowH + 12;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '各公司隐含上行下行空间' });
  let mn = 0, mx = 0;
  for (const { r } of usable) { mn = Math.min(mn, r.downPct, r.midPct); mx = Math.max(mx, r.upPct, r.midPct); }
  const span = (mx - mn) || 1; mn -= span * .10; mx += span * .10;
  const x = v => GL + (v - mn) / (mx - mn) * (W - GL - GR);
  svg.appendChild(svgEl('line', { x1: x(0), x2: x(0), y1: top, y2: H - 10, stroke: 'var(--axis)', 'stroke-width': 1 }));
  svg.appendChild(svgEl('text', { x: x(0), y: H - 1, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--text-muted)' }, t('priceZero')));
  const tip = $('ovTip');
  usable.forEach(({ co, r }, i) => {
    const yc = top + i * rowH + rowH / 2;
    const nm = svgEl('text', { x: GL - 12, y: yc - 2, 'text-anchor': 'end', 'font-size': 12.5, 'font-weight': 600, fill: 'var(--text-primary)' });
    nm.textContent = co.name.length > 12 ? co.name.slice(0, 12) + '…' : co.name;
    svg.appendChild(nm);
    svg.appendChild(svgEl('text', { x: GL - 12, y: yc + 11, 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--text-muted)' }, co.ticker));
    const bx = x(Math.min(r.downPct, r.upPct)), bw = Math.max(2, Math.abs(x(r.upPct) - x(r.downPct)));
    svg.appendChild(svgEl('rect', { x: bx, y: yc - 6, width: bw, height: 12, rx: 4, fill: 'var(--wash-strong)' }));
    svg.appendChild(svgEl('text', { x: bx - 6, y: yc + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-secondary)' }, fmtPct(r.downPct)));
    svg.appendChild(svgEl('text', { x: bx + bw + 6, y: yc + 4, 'font-size': 11, fill: 'var(--text-secondary)' }, fmtPct(r.upPct)));
    svg.appendChild(svgEl('circle', { cx: x(r.midPct), cy: yc, r: 5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    const hit = svgEl('rect', { x: 0, y: yc - rowH / 2, width: W, height: rowH, fill: 'transparent' });
    hit.style.cursor = 'pointer';
    hit.addEventListener('pointermove', ev => {
      tip.replaceChildren();
      tip.appendChild(el('div', 'v', co.name + ' ' + co.ticker));
      tip.appendChild(el('div', 'k', t('tipCore') + fmtN(r.coreLow) + ' ~ ' + fmtN(r.coreHigh) + '(' + fmtPct(r.downPct) + ' ~ ' + fmtPct(r.upPct) + ')'));
      tip.appendChild(el('div', 'k', t('tipMid') + fmtN(r.mid) + '(' + fmtPct(r.midPct) + ')· ' + t('tipPrice') + fmtN(co.price)));
      const bb = $('ovChartBox').getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = Math.max(0, Math.min(ev.clientX - bb.left + 14, bb.width - 300)) + 'px';
      tip.style.top = (ev.clientY - bb.top + 14) + 'px';
    });
    hit.addEventListener('pointerleave', () => tip.style.display = 'none');
    hit.addEventListener('click', () => { state.selected = co.ticker; renderAll(); $('detCard').scrollIntoView({ behavior: 'smooth' }); });
    svg.appendChild(hit);
  });
  box.appendChild(svg);
}
