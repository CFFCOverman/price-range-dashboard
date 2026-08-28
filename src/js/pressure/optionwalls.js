/* ================= 期权轨:未平仓量(OI)墙 —— 一层前瞻标注,不是一条压力轨 =================
 * 为什么它在这里但又"不算数":可回测的期权快照只有 4–5 个交易日(其中一天还是 18–37 行的残链)。
 * 这不是"样本小",是**没有时间序列** —— 没有时间序列就无法回答"这堵墙顶住了没有",
 * 于是这一轨永远进不了任何 z 检验。它渲染、它写前瞻台账,但它不产生百分比、不参与排序、
 * 不影响 up/down 的先后。`evidence` 因此是**写死的字面量 'pending'**,不由任何输入决定 ——
 * 防的事故是:有人往台账里塞几行就把它"升级"成 verified,而升级的依据其实一条都没有。
 *
 * 旧版那个 `strength = 55·(oi/maxOI) + 20·w + 25·align` 的 0–100 加权分**整个删除**,
 * 不得以任何名义恢复。它与后续走势的相关系数实测 r≈+0.01,而它在界面上是一根进度条 ——
 * 进度条这个视觉隐喻本身就在宣称"越长越可信"。表里只留带单位的原始量(OI、dte、align)。
 *
 * 七个 PX_OPT_* 参数本轮一个都不许调:在 5 个数据点上调 7 个参数,得到的不是校准,是拟合噪声。
 *
 * ---- 2026-07-30 那笔老账(下面三条行为是当时修出来的,这里逐条保留并在测试里钉死)----
 *   ① **周度期权把月度挤出去了。** 一份 NVDA 导出里有 12 个到期日,"最近两个"选中的是
 *      08/03、08/05 这种薄得没人参与的周度链,而 OI 真正堆着的月度 08/21 被整个忽略。
 *      所以选到期日的标准是"**窗口内 OI 最重的那几个**",不是日历上的远近;
 *      远近改由权重 w 连续衰减表达,而不是靠排名一刀切。
 *   ② **零 OI 行把均值压下去了。** 导出给的是整条链,一大半行权价 OI 是 0;把它们算进分母,
 *      `avg × 1.5` 这道门槛就形同虚设,于是满屏都是"墙"。均值只在真有人参与的行权价上算。
 *   ③ **当天到期的链占着最高权重。** 判据是 `expiry <= today`(不是 `<`)——
 *      今天到期的链今晚就归零,对明天之后一点约束力都没有,让它拿走一个名额是净损失。 */

/** 单个到期日的 max pain:让所有持有人内在价值总和最小的行权价。
 *  它是**磁吸位**参考,不是障碍位 —— 不进 walls,只挂在 expiries 上给面板打印。 */
function maxPain(rows) {
  let best = null, bestPay = Infinity;
  for (const s of rows) {
    let pay = 0;
    for (const r of rows) {
      pay += r.callOI * Math.max(0, s.strike - r.strike) + r.putOI * Math.max(0, r.strike - s.strike);
    }
    if (pay < bestPay) { bestPay = pay; best = s.strike; }
  }
  return best;
}

/** 行权价是不是落在整五十 / 整二十五的网格上。
 *  用整数分(×100 再取模)而不是直接对浮点取模:真导出里有 152.5 这种半档行权价,
 *  `152.5 % 25` 在浮点上不一定得到干净的 0,分层就会随机漏掉几行 ——
 *  H2 组按这个标记分层,标记漂一次,那一组的结论就整个作废。 */
function optGridMark(strike) {
  if (!isFinite(strike)) return { isGrid50: false, isGrid25: false };
  const c = Math.round(strike * 100);
  if (Math.abs(c - strike * 100) > 1e-6) return { isGrid50: false, isGrid25: false };
  const g50 = c % 5000 === 0;
  return { isGrid50: g50, isGrid25: !g50 && c % 2500 === 0 };
}

/** 期权链 → OI 墙。返回 { walls, expiries, window, evidence:'pending' } | null。
 *  walls[] = { strike, oi, callOI, putOI, expiry, dte, w, align, isGrid50, isGrid25 }。
 *
 *  第三参 `h` 是持有期(5/21/63)。它**故意不参与任何筛选**:七个 PX_OPT_* 冻结,
 *  一旦让 h 去改 MAX_DTE 或权重,等于在 5 个快照上按持有期分三套参数调 —— 那是纯拟合。
 *  留着这个参数只是为了让 engine.js 对三条轨用同一种调用形状,将来真有了 OI 时间序列
 *  再决定它该不该起作用。 */
