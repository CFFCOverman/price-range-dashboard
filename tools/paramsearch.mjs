#!/usr/bin/env node
/* tools/paramsearch.mjs —— 唯一一次调参搜索,和它的诚实评分口径
 * Author: Xuhao Chao · License: MIT
 *
 * ============================================================================
 * 【这个脚本存在的理由,以及它最想防住的那件事】
 *
 * SPEC 3.9 兜底条款只给三个参数开了搜索许可(`PX_SIGMA_WIN`、`PX_REACH_C`、
 * `PX_HALFLIFE_D`),判据写死为「LOO-CV 的样本外 Brier」。听上去照做就行 ——
 * 问题在于「样本外」这三个字,在开始搜索的那一瞬间会**偷偷换意思**。
 *
 * 现状是这样的:`reachProb` 在运行期**一个拟合参数都没有**。`PX_REACH_C` 是三个字面量,
 * 不由任何数据估出来。所以 G 组那个 10 折「样本外」split,唯一被逐折重估的东西是
 * **气候基准**(对照臂),模型臂从头到尾是同一条公式。把基准钉死成全样本值再跑一遍,
 * 得到 0.2325 / 0.0913 / 0.2611 —— 与样本内**逐位相同**。也就是说,现在那个 OOS 增益
 * 全部来自「给对照上了个让分」,不是模型里的技能。这不是 bug,是这套设计的实情,
 * 但它必须被说出来,否则下一步就会踩空。
 *
 * 下一步就是这个脚本。**一旦开始拿折结果去挑 c,c 就变成了一个拟合参数**,
 * 而「在这些折上挑出来、又在这些折上报分」是教科书式的样本内。它一定会给出漂亮数字,
 * 而且漂亮得毫无意义。所以本脚本的评分口径是**嵌套的**:
 *
 *   外层:留一只票(10 只 → 10 折)。
 *   内层:只在**训练折的 9 只票**里再做一次留一,用它挑配置 —— 留出那只票的任何一条
 *         观测都没参与过挑选。
 *   结算:用内层挑出来的配置去预测留出票,气候基准也只用那 9 只票的触及率。
 *   汇总:10 只留出票的 Brier 汇总成一个 skill。这是**整套搜索流程**的样本外分数,
 *         不是某个配置的分数 —— 而「要不要做这次搜索」问的正是流程的分,不是赢家的分。
 *
 * 对照臂是**同一套嵌套流程、但候选集只有 SPEC 3.3 初值一个**(即不搜索)。
 * 两者相减才是「搜索这件事到底带来了什么」。这个减法要是不为正,答案就是不为正。
 *
 * 【为什么每个配置的分也照样全部打印】
 * 只印赢家等于让读者相信搜索过程。140 个配置每一个都印:配置 + 它在固定配置下的
 * 留一票样本外 skill(固定配置没有拟合,这个数本身是诚实的)。谁想复核「有没有偷偷
 * 换过判据」,把这张表按 skill 排一遍就知道赢家是不是真的第一名。
 *
 * 【注入机制:为什么不能"装完再赋值"】
 * `PX_*` 是顶层 `const`,落在 vm 全局的词法环境里,既不挂 `globalThis` 也不可重新赋值。
 * 所以覆盖只能发生在**脚本进沙箱之前**:`loadDashboard(overrides)` 会把 params.js 的
 * 源码文本里那一行 `const X = …;` 换掉再送进去,而且要求正则命中且只命中一次,
 * 装完再从 bridge 出来的 `ctx.PX` 上回读一遍核对。磁盘上的 params.js 一个字节不动。
 * `PX_REACH_C` 走的是另一条路 —— 见下面 pOf() 的注释,它根本不需要重跑引擎。
 *
 * 用法:node tools/paramsearch.mjs [--h 5,21,63]
 */

import { loadDashboard, loadDaily, testReach, tCrit95 } from './backtest.mjs';

