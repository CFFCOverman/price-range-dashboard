/* ================= 买入规则:谓词表 · 预设 · 受限解析器 =================
 * 本文件只定义"什么算一次买入信号",不执行任何回放(回放在 sim/engine.js)。
 *
 * ---- 两条不许破的规矩 ----
 * ① **没有 eval,没有 new Function,没有正则驱动的动态派发。** 自定义输入框里的字符串
 *    只经过下面这个手写词法器,词法器只认:谓词名(必须在 SIM_PREDICATES 里)、数字、
 *    `and`、圆括号、逗号。别的一律在词法阶段就死掉。这个面板的输入框是页面上唯一一处
 *    "用户文本 → 被执行的东西"的通道,它一旦能执行任意代码,整份"数据只在本地处理"的
 *    承诺就没了(用户会把它连同 CSV 一起发给同事)。
 * ② **谓词 fn 是纯函数,只读 ctx,且只许读 ctx.px 里 index ≤ ctx.i 的元素。**
 *    读到 i 之后就是未来函数 —— 回放会变成一条漂亮的净值曲线,而且不抛任何错。
 *    as-of 截断由 sim/engine.js 统一做(它把当天的 pressureLevels 结果放进 ctx.P),
 *    谓词自己不许再切片、不许自己调 state.priceHist。
 *
 * 解析失败返回 `{ok:false, error:'simRuleErr', at:<看不懂的那一段>}`,**不抛异常**:
 * 这个函数在 `input` 事件里被调用,而 input 处理器里抛出去的错会连带打断后面所有绑定。 */

/** 谓词的参数取值:约束在 [min,max] 里,坏值一律退回 def。
 *  解析器已经拦掉了非数字,这里防的是"合法数字但离谱"(比如 nearSupport(999) —— 恒真规则,
 *  会得到一条"每天都买"的回放,而那条曲线读起来跟一条真规则一模一样)。 */
function simArg(args, k, spec) {
  const v = Array.isArray(args) ? args[k] : undefined;
  if (!isFinite(v)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, v));
}

/** 简单均线,只回看:mean(px[i-n+1 .. i])。i-n+1 < 0 返回 NaN(热身不够就不出信号)。 */
function simMA(px, i, n) {
  if (!(n > 0) || i - n + 1 < 0) return NaN;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += px[j].price;
  return s / n;
}

/* 六个谓词,不多不少。每个 fn 只读 ctx;参数走 ctx.args(引擎逐个谓词填进去),
 * 这样 fn 的签名保持 SPEC 3.2 写死的 fn(ctx) → boolean。 */
