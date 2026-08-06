/* ================= σ 尺度:日波动率 / 长度单位 / 触及概率 / 打分 =================
 * 本文件里的 sd 一律是**日**对数收益标准差,不年化。想要年化请自己乘 √252,
 * 但别把年化的值再喂回来 —— 详见 params.js 文件头那一段。 */

/** 日对数收益标准差。返回 { sd, n, from, to } | null。
 *  n 是参与计算的**收益个数**(不是价格根数),from/to 是实际窗口的首尾日期。
 *  不负责年化、不负责 √t 外推、不负责跨票比较 —— 那些都是调用方的事。 */
function sigmaD(ticker, refISO, win) {
  const all = state.priceHist.get(ticker);
  if (!all || !all.length) return null;
  /* 时间截断只走 asOfSlice 这一个口子(grid.js),别在这里自己写 filter */
  const seg = asOfSlice(all, refISO || null);
  const w = isFinite(win) && win > 0 ? Math.floor(win) : PX_SIGMA_WIN;
  /* 取最后 w 个收益,也就是最后 w+1 根价格 */
  const tail = seg.slice(Math.max(0, seg.length - (w + 1)));
  const rets = [], dates = [];
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1].price, b = tail[i].price;
    if (!(a > 0) || !(b > 0)) continue;
    rets.push(Math.log(b / a));
    dates.push(tail[i].date);
  }
  if (rets.length < PX_SIGMA_MIN_N) return null;
  const mu = rets.reduce((x, y) => x + y, 0) / rets.length;
  const va = rets.reduce((x, y) => x + (y - mu) * (y - mu), 0) / (rets.length - 1);
  const sd = Math.sqrt(va);
  if (!isFinite(sd)) return null;
  return { sd, n: rets.length, from: dates[0], to: dates[dates.length - 1] };
}

/** 本引擎唯一的长度单位「1u」= σd·√h·P(一个持有期的一个标准差,折成价格)。
 *  坏输入返回 NaN 而**不是 0**:0 会让下游的 dist/u 变成 Infinity(仍可比较,面板照画错的),
 *  NaN 会让所有比较为 false,于是那条带安静地不出现 —— 消失是看得见的,错数不是。 */
function scaleU(sd, h, price) {
  if (!isFinite(sd) || sd <= 0) return NaN;
  if (!isFinite(h) || h <= 0) return NaN;
  if (!isFinite(price) || price <= 0) return NaN;
  return sd * Math.sqrt(h) * price;
}

/** 标准正态 CDF,Abramowitz-Stegun 7.1.26(对 Φ 的绝对误差 < 7.5e-8)。 */
function normCdf(z) {
  if (!isFinite(z)) return z > 0 ? 1 : z < 0 ? 0 : NaN;
  const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
  const tt = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * tt - 1.453152027) * tt + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/** 未来 h 个交易日内**至少触及一次**的概率(反射原理 p = 2Φ(−u),经 c 再校准)。
 *  它对上下对称、不含方向;它**不是**"守得住的概率",也**不是**"收盘落在那里的概率"。
 *  edgeAbs 是现价到目标位**边缘**的绝对价差(非负)。 */
function reachProb(edgeAbs, sd, h, c) {
  /* 量纲哨兵:日波动率超过 25% 的股票不存在,这个值只可能是年化 σ 走错了门。
   * 返回 NaN 让整条带静默消失 —— 比返回 0.99 好,因为消失看得见,0.99 看不见。 */
  if (sd > 0.25) return NaN;
  if (!isFinite(edgeAbs) || edgeAbs < 0) return NaN;
  if (!isFinite(sd) || sd <= 0) return NaN;
  if (!isFinite(h) || h <= 0) return NaN;
  if (!isFinite(c) || c <= 0) return NaN;
  return Math.min(1, 2 * normCdf(-edgeAbs / (c * sd * Math.sqrt(h))));
}

/** 二项比例的 Wilson 区间。用 Wilson 不用正态近似:k=0 或 k=n 时正态区间会塌成一个点,
 *  而小样本恰恰是本面板最常见的处境。z 缺省 1.96。 */
function wilson(k, n, z) {
  const zz = isFinite(z) && z > 0 ? z : 1.96;
  if (!isFinite(k) || !isFinite(n) || n <= 0 || k < 0 || k > n) return { lo: NaN, hi: NaN };
  const p = k / n, d = 1 + zz * zz / n;
  const c = p + zz * zz / (2 * n);
  const s = zz * Math.sqrt(p * (1 - p) / n + zz * zz / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

/** Brier 分数 Σ(p−y)²/n。y 只能是 0/1。 */
function brier(ps, ys) {
  if (!Array.isArray(ps) || !Array.isArray(ys) || !ps.length || ps.length !== ys.length) return NaN;
  let s = 0, n = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], y = ys[i];
    if (!isFinite(p) || !isFinite(y)) continue;
    s += (p - y) * (p - y); n++;
  }
  return n ? s / n : NaN;
}

/** Brier skill:1 − brier(模型) / brier(常数 base 预测)。
 *  base 是气候基准(全样本触及率),不是别的模型 —— 换基准就换了题,不许混着报。 */
function brierSkill(ps, ys, base) {
  const b = brier(ps, ys);
  if (!isFinite(b) || !isFinite(base)) return NaN;
  const b0 = brier(ys.map(() => base), ys);
  if (!isFinite(b0) || b0 <= 0) return NaN;
  return 1 - b / b0;
}