/* ── 0. 搜索空间:逐字抄自 SPEC 3.3 的「搜索范围」栏,一个值不多一个值不少 ──────
 * 表里其余 21 个常量的搜索范围栏写的是「不调」,所以它们不在这里出现,也不许出现。 */
const INIT = { PX_SIGMA_WIN: 60, PX_HALFLIFE_D: 365, PX_REACH_C: { 5: 0.60, 21: 0.86, 63: 1.02 } };
const GRID_SIGMA = [20, 40, 60, 120];                     /* SPEC 3.3:{20,40,60,120} */
const GRID_HALF = [45, 90, 180, 365, Infinity];           /* SPEC 3.3:{45,90,180,365,Infinity} */
/* SPEC 3.3:「各 ±0.15,步长 0.05」。逐 h 展开,四舍五入到两位免得浮点尾巴进标签。 */
const cGrid = h => [-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15]
  .map(d => Math.round((INIT.PX_REACH_C[h] + d) * 100) / 100).filter(c => c > 0);

/* ── 1. 小工具 ───────────────────────────────────────────────────────────── */
const f2 = v => (isFinite(v) ? v.toFixed(2) : '—');
const f3 = v => (isFinite(v) ? v.toFixed(3) : '—');
const f4 = v => (isFinite(v) ? v.toFixed(4) : '—');
const pad = (s, w) => String(s).padEnd(w, ' ');
const lpad = (s, w) => String(s).padStart(w, ' ');
const H = s => `\n\x1b[1m${s}\x1b[0m\n${'─'.repeat(74)}`;
const halfLabel = v => (isFinite(v) ? String(v) : '∞');

/** 一个配置的人话标签。搜索表里每一行都靠它对上号,所以它必须无歧义。 */
const cfgLabel = (win, half, c) => `win=${lpad(win, 3)} 半衰=${lpad(halfLabel(half), 3)} c=${c.toFixed(2)}`;

/* ── 2. 概率:换 c 不必重跑引擎 ───────────────────────────────────────────
 * `pReach = reachProb(edgeAbs/price, sd, h, c)`,而视野闸门 `edgeU ≤ PX_REACH_U`
 * 只看 edgeU,与 c 无关。所以对固定的 (PX_SIGMA_WIN, PX_HALFLIFE_D),
 * **观测集合(哪些位置入表、各自的 edge 与结局)完全不随 c 变**,变的只有那一列概率。
 * 于是 c 的搜索退化成对已有观测重算一列 —— 但重算用的必须是 `ctx.reachProb` **本尊**,
 * 传的是 testReach 当场留档的原始入参(es/sds)。在这里照抄一遍 2Φ(−e/(c·sd·√h))
 * 测的就成了"我公式抄得对不对",不是"引擎算得对不对"(backtest.mjs 开头第 1 条纪律)。 */
const pOf = (ctx, R, c) => R.es.map((e, i) => ctx.reachProb(e, R.sds[i], R.h, c));

/* ── 3. 留一票的样本外 skill(固定配置用) ──────────────────────────────────
 * 与 backtest.mjs 里 G 组算 skillOOS 的口径逐字一致:折 = 标的,气候基准只用训练折算,
 * 汇总方式是按观测数加权的 Brier 池化。`drop` 用来在嵌套的内层里把留出票整只摘掉。 */
function looSkill(ctx, R, ps, drop) {
  const idx = [];
  for (let i = 0; i < R.ys.length; i++) if (!drop || !drop.has(R.tks[i])) idx.push(i);
  const keys = [...new Set(idx.map(i => R.tks[i]))];
  let sm = 0, sb = 0, nn = 0;
  for (const k of keys) {
    const te = [], tr = [];
    for (const i of idx) (R.tks[i] === k ? te : tr).push(i);
    if (!te.length || !tr.length) continue;
    const b0 = tr.reduce((a, i) => a + R.ys[i], 0) / tr.length;
    const yy = te.map(i => R.ys[i]);
    const bM = ctx.brier(te.map(i => ps[i]), yy);
    const bB = ctx.brier(yy.map(() => b0), yy);
    if (!isFinite(bM) || !isFinite(bB)) continue;
    sm += bM * te.length; sb += bB * te.length; nn += te.length;
  }
  return { skill: sb > 0 ? 1 - sm / sb : NaN, n: nn };
}

