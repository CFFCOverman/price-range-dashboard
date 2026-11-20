/* ================= PE stats & core calc ================= */
function peStats(ticker, years = state.peYears) {
  const full = state.history.get(ticker);
  const end = full?.at(-1)?.date;
  // Anchor windows to the library date, not the machine clock or price date.
  const cutoff = end && `${Number(end.slice(0, 4)) - years}${end.slice(4)}`;
  const h = full?.[0]?.basis === 'ntm' ? full.filter(d => d.date >= cutoff) : full;
  if (h && h.length >= 12) {
    const sorted = h.map(d => d.pe).slice().sort((a, b) => a - b);
    return {
      src: 'history', series: h, sorted, basis: h[0].basis || 'unknown', currentEps: h.at(-1).eps, years,
      p10: percentile(sorted, .10), p25: percentile(sorted, .25), p50: percentile(sorted, .50),
      p75: percentile(sorted, .75), p90: percentile(sorted, .90),
      current: h[h.length - 1].pe,
    };
  }
  const m = state.peManual.get(ticker);
  if (peManualValid(m)) {
    return { src: 'manual', p10: NaN, p25: m.p25, p50: m.p50, p75: m.p75, p90: NaN };
  }
  return null;
}
function peManualValid(m) {
  return !!m && isFinite(m.p25) && isFinite(m.p50) && isFinite(m.p75)
    && m.p25 > 0 && m.p25 <= m.p50 && m.p50 <= m.p75;
}
function peBasisLabel(pe) {
  if (pe?.basis === 'ntm') return LANG === 'en' ? 'Rolling NTM P/E' : '滚动 NTM P/E';
  if (pe?.basis === 'fixed_fy1') return LANG === 'en' ? 'Fixed FY1 P/E (up to 24 months)' : '固定 FY1 P/E（最多24个月）';
  return LANG === 'en' ? 'Imported / manual P/E' : '导入／手工 P/E';
}
function noRangeReason(co, hz) {
  if (hz === 'ntm') {
    if (!epsScen(epsFor(co.ticker, hz))) return LANG === 'en' ? 'Missing or nonpositive NTM EPS — no FY1 substitution' : '缺少有效 NTM EPS 或 EPS ≤ 0，不以 FY1 替代';
    const pe = peStats(co.ticker);
    if (!pe || (pe.basis !== 'ntm' && pe.src !== 'manual')) return LANG === 'en' ? 'Insufficient rolling NTM P/E history in this window' : '所选窗口内滚动 NTM PE 历史不足';
  }
  if (!epsScen(epsFor(co.ticker, hz))) return t('rowNoEps');
  if (!peStats(co.ticker)) return t('rowNoPe');
  return t('rowNoCalc');
}
function epsFor(ticker, hz) {
  const ov = state.overrides.get(ticker + '|' + hz);
  if (ov) return ov;
  if (hz === 'ntm') {
    const point = state.ntmEstimates.get(ticker);
    // Never substitute FY1, or an older positive EPS for a missing/latest loss.
    if (!point) return null;
    return { low: point.mean, mean: point.mean, high: point.mean };
  }
  const co = state.companies.get(ticker);
  return co ? co.eps[hz] : null;
}
/* EPS 情景清洗 —— 乘数法只有在 EPS>0 时才有意义。
 * Low/High 缺失、非正、或高低颠倒(列错位时真的会发生)统统在这里收敛;
 * calcRange 与情景矩阵共用同一份结果,保证"表头核心区间"和"矩阵格子"永远算的是同一件事。 */
