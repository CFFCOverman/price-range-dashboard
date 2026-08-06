function ingestPriceSummarySheet(sheetName, aoa, fileName) {
  let price = NaN;
  for (let i = 0; i < Math.min(aoa.length, 12); i++) {
    const row = aoa[i] || [];
    for (let j = 0; j < row.length; j++) {
      if (String(row[j] || '').trim() === 'Latest Price') {
        for (let k = i + 1; k <= i + 2 && k < aoa.length; k++) {
          const v = parseFloat(String((aoa[k] || [])[j] == null ? '' : (aoa[k] || [])[j]).replace(/[$,]/g, ''));
          if (isFinite(v) && v > 0) { price = v; break; }
        }
      }
    }
  }
  if (!isFinite(price)) return null;
  const ticker = resolveTicker(fileName, (aoa[0] || [])[0], price);
  const co = ticker && state.companies.get(ticker);
  if (!co) return { ticker: null, text: t('psNoTicker') };
  if ((SRC_RANK[co.priceSrc] || 0) <= 2) { co.price = price; co.priceSrc = 'file'; co.priceDate = '@snap'; }
  return { ticker, text: t('psMsg')(ticker, fmtN(price)) };
}
