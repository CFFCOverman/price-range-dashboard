/* ================= 走向概率:六维信号 → 情景权重 → MC ================= */
function dirScores(co, r) {
  const s = { rev: null, val: null, tech: null };
  if (co.rev && isFinite(co.rev.up) && isFinite(co.rev.down) && isFinite(co.rev.n) && co.rev.n > 0) {
    s.rev = Math.max(-1, Math.min(1, (co.rev.up - co.rev.down) / co.rev.n * 2));
  }
  const pe = peStats(co.ticker);
  if (pe && pe.src === 'history' && isFinite(pe.current)) {
    const p = rankPct(pe.sorted, pe.current);
    s.val = p <= 20 ? 1 : p <= 40 ? 0.5 : p < 60 ? 0 : p < 80 ? -0.5 : -1;   /* 低分位=便宜=+ */
    s.valPct = p;
  }
  const ph = state.priceHist.get(co.ticker);
  if (ph && ph.length >= 60 && isFinite(co.price)) {
    const c = ph.map(x => x.price);
    const ma = k => c.slice(-k).reduce((a, b) => a + b, 0) / k;
    const kS = Math.min(50, Math.floor(c.length / 4)), kL = Math.min(200, c.length);
    s.aboveS = co.price > ma(kS); s.aboveL = co.price > ma(kL);
    s.tech = (s.aboveS ? 0.5 : -0.5) + (s.aboveL ? 0.5 : -0.5);
  }
  return s;
}
/* ============ 市场级自动信号:宏观 / 行业 / 流动性(由 _MARKET-* 日线文件驱动) ============ */
function retPct(px, days) {
  if (!px || px.length < days + 1) return NaN;
  const a = px[px.length - 1 - days].price, b = px[px.length - 1].price;
  return a > 0 ? (b / a - 1) * 100 : NaN;
}
function aboveMA(px, k) {
  const c = px.map(x => x.price), n = Math.min(k, c.length);
  return c[c.length - 1] > c.slice(-n).reduce((a, b) => a + b, 0) / n;
}
const clamp1 = v => Math.max(-1, Math.min(1, Math.round(v * 100) / 100));
function marketScores() {
  const out = { m: null, i: null, l: null, why: {} };
  const get = role => { const m = state.market.get(role); return m && m.px.length >= 70 ? m : null; };
  const bench = get('BENCH'), sector = get('SECTOR'), credit = get('CREDIT'), rates = get('RATES');
  if (bench) {
    const c = bench.px.map(x => x.price);
    const trend = aboveMA(bench.px, 200) ? 1 : -1;
    /* 20日已实现波动 → 一年窗口分位(VIX 代理) */
    const rets = []; for (let i = 1; i < c.length; i++) if (c[i - 1] > 0) rets.push(Math.log(c[i] / c[i - 1]));
    const W = 20, vols = [];
    for (let i = W; i <= rets.length; i++) {
      const s = rets.slice(i - W, i), mu = s.reduce((a, b) => a + b, 0) / W;
      vols.push(Math.sqrt(s.reduce((a, b) => a + (b - mu) * (b - mu), 0) / W));
    }
    const yr = vols.slice(-252), last = vols[vols.length - 1];
    const vp = Math.round(yr.filter(v => v <= last).length / yr.length * 100);
    const volSc = vp <= 40 ? 1 : vp >= 70 ? -1 : 0;
    let rateSc = 0, r3 = NaN;
    if (rates) { r3 = retPct(rates.px, 63); rateSc = r3 >= 1 ? 1 : r3 <= -1 ? -1 : 0; }
    out.m = clamp1(0.4 * trend + 0.3 * volSc + 0.3 * rateSc);
    out.why.m = t('dirWhyMacro')(bench.sym, trend > 0, vp, rates ? rates.sym : null, r3);
    if (sector) {
      const rs = retPct(sector.px, 63) - retPct(bench.px, 63);
      const rsSc = !isFinite(rs) ? 0 : rs >= 5 ? 1 : rs >= 2 ? 0.5 : rs > -2 ? 0 : rs > -5 ? -0.5 : -1;
      out.i = clamp1(0.6 * rsSc + 0.4 * (aboveMA(sector.px, 200) ? 1 : -1));
      out.why.i = t('dirWhyInd')(sector.sym, bench.sym, rs, aboveMA(sector.px, 200));
    }
  }
  if (credit) {
    const t3 = retPct(credit.px, 63);
    const tSc = !isFinite(t3) ? 0 : t3 >= 1 ? 1 : t3 <= -1 ? -1 : 0;
    out.l = clamp1(0.6 * tSc + 0.4 * (aboveMA(credit.px, 200) ? 1 : -1));
    out.why.l = t('dirWhyLiq')(credit.sym, t3, aboveMA(credit.px, 200));
  }
  return out;
}
/* 情绪面四条腿:目标价动量 0.35 / 评级结构 0.15 / 空头趋势 0.25 / 新闻关键词 0.25
 * 缺哪条就按剩下的权重归一化,不会因为少一个文件就整块塌掉。 */