const SIM_PREDICATES = {
  /* 下方最近的支撑,离现价不到 arg 个 σ(edgeU 是到带**边缘**的距离,单位 1u)。 */
  nearSupport: {
    labelKey: 'nearSupport', argSpec: [{ def: 0.5, min: 0.01, max: 3 }],
    fn(ctx) {
      const L = ctx.P && ctx.P.down && ctx.P.down[0];
      return !!L && isFinite(L.edgeU) && L.edgeU <= simArg(ctx.args, 0, this.argSpec[0]);
    },
  },
  /* 上方最近的压力,离现价不到 arg 个 σ。 */
  nearResistance: {
    labelKey: 'nearResistance', argSpec: [{ def: 0.5, min: 0.01, max: 3 }],
    fn(ctx) {
      const L = ctx.P && ctx.P.up && ctx.P.up[0];
      return !!L && isFinite(L.edgeU) && L.edgeU <= simArg(ctx.args, 0, this.argSpec[0]);
    },
  },
  /* 向上突破**昨天**那条最近压力。
   *
   * ---- 这里与 SPEC 3.2 的字面写法不同,理由必须留下 ----
   * SPEC 写的是 `price > P.up[0].hi && prev <= P.up[0].hi`,其中 P 是**当天**的结果。
   * 那个条件**永远为 false**,一次都触发不了:engine.js 里 up 的定义是 `L.mid > price`,
   * 而 mid ∈ [lo, hi],所以 up[0].hi ≥ up[0].mid > price 恒成立 —— `price > up[0].hi`
   * 和它自相矛盾。突破一旦发生,那条带当天就已经掉进 down 里了,不在 up 里。
   * 这不是"少触发几次",是这条预设整条死掉,而面板只会显示"触发 0 次",看起来像
   * "这只票这一年没突破过"。
   * 所以这里用**上一根**的 as-of 结果 ctx.prevP(引擎按 px[i-1].date 算的,不含任何未来信息):
   * 昨天它还在上方,今天收盘站上了它的上沿 = 突破。 */
  breakResistance: {
    labelKey: 'breakResistance', argSpec: [],
    fn(ctx) {
      const R = ctx.prevP && ctx.prevP.up && ctx.prevP.up[0];
      if (!R || !isFinite(R.hi)) return false;
      /* 第二个子句在几何上由 prevP 的构造保证(prev < R.mid ≤ R.hi),留着是一道明写的护栏:
       * 哪天 ctx.prevP 被接错成别的根,这里会先熄火,而不是静默多报一批突破。 */
      return ctx.price > R.hi && ctx.prev <= R.hi;
    },
  },
  /* 近 arg0 根内的最高收盘回撤了 arg1(0.08 = 8%)。只看 i 及之前。 */
  pullbackPct: {
    labelKey: 'pullbackPct', argSpec: [{ def: 20, min: 2, max: 250 }, { def: 0.08, min: 0.005, max: 0.9 }],
    fn(ctx) {
      const w = Math.round(simArg(ctx.args, 0, this.argSpec[0]));
      const d = simArg(ctx.args, 1, this.argSpec[1]);
      const from = Math.max(0, ctx.i - w + 1);
      if (ctx.i - from + 1 < 2) return false;
      let mx = -Infinity;
      for (let j = from; j <= ctx.i; j++) if (ctx.px[j].price > mx) mx = ctx.px[j].price;
      if (!(mx > 0)) return false;
      return ctx.price / mx - 1 <= -d;
    },
  },
  /* 短均线上穿长均线(金叉):今天在上、昨天不在上。 */
  maCross: {
    labelKey: 'maCross', argSpec: [{ def: 20, min: 2, max: 250 }, { def: 60, min: 3, max: 400 }],
    fn(ctx) {
      const a = Math.round(simArg(ctx.args, 0, this.argSpec[0]));
      const b = Math.round(simArg(ctx.args, 1, this.argSpec[1]));
      if (!(b > a) || ctx.i < 1) return false;
      const s0 = simMA(ctx.px, ctx.i, a), l0 = simMA(ctx.px, ctx.i, b);
      const s1 = simMA(ctx.px, ctx.i - 1, a), l1 = simMA(ctx.px, ctx.i - 1, b);
      if (!isFinite(s0) || !isFinite(l0) || !isFinite(s1) || !isFinite(l1)) return false;
      return s0 > l0 && s1 <= l1;
    },
  },
  /* 上方最近的压力"本期够不着"(触及概率 ≤ arg)—— 也就是头顶暂时没有挡路的东西。
   * 上方压根没有位置入表时视为够不着,这是这条规则本来的意思。 */
  reachBelow: {
    labelKey: 'reachBelow', argSpec: [{ def: 0.4, min: 0.01, max: 1 }],
    fn(ctx) {
      if (!ctx.P) return false;                        /* 连位置表都算不出来 = 不知道,不是"没有压力" */
      const L = ctx.P.up && ctx.P.up[0];
      if (!L) return true;
      return isFinite(L.pReach) && L.pReach <= simArg(ctx.args, 0, this.argSpec[0]);
    },
  },
};

/* 五个预设。`hold` 直接引用 PX_HORIZONS(交易日数)—— 这就是 manifest 里
 * sim/rules.js(27)必须排在 pressure/params.js(21)之后的唯一原因:
 * 顶层 const 按 manifest 顺序求值,放反了这里是 TDZ ReferenceError。
 * 注意 hold 只是每个预设的**建议**持有期,面板上那个下拉才是实际用的那个。 */
const SIM_PRESETS = [
  { id: 'supportBuy', labelKey: 'supportBuy', hold: PX_HORIZONS.mid, all: [{ p: 'nearSupport', args: [0.5] }], exitKey: 'hold' },
  { id: 'breakoutBuy', labelKey: 'breakoutBuy', hold: PX_HORIZONS.short, all: [{ p: 'breakResistance', args: [] }], exitKey: 'hold' },
  { id: 'dipBuy', labelKey: 'dipBuy', hold: PX_HORIZONS.mid, all: [{ p: 'pullbackPct', args: [20, 0.08] }], exitKey: 'hold' },
  { id: 'trendBuy', labelKey: 'trendBuy', hold: PX_HORIZONS.long, all: [{ p: 'maCross', args: [20, 60] }], exitKey: 'hold' },
  { id: 'roomBuy', labelKey: 'roomBuy', hold: PX_HORIZONS.mid, all: [{ p: 'reachBelow', args: [0.4] }], exitKey: 'hold' },
];

/** 词法器。手写、逐字符,只吐五种 token:name / num / and / punct / bad。
 *  **刻意不用正则做派发**:抓一个"名字 + 括号 + 参数"的模式再按名字去查表,写起来短得多,
 *  但那种写法对 `foo(1)` 和 `nearSupport(1)` 一视同仁,于是"认不认识这个名字"这件事
 *  就被推迟到执行期,而执行期已经太晚了。这里名字的合法性在词法阶段就查表。 */
