/* ================= render root ================= */
let lastStatusMsg = null;
function renderAll(statusMsg) {
  const has = state.companies.size > 0;
  const vis = visibleCompanies();
  /* 选中的那家被隐藏了(比如刚点了收起),就改选一家画得出来的,别让详情卡片指着表格里没有的行 */
  if (vis.length && (!state.selected || !vis.some(c => c.ticker === state.selected))) state.selected = vis[0].ticker;
  $('ovCard').hidden = !has;
  if (statusMsg != null) lastStatusMsg = statusMsg;
  if (lastStatusMsg != null || has) {
    const st = $('status'); st.replaceChildren();
    if (lastStatusMsg != null) st.appendChild(el('span', 'ok', lastStatusMsg + ' '));
    if (has) {
      /* 数的是画出来的那批,不是载入的那批 —— 顶上写"6 家"、表格里 4 行,是最难自查的一种不一致 */
      const withHist = vis.filter(c => (state.history.get(c.ticker) || []).length >= 12).length;
      st.appendChild(el('span', '', t('stTotal')(vis.length, withHist)));
    }
  }
  if (has) {
    const rows = overviewRows();
    renderOvTable(rows);
    renderOvChart(rows);
    renderDetail();
  } else {
    $('detCard').hidden = true;
  }
}

