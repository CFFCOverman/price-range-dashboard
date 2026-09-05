/* ================= file handling(顺序导入,保证"新文件覆盖旧文件"确定性) ================= */
async function handleFiles(files) {
  const msgs = [];
  /* 归属类文件(Charting / Price Summary)排到主数据文件之后,保证公司先建立再归属 */
  const isSecondary = f => /price\s*summary|charting|targets|news/i.test(f.name);
  files = [...files].sort((a, b) => (isSecondary(a) ? 1 : 0) - (isSecondary(b) ? 1 : 0));
  for (const f of files) {
    try {
      if (/\.xlsx?$/i.test(f.name)) {
        await ensureXLSX();
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const got = [];
        for (const sn of wb.SheetNames) {
          const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true });
          const r = ingestModelSheet(sn, aoa) || ingestEstimateSheet(sn, aoa, f.name) || ingestSnapshotSheet(sn, aoa, f.name)
            || ingestTargetsSheet(sn, aoa, f.name) || ingestChartingSheet(sn, aoa, f.name) || ingestPriceSummarySheet(sn, aoa, f.name);
          if (r) got.push(r);
        }
        msgs.push(f.name + (got.length ? ':' + got.map(x => x.text).join(';') : t('mXlsxNone')));
      } else {
        const recs = parseCSV(await f.text());
        if (!recs.length) msgs.push(f.name + t('mEmptyFile'));
        else {
          const h = Object.keys(recs[0]);
          /* 拉取清单排在最前面认:它的列名(ticker/role/active)和下面几支都不重叠,
           * 先认掉省得每次都把不相干的分支跑一遍。见 ingest/roster.js */
          if (h.includes('ticker') && h.includes('role') && h.includes('active')) {
            const rr = ingestRoster(recs);
            msgs.push(f.name + t('mRosterRows')(rr.n));
          } else if (h.includes('days_to_cover') || h.includes('pct_of_float')) {
            msgs.push(f.name + t('mSiRows')(ingestShortInt(recs)));
          } else if (h.includes('headline')) {
            msgs.push(f.name + ingestNews(recs, f.name).text);
          } else if (h.includes('net_delta_shares') && h.includes('timestamp')) {
            const grouped = new Map();
            for (const r of recs) { if (!r.ticker || !r.timestamp) continue; if (!grouped.has(r.ticker)) grouped.set(r.ticker, new Map()); grouped.get(r.ticker).set(r.timestamp, r); }
            for (const [tk, rs] of grouped) state.optionSignals.set(tk, [...rs.values()].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)));
            msgs.push(f.name + ': ' + recs.length + ' observations');
          } else if (h.includes('strike') && (h.includes('call_oi') || h.includes('put_oi'))) {
            msgs.push(f.name + ingestOptions(recs, f.name).text);
          } else if (h.includes('pe_ntm') || (h.includes('eps_ntm') && h.includes('date'))) {
            msgs.push(f.name + t('mHistRows')(ingestHistory(recs)));
          } else if (h.includes('price') && h.some(k => k.startsWith('eps_fy1'))) {
            msgs.push(f.name + t('mCoRows')(ingestCompanies(recs)));
          } else {
            msgs.push(f.name + t('mBadCols'));
          }
        }
      }
    } catch (e) { msgs.push(f.name + t('mParseFail') + ((e && e.message) || e)); }
  }
  /* 默认选中的那家必须是**画得出来的**那批里的一家,否则详情卡片会指着一家表格里根本没有的公司 */
  const vis = visibleCompanies();
  if (vis.length && (!state.selected || !vis.some(c => c.ticker === state.selected))) state.selected = vis[0].ticker;
  renderAll(msgs.join(' · '));
}
