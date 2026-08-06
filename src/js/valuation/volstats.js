/* ================= 波动率统计 & 方法对比 ================= */
function volStats(ticker) {
  const ph = state.priceHist.get(ticker);
  if (!ph || ph.length < 13) return null;
  const rets = [], gaps = [];
  for (let i = 1; i < ph.length; i++) {
    if (ph[i - 1].price > 0 && ph[i].price > 0) rets.push(Math.log(ph[i].price / ph[i - 1].price));
    const g = (new Date(ph[i].date) - new Date(ph[i - 1].date)) / 86400000;
    if (isFinite(g) && g > 0) gaps.push(g);
  }
  if (rets.length < 12) return null;
  /* 按日期中位间隔判断数据频率 → 年化系数 */
  gaps.sort((a, b) => a - b);
  const medGap = gaps[Math.floor(gaps.length / 2)] || 30;
  const perYear = medGap <= 2 ? 252 : medGap <= 10 ? 52 : medGap <= 45 ? 12 : 1;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const va = rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1);
  return { sigma: Math.sqrt(va) * Math.sqrt(perYear), n: rets.length + 1 };
}
