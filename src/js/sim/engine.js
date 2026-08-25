/* ================= 浏览器内规则回放 + 同频随机对照 =================
 * 职责:把一条 {all:[{p,args}]} 规则在一只票的日线上逐根放一遍,吐出每一笔交易和一组统计,
 * 外加一组**同频随机入场**的对照。不做仓位管理、不做复利、不做多标的组合、不做做空。
 *
 * ---- 为什么对照不是可选项 ----
 * 这份数据是一年 × 十只票,而这一年是单边上行。在这种样本里,"随便哪天买、持有 21 天"
 * 的胜率本来就有六七成。没有对照的胜率会把**行情**读成**规则**,而且读起来非常有说服力。
 * 所以 simRun 每次都顺手跑一组同频随机入场,并把 z 一起交出去 —— 渲染层必须把它
 * **并排**摆在胜率旁边(SPEC 3.5 第 5 条),不许折进 tooltip。
 *
 * ---- 未来函数在这里最容易溜进来,三道防线 ----
 * ① 每一根的位置表都由 `pressureLevels(co, r, px[i].date, hz)` 现算 —— as-of 截断在
 *    engine 里(asOfSlice),**sim 一次都不自己切片**;
 * ② 谓词只拿得到 ctx,ctx.px 虽然是整条序列,但 ctx.i 划了线,越线读就是违规(见 rules.js);
 * ③ 入场只能在**信号那一根之后**(i+1 的收盘),出场在 i+1+hold —— 信号根自己的收盘
 *    是当天收盘之后才知道的,用它入场等于用当天收盘价买当天。
 * [13] 节有一条断言专门喂一段"结尾被篡改"的序列,要求 trades 逐条不变。 */

/** 32 位字符串哈希(FNV-1a 变体)。对照的种子由 `ticker + 规则文本` 得到,
 *  于是"同样输入每次跑出同一个数"是**结构性**保证的,而不是靠调用方记得传 seed。
 *  这条很重要:对照本身如果每次都换一批随机日,面板上的 z 就会在用户按第二次
 *  「立即模拟」时跳一下 —— 那会让人以为规则的表现在变。 */
