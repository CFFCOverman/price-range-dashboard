/* ================= 价格密度几何(σ 尺度) =================
 * 职责只有三件:as-of 截断、摆动极值、按 1u = σd·√h·P 分箱成带。
 * 不做合并、不做排序、不算概率、不判上下 —— 那些在 engine.js。
 * 这里的 sd 一律是**日**波动率(sigmaD().sd),不是 volStats 的年化 σ,详见 params.js 文件头。 */

/** 时间截断的唯一入口。别处再写 `filter(d => d.date <= ref)` 一律算规格违例 ——
 *  上一版整段未来函数防护就是密度函数里 `a >= 0` 一个子句,某次重构顺手就能删掉,
 *  删掉之后没有任何东西会响:回放照跑,只是每一根都偷看了后面的价格。
 *  这里刻意用**前缀截断 + 事后断言**而不是 filter:filter 会把乱序序列里夹着的未来行
 *  悄悄挑掉,留下一段"看起来干净"的结果;前缀截断会把同样的乱序直接炸出来。 */
function asOfSlice(series, refISO) {
  if (!Array.isArray(series) || !series.length) return [];
  if (!refISO) return series;
  let i = 0;
  while (i < series.length && series[i] && series[i].date <= refISO) i++;
  const out = series.slice(0, i);
  if (out.length && out[out.length - 1].date > refISO)
    throw new Error('as-of 越界:切片末日期 ' + out[out.length - 1].date + ' 晚于 ' + refISO);
  /* 截断点之后若还有 <= refISO 的行,说明序列没按日期升序 —— 那就不只是排序问题,
   * 是"我刚刚静默丢掉了本该参与计算的历史"。宁可炸,不许少算。 */
  for (let j = i; j < series.length; j++) {
    if (series[j] && series[j].date <= refISO)
      throw new Error('as-of 越界:序列未按日期升序,' + series[j].date + ' 出现在截断点之后');
  }
  if (!out.length) throw new Error('as-of 越界:' + refISO + ' 早于该序列的第一根 ' + series[0].date);
  return out;
}

/** 摆动高低点:局部极值,最经典的前高/前低来源。k 缺省 PX_SWING_K。 */
function swingPoints(series, k) {
  const kk = isFinite(k) && k > 0 ? Math.floor(k) : PX_SWING_K;
  const out = [];
  for (let i = kk; i < series.length - kk; i++) {
    const p = series[i].price;
    let hi = true, lo = true;
    for (let j = i - kk; j <= i + kk; j++) {
      if (j === i) continue;
      if (series[j].price > p) hi = false;
      if (series[j].price < p) lo = false;
      if (!hi && !lo) break;
    }
    if (hi || lo) out.push({ price: p, date: series[i].date, kind: hi ? 'high' : 'low' });
  }
  return out;
}

/* 结构位回答“价格在哪些前高/前低反复转向”，不能拿最近一个小拐点顶替。
 * h 同时决定观察窗口与摆动半径，短中长期因此真的看不同历史，而不只是改变带宽。 */
