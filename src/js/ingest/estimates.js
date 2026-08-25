const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function toISODate(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return parseEstDate(v);
}
function parseEstDate(v) {
  if (typeof v === 'number' && isFinite(v)) {      /* Excel 序列日期 */
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  const m = String(v || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+'?(\d{2,4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return y + '-' + mo + '-' + m[1].padStart(2, '0');
}
/* 这份 Estimate History 跟的是第几个财年 —— 用**表里写的财年末**判定,不信文件名。
 * FactSet 会在 "Estimate History" 那一行右边写上「… Jan '27E …」,拿它和这批数据
 * 最新一行的日期比,差满几个整年就是第几个财年。文件名只在读不到标签时兜底。
 *
 * 为什么非得较真到这一步:2026-07-27/28 那两轮抓错了财年,存下一批 *FY3* 文件。
 * 老代码只问一句「文件名里有没有 FY2」,答否就当 FY1 —— 于是 Jan '29E 的 P/E 分位
 * 配上了 Jan '27E 的 EPS,NVDA 中枢从 +11.9% 翻成 -16.5%,GOOGL 从 +15.7% 翻成 -10.0%,
 * 连正负号都反了。它不抛异常、不写日志,只是安静地给出一个反的结论 —— 判定口径
 * 一旦依赖文件名,下一次抓错财年就又会中毒一次,所以改成认数据自己带的那行标签。 */
const FY_LABEL = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*'?\s*(\d{2})\s*E\b/i;
function fyGapMonths(label, asOfISO) {
  const m = FY_LABEL.exec(String(label || ''));
  const d = String(asOfISO || '').match(/^(\d{4})-(\d{2})/);
  if (!m || !d || !MONTHS[m[1].toLowerCase()]) return NaN;
  return (2000 + Number(m[2])) * 12 + Number(MONTHS[m[1].toLowerCase()]) - (Number(d[1]) * 12 + Number(d[2]));
}
function estimateFy(label, asOfISO, fileName) {
  const gap = fyGapMonths(label, asOfISO);
  /* 已经过完但还没出报的财年 gap≤0,仍算 FY1 —— 下限钳在 1,别让它变成 0 或负数 */
  if (isFinite(gap)) return Math.max(1, Math.floor(gap / 12) + 1);
  const m = String(fileName || '').match(/\bFY\s*(\d+)/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}
function ingestEstimateSheet(sheetName, aoa, fileName) {
  let sec = -1;
  for (let i = 0; i < aoa.length; i++) {
    if (String((aoa[i] || [])[0] || '').trim() === 'Estimate History') { sec = i; break; }
  }
  if (sec < 0) return null;
  const head = (aoa[sec + 1] || []).map(h => String(h || '').trim().toLowerCase());
  const ci = name => head.indexOf(name);
  const cDate = ci('date'), cMean = ci('mean'), cLow = ci('low'), cHigh = ci('high'), cPE = ci('p/e (x)');
  const cN = ci('num of est'), cUp = ci('num up'), cDn = ci('num down');
  if (cDate < 0 || cMean < 0) return null;
  const recs = [];
  for (let i = sec + 2; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const date = parseEstDate(row[cDate]);
    if (!date) { if (recs.length) break; else continue; }
    const mean = parseFloat(row[cMean]);
    /* 日期存在但 Mean 为空的尾行常见于未完成导出。不能让它成为 latest：旧实现
     * 会先把 state 中 EPS 写成 NaN，随后 toFixed 抛错，留下半提交状态。 */
    if (!isFinite(mean)) continue;
    recs.push({
      date,
      mean,
      low: cLow >= 0 ? parseFloat(row[cLow]) : NaN,
      high: cHigh >= 0 ? parseFloat(row[cHigh]) : NaN,
      pe: cPE >= 0 ? parseFloat(row[cPE]) : NaN,
      n: cN >= 0 ? parseFloat(row[cN]) : NaN,
      up: cUp >= 0 ? parseFloat(row[cUp]) : NaN,
      down: cDn >= 0 ? parseFloat(row[cDn]) : NaN,
    });
  }
  if (!recs.length) return null;
  /* 同日重复版本以后出现者覆盖；latest 与 rev 从同一个记录对象读取。 */
  const byDate = new Map();
  for (const r of recs) byDate.set(r.date, r);
  recs.length = 0;
  recs.push(...[...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const latest = recs[recs.length - 1];
  const fy = estimateFy((aoa[sec] || [])[1], latest.date, fileName);
  const isFY2 = fy === 2;
  /* 第三个财年及以后:只借它的价格序列,EPS 与 P/E 分位一概不收。
   * 三年后的盈利乘不上明年的估值分位,收进来就是把两套口径混在一张卡片上。 */
  const isFar = fy >= 3;
  let ticker = String((aoa[0] || [])[0] || sheetName).trim().toUpperCase();
  if (!ticker) ticker = sheetName.toUpperCase();
  const prev = state.companies.get(ticker);
  const co = prev || {
    ticker, name: ticker, currency: '', price: NaN, priceDate: '',
    eps: { fy1: { low: NaN, mean: NaN, high: NaN }, fy2: { low: NaN, mean: NaN, high: NaN } },
  };
  if (!isFar) co.eps[isFY2 ? 'fy2' : 'fy1'] = { low: latest.low, mean: latest.mean, high: latest.high };
  if (fy === 1) {   /* 修正动量:最新一期上调/下调家数(方向信号) */
    co.rev = {
      n: latest.n,
      up: latest.up,
      down: latest.down,
      date: latest.date,
    };
  }
  state.companies.set(ticker, co);
  /* 价格序列 = P/E × Mean(逐月恒等还原),用于波动率;不受 24 个月截断影响 */
  const pxSeries = recs.filter(r => isFinite(r.pe) && r.pe > 0 && isFinite(r.mean) && r.mean > 0)
    .map(r => ({ date: r.date, price: +(r.pe * r.mean).toFixed(4) }));
  setPriceHist(ticker, pxSeries);
  let peSeries = recs.filter(r => isFinite(r.pe) && r.pe > 0).map(r => ({ date: r.date, pe: r.pe }));
  let truncNote = '';
  if (peSeries.length > 24) {
    truncNote = t('truncNote')(peSeries.length);
    peSeries = peSeries.slice(-24);
  }
  const existing = state.history.get(ticker) || [];
  let peNote = '';
  if (fy !== 1) {
    peNote = isFar ? t('estFarSkip')(fy) : '';   /* 非第一财年:PE 分位一律不收,口径以 FY1/NTM 为准 */
  } else if (peSeries.length > existing.length) {
    state.history.set(ticker, peSeries);
    peNote = t('peSeries')(peSeries.length, peSeries[0].date.slice(0, 7), peSeries[peSeries.length - 1].date.slice(0, 7)) + truncNote
      + (peSeries.length < 36 ? t('shortWin') : '');
  } else if (existing.length) {
    peNote = t('keepLonger')(existing.length);
  }
  let jumpNote = '';
  if (recs.length >= 2) {
    const prevMean = recs[recs.length - 2].mean;
    if (isFinite(prevMean) && prevMean > 0 && Math.abs(latest.mean / prevMean - 1) > 0.15) {
      jumpNote = t('jumpNote')(fmtPct((latest.mean / prevMean - 1) * 100));
    }
  }
  return {
    ticker,
    text: (fy > 1 ? '[FY' + fy + '] ' : '') + t('estHead')(ticker, latest.date) + (isFinite(latest.low) ? latest.low.toFixed(2) : '—')
      + t('estMid') + latest.mean.toFixed(2) + t('estHigh') + (isFinite(latest.high) ? latest.high.toFixed(2) : '—') + peNote + jumpNote,
  };
}