function sentScores(co) {
  const parts = [], why = [];
  const tg = co.targets;
  if (tg && tg.length >= 4) {
    const last = tg[tg.length - 1], prev = tg[tg.length - 4];   /* 月度表,回看3行≈3个月 */
    const chg = prev.tgt > 0 ? (last.tgt / prev.tgt - 1) * 100 : NaN;
    const tgtSc = !isFinite(chg) ? 0 : chg >= 8 ? 1 : chg >= 3 ? 0.5 : chg > -3 ? 0 : chg > -8 ? -0.5 : -1;
    parts.push([tgtSc, 0.35]);
    const bChg = isFinite(last.buyPct) && isFinite(prev.buyPct) ? last.buyPct - prev.buyPct : NaN;
    const rSc = !isFinite(bChg) ? 0 : bChg >= 3 ? 1 : bChg >= 1 ? 0.5 : bChg > -1 ? 0 : bChg > -3 ? -0.5 : -1;
    parts.push([rSc, 0.15]);
    why.push(t('dirWhyTgt')(chg, last.buyPct));
  }
  const si = state.shortInt.get(co.ticker);
  if (si && si.length) {
    const last = si[si.length - 1];
    const base = [...si].reverse().find(x => (new Date(last.date) - new Date(x.date)) / 86400000 >= 7);
    let siSc;
    if (base && base.pct > 0) {
      const rel = (last.pct - base.pct) / base.pct * 100;   /* 空头占比下降 = 利多 */
      siSc = rel <= -10 ? 1 : rel <= -3 ? 0.5 : rel < 3 ? 0 : rel < 10 ? -0.5 : -1;
    } else siSc = last.pct < 2 ? 0.25 : last.pct <= 5 ? 0 : -0.25;   /* 只有单点:按水平轻打分 */
    parts.push([siSc, 0.25]);
    why.push(t('dirWhySi')(last.pct, last.days, !!base));
  }
  const nw = newsScore(co.ticker);
  if (nw) { parts.push([nw.s, 0.25]); why.push(nw.why); }
  if (!parts.length) return { s: null, why: null };
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  return { s: clamp1(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum), why, news: nw };
}
/* 同行修正动量:同行 Estimate History 的 (上调-下调)/覆盖数,平均后并入行业面 */
function peerRevs(co) {
  const spec = (state.peerSel.get(co.ticker) || '').trim();
  const list = spec
    ? spec.split(/[,,;\s]+/).map(s => s.toUpperCase()).filter(s => s && s !== co.ticker)
    /* 默认同行 = 清单内的其他公司。落榜的那些数据可能已经停了几个月,
     * 拿它们的修正动量去平均,等于让一批过期样本悄悄参与定价。手动指定的同行不受此限。 */
    : onRosterTickers().filter(k => k !== co.ticker);
  const items = [];
  for (const tk of list) {
    const p = state.companies.get(tk);
    if (p && p.rev && isFinite(p.rev.up) && isFinite(p.rev.down) && isFinite(p.rev.n) && p.rev.n > 0)
      items.push({ tk, sc: Math.max(-1, Math.min(1, (p.rev.up - p.rev.down) / p.rev.n * 2)) });
  }
  if (!items.length) return null;
  return { avg: clamp1(items.reduce((a, b) => a + b.sc, 0) / items.length), items };
}