function structuralLevels(ticker, refISO, h) {
  const all = state.priceHist.get(ticker);
  if (!all || all.length < PX_SIGMA_MIN_N) return null;
  const hh = isFinite(h) && h > 0 ? h : PX_HORIZONS.mid;
  const sliced = asOfSlice(all, refISO || null);
  const cfg = hh <= PX_HORIZONS.short ? { look: 63, k: 2 }
    : hh <= PX_HORIZONS.mid ? { look: 126, k: 3 } : { look: 252, k: 5 };
  const series = sliced.slice(-cfg.look);
  if (series.length < PX_SIGMA_MIN_N) return null;
  const sig = sigmaD(ticker, refISO || null, PX_SIGMA_WIN);
  if (!sig) return null;
  const price = series.at(-1).price, u = scaleU(sig.sd, hh, price);
  /* 聚类宽度使用日波动；若使用 √h，长期档会把十几美元揉成同一条位置。 */
  const tol = Math.max(price * .004, price * sig.sd * .55);
  const pivots = swingPoints(series, cfg.k).map(sp => {
    const i = series.findIndex(d => d.date === sp.date);
    const after = series.slice(i + 1, Math.min(series.length, i + 1 + cfg.k * 3));
    const reaction = after.length ? (sp.kind === 'high'
      ? sp.price - Math.min(...after.map(d => d.price))
      : Math.max(...after.map(d => d.price)) - sp.price) : 0;
    return { ...sp, reaction: Math.max(0, reaction), fresh: Math.pow(.5, (series.length - 1 - i) / (cfg.look / 2)) };
  });
  const clusters = [];
  for (const kind of ['high', 'low']) for (const p of pivots.filter(x => x.kind === kind).sort((a, b) => a.price - b.price)) {
    let c = clusters.filter(x => x.kind === kind).sort((a, b) => Math.abs(a.peak - p.price) - Math.abs(b.peak - p.price))[0];
    if (!c || Math.abs(c.peak - p.price) > tol) { c = { kind, points: [], peak: p.price }; clusters.push(c); }
    c.points.push(p);
    const fw = c.points.reduce((s, x) => s + x.fresh, 0);
    c.peak = c.points.reduce((s, x) => s + x.price * x.fresh, 0) / fw;
  }
  for (const c of clusters) {
    const fw = c.points.reduce((s, p) => s + p.fresh, 0);
    c.touch = c.points.length; c.last = c.points.map(p => p.date).sort().at(-1);
    c.reaction = c.points.reduce((s, p) => s + p.reaction * p.fresh, 0) / fw;
    c.lo = Math.min(...c.points.map(p => p.price)) - tol * .45;
    c.hi = Math.max(...c.points.map(p => p.price)) + tol * .45;
    const quality = fw + Math.min(2, c.reaction / Math.max(tol, 1));
    const edge = c.kind === 'high' ? Math.max(0, c.lo - price) : Math.max(0, price - c.hi);
    c.score = quality / (1 + edge / Math.max(u, tol) * .22);
    /* 1–5 是结构证据等级，不是命中率：重复确认 0–2、反转幅度 0–2、新鲜度 0–1。 */
    const repeatPts = c.touch >= 3 ? 2 : c.touch >= 2 ? 1 : 0;
    const reactionX = c.reaction / Math.max(tol, 1);
    const reactionPts = reactionX >= 2 ? 2 : reactionX >= 1 ? 1 : 0;
    const recentPts = Math.max(...c.points.map(p => p.fresh)) >= .5 ? 1 : 0;
    c.strength = 1 + Math.min(4, repeatPts + reactionPts + recentPts);
    c.strengthParts = { repeat: repeatPts, reaction: reactionPts, recent: recentPts, reactionX };
  }
  const upper = clusters.filter(c => c.kind === 'high' && c.lo > price).sort((a, b) => b.score - a.score)[0] || null;
  const lower = clusters.filter(c => c.kind === 'low' && c.hi < price).sort((a, b) => b.score - a.score)[0] || null;
  return { upper, lower, price, u, tol, from: series[0].date, to: series.at(-1).date, n: series.length };
}

/** 价格密度 → 价位带。名字不许改:tools/backtest.mjs 的函数存在性断言点名了它。
 *  返回 { bins, bands, basis, n, from, to, swings, min, max, sd, u, asOf } | null。 */
