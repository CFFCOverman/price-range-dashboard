/* ================= xlsx (FactSet 公司模型导出) ================= */
let xlsxPromise = null;
function ensureXLSX() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxPromise) xlsxPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res;
    s.onerror = () => { xlsxPromise = null; rej(new Error(t('mNeedNet'))); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}
function findSection(aoa, title) {
  for (let i = 0; i < aoa.length; i++) {
    if (String((aoa[i] || [])[0] || '').trim() === title) {
      return { dates: aoa[i + 1] || [], quarters: aoa[i + 2] || [], start: i + 3 };
    }
  }
  return null;
}
function annualCols(sec, withE) {
  const out = [];
  for (let j = 1; j < sec.dates.length; j++) {
    const dh = String(sec.dates[j] || '').trim(), q = String(sec.quarters[j] || '').trim();
    if (q) continue;
    if (withE ? /E$/.test(dh) : /'\d{2}$/.test(dh)) out.push({ col: j, label: dh });
  }
  return out;
}
function findRows(aoa, start, labels, maxScan) {
  const out = {};
  for (let i = start; i < Math.min(aoa.length, start + (maxScan || 30)); i++) {
    const lb = String((aoa[i] || [])[0] || '').trim();
    if (labels.includes(lb) && !(lb in out)) out[lb] = aoa[i];
  }
  return out;
}
function ingestModelSheet(sheetName, aoa) {
  const es = findSection(aoa, 'Earnings Per Share');
  if (!es) return null;
  const annualE = annualCols(es, true);
  if (!annualE.length) return null;
  const rows = findRows(aoa, es.start, ['EPS', 'EPS - Non GAAP'], 18);
  const src = rows['EPS'] || rows['EPS - Non GAAP'];
  if (!src) return null;
  const g = (row, c) => { const v = parseFloat(row[c.col]); return isFinite(v) ? v : NaN; };
  let ticker = String((aoa[0] || [])[0] || sheetName).trim().toUpperCase();
  if (!ticker) ticker = sheetName.toUpperCase();
  const fy1 = annualE[0], fy2 = annualE[1] || null;
  const epsFy1 = g(src, fy1);
  /* Valuation 区块:用 FY1 forward PE 反推现价;历史年度 PE 作参考 */
  let priceCalc = NaN, peFy1 = NaN, histPE = [];
  const vs = findSection(aoa, 'Valuation');
  if (vs) {
    const peRow = findRows(aoa, vs.start, ['Price/Earnings (x)'], 30)['Price/Earnings (x)'];
    if (peRow) {
      const vAnnE = annualCols(vs, true), vAnnH = annualCols(vs, false);
      if (vAnnE.length) peFy1 = g(peRow, vAnnE[0]);
      if (isFinite(peFy1) && peFy1 > 0 && isFinite(epsFy1) && epsFy1 > 0) priceCalc = +(peFy1 * epsFy1).toFixed(2);
      histPE = vAnnH.map(c => ({ label: c.label, pe: g(peRow, c) })).filter(x => isFinite(x.pe) && x.pe > 0);
    }
  }
  const prev = state.companies.get(ticker);
  const curRank = prev ? (SRC_RANK[prev.priceSrc] || 0) : 0;
  const useDerived = isFinite(priceCalc) && curRank <= 1;   /* 反推价只在没有更可靠来源时使用 */
  const pf = (a, b) => isFinite(a) ? a : b;   /* 已有值优先,模型只补空缺(Estimate History 的一致预期更新、更完整) */
  state.companies.set(ticker, {
    ticker,
    name: prev ? prev.name : ticker,
    fullName: prev ? prev.fullName : undefined,
    currency: prev ? prev.currency : '',
    price: useDerived ? priceCalc : (prev ? prev.price : NaN),
    priceSrc: useDerived ? 'derived' : (prev ? prev.priceSrc : undefined),
    priceDate: useDerived ? '@derived' : (prev ? prev.priceDate : ''),
    extra: prev ? prev.extra : undefined,
    eps: {
      fy1: prev ? { low: prev.eps.fy1.low, mean: pf(prev.eps.fy1.mean, epsFy1), high: prev.eps.fy1.high }
                : { low: NaN, mean: epsFy1, high: NaN },
      fy2: prev ? { low: prev.eps.fy2.low, mean: pf(prev.eps.fy2.mean, fy2 ? g(src, fy2) : NaN), high: prev.eps.fy2.high }
                : { low: NaN, mean: fy2 ? g(src, fy2) : NaN, high: NaN },
    },
  });
  let note = '';
  if (rows['EPS'] && rows['EPS - Non GAAP']) {
    const a = g(rows['EPS'], fy1), b = g(rows['EPS - Non GAAP'], fy1);
    if (isFinite(a) && isFinite(b) && Math.abs(a - b) / Math.abs(a) > 0.05) {
      note = t('gaapNote')(a.toFixed(2), b.toFixed(2));
    }
  }
  if (useDerived) {
    note += t('derivedNote')(priceCalc.toFixed(2), peFy1.toFixed(2));
  }
  if (histPE.length) {
    note += t('peRefNote')(histPE.map(h => h.label + ' ' + h.pe.toFixed(1) + 'x').join('、'));
  }
  return {
    ticker,
    text: ticker + ' FY1(' + fy1.label + ') EPS ' + epsFy1.toFixed(2)
      + (fy2 ? ' / FY2(' + fy2.label + ') ' + g(src, fy2).toFixed(2) : '') + note,
  };
}
/* Estimate History 导出:月度一致预期(Mean/Low/High)+ 月度 P/E 序列 */