function simLex(text) {
  /* 连"这个字符算不算标识符"都用逐字符比较,不用 /\w/ ——
   * 本文件里一个正则都不出现,是为了让"这里没有任何东西能被当成代码执行"这件事
   * 用肉眼一次就能读完,而不是要先想清楚某个正则会不会回溯出别的分支。 */
  const isD = c => c >= '0' && c <= '9';
  const isA = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const s = String(text == null ? '' : text);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ k: c, v: c, at: i }); i++; continue; }
    if (isD(c) || c === '.' || c === '-' || c === '+') {
      let j = i, seen = false, dot = false;
      if (s[j] === '-' || s[j] === '+') j++;
      while (j < s.length) {
        const d = s[j];
        if (isD(d)) { seen = true; j++; continue; }
        if (d === '.' && !dot) { dot = true; j++; continue; }
        break;
      }
      const raw = s.slice(i, j);
      if (!seen) return { ok: false, at: raw || c };
      out.push({ k: 'num', v: parseFloat(raw), at: i });
      i = j; continue;
    }
    if (isA(c)) {
      let j = i;
      while (j < s.length && (isA(s[j]) || isD(s[j]))) j++;
      const w = s.slice(i, j);
      if (w === 'and' || w === 'AND' || w === 'And') out.push({ k: 'and', v: 'and', at: i });
      /* 名字不在谓词表里 = 词法阶段就失败。`or`、`not`、`eval`、`window` 都走这一条。 */
      else if (Object.prototype.hasOwnProperty.call(SIM_PREDICATES, w)) out.push({ k: 'name', v: w, at: i });
      else return { ok: false, at: w };
      i = j; continue;
    }
    /* 别的字符一个都不认:`+ - * / = ; { } [ ] $ ' " 反引号 中文` 全在这里死掉。 */
    return { ok: false, at: c };
  }
  return { ok: true, toks: out };
}

/** 受限文法:
 *    rule := call ( 'and' call )*
 *    call := NAME '(' [ NUM (',' NUM)* ] ')'
 *  **没有分组括号、没有 or、没有 not、没有表达式**。只有 `and` 意味着不需要优先级,
 *  也就不需要一棵树 —— 结果是一个扁平的 {all:[...]},与 SIM_PRESETS 的结构一模一样,
 *  于是"预设"和"自定义"在下游走的是同一条代码路径(两条路径迟早会长歪一条)。
 *
 *  返回 {ok:true, rule} 或 {ok:false, error:'simRuleErr', at}。**任何情况下都不抛。** */
function parseRule(text) {
  const bad = at => ({ ok: false, error: 'simRuleErr', at: String(at == null ? '' : at).slice(0, 40) });
  const lx = simLex(text);
  if (!lx.ok) return bad(lx.at);
  const toks = lx.toks;
  if (!toks.length) return bad('');                    /* 空串也是"看不懂",渲染层显示 ∅ */
  const all = [];
  let i = 0;
  for (;;) {
    const nm = toks[i];
    if (!nm || nm.k !== 'name') return bad(nm ? String(nm.v) : '');
    const spec = SIM_PREDICATES[nm.v].argSpec;
    if (!toks[i + 1] || toks[i + 1].k !== '(') return bad(nm.v);
    i += 2;
    const args = [];
    if (toks[i] && toks[i].k === ')') i++;
    else {
      for (;;) {
        if (!toks[i] || toks[i].k !== 'num') return bad(toks[i] ? String(toks[i].v) : nm.v);
        args.push(toks[i].v); i++;
        if (toks[i] && toks[i].k === ',') { i++; continue; }
        if (toks[i] && toks[i].k === ')') { i++; break; }
        return bad(toks[i] ? String(toks[i].v) : nm.v);
      }
    }
    /* 参数个数不对也算看不懂:多给的会被无声丢掉,少给的会退回默认值,
     * 两种都让用户以为自己写的那条规则被执行了,而实际跑的是另一条。 */
    if (args.length > spec.length) return bad(nm.v);
    all.push({ p: nm.v, args });
    if (i >= toks.length) break;
    if (toks[i].k !== 'and') return bad(String(toks[i].v));
    i++;
  }
  return { ok: true, rule: { all }, error: null, at: null };
}

/** rule → 规范文本。用于:显示预设的实际条件、把规则文本喂进对照的种子哈希。
 *  必须是**规范形式**(固定空格、固定分隔符),否则同一条规则写法不同就会得到不同的种子,
 *  "同样输入每次跑出同一个数"这条承诺当场破功。 */
function ruleToText(rule) {
  if (!rule || !Array.isArray(rule.all)) return '';
  return rule.all.map(c => c.p + '(' + (c.args || []).map(a => String(a)).join(',') + ')').join(' and ');
}