/* ── 4. 嵌套留一:整套搜索流程的样本外分 ────────────────────────────────────
 * cands = 候选池。对照臂传长度 1 的池(= 不搜索),处理臂传全网格。
 * 内层只看训练折,外层那只票在挑选时是不存在的。 */
function nestedLoo(ctx, cands, tickers) {
  let sm = 0, sb = 0, nn = 0;
  const picks = [], oofP = [], oofY = [], foldSkill = [];
  for (const k of tickers) {
    const drop = new Set([k]);
    let best = null;
    for (const cd of cands) {
      const s = looSkill(ctx, cd.R, cd.ps, drop).skill;
      if (isFinite(s) && (!best || s > best.s)) best = { s, cd };
    }
    if (!best) continue;
    const R = best.cd.R, ps = best.cd.ps;
    const te = [], tr = [];
    for (let i = 0; i < R.ys.length; i++) (R.tks[i] === k ? te : tr).push(i);
    if (!te.length || !tr.length) { picks.push({ tk: k, label: best.cd.label, inner: best.s, n: 0 }); continue; }
    const b0 = tr.reduce((a, i) => a + R.ys[i], 0) / tr.length;
    const yy = te.map(i => R.ys[i]);
    const bM = ctx.brier(te.map(i => ps[i]), yy);
    const bB = ctx.brier(yy.map(() => b0), yy);
    if (!isFinite(bM) || !isFinite(bB)) continue;
    sm += bM * te.length; sb += bB * te.length; nn += te.length;
    if (bB > 0) foldSkill.push(1 - bM / bB);
    for (const i of te) { oofP.push(ps[i]); oofY.push(R.ys[i]); }
    picks.push({ tk: k, label: best.cd.label, inner: best.s, n: te.length, base: b0 });
  }
  /* CV 下界:SPEC 3.9 三条判据里的第二条。临界值跟着实际折数走 —— 用 tCrit95(df)
   * 而不是 1.96,和 G 组同一个函数本尊,免得两处对"下界"的算法悄悄分家。 */
  const m = foldSkill.reduce((a, x) => a + x, 0) / (foldSkill.length || 1);
  const sd = foldSkill.length > 1
    ? Math.sqrt(foldSkill.reduce((a, x) => a + (x - m) * (x - m), 0) / (foldSkill.length - 1)) : NaN;
  const t = tCrit95(foldSkill.length - 1);
  const cvLo = isFinite(sd) && isFinite(t) ? m - t * sd / Math.sqrt(foldSkill.length) : NaN;
  return { skill: sb > 0 ? 1 - sm / sb : NaN, n: nn, picks, oofP, oofY, foldSkill, cvLo, cvDf: foldSkill.length - 1 };
}

/** 10 桶可靠性图的最大偏差,口径与 G 组那张表一致(门槛 0.10 也是同一个预注册值)。
 *  这里喂的是**留出折的预测**,所以它同样是样本外的。 */
function maxDevOf(ps, ys) {
  const b = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, sy: 0 }));
  for (let i = 0; i < ps.length; i++) {
    const j = Math.min(9, Math.max(0, Math.floor(ps[i] * 10)));
    b[j].n++; b[j].sp += ps[i]; b[j].sy += ys[i];
  }
  let m = NaN;
  for (const x of b) { if (!x.n) continue; const d = Math.abs(x.sy / x.n - x.sp / x.n); if (!(m >= d)) m = d; }
  return m;
}