function priceDensity(ticker, refISO, h) {
  const all = state.priceHist.get(ticker);
  if (!all || all.length < PX_SIGMA_MIN_N) return null;
  /* h 缺省必须落到 PX_HORIZONS.mid(=21),绝不允许 undefined 走进几何:
   * √undefined = NaN → u = NaN → 所有 distU/edgeU 全 NaN → 过滤条件恒为 false
   * → 面板整个消失,而控制台干干净净。这种失败看起来像"这只票没数据",不像 bug。 */
  const hh = isFinite(h) && h > 0 ? h : PX_HORIZONS.mid;
  const sliced = asOfSlice(all, refISO || null);
  if (sliced.length < PX_SIGMA_MIN_N) return null;
  const asOf = sliced[sliced.length - 1].date;

  /* 回看窗口:这一刀砍的是**太老**的数据,与 as-of 无关(as-of 已经在上面做完了)。
   * 同样用前缀索引而不是 filter,免得日后有人把两种截断看成一类而互相抄。
   * 年龄一律从 refISO 起算,不从最后一根起算:序列停更两年的票,
   * 若按最后一根算年龄,它的老平台永远是"新鲜"的,回看窗口和半衰期都等于没有。 */
  const now = new Date((refISO || asOf) + 'T00:00:00Z');
  const ageD = d => (now - new Date(d + 'T00:00:00Z')) / 86400000;
  let s0 = 0;
  while (s0 < sliced.length && ageD(sliced[s0].date) > PX_LOOKBACK_D) s0++;
  const series = sliced.slice(s0);
  if (series.length < PX_SIGMA_MIN_N) return null;

  const sig = sigmaD(ticker, refISO || null, PX_SIGMA_WIN);
  if (!sig) return null;
  const refPx = series[series.length - 1].price;
  const u = scaleU(sig.sd, hh, refPx);
  if (!isFinite(u) || u <= 0) return null;

  const basis = hasVol(series) ? 'volume' : 'time';
  const prices = series.map(d => d.price);
  const mn = Math.min(...prices), mx = Math.max(...prices);
  if (!(mx > mn)) return null;

  /* 箱宽 = PX_BIN_U · u,不再是固定 48 箱 —— 固定箱数会把价区大的票切碎、把窄幅票糊成一片。
   * 上下两道钳位不是可调参数,是分辨率上限:箱数超过样本量的一半以后,
   * 平均每箱不到 2 个观测,密度就是散粒噪声 —— 峰值检测测到的是"哪天恰好落在这一格",
   * 不是筹码分布。σ 塌到接近 0 时(比如一段几乎线性的走势)箱数会炸到十万级,
   * 那不是"更精细",那是把噪声当成结构,顺带把浏览器卡死。 */
  let nb = Math.ceil((mx - mn) / (PX_BIN_U * u));
  if (!isFinite(nb) || nb < 4) nb = 4;
  const nbMax = Math.max(8, Math.floor(series.length / 2));
  if (nb > nbMax) nb = nbMax;
  const w = (mx - mn) / nb;
  const bins = Array.from({ length: nb }, (_, i) => ({ lo: mn + i * w, hi: mn + (i + 1) * w, mid: mn + (i + 0.5) * w, wt: 0, last: '' }));
  const at = p => Math.min(nb - 1, Math.max(0, Math.floor((p - mn) / w)));
  for (const d of series) {
    const decay = Math.pow(0.5, ageD(d.date) / PX_HALFLIFE_D);
    const unit = basis === 'volume' ? (isFinite(d.vol) && d.vol > 0 ? d.vol : 0) : 1;
    if (!unit) continue;
    const idx = at(d.price);
    bins[idx].wt += unit * decay;
    if (d.date > bins[idx].last) bins[idx].last = d.date;
  }
  const total = bins.reduce((a, b) => a + b.wt, 0);
  if (!(total > 0)) return null;
  for (const b of bins) b.share = b.wt / total;
  /* 3 点平滑后再找峰:未平滑的分布在"匀速走过"的区段会出现一串等高的微峰,
   * 峰值法会把一个连续区域切成好几条挨着的窄带,读起来是噪声。平滑只用于识别,展示仍用原始值。 */
  for (let i = 0; i < nb; i++) {
    const a = bins[i - 1] ? bins[i - 1].share : bins[i].share;
    const c = bins[i + 1] ? bins[i + 1].share : bins[i].share;
    bins[i].sm = (a + bins[i].share + c) / 3;
  }

  /* 摆动点:落进哪个箱就给那个箱记一次"触及" */
  const swings = swingPoints(series, PX_SWING_K);
  for (const sp of swings) { const i = at(sp.price); bins[i].touch = (bins[i].touch || 0) + 1; }

  /* 峰值 → 向两侧扩张成带(峰值必须高于平均密度,否则只是噪声) */
  const avg = 1 / nb;
  const used = new Array(nb).fill(false);
  const peaks = bins.map((b, i) => ({ i, s: b.sm }))
    .filter(x => x.s > avg * PX_PEAK_X
      && x.s >= (bins[x.i - 1] ? bins[x.i - 1].sm : -1)
      && x.s >= (bins[x.i + 1] ? bins[x.i + 1].sm : -1))
    .sort((a, b) => b.s - a.s);
  const spans = [];
  for (const pk of peaks) {
    if (used[pk.i]) continue;
    let a = pk.i, z = pk.i;
    while (a > 0 && !used[a - 1] && bins[a - 1].sm >= pk.s * PX_BAND_CUT) a--;
    while (z < nb - 1 && !used[z + 1] && bins[z + 1].sm >= pk.s * PX_BAND_CUT) z++;
    for (let i = a; i <= z; i++) used[i] = true;
    spans.push({ a, z, pi: pk.i });
    if (spans.length >= 10) break;
  }
  /* 相邻(中间没有真正空档)的两段合成一条——一个连续密集区应该是一条带,不是三条 */
  spans.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && s.a - prev.z <= 1) {
      prev.z = s.z;
      if (bins[s.pi].sm > bins[prev.pi].sm) prev.pi = s.pi;
    } else merged.push({ ...s });
  }
  const half = PX_HALF_U * u;
  const bands = merged.map(({ a, z, pi }) => {
    let wt = 0, touch = 0, last = '';
    for (let i = a; i <= z; i++) { wt += bins[i].share; touch += bins[i].touch || 0; if (bins[i].last > last) last = bins[i].last; }
    const peak = bins[pi].mid;
    let lo = bins[a].lo, hi = bins[z].hi;
    /* 半宽下限 PX_HALF_U·u:比这更窄的带在本持有期的尺度上就是一个点,
     * 而"点"承载不了触及概率(到边缘和到中心的距离没有区别)。按峰值对称补足。 */
    if ((hi - lo) / 2 < half) { lo = Math.min(lo, peak - half); hi = Math.max(hi, peak + half); }
    return { lo, hi, peak, share: wt, touch, last };
  }).sort((x, y) => y.share - x.share).slice(0, 6);

  return {
    bins, bands, basis, n: series.length,
    from: series[0].date, to: series[series.length - 1].date,
    swings, min: mn, max: mx, sd: sig.sd, u, asOf,
  };
}
