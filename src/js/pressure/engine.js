/* ================= 压力位引擎:组装 =================
 * 取 as-of 价 → 拿密度带与 OI 墙 → 合并 → 算触及概率 → 按现价分上下。
 *
 * 这个文件**不做**四件事,每一件都是上一版做过并且被自己的回测否掉的:
 *   ① 不给 0–100 强度分。旧 `strength` 与后续走势的相关是 r≈+0.01,而它在界面上是进度条,
 *      进度条这个隐喻本身就在宣称"越长越可信"。表里只留带单位的原始量。
 *   ② 不预测方向。
 *   ③ 不预测"守不守得住"。三套不同对照都得到同一个"没有"(max|z| 1.06–1.20,门槛 2),
 *      所以 `why` 里必须有一句明说这件事测不出来 —— 少了一个功能而不说,用户会以为它还在。
 *   ④ 不把估值线放进 up/down。本仓库 D 组回测已判 `valAnchorBias = biased`:
 *      中枢相对现价的偏离中位数为负、方向命中率跌破 50%(P/E 分位取自该票自身历史,
 *      而这一年是再评级行情)。一条被自家回测判为系统性挂偏的线,不能继续占"压力位"这个名分。
 *      它降级为图上的虚线参考刻度,走 `valRefs`,永不进 up/down、永不参与合并。 */

/** 按当前语种挑一句话。用 typeof 兜住是因为回测在 vm 里可能没装 i18n.js ——
 *  引擎不该因为少了一个词表就整个不能跑。 */
function pxWhy(zh, en) { return (typeof LANG === 'string' && LANG === 'en') ? en : zh; }

/** as-of 那天的收盘价。refISO 为 null → 用 fallback(即 co.price)。
 *
 *  **这个函数存在的唯一理由是修一个已知的未来函数。** 上一版 `pressureLevels` 拿 `co.price`
 *  切分 up/down,而 `co.price` 永远是**今天**的价 —— 历史回放时,2025 年那一天的"上方压力"
 *  是按 2026 年的价算出来的。后果不是数字略偏,是 `price > up[0].hi` 这类突破规则
 *  在回放里**永远不可能触发**:上方压力被今天的高价推得要么全在下方、要么远得出视野。
 *  回测于是安静地少掉一整类事件,报告上看起来只是"这条规则触发次数少"。 */
function asOfPrice(ticker, refISO, fallback) {
  if (!refISO) return fallback;
  const all = state.priceHist.get(ticker);
  if (!all || !all.length) return fallback;
  /* 时间截断只走 asOfSlice 这一个口子;它越界会抛错,这里不接 —— 抛错是要的,
   * 静默用错日期的价才是要防的那件事。 */
  const seg = asOfSlice(all, refISO);
  const p = seg.length ? seg[seg.length - 1].price : NaN;
  return (isFinite(p) && p > 0) ? p : fallback;
}

/** 估值参考线:基准 EPS × 五个 P/E 分位。取代旧的 `valuationLevels`。
 *  **调用方只有渲染层。** 改名是故意的:旧名字叫 "levels",与压力位表里的 Level 同名,
 *  于是"顺手把它也 push 进 up/down"变成一个很自然的动作。改叫 refs 之后,
 *  再想合并就得先改名字,而改名字这件事会被人看见。
 *  这里刻意只用基准 EPS(不用悲观/乐观),这样每条线只含估值一个变量,
 *  跟核心区间(EPS 情景 × 分位,两个变量一起动)是不同的问题,不要混为一谈。 */
function valuationRefs(co, r) {
  if (!r || !r.eps || !r.pe) return [];
  const e = r.eps.mean, pe = r.pe;
  const defs = [['p10', 'plV10'], ['p25', 'plV25'], ['p50', 'plV50'], ['p75', 'plV75'], ['p90', 'plV90']];
  const out = [];
  for (const [k, key] of defs) {
    if (!pePos(pe, k)) continue;
    const v = e * pe[k];
    if (!isFinite(v) || v <= 0) continue;
    out.push({ price: v, pct: k, label: (typeof t === 'function' ? t(key) : key), x: pe[k] });
  }
  return out;
}

/** 压力位 / 支撑位。名字不许改:tests/test-app.mjs 与 tools/backtest.mjs 都直接按名调。
 *  horizon ∈ 'short'|'mid'|'long';**缺省与任何非法值一律退回 'mid'**。
 *
 *  为什么这道退回必须存在、而且必须**出声**:`state.horizon` 已经被**财年**占用了
 *  ('fy1'/'fy2'),它和持有期是两个东西却共用一个字段名。若有人顺手写
 *  `pressureLevels(co, r, null, state.horizon)`,`PX_HORIZONS['fy1']` = undefined
 *  → `√undefined` = NaN → u = NaN → `edgeU <= PX_REACH_U` 恒为 false
 *  → up/down 两个数组都空 → 渲染层走进 `sec.hidden = true` → **面板整个消失,控制台干干净净**。
 *  用户看到的是"这只票没数据",不是 bug。所以退回之后还要往 why 里推一句可见的提示。 */