/* ── 5. 主流程 ───────────────────────────────────────────────────────────── */
function main() {
  const argv = process.argv.slice(2);
  const hArg = (argv.find(a => a.startsWith('--h')) || '').split('=')[1];
  const HZ = hArg ? hArg.split(',').map(Number) : [5, 21, 63];

  console.log(H('参数搜索 —— 判据、口径,以及为什么它是嵌套的'));
  console.log('  \x1b[90m许可范围:SPEC 3.9 兜底条款点名的三个参数,其余 21 个常量冻结,一个字不碰。\x1b[0m');
  console.log('  \x1b[90m判据:留一票交叉验证的**样本外 Brier skill**。不是命中率,不是 z,不是样本内 skill。\x1b[0m');
  console.log('  \x1b[90m嵌套的理由:reachProb 运行期零拟合参数,一旦拿折结果挑 c,c 就成了拟合参数 ——\x1b[0m');
  console.log('  \x1b[90m在同一批折上挑、又在同一批折上报分,是样本内。所以配置只在训练折里挑,留出票不参与挑选。\x1b[0m');

  const { cos } = loadDaily();
  if (!cos.size) { console.log('\n  Assets/charting 里没有日线,搜索无从谈起。'); process.exit(1); }
  console.log(`\n  盘上 ${cos.size} 只标的 —— 外层折数就是它,一只票一折。`);

  /* 引擎必须真跑的只有 (PX_SIGMA_WIN × PX_HALFLIFE_D) 这 20 个组合:这两个参数会改变
   * σ、带的位置和视野闸门,也就是改变**观测集合本身**;c 只改概率那一列(见 pOf 注释)。 */
  const engines = [];
  for (const win of GRID_SIGMA) for (const half of GRID_HALF) engines.push({ win, half });
  console.log(`  引擎需要真跑的组合:${GRID_SIGMA.length} × ${GRID_HALF.length} = ${engines.length} 次`
    + `(c 不改变观测集合,只改概率那一列,所以它不需要重跑引擎)。`);

  /* runs.get(`${win}|${half}`) = testReach 的原始返回,按 h 索引 */
  const runs = new Map();
  const t0 = Date.now();
  for (const e of engines) {
    const ov = {};
    if (e.win !== INIT.PX_SIGMA_WIN) ov.PX_SIGMA_WIN = e.win;
    if (e.half !== INIT.PX_HALFLIFE_D) ov.PX_HALFLIFE_D = e.half;
    const ctx = loadDashboard(ov);
    const res = testReach(ctx, cos, HZ, {});
    const byH = new Map();
    for (const r of res) byH.set(r.h, r);
    runs.set(`${e.win}|${e.half}`, byH);
  }
  console.log(`  引擎跑完,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s。`);

  /* 一个 ctx 够用了:下面只调 reachProb / brier 这两个纯函数,它们不读 PX_*。 */
  const ctx = loadDashboard();

  /* ---- 一致性断言:换 c 的那条捷径必须与引擎逐位相同 ----------------------
   * 用初值 c 重算一遍概率,必须与引擎自己算出来的 pReach 逐位相等。对不上就说明
   * es/sds 留档留错了,后面整张搜索表全是废纸 —— 这种错不会抛,只会让数字好看或难看。 */
  for (const h of HZ) {
    const R = runs.get(`${INIT.PX_SIGMA_WIN}|${INIT.PX_HALFLIFE_D}`).get(h);
    if (!R || R.thin) continue;
    const re = pOf(ctx, R, INIT.PX_REACH_C[h]);
    let mx = 0;
    for (let i = 0; i < R.ps.length; i++) mx = Math.max(mx, Math.abs(re[i] - R.ps[i]));
    if (!(mx < 1e-12)) throw new Error(`h=${h}:用初值 c 重算的概率与引擎的 pReach 最大差 ${mx} —— es/sds 留档口径不对`);
  }
  console.log('  \x1b[90m一致性断言通过:用初值 c 经 reachProb 本尊重算的概率,与引擎输出的 pReach 逐位相同(差 < 1e-12)。\x1b[0m');

  /* ---- 空组合点名:哪些格子一条观测都没有,以及为什么 --------------------
   * 不点名的话,"候选 105 个"会被读成"搜索范围就是 105 个",而 SPEC 3.3 写的
   * 是 4 × 5 × 7 = 140。差的那 35 个不是被我筛掉的,是引擎在那一档吐不出观测。 */
  const dead = [];
  for (const e of engines) {
    const gone = HZ.filter(h => { const R = runs.get(`${e.win}|${e.half}`).get(h); return !R || R.thin || !R.n; });
    if (gone.length) dead.push({ e, gone });
  }
  if (dead.length) {
    const winsAllDead = GRID_SIGMA.filter(w => GRID_HALF.every(hf =>
      HZ.every(h => { const R = runs.get(`${w}|${hf}`).get(h); return !R || R.thin || !R.n; })));
    console.log(`  \x1b[33m${dead.length} 个引擎组合在至少一个持有期上零观测,已从候选池剔除(不是筛选,是根本没数)。\x1b[0m`);
    for (const w of winsAllDead)
      console.log(`  \x1b[33m  PX_SIGMA_WIN=${w}:全 ${GRID_HALF.length} 档半衰期、全 3 个持有期都是零观测 ——\x1b[0m`
        + `\x1b[33m 冻结常量 PX_SIGMA_MIN_N=40 要求至少 40 根收益,${w} 根窗口喂不满,sigmaD() 直接返回 null。\x1b[0m`);
    console.log('  \x1b[33m  这是 SPEC 3.3 的搜索范围与冻结常量之间的一处矛盾:范围里写着的值,引擎跑不出来。\x1b[0m');
    console.log('  \x1b[33m  本轮不改任何冻结常量,只把这件事记下来。\x1b[0m');
  }

  /* ---- 第一段:PX_HALFLIFE_D 的裁决(SPEC D6 / 4.1,本轮必须完成) -------- */
  console.log(H('① PX_HALFLIFE_D 裁决(SPEC D6:搜索集 {45,90,180,365,∞},极差 < 0.005 判 no_effect)'));
  console.log('  \x1b[90m其余两个参数按初值钉住(win=60,c 用 3.3 初值)—— 单参数扫描才答得了"这一个参数有没有效应"。\x1b[0m');
  console.log('  \x1b[90m平均带宽是 SPEC 4.1 点名要的混杂探针:若 skill 与带宽同步动,那条曲线测的是带宽不是半衰期。\x1b[0m');
  const halfVerdict = {};
  for (const h of HZ) {
    console.log(`\n  \x1b[1mh = ${h} 日\x1b[0m`);
    console.log(`    ${pad('半衰期', 8)}${lpad('样本', 7)}${lpad('平均带宽u', 11)}${lpad('样本外skill', 13)}${lpad('样本内skill', 13)}`);
    const vals = [];
    for (const half of GRID_HALF) {
      const R = runs.get(`${INIT.PX_SIGMA_WIN}|${half}`).get(h);
      if (!R || R.thin) { console.log(`    ${pad(halfLabel(half), 8)}${lpad(0, 7)}  这一档一条观测都没有`); continue; }
      const ps = pOf(ctx, R, INIT.PX_REACH_C[h]);
      const s = looSkill(ctx, R, ps).skill;
      vals.push({ half, s, w: R.meanBandU, n: R.n });
      console.log(`    ${pad(halfLabel(half), 8)}${lpad(R.n, 7)}${lpad(f3(R.meanBandU), 11)}${lpad(f4(s), 13)}${lpad(f4(R.skillIn), 13)}`);
    }
    const ss = vals.map(v => v.s).filter(isFinite);
    const range = ss.length ? Math.max(...ss) - Math.min(...ss) : NaN;
    const ws = vals.map(v => v.w).filter(isFinite);
    const wRange = ws.length ? Math.max(...ws) - Math.min(...ws) : NaN;
    const noEffect = isFinite(range) && range < 0.005;
    halfVerdict[h] = { range, wRange, noEffect, best: vals.slice().sort((a, b) => b.s - a.s)[0] };
    console.log(`    \x1b[90m极差 ${f4(range)}(预注册门槛 0.005)→ ${noEffect ? '\x1b[33mno_effect\x1b[0m' : '\x1b[36m有差别,进第 ③ 段与另外两个参数一起接受嵌套评分\x1b[0m'}`
      + `;平均带宽极差 ${f3(wRange)}u。`);
  }

  /* ---- 第二段:全网格,每个配置一行,固定配置的留一票样本外 skill -------- */
  console.log(H('② 全网格逐配置(固定配置 = 零拟合参数,所以这一列的"样本外"是干净的)'));
  console.log('  \x1b[90m每个配置都印,不只印赢家:只印赢家等于让人相信搜索过程。想复核就按 skill 列排一遍。\x1b[0m');
  console.log('  \x1b[90m注意这一列**不能**拿来宣布提升 —— 挑出最大值这个动作本身就把它变成样本内了。宣布用第 ③ 段。\x1b[0m');
  const pool = {};                       /* pool[h] = 全部候选(带算好的概率列) */
  for (const h of HZ) {
    pool[h] = [];
    for (const e of engines) {
      const R = runs.get(`${e.win}|${e.half}`).get(h);
      if (!R || R.thin || !R.n) continue;
      for (const c of cGrid(h)) pool[h].push({ label: cfgLabel(e.win, e.half, c), win: e.win, half: e.half, c, R, ps: pOf(ctx, R, c) });
    }
  }
  for (const h of HZ) {
    console.log(`\n  \x1b[1mh = ${h} 日\x1b[0m   候选 ${pool[h].length} 个`
      + `(应为 ${engines.filter(e => { const R = runs.get(`${e.win}|${e.half}`).get(h); return R && !R.thin && R.n; }).length} 个可用引擎组合 × ${cGrid(h).length} 个 c)`);
    console.log(`    ${pad('配置', 30)}${lpad('样本', 7)}${lpad('样本外skill', 13)}`);
    const rows = pool[h].map(cd => ({ cd, s: looSkill(ctx, cd.R, cd.ps).skill }));
    for (const r of rows) console.log(`    ${pad(r.cd.label, 30)}${lpad(r.cd.R.n, 7)}${lpad(f4(r.s), 13)}`);
    const top = rows.slice().sort((a, b) => b.s - a.s)[0];
    const init = rows.find(r => r.cd.win === INIT.PX_SIGMA_WIN && r.cd.half === INIT.PX_HALFLIFE_D
      && Math.abs(r.cd.c - INIT.PX_REACH_C[h]) < 1e-9);
    console.log(`    \x1b[90m这张表里的最大值:${top.cd.label} → ${f4(top.s)};3.3 初值 ${init ? f4(init.s) : '—'}。`
      + `差 ${top && init ? f4(top.s - init.s) : '—'} —— 这个差**不是**提升,它是 ${rows.length} 个数里挑最大挑出来的。\x1b[0m`);
    /* 挑最大值这个动作能从纯噪声里榨出多少,拿"零信息候选池"当尺子量一下更直观:
     * 候选越多,最大值越大,这条关系与模型好不好无关。 */
    const spread = Math.max(...rows.map(r => r.s).filter(isFinite)) - Math.min(...rows.map(r => r.s).filter(isFinite));
    console.log(`    \x1b[90m全表跨度 ${f4(spread)};候选数 ${rows.length}。跨度越大、候选越多,"挑最大"的虚高就越大。\x1b[0m`);
  }

  /* ---- 第三段:嵌套评分,唯一有资格宣布结论的一段 ------------------------ */
  const GTH = { 5: 0, 21: 0.15, 63: 0.25 };     /* SPEC 3.9 预注册,跑完不许改 */
  const GDEV = 0.10;                            /* 同上:可靠性图 10 桶最大偏差 */
  const tickers = [...cos.keys()];

  /* 两轮搜索,一轮一个候选池。之所以是两轮而不是一轮接一轮地放宽:
   *   · 第一轮(全网格)问的是「在许可范围内随便挑,搜索这件事有没有净贡献」;
   *   · 第二轮(只搜 c)问的是一个**更干净**的问题 —— 改 PX_SIGMA_WIN / PX_HALFLIFE_D
   *     会改变**观测集合本身**(哪些位置入表、入表几条),两个配置比的其实是两道不同的题;
   *     而 c 只改概率那一列,观测集合逐条相同,是真正的同题对比。
   * 第二轮**不是**第一轮没过之后再去放宽条件找绿灯:它的候选池是第一轮的**子集**,
   * 门槛一个字没动,而且它先天更难赢(能挑的东西更少)。 */
  const ROUNDS = [
    { id: '第一轮', name: '全网格(win × 半衰 × c)',
      note: '许可范围内的全部组合。逐 h 各挑各的配置,比"三个持有期共用一套"宽松得多 —— 故意给搜索占便宜。',
      pick: h => pool[h] },
    { id: '第二轮', name: '只搜 c(引擎钉在 3.3 初值)',
      note: 'c 不改变观测集合,所以处理臂与对照臂逐条比的是同一批位置、同一批结局 —— 唯一没有"换了道题"嫌疑的对比。',
      pick: h => pool[h].filter(cd => cd.win === INIT.PX_SIGMA_WIN && cd.half === INIT.PX_HALFLIFE_D) },
  ];
  const summary = [];
  for (const R0 of ROUNDS) {
    console.log(H(`③ ${R0.id} · 嵌套留一 —— ${R0.name}`));
    console.log(`  \x1b[90m${R0.note}\x1b[0m`);
    console.log('  \x1b[90m对照臂 = 同一套嵌套流程,候选池只有 3.3 初值一个(= 根本不搜索)。两臂之差 = 搜索的净贡献。\x1b[0m');
    console.log(`\n  ${pad('周期', 6)}${lpad('候选数', 7)}${lpad('对照(不搜索)', 16)}${lpad('处理(搜索)', 14)}${lpad('净贡献', 10)}`
      + `${lpad('CV下界', 9)}${lpad('maxDev', 8)}${lpad('门槛', 8)}  判定`);
    for (const h of HZ) {
      const cands = R0.pick(h);
      const initCd = pool[h].find(cd => cd.win === INIT.PX_SIGMA_WIN && cd.half === INIT.PX_HALFLIFE_D
        && Math.abs(cd.c - INIT.PX_REACH_C[h]) < 1e-9);
      if (!initCd || !cands.length) { console.log(`  ${pad(h + '日', 6)}  初值配置在这一档没有观测,跳过`); continue; }
      const ctrl = nestedLoo(ctx, [initCd], tickers);
      const trt = nestedLoo(ctx, cands, tickers);
      const dev = maxDevOf(trt.oofP, trt.oofY);
      const th = GTH[h] ?? 0;
      /* SPEC 3.9 的三条判据,并联:skill 过门槛、CV 下界 > 0、可靠性图最大偏差 ≤ 0.10。
       * 门槛一个字不改;这里只是把它们全算进同一个 pass 里。 */
      const pass = isFinite(trt.skill) && trt.skill > th && isFinite(trt.cvLo) && trt.cvLo > 0
        && isFinite(dev) && dev <= GDEV;
      summary.push({ round: R0.id, h, cands: cands.length, ctrl: ctrl.skill, trt: trt.skill,
        gain: trt.skill - ctrl.skill, cvLo: trt.cvLo, cvDf: trt.cvDf, dev, th, pass, picks: trt.picks });
      console.log(`  ${pad(h + '日', 6)}${lpad(cands.length, 7)}${lpad(f4(ctrl.skill), 16)}${lpad(f4(trt.skill), 14)}`
        + `${lpad(f4(trt.skill - ctrl.skill), 10)}${lpad(f3(trt.cvLo), 9)}${lpad(f2(dev), 8)}${lpad('>' + th.toFixed(2), 8)}  `
        + (pass ? '\x1b[32m过线\x1b[0m' : '\x1b[31m未过线\x1b[0m'));
    }
    console.log('\n  \x1b[90m对照臂那一列应当与 tools/backtest.mjs 里 G 组打印的 OOS skill 逐位吻合 —— 两边是同一套折、同一套基准。\x1b[0m');
    console.log('  \x1b[90m对不上就说明这两个脚本对"样本外"的理解已经分家了,那时先修口径,别读结论。\x1b[0m');
  }

  console.log(H('④ 每一折挑中了什么(搜索的稳定性:折与折之间挑得不一样 = 挑的是噪声)'));
  for (const s of summary) {
    console.log(`\n  \x1b[1m${s.round} · h = ${s.h} 日\x1b[0m`);
    console.log(`    ${pad('留出票', 12)}${pad('训练折挑中的配置', 32)}${lpad('内层skill', 11)}${lpad('留出样本', 9)}`);
    for (const p of s.picks) console.log(`    ${pad(p.tk, 12)}${pad(p.label, 32)}${lpad(f4(p.inner), 11)}${lpad(p.n, 9)}`);
    const uniq = new Set(s.picks.map(p => p.label));
    console.log(`    \x1b[90m${s.picks.length} 折挑出 ${uniq.size} 套不同的配置。挑得越散,越说明被挑的是折间噪声而不是稳定效应。\x1b[0m`);
  }

  console.log(H('结论(照 SPEC 3.9 的三条并联判据念,门槛一个字不改)'));
  for (const s of summary) {
    const why = [];
    if (!(s.gain > 0)) why.push(`搜索的净贡献 ${f4(s.gain)} ≤ 0`);
    if (!(s.trt > s.th)) why.push(`嵌套样本外 skill ${f4(s.trt)} ≤ 门槛 ${s.th.toFixed(2)}`);
    if (!(isFinite(s.cvLo) && s.cvLo > 0)) why.push(`CV 下界 ${f3(s.cvLo)} ≤ 0`);
    if (!(isFinite(s.dev) && s.dev <= GDEV)) why.push(`留出折可靠性图最大偏差 ${f2(s.dev)} > ${GDEV.toFixed(2)}`);
    console.log(`  ${s.round} h=${lpad(s.h, 2)} 日:${why.length ? '\x1b[31m未过 —— ' + why.join(';') + '\x1b[0m' : '\x1b[32m判据全过\x1b[0m'}`);
  }
  const anyPass = summary.some(s => s.pass && s.gain > 0);
  console.log(`\n  \x1b[1m两轮合计 ${summary.length} 格,过线 ${summary.filter(s => s.pass && s.gain > 0).length} 格。\x1b[0m`);
  if (!anyPass) {
    console.log('  \x1b[33m没有任何一个持有期上,搜索出来的配置能在诚实的留出评分上同时满足三条预注册判据。\x1b[0m');
    console.log('  \x1b[33m照 SPEC 3.9 的兜底条款:三个参数一律取回 3.3 初值,不得为了让它过而回头改参数或改门槛。\x1b[0m');
  }
  console.log('\n  \x1b[90mPX_HALFLIFE_D 的裁决见第 ① 段的极差列;它是否 no_effect 由 0.005 这个预注册门槛说了算,不由好看不好看。\x1b[0m');
  console.log('  \x1b[90m本脚本只出数,不改 src/ 里的任何一个字节:让搜索脚本自己去改参数表,是下一类事故。\x1b[0m\n');
}

main();