function optionWalls(co, refISO, h) {
  const history = co && state.options.get(co.ticker);
  if (!history || !history.length || !isFinite(co.price) || co.price <= 0) return null;
  const today = (refISO || new Date().toISOString().slice(0, 10));
  /* 每个合约只取参照日前最新快照。state.options 保留全历史供行为面板使用，
   * 压力位若直接累加所有快照，会把同一份仓位重复算十几遍。 */
  const latest = new Map();
  for (const r of history) {
    if (refISO && r.asof && r.asof > refISO) continue;
    const k = r.expiry + '|' + r.strike, old = latest.get(k);
    if (!old || (r.asof || '') >= (old.asof || '')) latest.set(k, r);
  }
  const arr = [...latest.values()];
  /* 行权价窗口必须围着 **as-of 那天的价** 取,不是 `co.price`(那永远是今天的价)。
   * 写成 `co.price` 的后果是 refISO 对这个函数**完全无效**:回放到 2025-03 的某一天,
   * 窗口仍然以 2026-08 的价为中心 —— 一年的涨幅足以让整条链落到 ±PX_OPT_WINDOW 之外,
   * 于是那天"一面墙都没有";反过来在下跌票上会挑出一批当时根本不在价内外的行权价。
   * 这一轨现在 evidence='pending'、不进任何统计,所以这个偷看不影响任何已发布的数字;
   * 但把一个已知的未来函数留在代码里,下一个把它接进统计的人一定会踩上去。
   * 同理,下面判断"上方看涨占优 / 下方看跌占优"的 align 也必须用同一个 px。 */
  const px = asOfPrice(co.ticker, refISO || null, co.price);
  if (!isFinite(px) || px <= 0) return null;
  const dteOf = e => Math.round((new Date(e + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  const oiOf = r => r.callOI + r.putOI;
  const byExp = new Map();
  for (const r of arr) {
    /* ---- as-of 闸门:**快照日晚于参照日的行,一条都不许进** ----
     * 这是这个文件里最后一个、也是最严重的一个未来函数。上面那段修的是"窗口中心用错了价",
     * 这一条修的是"整批 OI 本身就来自未来":Assets/options/ 下的链只有一个很窄的近期窗口
     * (NVDA-US 是 2026-07-29 ~ 2026-08-06),而回放会把 refISO 拨到几周甚至一年前。
     * 少了这道闸门,站在 2026-07-01 那天读到的是 08-06 收盘之后才登记下来的未平仓量 ——
     * **一份在参照日之后拍下的快照不是证据,是答案本身。** 拿它当"当时看得见的信息",
     * 等于先看了后面的走势再回头画墙,画出来的墙当然处处应验。
     * 事故的形态是可见的:线上 breakoutBuy 在 NVDA 上触发 4 次、五个候选位置 tracks 全是
     * ["opt"];而回测那边从不往 state.options 里塞链,同一条规则一次都不触发 ——
     * 同一份代码在两条路径上给出两种世界,差的就是这一行。
     * 判据用 `>` 不用 `>=`:参照日**当天**收盘后登记的 OI 是那天收盘时就存在的存量,
     * 与 expiry 那条 `<=` 不同,这里没有"今晚归零"的问题。
     * refISO 为空(线上看今天)时不设限:那时候没有"未来"可偷。 */
    if (r.expiry <= today) continue;                          // 见文件头 ③:今晚归零的链不占名额
    if (dteOf(r.expiry) > PX_OPT_MAX_DTE) continue;           // 超出视野的远月对当下价格没有钉住力
    if (Math.abs(r.strike / px - 1) > PX_OPT_WINDOW) continue;
    if (!byExp.has(r.expiry)) byExp.set(r.expiry, []);
    byExp.get(r.expiry).push(r);
  }
  /* 见文件头 ①:按窗口内 OI 总量选到期日,选完再按日期排(面板要按时间读)。 */
  const exps = [...byExp.keys()]
    .sort((a, b) => byExp.get(b).reduce((s, r) => s + oiOf(r), 0) - byExp.get(a).reduce((s, r) => s + oiOf(r), 0))
    .slice(0, PX_OPT_EXPIRIES)
    .sort();
  if (!exps.length) return null;
  const walls = [], expiries = [];
  exps.forEach(expiry => {
    const rows = byExp.get(expiry).slice().sort((a, b) => a.strike - b.strike);
    const live = rows.filter(r => oiOf(r) > 0);               // 见文件头 ②:零 OI 行不进分母
    const tot = live.reduce((s, r) => s + oiOf(r), 0);
    if (!tot) return;
    const avg = tot / live.length;
    const dte = dteOf(expiry);
    const w = 1 / (1 + dte / PX_OPT_DTE_HALF);
    expiries.push({ expiry, dte, w, maxPain: maxPain(rows), nStrike: live.length,
      callOI: rows.reduce((s, r) => s + r.callOI, 0), putOI: rows.reduce((s, r) => s + r.putOI, 0) });
    const picked = live.filter(r => oiOf(r) >= Math.max(PX_OPT_MIN_OI, avg * PX_OPT_WALL_X))
      .sort((a, b) => oiOf(b) - oiOf(a)).slice(0, PX_OPT_KEEP);
    for (const r of picked) {
      const oi = oiOf(r);
      /* 方位一致性:上方要看涨占优才像阻力,下方要看跌占优才像支撑。
       * 方向不一致的大 OI 更可能是别人的对冲腿。align 现在是**一个原始比例的三档标签**,
       * 不再乘进任何合成分 —— 它只被渲染出来给人看,不参与任何排序。 */
      const share = r.strike > px ? r.callOI / oi : r.putOI / oi;
      const align = share >= 0.6 ? 1 : share >= 0.4 ? 0.5 : 0.25;
      const g = optGridMark(r.strike);
      walls.push({ strike: r.strike, oi, callOI: r.callOI, putOI: r.putOI, expiry, dte, w, align,
        isGrid50: g.isGrid50, isGrid25: g.isGrid25 });
    }
  });
  if (!walls.length && !expiries.length) return null;
  /* 字面量,不是变量:evidence 不许因为任何输入变成 verified。 */
  return { walls, expiries, window: PX_OPT_WINDOW, evidence: 'pending' };
}
