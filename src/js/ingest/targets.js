/* Targets & Ratings 月度历史(fetcher 输出 "{ticker} Targets Ratings.xlsx")→ 情绪面信号 */
const MON3 = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function parseDMYY(s) {   /* "28 Jul '26" -> ISO */
  const m = /^(\d{1,2})\s+([A-Z][a-z]{2})\s+'(\d{2})$/.exec(String(s || '').trim());
  if (!m || !MON3[m[2]]) return null;
  return `20${m[3]}-${String(MON3[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
function ingestTargetsSheet(sheetName, aoa, fileName) {
  let hi = -1;
  for (let i = 0; i < Math.min(aoa.length, 6); i++) {
    const row = (aoa[i] || []).map(c => String(c || ''));
    if (row.some(c => /Mean Tgt Price/i.test(c)) && row.some(c => /^Date$/i.test(c))) { hi = i; break; }
  }
  if (hi < 0) return null;
  const hdr = aoa[hi].map(c => String(c || '').trim());
  const col = re => hdr.findIndex(h => re.test(h));
  const cD = col(/^Date$/i), cR = col(/Mean Rating/i), cN = col(/# of Ratings/i),
    cB = col(/^Buy/i), cO = col(/Overweight/i), cT = col(/Mean Tgt Price/i);
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const d = parseDMYY(r[cD]); const tgt = parseFloat(String(r[cT]).replace(/[$,]/g, ''));
    if (!d || !isFinite(tgt)) continue;
    const rt = /\(([\d.]+)\)/.exec(String(r[cR] || ''));
    rows.push({
      date: d, tgt,
      rating: rt ? +rt[1] : NaN,
      n: parseFloat(r[cN]),
      buyPct: (parseFloat(r[cB]) || 0) + (parseFloat(r[cO]) || 0),
    });
  }
  if (rows.length < 2) return null;
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  const tk = ((/^([A-Z.]{1,6}-[A-Z]{2})/.exec(fileName || '') || [])[1] || String((aoa[0] || [])[0] || '')).toUpperCase();
  const ticker = state.companies.has(tk) ? tk : resolveTicker(fileName, tk, NaN);
  if (!ticker) return { ticker: null, text: t('tgtNoTicker') };
  if (!state.companies.has(ticker)) return { ticker: null, text: t('tgtNoTicker') };
  state.companies.get(ticker).targets = rows;
  return { ticker, text: t('tgtMsg')(ticker, rows.length, rows[rows.length - 1].tgt) };
}
