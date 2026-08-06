/* Snapshot 导出:真实收盘价 + 52周区间 + 分析师目标价 + 年度 PE 参考 */
function ingestSnapshotSheet(sheetName, aoa, fileName) {
  const findKV = label => {
    for (const row of aoa) {
      if (!row) continue;
      for (let j = 0; j < row.length; j++) {
        if (String(row[j] || '').trim() === label) {
          for (let k = j + 1; k < row.length; k++) {
            const v = row[k];
            if (v != null && String(v).trim() !== '') return String(v).trim();
          }
          return null;
        }
      }
    }
    return null;
  };
  const pc = findKV('Previous Close');
  if (pc == null) return null;
  const money = s => { const v = parseFloat(String(s == null ? '' : s).replace(/[$,]/g, '')); return isFinite(v) ? v : NaN; };
  let ticker = (findKV('Primary Ticker') || String((aoa[0] || [])[0] || sheetName)).trim().toUpperCase();
  if (!ticker) ticker = sheetName.toUpperCase();
  const price = money(pc);
  const m52 = String(findKV('52 Week Range') || '').match(/\$?([\d.,]+)\s*-\s*\$?([\d.,]+)/);
  const target = money(findKV('Target Price'));
  const rating = String(findKV('Avg Rating') || '');
  /* 年度 PE 参考:Valuation 表 Price / Earnings 行(排除估计年 E) */
  const peRefs = [];
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const li = row.findIndex(c => String(c || '').trim() === 'Price / Earnings');
    if (li < 0) continue;
    for (let h = i - 1; h >= Math.max(0, i - 4); h--) {
      const hr = aoa[h] || [];
      const hi = hr.findIndex(c => String(c || '').trim() === '5Yr Avg');
      if (hi < 0) continue;
      for (let j = hi; j < hr.length; j++) {
        const lb = String(hr[j] || '').trim(), v = parseFloat(row[j]);
        if (!isFinite(v) || v <= 0) continue;
        if (lb === '5Yr Avg' || /'\d{2}$/.test(lb)) peRefs.push({ label: lb, pe: v });
      }
      break;
    }
    if (peRefs.length) break;
  }
  const prev = state.companies.get(ticker);
  const co = prev || {
    ticker, name: ticker, currency: '', price: NaN, priceDate: '',
    eps: { fy1: { low: NaN, mean: NaN, high: NaN }, fy2: { low: NaN, mean: NaN, high: NaN } },
  };
  const curRank = SRC_RANK[co.priceSrc] || 0;
  if (isFinite(price) && curRank <= 2) { co.price = price; co.priceSrc = 'file'; co.priceDate = '@snap'; }
  const fm = String(fileName || '').match(/snapshot_[^_]+_.*_([A-Za-z0-9]+)\.xlsx?$/i);
  if (fm) co.fullName = fm[1];   /* 公司全名:供 Charting / Price Summary 文件归属匹配 */
  co.extra = {
    target, rating,
    w52lo: m52 ? parseFloat(m52[1].replace(/,/g, '')) : NaN,
    w52hi: m52 ? parseFloat(m52[2].replace(/,/g, '')) : NaN,
    peRefs,
  };
  state.companies.set(ticker, co);
  let text = t('snapHead')(ticker) + fmtN(price) + t('snapClose');
  if (m52) text += t('snapW52') + m52[1] + ' ~ ' + m52[2];
  if (isFinite(target)) text += t('snapTgt') + fmtN(target) + (rating ? '(' + rating + ')' : '');
  if (peRefs.length) text += t('snapPeRef')(peRefs.map(x => x.label + ' ' + x.pe.toFixed(1) + 'x').join('、'));
  return { ticker, text };
}