function simHash(s) {
  let h = 2166136261;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 确定性 LCG(与 tests / backtest 里那套同一个式子)。返回 [0,1)。 */
function simRng(seed) {
  let s = (isFinite(seed) ? Math.floor(seed) : 1) & 0x7fffffff;
  if (s <= 0) s = 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** 交易日数 → 'short'|'mid'|'long'。认不出来的一律 'mid'(与 pressureLevels 同一套兜底)。
 *  **不许把 state.horizon 塞进来**:那是财年 fy1/fy2,不是持有期。 */
function simHzKey(hold) {
  for (const k in PX_HORIZONS) if (PX_HORIZONS[k] === hold) return k;
  return 'mid';
}

const SIM_HEAD_KEYS = ['entryDate', 'entryPx', 'exitDate', 'exitPx', 'retPct', 'maePct'];

/** 一笔交易的算术。cost 是**往返**总成本(bp),一次性从收益里扣掉。
 *  MAE/MFE 取入场根到出场根之间(含两端)的最不利 / 最有利偏移,以入场价为基准 —— 含入场根
 *  意味着 mae ≤ 0 ≤ mfe,读表的人不用先想"这个正的 MAE 是什么意思"。 */
function simTrade(px, e, x, costBps) {
  const entryPx = px[e].price, exitPx = px[x].price;
  if (!(entryPx > 0) || !(exitPx > 0)) return null;
  let mae = 0, mfe = 0;
  for (let j = e; j <= x; j++) {
    const d = px[j].price / entryPx - 1;
    if (d < mae) mae = d;
    if (d > mfe) mfe = d;
  }
  const gross = (exitPx / entryPx - 1) * 100;
  return {
    entryDate: px[e].date, exitDate: px[x].date, entryPx, exitPx,
    /* 成本口径:SIM_COST_BPS = 10 bp = 0.10 个百分点,**整笔往返一次性扣**。
     * [13] 有一条断言盯着这件事:零成本与 10bp 的平均收益必须相差 0.1 个百分点。 */
    retPct: gross - costBps / 100,
    maePct: mae * 100, mfePct: mfe * 100,
    bars: x - e, entryI: e, exitI: x,
  };
}

/** 贪心不重叠去重后的独立事件数。
 *  持有 63 天的规则很容易连着 40 天天天触发,那 40 笔共享的是同一段行情,
 *  当成 40 个独立样本去算 z,分母虚高四十倍,任何噪声都会显著。effN 是给 z 用的真分母。 */
function simEffSample(trades) {
  let n = 0, win = 0, until = -1;
  for (const tr of trades) {
    if (tr.entryI > until) { n++; if (tr.retPct > 0) win++; until = tr.exitI; }
  }
  return { n, win };
}
function simEffN(trades) { return simEffSample(trades).n; }

/** 一组交易 → 一组统计。maxDD 的定义在这里写死,别处不许再算一遍。 */
function simStats(trades) {
  const n = trades.length;
  const eff = simEffSample(trades);
  const out = { n, win: 0, winPct: NaN, avgRet: NaN, medRet: NaN, maxDD: NaN, avgMAE: NaN, avgMFE: NaN,
    effN: eff.n, effWin: eff.win };
  if (!n) return out;
  const rets = trades.map(t => t.retPct);
  out.win = rets.filter(v => v > 0).length;
  out.winPct = out.win / n * 100;
  out.avgRet = rets.reduce((a, b) => a + b, 0) / n;
  const srt = rets.slice().sort((a, b) => a - b);
  out.medRet = percentile(srt, 0.5);
  out.avgMAE = trades.reduce((a, t) => a + t.maePct, 0) / n;
  out.avgMFE = trades.reduce((a, t) => a + t.mfePct, 0) / n;
  /* ---- maxDD:把每一笔按时间顺序接成一条权益曲线,取曲线上的最大回撤 ----
   * **不是**单笔最大亏损。两笔 -10% 接起来是 -19%(0.9×0.9),不是 -10%;
   * 而如果前面先赚了 5%,峰值是 1.05,同样两笔 -10% 就是 -19.0% 相对峰值。
   * 这条定义必须与 i18n 的 simMaxDDTip 一字对应 —— 面板上写着什么,这里就得算什么。 */
  let eq = 1, peak = 1, dd = 0;
  for (const v of rets) {
    eq *= (1 + v / 100);
    if (eq > peak) peak = eq;
    const d = eq / peak - 1;
    if (d < dd) dd = d;
  }
  out.maxDD = dd * 100;
  return out;
}

/** 同频随机入场对照:在同一段可入场区间里随机挑 nEvents 个入场日,持有期相同。
 *  种子固定 → 同样输入每次得到同一批日子(SPEC 3.2)。
 *  对照**不看任何规则**,这是它的全部意义:它回答"这段行情里随便买会怎样"。 */
function simControl(ticker, hold, nEvents, seed, opts) {
  const px = state.priceHist.get(ticker) || [];
  const o = opts || {};
  const warm = isFinite(o.warm) && o.warm > 0 ? Math.floor(o.warm) : SIM_WARM;
  const costBps = isFinite(o.costBps) ? o.costBps : SIM_COST_BPS;
  const lo = warm + 1, hi = px.length - 1 - hold;      /* 入场根的合法区间 [lo, hi] */
  const trades = [];
  if (!(nEvents > 0) || hi < lo) return Object.assign(simStats(trades), { trades, seed });
  const span = hi - lo + 1;
  /* 策略组持仓期间不重复开仓；对照也必须从生成时就满足同一约束。
   * 先在压缩坐标里无放回抽样，再按排序名次展开 hold 格，可保证相邻 entry > 前一 exit。 */
  const maxN = Math.floor((span + hold) / (hold + 1));
  const want = Math.min(nEvents, maxN);
  if (!(want > 0)) return Object.assign(simStats(trades), { trades, seed });
  const compactSpan = span - (want - 1) * hold;
  const rnd = simRng(seed);
  const picked = new Set();
  /* 不放回抽样;撞满 20×want 次还没抽够就停 —— 宁可对照少几笔,也不要一个死循环
   * 把浏览器挂住(want 接近 span 时碰撞率会很高)。 */
  let guard = 0;
  while (picked.size < want && guard++ < want * 20 + 200) {
    picked.add(Math.min(compactSpan - 1, Math.floor(rnd() * compactSpan)));
  }
  const idx = [...picked].sort((a, b) => a - b).map((q, i) => lo + q + i * hold);
  for (const e of idx) {
    const tr = simTrade(px, e, e + hold, costBps);
    if (tr) trades.push(tr);
  }
  return Object.assign(simStats(trades), { trades, seed });
}

/** 两比例 z(合并 p)。分母用 min(n, effN) —— 重叠持仓不算独立样本。 */
function simZ(a, b) {
  const na = Math.min(a.n, a.effN), nb = Math.min(b.n, b.effN);
  if (!(na > 0) || !(nb > 0)) return NaN;
  /* 胜场必须来自同一组实际非重叠交易，不能用整体胜率乘 effN 伪造。 */
  const ka = a.effWin, kb = b.effWin;
  if (!isFinite(ka) || !isFinite(kb)) return NaN;
  const p = (ka + kb) / (na + nb);
  const se = Math.sqrt(p * (1 - p) * (1 / na + 1 / nb));
  if (!(se > 0)) return NaN;
  return (ka / na - kb / nb) / se;
}

/** 规则回放。`hold` 是**交易日数**(5/21/63),`opts = { costBps, warm, seed }`。
 *  返回见 SPEC 3.2;`warn` ∈ 'thin' | 'overlap' | 'noTrigger' | 'shortHistory'。 */
function simRun(ticker, rule, hold, opts) {
  const o = opts || {};
  const costBps = isFinite(o.costBps) ? o.costBps : SIM_COST_BPS;
  const warm = isFinite(o.warm) && o.warm > 0 ? Math.floor(o.warm) : SIM_WARM;
  const h = isFinite(hold) && hold > 0 ? Math.floor(hold) : PX_HORIZONS.mid;
  const hz = simHzKey(h);
  const px = state.priceHist.get(ticker) || [];
  const co = state.companies.get(ticker) || null;
  const ruleText = ruleToText(rule);
  const seed = isFinite(o.seed) ? o.seed : simHash(ticker + '|' + ruleText);
  const warn = [];
  const trades = [];

  const empty = () => {
    const st = simStats(trades);
    const ctrl = simControl(ticker, h, 0, seed, { warm, costBps });
    return Object.assign(st, { trades, ctrl, z: NaN, warn, hold: h, horizon: hz, ruleText, seed, costBps,
      scanned: 0, from: px.length ? px[0].date : null, to: px.length ? px[px.length - 1].date : null });
  };
  if (!co || !rule || !Array.isArray(rule.all) || !rule.all.length) { warn.push('noTrigger'); return empty(); }
  /* 能扫的信号根:[warm, len-2-hold] —— 入场在 i+1,出场在 i+1+hold,两根都必须存在。 */
  const first = warm, last = px.length - 2 - h;
  if (last < first) { warn.push('shortHistory'); warn.push('noTrigger'); return empty(); }
  if (last - first + 1 < 60) warn.push('shortHistory');

  /* 估值参考线对 up/down 没有任何影响(engine.js 里它们走 valRefs,永不入表),
   * 所以这里给 r = null:省掉 250 次 calcRange,结果一模一样。 */
  let prevP = null;
  let heldUntil = -1;
  let scanned = 0;
  for (let i = first; i <= last; i++) {
    /* **每一根都现算**。pressureLevels 内部按 px[i].date 做 as-of 截断,
     * 历史不够(不足 40 根收益、既无密度带又无 OI 墙)时它返回 null —— 那是正常输出,
     * 不是异常:谓词拿到 ctx.P === null 应当自己判"不知道",而不是崩。 */
    let P = null;
    try { P = pressureLevels(co, null, px[i].date, hz); }
    catch (e) { P = null; }                            /* asOfSlice 越界之类:这一根跳过,不打断整场回放 */
    scanned++;
    const base = {
      ticker, i, px, price: px[i].price, prev: i > 0 ? px[i - 1].price : NaN,
      sd: P ? P.sd : NaN, u: P ? P.u : NaN, P, prevP, ref: px[i].date,
    };
    prevP = P;
    if (i + 1 <= heldUntil) continue;                  /* 已有持仓 → 同一时刻不重复开仓 */
    let hit = true;
    for (const c of rule.all) {
      const pred = SIM_PREDICATES[c.p];
      if (!pred) { hit = false; break; }
      base.args = c.args || [];
      let v = false;
      try { v = !!pred.fn(base); } catch (e) { v = false; }
      if (!v) { hit = false; break; }
    }
    if (!hit) continue;
    const tr = simTrade(px, i + 1, i + 1 + h, costBps);
    if (!tr) continue;
    tr.sigDate = px[i].date;
    trades.push(tr);
    heldUntil = tr.exitI;
  }

  const st = simStats(trades);
  const ctrl = simControl(ticker, h, st.n, seed, { warm, costBps });
  if (!st.n) warn.push('noTrigger');
  else {
    if (st.n < SIM_MIN_TRIG) warn.push('thin');
    if (st.effN < st.n) warn.push('overlap');
  }
  return Object.assign(st, {
    trades, ctrl, z: st.n ? simZ(st, ctrl) : NaN, warn,
    hold: h, horizon: hz, ruleText, seed, costBps, scanned,
    from: px[first] ? px[first].date : null, to: px[px.length - 1] ? px[px.length - 1].date : null,
  });
}