function pressureLevels(co, r, refISO, horizon) {
  if (!co || !isFinite(co.price) || co.price <= 0) return null;
  const ref = refISO || null;
  const why = [];

  let hz = horizon;
  if (hz !== 'short' && hz !== 'mid' && hz !== 'long') {
    if (horizon !== undefined && horizon !== null && horizon !== '') {
      why.push(pxWhy('不认识的持有期「' + String(horizon) + '」—— 已退回中线(21 个交易日)。'
        + '注意 state.horizon 是**财年**(fy1/fy2),不是持有期,两者不能互相传。',
        'Unrecognised horizon "' + String(horizon) + '" — fell back to mid (21 sessions). '
        + 'Note state.horizon holds a fiscal year (fy1/fy2), not a holding period.'));
    }
    hz = 'mid';
  }
  const h = PX_HORIZONS[hz];

  /* 现价:回放时必须是 as-of 那天的价,不是 co.price(见 asOfPrice 的注释)。 */
  const price = asOfPrice(co.ticker, ref, co.price);
  const sig = sigmaD(co.ticker, ref, PX_SIGMA_WIN);
  const sd = sig ? sig.sd : NaN;
  const u = scaleU(sd, h, price);

  const dens = priceDensity(co.ticker, ref, h);
  const opt = optionWalls(co, ref, h);
  const walls = opt ? opt.walls : [];
  const valRefs = valuationRefs(co, r);
  /* 估值线不算"内容":上一版把它算进来,于是一只完全没有日线、没有期权链的票
   * 也能画出五条"支撑位"。现在没有技术带也没有 OI 墙就是没有位置可报。 */
  if (!dens && !walls.length) return null;

  let asOf = dens ? dens.asOf : null;
  if (!asOf) {
    const all = state.priceHist.get(co.ticker);
    const seg = (all && all.length) ? asOfSlice(all, ref) : [];
    asOf = seg.length ? seg[seg.length - 1].date : (ref || null);
  }

  /* ---- 候选:技术带(有宽度)+ OI 墙(是点) ---- */
  const raw = [];
  if (dens && dens.bands.length) {
    for (const b of dens.bands) raw.push({ lo: b.lo, hi: b.hi, mid: b.peak, tech: b, opts: [] });
  }
  /* 合并容差改用 PX_MERGE_U·u,取代旧的固定 1.5%:固定百分比对高波动票太严、对低波动票太松,
   * 同一个 1.5% 在两只票上表达的根本不是同一件事。u 是无量纲化以后的"本期一个标准差"。 */
  const mergeAbs = (isFinite(u) && u > 0) ? PX_MERGE_U * u : NaN;
  for (const w of walls) {
    let host = raw.find(L => L.tech && w.strike >= L.lo && w.strike <= L.hi);
    if (!host && isFinite(mergeAbs)) host = raw.find(L => !L.tech && Math.abs(w.strike - L.mid) <= mergeAbs);
    if (host) {
      host.opts.push(w);
      if (!host.tech) { host.lo = Math.min(host.lo, w.strike); host.hi = Math.max(host.hi, w.strike); }
    } else raw.push({ lo: w.strike, hi: w.strike, mid: w.strike, tech: null, opts: [w] });
  }

  /* ---- 每个位置算距离与触及概率 ---- */
  const levels = raw.map(L => {
    /* 概率用**到最近边缘**的距离,不用到中心的距离:带是有宽度的,
     * 价格碰到边缘就算"触及"了,用中心会系统性低估触及概率。 */
    const edgeAbs = price < L.lo ? L.lo - price : price > L.hi ? price - L.hi : 0;
    return {
      lo: L.lo, hi: L.hi, mid: L.mid,
      distU: (L.mid - price) / u,
      distPct: (L.mid / price - 1) * 100,
      edgeU: edgeAbs / u,
      /* 量纲:reachProb 的分母是 `c·sd·√h`,那是一个**收益率**尺度(无量纲),
       * 所以分子也必须是收益率 —— 传 edgeAbs / price,不能传 edgeAbs 本身。
       * SPEC 3.2 的注释写的是 `reachProb(edgeU*u, ...)`,edgeU*u 恰好等于 edgeAbs(元),
       * 照那样传下去 z = edgeAbs/(c·sd·√h) 会被价格放大约 P 倍:116 元的票、半个 u 的距离
       * 得到 z≈68 → Φ(−68) 下溢成 0 → **整列触及概率恒为 0.00%**。
       * 这正是 SPEC 4.3 危险清单里"概率静默塌到 0"那一条描述的事故形态,
       * 只不过这次放大倍数来自 P 而不是 √252。数全在 [0,1] 里,不抛错,没人看得出来。
       * 这里改的是**调用方的量纲**,scale.js 的公式与七个参数一个字没动。 */
      pReach: reachProb(edgeAbs / price, sd, h, PX_REACH_C[h]),
      tracks: [L.tech && 'tech', L.opts.length && 'opt'].filter(Boolean),
      src: { tech: L.tech, opts: L.opts },
      /* 含期权腿就整条取期权轨那一档 —— 一条未验证的腿不会因为旁边站着一条已验证的腿
       * 就变得可验证;混着报等于把 pending 洗成 verified。这条论证与等级本身无关,
       * 所以它在两个等级都变成 pending 之后照样成立:取的永远是**更弱的那一档**。
       *
       * 两个等级现在都从 PX_EVIDENCE 读,不再是写死的字面量。理由不是洁癖,是可执行性:
       * SPEC 3.9 的兜底条款说「任何一格判为未过,该腿的 evidence 落为 pending」,
       * 而字面量让这句话**无法被执行** —— 改 PX_EVIDENCE.reach 对用户看到的东西零影响,
       * 实测把它翻成 'pending' 得到的是 {before:'已验证', after:'已验证', changed:false}。
       * 一个改了没反应的开关不是开关,是装饰;降级条款靠它兜底,就等于没有兜底。
       * 现在这一行是参数的函数,回测判语一变,徽章和百分比跟着变,不需要谁记得来改代码。 */
      evidence: L.opts.length ? PX_EVIDENCE.opt : PX_EVIDENCE.reach,
    };
  });

  /* 视野闸门:距离超过 PX_REACH_U 个 u 的位置本期不入表 —— 再远就不是"本期的位置"。
   * u 为 NaN 时这个比较恒为 false,于是两张表都空、面板消失。这是**有意**的:
   * 消失看得见,一屏 NaN 或一屏 99% 看不见。 */
  const inView = levels.filter(L => L.edgeU <= PX_REACH_U);
  const inBand = inView.find(L => L.src.tech && price >= L.lo && price <= L.hi) || null;
  const up = inView.filter(L => L.mid > price && L !== inBand).sort((a, b) => a.mid - b.mid).slice(0, PX_KEEP);
  const down = inView.filter(L => L.mid < price && L !== inBand).sort((a, b) => b.mid - a.mid).slice(0, PX_KEEP);

  why.push(pxWhy(
    '这张表只回答"本期够不够得着",不回答"挡不挡得住"。**我们不预测支撑位会不会守住** —— '
    + '用距离匹配的对照测过,在这份数据上测不出任何优于对照的守位能力(最大 z ≈ 1.2,门槛 2)。',
    'This table answers "can price reach it," not "will it stop there." **We do not predict whether a level holds** — '
    + 'tested against distance-matched controls, no track beat control on any horizon (max z ≈ 1.2 against a threshold of 2).'));
  why.push(pxWhy(
    '长中短期不是三套算法,是同一把尺子的三个刻度:持有期越长,同一个位置的不确定性越大,带子就越宽'
    + '(√5 : √21 : √63 ≈ 1 : 2 : 3.6)。',
    'Long/mid/short are not three algorithms but three notches on one ruler: the longer the horizon, '
    + 'the wider the band around the same level (√5 : √21 : √63 ≈ 1 : 2 : 3.6).'));
  if (!isFinite(u) || u <= 0) {
    why.push(pxWhy('日波动率估不出来(样本不足 ' + PX_SIGMA_MIN_N + ' 根收益,或价格序列有非正值),'
      + '本期长度单位 u 无效 —— 宁可一条都不报,也不报一批没有尺度的位置。',
      'Daily volatility could not be estimated (fewer than ' + PX_SIGMA_MIN_N + ' returns, or non-positive prices), '
      + 'so the length unit u is invalid — reporting nothing beats reporting levels with no scale.'));
  }
  if (valRefs.length) {
    why.push(pxWhy('估值参考线只画在图上,一条都不进上下两张表:本仓库 D 组回测已判它系统性挂偏'
      + '(中位偏离为负、方向命中率低于 50%)。',
      'Valuation reference lines are drawn on the chart only and never enter the tables: this repo\'s group-D '
      + 'backtest flagged them as systematically biased (negative median deviation, sub-50% directional hit rate).'));
  }
  if (walls.length) {
    why.push(pxWhy('OI 墙 ' + walls.length + ' 面 · 未验证:可回测的期权快照只有 4–5 天(其中一天是残链),'
      + '没有时间序列就没法检验"这堵墙顶住没有"。这一轨只标注,不进任何统计、不影响排序。',
      walls.length + ' OI wall(s) · unverified: only 4–5 usable option snapshots exist (one a partial chain). '
      + 'Without a time series there is no way to test whether a wall held. This track annotates only.'));
  }

  return {
    horizon: hz, h, sd, u, price, asOf,
    up, down, inBand,
    dens, opt,
    valRefs,
    /* 浅拷贝而不是直接交出 PX_EVIDENCE:调用方(渲染层)拿到的是一次快照,
     * 谁写坏了都传染不回参数表。 */
    evidence: { reach: PX_EVIDENCE.reach, contain: PX_EVIDENCE.contain, bounce: PX_EVIDENCE.bounce,
      opt: PX_EVIDENCE.opt, val: PX_EVIDENCE.val },
    why,
  };
}