function epsScen(eps) {
  if (!eps || !isFinite(eps.mean) || eps.mean <= 0) return null;
  const flags = [];
  let low = isFinite(eps.low) ? eps.low : eps.mean;
  let high = isFinite(eps.high) ? eps.high : eps.mean;
  if (low > high) { const x = low; low = high; high = x; flags.push('swapped'); }
  if (low > eps.mean || high < eps.mean) flags.push('meanOutside');   /* 均值落在区间外:只提示,不改数 */
  if (low <= 0) { low = eps.mean; flags.push('lossLow'); }            /* 悲观情景亏损 → 乘数法失效,退回均值 */
  if (high <= 0) { high = eps.mean; flags.push('lossHigh'); }
  return { low, mean: eps.mean, high, flags };
}
/* 估值分位必须为正:历史里有亏损年份时 P/E 会是负数,乘出来的"价格"没有意义 */
const pePos = (pe, k) => isFinite(pe[k]) && pe[k] > 0;
// Current P/E reacts to every imported quote; it is NOT the historical median
// and is never recycled into a price target (which would return the quote).
function latestValuation(co) {
  const point = state.ntmEstimates.get(co.ticker);
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const current = positive(co.price) && positive(point?.mean) ? co.price / point.mean : null;
  const prior = (state.history.get(co.ticker) || []).filter(r => r.basis === 'ntm' && r.date < point?.date).at(-1);
  const comparable = current !== null && positive(prior?.eps) && positive(prior?.pe);
  const baselinePrice = comparable ? prior.pe * prior.eps : null;
  return { point, current, prior,
    change: comparable ? current / prior.pe - 1 : null,
    epsChange: comparable ? point.mean / prior.eps - 1 : null,
    priceChange: comparable ? co.price / baselinePrice - 1 : null,
    priceOnly: comparable ? co.price / prior.eps : null,
    earningsEffect: comparable ? prior.eps / point.mean - 1 : null,
  };
}
function impliedExpectations(co) {
  let pe=peStats(co.ticker);
  if (state.horizon === 'ntm' && pe?.basis !== 'ntm' && pe?.src !== 'manual') pe=null;
  const e1=epsFor(co.ticker,'fy1'),e2=epsFor(co.ticker,'fy2');
  const selected=epsFor(co.ticker,state.horizon);
  const positive=x=>typeof x==='number'&&isFinite(x)&&x>0;
  if(!positive(co.price))return null;
  const required=pe&&positive(pe.p50)?co.price/pe.p50:null;
  return {fy1:positive(e1?.mean)?co.price/e1.mean:null,fy2:positive(e2?.mean)?co.price/e2.mean:null,
    required,gap:required&&positive(selected?.mean)?required/selected.mean-1:null,
    growth:positive(e1?.mean)&&positive(e2?.mean)?e2.mean/e1.mean-1:null,
    revision:state.overrides.has(co.ticker+'|fy1')?null:co.estimateMeta?.fy1?.revision??null,
    epsDate:state.horizon==='ntm'?state.ntmEstimates.get(co.ticker)?.date||'':co.estimateMeta?.[state.horizon]?.date||'',peDate:pe?.series?.at(-1)?.date||'',manual:pe?.src==='manual'};
}
/* 口径自查:分位库最新一点 × 基准 EPS ≈ 现价。
 * 这两个数本该出自同一份 Estimate History 的同一行(P/E 和 Mean 并排摆着),
 * 乘回去就是那一行当天的股价。和现价差得离谱,说明分位库和 EPS 压根不是同一个口径。
 *
 * 阈值 25%:四家真实数据在配对正确时偏差落在 -12% ~ +1%(价格快照和估值快照差几天,
 * 加上 P/E 只有一位小数);FY3 的分位配 FY1 的 EPS 那次是 -40%。
 * 这条只报警不改数 —— 说不清是哪一边错的时候,不该替人做主。 */
const BASE_GAP_TOL = 25;
function baseGap(price, pe, eps) {
  // NTM multiples must be checked against their own NTM earnings, not FY1.
  if (pe?.basis === 'ntm') eps = { mean: pe.currentEps };
  if (!pe || !isFinite(pe.current) || pe.current <= 0) return null;
  if (!isFinite(price) || price <= 0 || !eps || !isFinite(eps.mean) || eps.mean <= 0) return null;
  const implied = pe.current * eps.mean, dev = (implied / price - 1) * 100;
  return Math.abs(dev) > BASE_GAP_TOL ? { implied, dev } : null;
}
function calcRange(co, hz, years = state.peYears) {
  const pe = peStats(co.ticker, years), eps = epsScen(epsFor(co.ticker, hz));
  if (!eps || !pe) return null;
  if (hz === 'ntm' && pe.basis !== 'ntm' && pe.src !== 'manual') return null;
  if (!pePos(pe, 'p25') || !pePos(pe, 'p50') || !pePos(pe, 'p75')) return null;
  const r = {
    eps, pe, flags: eps.flags,
    mid: eps.mean * pe.p50,
    coreLow: eps.low * pe.p25, coreHigh: eps.high * pe.p75,
    extLow: pePos(pe, 'p10') ? eps.low * pe.p10 : NaN,
    extHigh: pePos(pe, 'p90') ? eps.high * pe.p90 : NaN,
  };
  // NTM identity uses its own earnings; fixed-FY fallback checks against FY1.
  r.baseGap = baseGap(co.price, pe, epsFor(co.ticker, 'fy1'));
  r.midPct = (r.mid / co.price - 1) * 100;
  r.downPct = (r.coreLow / co.price - 1) * 100;
  r.upPct = (r.coreHigh / co.price - 1) * 100;
  return r;
}
