#!/usr/bin/env node
/* tools/backtest.mjs —— 回测:仪表盘画出来的那几条线,过去到底对不对
 * Author: Xuhao Chao · License: MIT
 *
 * 三条纪律,少一条结论就不值钱:
 *
 * 1. **测的必须是仪表盘真在跑的那份代码。** 下面用 vm 把 `src/js/**` 原样装进来,
 *    调的是 `volStats` / `priceDensity` / `peStats` 本尊。照着重写一份来测,
 *    测的就是我理解得对不对,不是它算得对不对 —— 那种绿灯毫无意义。
 *
 * 2. **只能用 t 及以前的数据算信号,再拿 t 之后的走势对账。** 任何一处偷看未来,
 *    结论都会好看得离谱。所有截断都在 `at()` 一个地方做。
 *
 * 3. **每个命中率旁边必须有基准和有效样本数。** "命中 61%" 单独摆着什么都不说明:
 *    要对照掷硬币 / 随机画的带 / 价格不变。而且窗口是重叠的,
 *    N=1800 里真正独立的只有 N/h 个,不写出来就是在拿重叠样本冒充证据。
 *
 * 用法:node tools/backtest.mjs [--h 5,21,63] [--log] [--selftest]
 *   --log  把这一轮的关键数字追加到 Assets/_logs/backtest-history.csv。
 *          存的是**长表**(一行一个指标)而不是宽表 —— 以后加一条腿只是多几行,
 *          宽表则要改表头,几个月后的历史就对不上列了。
 *   --selftest  只跑读盘层的夹具测试(不读 Assets/,不出报告),见 selfTest()。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'Assets');

/** xlsx 不能写成 `import * as XLSX from 'xlsx'`。
 *
 *  裸模块名是**从引用它的那个文件所在目录**逐级往上找 node_modules 的 —— 跟进程的
 *  cwd 一点关系都没有。这个文件在 tools/,于是只会看 tools/node_modules 和 根/node_modules;
 *  而 run-factset.bat 首次启动时是在 fetcher/ 里 npm i 的,包全躺在 fetcher/node_modules。
 *  结果就是:手动在仓库根 npm i 过的机器上一切正常,只用 bat 装过的机器上必崩
 *  ERR_MODULE_NOT_FOUND —— 而后者才是这个脚本被自动调起时的常态。
 *
 *  所以改成显式按锚点找:先本地,再 fetcher/,最后仓库根。三处都没有就自己打一句
 *  人话然后 exit 3(见下),不让 Node 把一整段堆栈糊到用户脸上。 */
function loadXLSX() {
  const anchors = [
    fileURLToPath(import.meta.url),
    path.join(ROOT, 'fetcher', 'package.json'),   /* bat 首次启动装的就是这里 */
    path.join(ROOT, 'package.json'),
  ];
  for (const a of anchors) {
    try { return createRequire(a)('xlsx'); }
    catch (e) { if (e?.code !== 'MODULE_NOT_FOUND') throw e; }   /* 只吞"没找到",别的照抛 */
  }
  return null;
}

const XLSX = loadXLSX();
if (!XLSX) {
  console.error('\x1b[33m回测要用 xlsx 读 FactSet 导出的表,三个地方都没找到:\x1b[0m');
  console.error('  ' + path.join(ROOT, 'tools', 'node_modules'));
  console.error('  ' + path.join(ROOT, 'fetcher', 'node_modules') + '   ← run-factset.bat 装的是这里');
  console.error('  ' + path.join(ROOT, 'node_modules'));
  console.error('\x1b[1m装一次就好:\x1b[0m  cd fetcher && npm i xlsx');
  process.exit(3);   /* 3 = 缺依赖,调用方(fetcher/lib/backtest.mjs)靠这个码分辨"跑挂了"和"根本没装" */
}

/* ── 0. 把 src/ 里的真代码装进沙箱 ───────────────────────────────────────── */

/** 把 `params.js` **源码文本**里某个顶层 const 的初值换掉,再送进沙箱。
 *
 *  为什么只能在进沙箱**之前**改源码,不能装完了在外面赋值:`PX_*` 是顶层 `const`,
 *  落在 vm 全局的**词法**环境里 —— 既不挂 `globalThis`(所以下面那行 bridge 才必须存在),
 *  也不可重新赋值。沙箱外面既读不到也写不动它,唯一的注入点就是脚本进沙箱前的这一步。
 *
 *  替换必须**命中且只命中一次**,命不中就当场抛。理由不是洁癖:一个静默失效的 override
 *  会让整轮搜索变成"同一个配置跑了二十遍",而终端上每一行印的配置名都不一样 ——
 *  出来的表格看着像一次搜索,其实是一个常数重复了二十次,事后完全分辨不出来。
 *  装载完成后还会拿桥出来的 `ctx.PX` 逐个对一遍实际值,两道锁。 */
function overrideParamSrc(src, ov) {
  const lit = v => (typeof v === 'number' ? String(v) : JSON.stringify(v));   /* Infinity 要走 String,JSON 会把它写成 null */
  for (const [k, v] of Object.entries(ov)) {
    const re = new RegExp('(^|\\n)(const ' + k + ' = )([^;]*);', 'g');
    const hit = src.match(re);
    if (!hit || hit.length !== 1)
      throw new Error(`params.js 里 \`const ${k} = …;\` 命中 ${hit ? hit.length : 0} 次(只许 1 次)—— override 注入不进去`);
    src = src.replace(re, (m, a, b) => a + b + lit(v) + ';');
  }
  return src;
}

/** 仪表盘是一堆浏览器全局脚本,不是 ESM;拿 vm 起一个假窗口把它们按序跑一遍,
 *  之后就能直接调 volStats / priceDensity / peStats / dirScores / marketScores 本尊。
 *
 *  `overrides`(可选,只给 tools/paramsearch.mjs 用)= `{ PX_SIGMA_WIN: 40, … }`。
 *  它改的是**装进沙箱那一份**的源码文本,磁盘上的 params.js 一个字节都不动 ——
 *  搜索进程崩在半路也不会留下一个被改过的参数表。 */
function loadDashboard(overrides) {
  const need = [
    'src/js/core/utils.js', 'src/js/core/i18n.js', 'src/js/core/state.js',
    'src/js/ingest/companies.js', 'src/js/ingest/resolve.js', 'src/js/ingest/signals.js',
    'src/js/valuation/calc.js', 'src/js/valuation/volstats.js',
    /* 压力位引擎五件套。**顺序必须与 src/manifest.json 的 21–25 一致**:顶层 const 按脚本
     * 顺序求值,params.js 的 PX_* 会被 scale/grid/engine 的顶层求值读到,放反了是 TDZ。 */
    'src/js/pressure/params.js', 'src/js/pressure/scale.js', 'src/js/pressure/grid.js',
    'src/js/pressure/optionwalls.js', 'src/js/pressure/engine.js',
    /* sim 两件套(第 8 步补齐)。必须排在 pressure/* 之后:SIM_PRESETS 是顶层 const,
     * 它的初值读 PX_HORIZONS,放到 params.js 前面就是 TDZ ReferenceError。
     * render/sim.js **不装**:它碰 DOM,而且回测不需要渲染层。 */
    'src/js/sim/rules.js', 'src/js/sim/engine.js',
    'src/js/direction/scores.js',
  ];
  const stub = () => ({ className: '', textContent: '', appendChild() {}, setAttribute() {}, style: {} });
  const ctx = vm.createContext({
    console, Math, Date, JSON, Map, Set, Array, Object, Number, String, isFinite, parseFloat, parseInt,
    document: { getElementById: () => null, createElement: stub, createElementNS: stub },
  });
  const ov = overrides && Object.keys(overrides).length ? overrides : null;
  for (const f of need) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) throw new Error(`回测要用的模块不在:${f}(src/ 布局变了?)`);
    let src = fs.readFileSync(p, 'utf8');
    if (ov && f.endsWith('pressure/params.js')) src = overrideParamSrc(src, ov);
    vm.runInContext(src, ctx, { filename: f });
  }
  /* `const state = {...}` 是词法声明,不会挂到全局对象上 —— 沙箱外面拿不到。
   * 所以在沙箱里面再跑一行,把要用的词法绑定显式搭出来。函数声明不需要这一步。 */
  vm.runInContext(`globalThis.state = state;
    globalThis.PX = { PX_SIGMA_WIN, PX_REACH_C, PX_HALF_U, PX_REACH_U, PX_MERGE_U,
                      PX_BIN_U, PX_LOOKBACK_D, PX_HALFLIFE_D, PX_SWING_K, PX_HORIZONS, PX_EVIDENCE };`,
    ctx, { filename: '<bridge>' });
  /* SIM_PRESETS 同样是词法 const,不挂全局 —— I 组(第 10 步)要按 id 遍历预设。 */
  vm.runInContext('globalThis.SIM_PRESETS = SIM_PRESETS;', ctx, { filename: '<bridge-sim>' });
  for (const fn of ['volStats', 'priceDensity', 'peStats', 'dirScores', 'marketScores', 'percentile', 'newsScore', 'ingestNews',
    'sigmaD', 'reachProb', 'pressureLevels', 'simRun'])
    if (typeof ctx[fn] !== 'function') throw new Error(`装进来了但没有 ${fn}() —— 函数改名了,回测跟着改`);
  if (!ctx.state || !(ctx.state.priceHist instanceof Map)) throw new Error('装进来了但没有 state.priceHist —— state 结构变了,回测跟着改');
  /* 用一个必炸的检查去挡一整类不炸的错误(SPEC 4.4a):PX_* 是顶层 const,不挂 globalThis。
   * 桥接漏一个常量,Node 侧读到的是 undefined 而**不抛错** —— 比如 PX_HALF_U 漏掉,
   * `0.35 * u` 变成 `undefined * u = NaN`,带宽 NaN → bands 空 → 报告上看起来像
   * "这段历史画不出带",而不像 bug。 */
  if (!ctx.PX || !ctx.PX.PX_REACH_C) throw new Error('装进来了但桥接没带出 PX —— 新增常量忘了加进 bridge');
  for (const k of ['PX_SIGMA_WIN', 'PX_REACH_C', 'PX_HALF_U', 'PX_REACH_U', 'PX_MERGE_U',
    'PX_BIN_U', 'PX_LOOKBACK_D', 'PX_HALFLIFE_D', 'PX_SWING_K', 'PX_HORIZONS', 'PX_EVIDENCE'])
    if (ctx.PX[k] === undefined) throw new Error(`桥接里的 PX.${k} 是 undefined —— params.js 改了名,bridge 跟着改`);
  /* override 的第二道锁:文本替换成功不等于沙箱里真的是这个值(比如替换命中了一段注释里的
   * 同名字符串)。这里从桥出来的 PX 上逐个回读一遍,对不上就抛 —— 见 overrideParamSrc 的注释。 */
  if (ov) for (const [k, v] of Object.entries(ov)) {
    const got = ctx.PX[k];
    const same = (v !== null && typeof v === 'object') ? JSON.stringify(got) === JSON.stringify(v) : got === v;
    if (!same) throw new Error(`override 没落地:PX.${k} 期望 ${JSON.stringify(v)},沙箱里读到 ${JSON.stringify(got)}`);
  }
  return ctx;
}

/* ── 1. 读盘:三份互相独立的历史 ─────────────────────────────────────────── */

const aoa = f => {
  const wb = XLSX.read(fs.readFileSync(f), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
};
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : NaN; };
const serialISO = v => {
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  const M = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const m = String(v || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+'?(\d{2,4})$/);
  if (!m) return null;
  const mo = M[m[2].toLowerCase()]; if (!mo) return null;
  return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + mo + '-' + m[1].padStart(2, '0');
};

/* 最少 K 根(回测读盘侧的下限):一份导出少于这么多根,整份跳过。
 * 以前这里写的是字面量 `px.length < 40`,浏览器摄取侧写的是字面量 `px.length < 13`,
 * 于是"13 < 40"只是两个文件各写各的、看上去像巧合。这两个 const 就是把它声明出来。
 *
 * 40 的出处:冻结常量 `PX_SIGMA_MIN_N = 40`(src/js/pressure/params.js,SPEC 附录标注"不调")。
 * sigmaD()(pressure/scale.js)与 priceDensity()(pressure/grid.js)都按它拒算。
 * 回测只经 sigmaD 消费日线,不足 40 根收益本来就出不了任何结论,
 * 在读盘处早筛掉比算到一半返回 null 干净。tools/ledger.mjs 里同一个 40 也是这么来的。
 *
 * 不变式:INGEST_MIN_BARS(13,见 src/js/ingest/charting.js)< BACKTEST_MIN_BARS(40)。
 * 两者服务的下游不同,**不是手误**:统一到 40 会让 SPCX-US(36 根)从面板上消失;
 * 统一到 13 会让回测拿 12 个收益率去估 σ。tests/test-app.mjs [16] 末尾三条钉的就是这个差。
 *
 * 这里写死 40 而不是从沙箱里读 PX_SIGMA_MIN_N:loadDaily() 不依赖 loadDashboard(),
 * 读盘先于装载,而顶层 const 不挂沙箱 globalThis(见本文件 bridge 那一段)。
 * 代价是这个 40 与 params.js 的 40 靠上面这段注释对齐,不是靠机器 —— 改一处要记得改另一处。 */
const BACKTEST_MIN_BARS = 40;

/** 日线:252 个交易日的收盘 + 成交量(**有** Open/High/Low 三列时一并读进来)。同时挑出四条市场级序列。
 *
 *  OHLC 这段的唯一职责是**读进来**,不参与本文件任何一个统计口径:
 *  附录 K.2 把需要 O/H/L 的那一整类指标判成 `pending_no_ohlc`,不许用收盘价近似出一个
 *  "差不多的 ATR" 再拿去过闸。所以盘上今天没有这三列时,下面每一个字段、每一个判定
 *  都与加这段之前逐字节相同 —— A/C/D/E/F/G/H/I/J 各组的数字不会因为这段代码动一位。
 *  返回值里额外带一个 `ohlcFiles`:只用于数据盘点那一行,并且**只在真读到 OHLC 时**才打印,
 *  这样今天的终端输出也一个字符都不变。
 *
 *  `dirArg`(可选,只给 `--selftest` 用)= 换一个目录读。缺省仍然是 `Assets/charting`,
 *  main() 和 tools/paramsearch.mjs 都不传 —— 默认路径这条线的行为与加这个参数之前逐字节相同。 */
function loadDaily(dirArg) {
  const dir = dirArg || path.join(ASSETS, 'charting');
  const cos = new Map(), mkt = new Map();
  let ohlcFiles = 0;
  if (!fs.existsSync(dir)) return { cos, mkt, ohlcFiles };
  for (const fn of fs.readdirSync(dir).filter(f => /\.xlsx?$/i.test(f))) {
    const a = aoa(path.join(dir, fn));
    const hdr = (a[0] || []).map(c => String(c || '').trim());
    const di = hdr.findIndex(h => /^date$/i.test(h));
    const ci = hdr.findIndex(h => / - Close$/i.test(h));
    const vi = hdr.findIndex(h => / - Volume$/i.test(h) || /^volume$/i.test(h));
    if (di < 0 || ci < 0) continue;
    /* 与 src/js/ingest/charting.js 和 fetcher/steps/charting.mjs 同一条列名正则:
     * "52 Week High" 里也有 High,只认 "^High$" 与 " - High$"。三列缺一就当没有。 */
    const oIdx = w => hdr.findIndex(h => new RegExp('(^| - )' + w + '$', 'i').test(h));
    const oi = oIdx('Open'), hi = oIdx('High'), li = oIdx('Low');
    const hasOHLCCols = oi >= 0 && hi >= 0 && li >= 0;
    const px = [];
    for (let i = 1; i < a.length; i++) {
      const r = a[i] || [], d = serialISO(r[di]), p = num(r[ci]);
      if (!d || !(p > 0)) continue;
      const rec = { date: d, price: p };
      if (vi >= 0) { const v = num(r[vi]); if (v > 0) rec.vol = v; }
      if (hasOHLCCols) {
        const o = num(r[oi]), hh = num(r[hi]), ll = num(r[li]);
        /* 自相矛盾的一根整根退回"只有收盘价":一根 high < low 的蜡烛仍然长得像数据 */
        if (o > 0 && hh > 0 && ll > 0 && hh >= ll && hh >= Math.max(o, p) && ll <= Math.min(o, p)) {
          rec.o = o; rec.h = hh; rec.l = ll;
        }
      }
      px.push(rec);
    }
    if (px.length < BACKTEST_MIN_BARS) continue;
    px.sort((x, y) => x.date < y.date ? -1 : 1);
    if (px.some(r => r.o > 0)) ohlcFiles++;
    const mm = /_MARKET-(BENCH|SECTOR|CREDIT|RATES)\s+([A-Z.]{1,6}-[A-Z]{2})/i.exec(fn);
    if (mm) mkt.set(mm[1].toUpperCase(), { sym: mm[2].toUpperCase(), px });
    else cos.set(fn.replace(/\s+Daily Charting\.xlsx?$/i, '').toUpperCase(), px);
  }
  return { cos, mkt, ohlcFiles };
}

/** 估值:Estimate History 是**月度**面板,盘上有 ~61 个月。
 *  价格用 `P/E × Mean` 逐月还原 —— 这跟仪表盘 ingest 是同一个恒等式,不是另造的口径。 */
function loadEstimates() {
  const dir = path.join(ASSETS, 'estimates');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const fn of fs.readdirSync(dir).filter(f => /FY1 Estimate History\.xlsx?$/i.test(f))) {
    const a = aoa(path.join(dir, fn));
    const sec = a.findIndex(r => String((r || [])[0] || '').trim() === 'Estimate History');
    if (sec < 0) continue;
    const head = (a[sec + 1] || []).map(h => String(h || '').trim().toLowerCase());
    const ix = n => head.indexOf(n);
    const cD = ix('date'), cM = ix('mean'), cL = ix('low'), cH = ix('high'), cP = ix('p/e (x)');
    const cN = ix('num of est'), cU = ix('num up'), cW = ix('num down');
    if (cD < 0 || cM < 0 || cP < 0) continue;
    const rows = [];
    for (let i = sec + 2; i < a.length; i++) {
      const r = a[i] || [], d = serialISO(r[cD]);
      if (!d) continue;
      const mean = num(r[cM]), pe = num(r[cP]);
      if (!(mean > 0) || !(pe > 0)) continue;          /* 最老那几行是空的("-"),不是零 */
      rows.push({
        date: d, mean, pe, price: +(pe * mean).toFixed(4),
        low: num(r[cL]), high: num(r[cH]),
        n: num(r[cN]), up: num(r[cU]), down: num(r[cW]),
      });
    }
    if (rows.length < 16) continue;
    rows.sort((x, y) => x.date < y.date ? -1 : 1);
    out.set(fn.replace(/\s+FY1 Estimate History\.xlsx?$/i, '').toUpperCase(), rows);
  }
  return out;
}

/** 目标价:同样月度,~25 个月。现价用 `均值目标 ÷ (1+隐含回报)` 还原。 */
function loadTargets() {
  const dir = path.join(ASSETS, 'targets');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const fn of fs.readdirSync(dir).filter(f => /Targets Ratings\.xlsx?$/i.test(f))) {
    const a = aoa(path.join(dir, fn));
    const hi = a.findIndex(r => String((r || [])[0] || '').trim().toLowerCase() === 'date');
    if (hi < 0) continue;
    const head = a[hi].map(h => String(h || '').trim().toLowerCase());
    const ix = s => head.findIndex(h => h.includes(s));
    const cD = ix('date'), cT = ix('mean tgt'), cB = ix('buy (%)'), cR = ix('implied return');
    if (cD < 0 || cT < 0) continue;
    const rows = [];
    for (let i = hi + 1; i < a.length; i++) {
      const r = a[i] || [], d = serialISO(r[cD]); if (!d) continue;
      const tgt = num(r[cT]), impl = cR >= 0 ? num(r[cR]) : NaN;
      if (!(tgt > 0)) continue;
      rows.push({ date: d, tgt, buyPct: cB >= 0 ? num(r[cB]) : NaN, price: isFinite(impl) ? tgt / (1 + impl / 100) : NaN });
    }
    if (rows.length < 8) continue;
    rows.sort((x, y) => x.date < y.date ? -1 : 1);
    out.set(fn.replace(/\s+Targets Ratings\.xlsx?$/i, '').toUpperCase(), rows);
  }
  return out;
}

/** 新闻:"{ticker} News.csv" 是 fetcher 一轮一轮**累积**下来的,盘上有整整一年。
 *  v16.7 那版报告里我把这条写成了"只有单点,没有历史" —— 那是错的,是我没看数据就下的结论。
 *  这里只做 csv 拆行(逗号 + 引号),打分一步都不碰:
 *  拆完的行原样交给仪表盘自己的 `ingestNews`,分数由 `newsScore` 本尊算。 */
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function loadNews() {
  const dir = path.join(ASSETS, 'news');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const fn of fs.readdirSync(dir).filter(f => /News\.csv$/i.test(f))) {
    const lines = fs.readFileSync(path.join(dir, fn), 'utf8').split(/\r?\n/);
    const head = splitCsv(lines[0] || '').map(h => h.trim().toLowerCase());
    const cD = head.indexOf('date'), cH = head.indexOf('headline');
    if (cD < 0 || cH < 0) continue;
    const recs = [];
    for (const l of lines.slice(1)) {
      if (!l.trim()) continue;
      const c = splitCsv(l);
      if (c.length <= Math.max(cD, cH)) continue;
      recs.push({ date: c[cD].trim(), headline: c[cH].trim() });
    }
    if (recs.length < 20) continue;
    out.set(fn.replace(/\s+News\.csv$/i, '').toUpperCase(), recs);
  }
  return out;
}

/* ── 2. 统计小工具:每个结论都要能对照基准 ───────────────────────────────── */

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (k, n) => n ? (k / n * 100) : NaN;

/** t 分布 95%(双侧)的临界值,按自由度查。
 *
 * 为什么不是 1.96:1.96 是**已知总体方差**时的正态临界值。CV 下界那里的标准差
 * 是拿 k 个折内 skill 现算出来的(k 通常就是 10),自由度只有 k−1 —— 用 1.96
 * 会把区间系统性收窄。k=10 时正确的值是 t(9)=2.262,比 1.96 大 15%,而 G 组
 * h=21 的下界本来就只有 +0.010,这 15% 恰好足以把它推到 0 以下。
 * 也就是说这不是"更严谨一点",是**一个已经翻过线的格子被错判成没翻**。
 *
 * 不写死 2.262 的理由同样具体:折数 = min(10, 票数),票不足 10 只时折数会变小,
 * 那时 t(k−1) 比 2.262 还大得多(k=5 时 t(4)=2.776)。写死一个数就等于在票少的时候
 * 偷偷放宽了门槛,而票越少本该越保守。df > 30 之后 t 与正态差 < 2%,回落到 1.96。 */
const T95 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
  9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120,
  17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064,
  25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042 };
function tCrit95(df) {
  if (!(df >= 1)) return NaN;               /* 自由度 < 1 算不出离散度,下界就该是 NaN */
  return T95[df] ?? 1.96;
}
/** 二项检验的正态近似:|命中率 − 基准| 有几个标准误。>2 才值得多看一眼。
 *
 * `effN` 是**有效样本数**,必须传。滚动窗口的样本是重叠的:h=63 时相邻两个观测
 * 共用 62 天的走势,它们不是两条独立证据。命中率照 n 个样本算(那是最好的点估计),
 * 但标准误只能按 effN=n/h 算。不做这个折算,z 会凭空放大 √h ≈ 8 倍 ——
 * 一个纯噪声的结果能被打扮成 z=-9,而它其实是 z=-1.2。这是回测里最常见的一种自欺。 */
function zBinom(k, n, p0, effN = n) {
  if (!(n > 0) || !(effN > 0)) return NaN;
  return (k / n - p0) / Math.sqrt(p0 * (1 - p0) / effN);
}
function spearman(xs, ys) {
  const n = xs.length; if (n < 8) return NaN;
  const rank = v => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
/** 确定性伪随机 —— 随机基准也必须每次跑出同一个数,否则它自己就是噪声。 */
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/* ── 3. A 组:波动率区间的覆盖率 ─────────────────────────────────────────── */

/* 仪表盘画的是 `现价 × exp(±σ年化)`,也就是**一年** ±1σ。
 * 盘上只有一年日线 —— 一年期的区间**在数据上无法验证**,一个前瞻样本都没有,这里不假装能。
 * 能验的是它脚下那两个假设:
 *   (a) σ 用滚动窗口估出来后,短周期的实际波动是不是真在 ±1σ 里(应 ≈68.3%);
 *   (b) √t 缩放成不成立(方差比 ≈1)。这两条塌了,一年期区间必然也是错的。 */
function testVolCoverage(ctx, cos, horizons, W = 120) {
  const res = [];
  for (const h of horizons) {
    let n = 0, in1 = 0, in2 = 0; const zs = [];
    for (const [tk, px] of cos) {
      for (let t = W; t + h < px.length; t++) {
        ctx.state.priceHist.set('__BT', px.slice(0, t + 1).slice(-W));   /* 只喂 t 及以前 */
        const v = ctx.volStats('__BT');
        if (!v || !(v.sigma > 0)) continue;
        const sd = v.sigma * Math.sqrt(h / 252);
        const r = Math.log(px[t + h].price / px[t].price);
        n++; if (Math.abs(r) <= sd) in1++; if (Math.abs(r) <= 2 * sd) in2++;
        zs.push(r / sd);
      }
    }
    ctx.state.priceHist.delete('__BT');
    const sorted = zs.slice().sort((a, b) => a - b);
    const effN = Math.max(1, Math.round(n / h));
    res.push({ h, n, effN, c1: pct(in1, n), c2: pct(in2, n),
      z1: zBinom(in1, n, 0.6827, effN), z2: zBinom(in2, n, 0.9545, effN),
      worst: sorted.length ? sorted[0] : NaN, best: sorted.length ? sorted[sorted.length - 1] : NaN,
      tail3: pct(zs.filter(z => Math.abs(z) > 3).length, n) });
  }
  return res;
}

/** √t 缩放:h 日收益的方差 ÷ (h × 1 日方差)。=1 说明可以按 √t 外推,
 *  <1 是均值回复(区间会画得太宽),>1 是趋势/波动聚集(区间太窄,而这才是危险的那一边)。 */
function testVarianceRatio(cos, horizons) {
  return horizons.map(h => {
    const vrs = [];
    for (const [, px] of cos) {
      const c = px.map(d => d.price);
      const r1 = [], rh = [];
      for (let i = 1; i < c.length; i++) r1.push(Math.log(c[i] / c[i - 1]));
      for (let i = h; i < c.length; i++) rh.push(Math.log(c[i] / c[i - h]));
      if (r1.length < 60 || rh.length < 30) continue;
      const v = a => { const m = mean(a); return a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1); };
      const v1 = v(r1), vh = v(rh);
      if (v1 > 0) vrs.push(vh / (h * v1));
    }
    return { h, vr: mean(vrs), k: vrs.length };
  });
}

/* ── 4. B 组:技术位到底有没有被尊重(距离匹配对照) ───────────────────── */

/* "价格碰到带子会反弹"要成立,得赢过一个**同侧、同宽、距离匹配**的对照带。
 *
 * 上一版的对照是"同宽度、随机摆在同一价区里"。宽度控住了,**距离没控住**:
 * 真实带由密度峰值生成,系统性地贴着现价;随机带在 [min,max] 上均匀撒,平均远得多。
 * 两臂比的于是是"近的带 vs 远的带" —— 近的带更容易被碰到、碰到之后也更容易在 hold
 * 窗口里出胜负,这个混杂单独就能造出几个点的差,和"这个位置有没有信息"毫无关系。
 *
 * 距离匹配只能是**分布上的匹配**,不可能是逐条精确匹配:一维价格轴上
 * (现价, 哪一侧, 到边缘的距离, 宽度) 四件事一旦定死,带就唯一确定了 ——
 * 逐条"同侧同宽同距离"的对照就是真实带自己。所以做法是:逐条保留真实带的**宽度**与
 * **所在一侧**,只把"离现价多远"从**真实带自己的经验分布**里重新抽一次。
 * 两臂的距离分布因此同分布(表里打印两臂的平均距离供核对),唯一剩下的差别是
 * "这个位置是不是密度峰值"。
 *
 * B2 退化闸门:对照臂的判决事件数若不足处理臂的 30%,两个比例就没得比,判 degenerate_control。
 * 距离匹配的对照**不该**退化 —— 真退化了,那是距离匹配写错了,不是数据的问题。 */
function bandOutcome(px, t0, bands, fwd, hold) {
  const out = { touch: 0, bounce: 0, brk: 0, stall: 0 };
  for (const b of bands) {
    let hit = -1, from = 0;
    for (let i = t0 + 1; i <= Math.min(t0 + fwd, px.length - 1); i++) {
      const p = px[i].price;
      if (p >= b.lo && p <= b.hi) { hit = i; from = px[i - 1].price > b.hi ? 1 : px[i - 1].price < b.lo ? -1 : 0; break; }
    }
    if (hit < 0 || from === 0) continue;              /* 没碰到,或本来就在带子里 → 这条带这轮不计 */
    out.touch++;
    let done = false;
    for (let i = hit + 1; i <= Math.min(hit + hold, px.length - 1); i++) {
      const p = px[i].price;
      if (from === 1 && p > b.hi) { out.bounce++; done = true; break; }   /* 从上方来,又回到上方 = 撑住了 */
      if (from === 1 && p < b.lo) { out.brk++; done = true; break; }
      if (from === -1 && p < b.lo) { out.bounce++; done = true; break; }
      if (from === -1 && p > b.hi) { out.brk++; done = true; break; }
    }
    if (!done) out.stall++;
  }
  return out;
}

/** 一轮里的真实带 → 只留现价**之外**的那些,并记下侧 / 宽度 / 到近边缘的距离(以 u 为单位)。
 *  现价就落在带里的那条是 inBand,它问的是"会不会被碰到"之外的另一个问题,两臂都不计。 */
function bandGeom(bands, p0, u) {
  const out = [];
  for (const b of bands) {
    const side = b.lo > p0 ? 1 : b.hi < p0 ? -1 : 0;
    if (!side || !(u > 0)) continue;
    const edge = side === 1 ? b.lo - p0 : p0 - b.hi;
    out.push({ lo: b.lo, hi: b.hi, side, w: b.hi - b.lo, edgeU: edge / u });
  }
  return out;
}

function testBands(ctx, cos, { h = 5, step = 21, fwd = 21, warm = 120 } = {}) {
  const hold = h;                       /* 判决窗口 = 持有期;找触碰的窗口固定 21 日 */
  /* ---- 第一趟:真实带。距离池要先攒齐,第二趟才抽得出匹配的距离 ---- */
  const rounds = [];
  let noBand = 0;
  for (const [tk, px] of cos) {
    for (let t = warm; t + fwd < px.length; t += step) {
      const hist = px.slice(0, t + 1);
      ctx.state.priceHist.set('__BT', hist);
      let pd = null;
      try { pd = ctx.priceDensity('__BT', hist[hist.length - 1].date, h); } catch { pd = null; }
      ctx.state.priceHist.delete('__BT');
      if (!pd || !pd.bands.length || !(pd.u > 0)) { noBand++; continue; }
      const g = bandGeom(pd.bands, px[t].price, pd.u);
      if (!g.length) { noBand++; continue; }
      rounds.push({ tk, px, t, p0: px[t].price, u: pd.u, bands: g });
    }
  }
  /* 上下两侧分开攒:这一年是单边上行年,上方与下方的距离分布本来就不是一个分布,
   * 混在一起抽等于把"上方的距离"发给"下方的对照",距离就又不匹配了。 */
  const pool = { up: [], dn: [] };
  for (const r of rounds) for (const b of r.bands) (b.side === 1 ? pool.up : pool.dn).push(b.edgeU);

  /* ---- 第二趟:对照带 = 同侧 + 同宽 + 距离从同侧的经验分布里重抽 ---- */
  const rnd = lcg(20260730);
  const real = { touch: 0, bounce: 0, brk: 0, stall: 0 }, ctrl = { touch: 0, bounce: 0, brk: 0, stall: 0 };
  let decR = 0, decC = 0, nBandR = 0, nBandC = 0;
  let sumDR = 0, sumDC = 0;
  for (const r of rounds) {
    const fake = r.bands.map(b => {
      const p = b.side === 1 ? pool.up : pool.dn;
      const e = p.length ? p[Math.min(p.length - 1, Math.floor(rnd() * p.length))] : b.edgeU;
      const near = b.side === 1 ? r.p0 + e * r.u : r.p0 - e * r.u;
      const lo = b.side === 1 ? near : near - b.w;
      return { lo, hi: lo + b.w, edgeU: e };
    });
    for (const b of r.bands) { sumDR += b.edgeU; nBandR++; }
    for (const b of fake) { sumDC += b.edgeU; nBandC++; }
    const R = bandOutcome(r.px, r.t, r.bands, fwd, hold);
    const C = bandOutcome(r.px, r.t, fake, fwd, hold);
    for (const k of Object.keys(real)) { real[k] += R[k]; ctrl[k] += C[k]; }
    if (R.bounce + R.brk > 0) decR++;
    if (C.bounce + C.brk > 0) decC++;
  }
  const rate = o => pct(o.bounce, o.bounce + o.brk);
  /* 两个比例之差的 z。分母用"出过胜负的轮数",不用带子条数 ——
   * 同一只票同一天画出来的几条带,后面 h 天走的是同一段行情,算成几条独立证据就是灌水。 */
  const dR = real.bounce + real.brk, dC = ctrl.bounce + ctrl.brk;
  const eR = Math.min(dR, decR), eC = Math.min(dC, decC);
  const pR = dR ? real.bounce / dR : NaN, pC = dC ? ctrl.bounce / dC : NaN;
  const pBar = (dR + dC) ? (real.bounce + ctrl.bounce) / (dR + dC) : NaN;
  /* B2:对照臂判决事件不足处理臂 30% → 两个比例没得比,z 不发布 */
  const cover = dR > 0 ? dC / dR : NaN;
  const degenerate = dR > 0 && dC < 0.3 * dR;
  const z = !degenerate && eR > 0 && eC > 0 && pBar > 0 && pBar < 1
    ? (pR - pC) / Math.sqrt(pBar * (1 - pBar) * (1 / eR + 1 / eC)) : NaN;
  return { h, hold, rounds: rounds.length, noBand, real, ctrl,
    realRate: rate(real), ctrlRate: rate(ctrl),
    effReal: eR, effCtrl: eC, decR: dR, decC: dC, cover, degenerate, z,
    nBandR, nBandC, distR: nBandR ? sumDR / nBandR : NaN, distC: nBandC ? sumDC / nBandC : NaN };
}

/* ── 5. C 组:走向倾斜度有没有方向性 ─────────────────────────────────────── */

/* 六条腿里能回放的只有四条。宏观/行业/流动性三条**同一天对所有标的是同一个数** ——
 * 它们是择时信号,不是选股信号,横截面上不含信息,有效样本只有"独立的 21 日窗口数"这么多。
 * 一年日线 ≈ 12 个。这不是统计,这是看一眼。数字照给,但结论只能说"看不出",不能说"有效"。 */
function testTilt(ctx, cos, mkt, { fwd = 21, warm = 140 } = {}) {
  const legs = { tilt: [], tech: [], m: [], i: [], l: [] };
  const fwds = { tilt: [], tech: [], m: [], i: [], l: [] };
  const dates = new Set();
  const anyPx = [...cos.values()][0] || [];
  for (let t = warm; t + fwd < anyPx.length; t++) {
    const day = anyPx[t].date;
    /* 市场序列按日期截断(各序列长度可能对不齐,按日期切最稳) */
    ctx.state.market.clear();
    for (const [role, m] of mkt) {
      const cut = m.px.filter(d => d.date <= day);
      if (cut.length >= 70) ctx.state.market.set(role, { sym: m.sym, px: cut });
    }
    let ms;
    try { ms = ctx.marketScores(); } catch { continue; }
    for (const [tk, px] of cos) {
      const ti = px.findIndex(d => d.date === day);
      if (ti < warm || ti + fwd >= px.length) continue;
      ctx.state.priceHist.set(tk, px.slice(0, ti + 1));
      const co = { ticker: tk, price: px[ti].price };
      let s; try { s = ctx.dirScores(co, null); } catch { continue; }
      ctx.state.priceHist.delete(tk);
      const r = Math.log(px[ti + fwd].price / px[ti].price) * 100;
      const avail = [[s.tech, 0.15], [ms.m, 0.15], [ms.i, 0.15], [ms.l, 0.10]].filter(([v]) => isFinite(v) && v !== null);
      if (!avail.length) continue;
      const w = avail.reduce((a, [, x]) => a + x, 0);
      legs.tilt.push(avail.reduce((a, [v, x]) => a + v * x, 0) / w); fwds.tilt.push(r);
      if (isFinite(s.tech) && s.tech !== null) { legs.tech.push(s.tech); fwds.tech.push(r); }
      for (const k of ['m', 'i', 'l']) if (isFinite(ms[k]) && ms[k] !== null) { legs[k].push(ms[k]); fwds[k].push(r); }
      dates.add(day);
    }
  }
  const out = {};
  for (const k of Object.keys(legs)) {
    const x = legs[k], y = fwds[k];
    if (x.length < 30) { out[k] = { n: x.length, thin: true }; continue; }
    /* 这条腿整段历史是不是一个常数?是的话 rho 算不出,同向% 也只是"涨的月份占比"披了层皮,
     * 一起按"没信息"报,别让一个常数在表里冒充一条信号。 */
    if (x.every(v => v === x[0])) { out[k] = { n: x.length, flat: true, val: x[0] }; continue; }
    const hit = x.filter((v, i) => v !== 0 && Math.sign(v) === Math.sign(y[i])).length;
    const nz = x.filter(v => v !== 0).length;
    const srt = x.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
    const q = Math.floor(srt.length / 3);
    /* tech/tilt 逐票不同 → 每个不重叠窗口能贡献 cos.size 条;宏观三条腿全票同值 → 只贡献 1 条 */
    const effN = Math.max(1, Math.round(dates.size / fwd) * (k === 'tech' || k === 'tilt' ? cos.size : 1));
    out[k] = {
      n: x.length, effN,
      rho: spearman(x, y), hit: pct(hit, nz), nz, z: zBinom(hit, nz, 0.5, Math.min(nz, effN)),
      loBucket: mean(srt.slice(0, q).map(r => r[1])),
      hiBucket: mean(srt.slice(-q).map(r => r[1])),
    };
  }
  out.__days = dates.size;
  return out;
}

/* ── 6. D 组:估值区间 vs 实际,以及"赢不赢得了'价格不动'" ───────────────── */

/* 这一组是全场样本量最像样的:月度面板 ~61 个月 × 7 家,而且逐月不重叠。
 * 真正要问的不是"区间宽不宽",是**中枢比"价格明天还是今天这个价"预测得更准吗**。
 * 赢不了随机游走,这条区间就只是装饰。 */
function testValuation(ctx, est, hs = [3, 6, 12]) {
  const res = [];
  for (const h of hs) {
    let n = 0, inCore = 0, inExt = 0, dirHit = 0, dirN = 0;
    const eModel = [], eRW = [], bias = [];   /* bias = log(中枢/现价):是"算不准"还是"系统性偏低",两回事 */
    for (const [tk, rows] of est) {
      for (let t = 12; t + h < rows.length; t++) {
        const hist = rows.slice(0, t + 1).filter(r => r.pe > 0);
        if (hist.length < 12) continue;
        ctx.state.history.set('__BT', hist.map(r => ({ date: r.date, pe: r.pe })));
        const pe = ctx.peStats('__BT');
        ctx.state.history.delete('__BT');
        if (!pe || pe.src !== 'history' || !(pe.p25 > 0) || !(pe.p50 > 0) || !(pe.p75 > 0)) continue;
        const r0 = rows[t];
        const low = isFinite(r0.low) && r0.low > 0 ? r0.low : r0.mean;
        const high = isFinite(r0.high) && r0.high > 0 ? r0.high : r0.mean;
        const coreLo = low * pe.p25, coreHi = high * pe.p75, mid = r0.mean * pe.p50;
        const extLo = pe.p10 > 0 ? low * pe.p10 : NaN, extHi = pe.p90 > 0 ? high * pe.p90 : NaN;
        const p0 = r0.price, pT = rows[t + h].price;
        if (!(p0 > 0) || !(pT > 0) || !(mid > 0)) continue;
        n++;
        if (pT >= coreLo && pT <= coreHi) inCore++;
        if (isFinite(extLo) && isFinite(extHi) && pT >= extLo && pT <= extHi) inExt++;
        eModel.push(Math.abs(Math.log(mid / pT)));
        eRW.push(Math.abs(Math.log(p0 / pT)));
        bias.push(Math.log(mid / p0));
        const want = Math.sign(mid - p0), got = Math.sign(pT - p0);
        if (want !== 0) { dirN++; if (want === got) dirHit++; }
      }
    }
    const effN = Math.max(1, Math.round(n / h));   /* 月度步进、h 个月前瞻 → 相邻 h 条重叠 */
    res.push({ h, n, effN, core: pct(inCore, n), ext: pct(inExt, n),
      mae: mean(eModel) * 100, maeRW: mean(eRW) * 100,
      ratio: mean(eModel) / mean(eRW), dir: pct(dirHit, dirN), dirN,
      biasMed: bias.length ? (Math.exp(bias.slice().sort((a, b) => a - b)[Math.floor(bias.length / 2)]) - 1) * 100 : NaN,
      biasBelow: pct(bias.filter(b => b < 0).length, bias.length),
      z: zBinom(dirHit, dirN, 0.5, Math.max(1, Math.round(dirN / h))) });
  }
  return res;
}

/* ── 7. E 组:修正动量与目标价动量(月度,不重叠,是这里最有说服力的两条) ── */

function testMonthlySignal(rows, scoreOf, hs) {
  return hs.map(h => {
    const xs = [], ys = [];
    for (const [, rs] of rows) {
      for (let t = 3; t + h < rs.length; t++) {
        const s = scoreOf(rs, t);
        if (!isFinite(s)) continue;
        const p0 = rs[t].price, pT = rs[t + h].price;
        if (!(p0 > 0) || !(pT > 0)) continue;
        xs.push(s); ys.push(Math.log(pT / p0) * 100);
      }
    }
    if (xs.length < 30) return { h, n: xs.length, thin: true };
    const nz = xs.filter(v => v !== 0).length;
    const hit = xs.filter((v, i) => v !== 0 && Math.sign(v) === Math.sign(ys[i])).length;
    const srt = xs.map((v, i) => [v, ys[i]]).sort((a, b) => a[0] - b[0]);
    const q = Math.floor(srt.length / 3);
    const effN = Math.max(1, Math.round(xs.length / h));
    return { h, n: xs.length, effN, rho: spearman(xs, ys),
      hit: pct(hit, nz), nz, z: zBinom(hit, nz, 0.5, Math.min(nz, effN)),
      loBucket: mean(srt.slice(0, q).map(r => r[1])), hiBucket: mean(srt.slice(-q).map(r => r[1])) };
  });
}

/* ── 7b. F 组:新闻情绪(30 日关键词打分)能不能预示后面的走势 ───────────── */

/* 这一条 v16.7 漏了,而且漏得不体面:我当时写的是"新闻只有单点,没有历史可回放"。
 * 实际上 Assets/news/ 里是一年、七只票、~1400 条标题,而 `newsScore(ticker, todayISO)`
 * 第二个参数就是**参照日**,它按 `年龄 < 0 就跳过` 把未来的新闻挡在外面 ——
 * 也就是说这条腿**在构造上**就不可能偷看未来,本来就是最好测的一条。
 *
 * 有效样本要按 max(h, 30) 折,不是按 h:打分窗口本身有 30 天记忆,
 * 相邻两天读到的是几乎同一批标题,再怎么错开也不是两条独立证据。 */
function testNews(ctx, cos, news, hs, { warm = 40 } = {}) {
  return hs.map(h => {
    const xs = [], ys = [];
    let quiet = 0, days = 0, tks = 0;
    for (const [tk, recs] of news) {
      const px = cos.get(tk);
      if (!px || px.length < warm + h + 20) continue;
      /* 走真正的 ingest:去重、日期校验、排序都用仪表盘那份,不另写一遍 */
      ctx.state.companies.set(tk, { ticker: tk });
      ctx.state.news.delete(tk);
      ctx.ingestNews(recs, `${tk} News.csv`);
      let used = 0;
      for (let t = warm; t + h < px.length; t++) {
        const nw = ctx.newsScore(tk, px[t].date);      /* 参照日 = 当天,未来的标题进不来 */
        if (!nw) continue;
        if (nw.tot === 0) quiet++;
        xs.push(nw.s); ys.push(Math.log(px[t + h].price / px[t].price) * 100);
        used++;
      }
      ctx.state.news.delete(tk);
      ctx.state.companies.delete(tk);
      if (used) { tks++; days = Math.max(days, used); }
    }
    if (xs.length < 30) return { h, n: xs.length, thin: true, tks };
    const nz = xs.filter(v => v !== 0).length;
    const hit = xs.filter((v, i) => v !== 0 && Math.sign(v) === Math.sign(ys[i])).length;
    const srt = xs.map((v, i) => [v, ys[i]]).sort((a, b) => a[0] - b[0]);
    const q = Math.floor(srt.length / 3);
    /* 30 = newsScore 的打分窗口。两个记忆(信号 30 天、前瞻 h 天)取长的那个 */
    const effN = Math.max(1, Math.round(days / Math.max(h, 30))) * Math.max(1, tks);
    return { h, n: xs.length, effN, tks, nz, quiet,
      rho: spearman(xs, ys), hit: pct(hit, nz), z: zBinom(hit, nz, 0.5, Math.min(nz, effN)),
      loBucket: mean(srt.slice(0, q).map(r => r[1])), hiBucket: mean(srt.slice(-q).map(r => r[1])) };
  });
}

/* ── 7c. G 组:可达性概率的校准 ──────────────────────────────────────────── */

/* 这是压力位引擎唯一有资格进"验收"的声明:`reachProb` 说"未来 h 日内至少触到这条位置
 * 的概率是 p",这是一个**概率预测**,概率预测能被 Brier 分数直接结算,不需要挑门槛、
 * 不需要分档、不需要"命中率"这种对带宽极度敏感的量。
 *
 * 基准是**气候基准**:一个常数预测,值 = 全样本的实际触及率。赢不了常数,这条腿就是装饰。
 * 样本外怎么保证:折 = **标的**(cluster),10 只票正好 10 折,每折的气候基准只用训练折
 * 的触及率算,再拿去结算留出折。这样"常数基准"本身也没偷看留出折。
 *
 * 量纲提醒(SPEC 4.3):`reachProb` 的第一参是**无量纲**的 edgeAbs/price,不是美元。
 * 传成美元会让 z 被价格放大 P 倍 → Φ(−68) 下溢成 0 → 整列概率恒为 0;
 * 喂年化 σ 则会让概率全部贴到 1。两种事故都不抛错,都只能靠可靠性图看出来 ——
 * 所以这一组必须把 10 桶表整个打出来,不能只报一个 skill 数。
 *
 * **结算的对象必须是面板真正报出来的那些位置,不是 priceDensity 的全部带。**
 * pressureLevels 在末尾有一道视野闸门 `edgeU <= PX_REACH_U`(=1u):超过一个 u 的位置
 * 本期不入表。直接对全部密度带结算,会把一大堆 3u 开外、预测≈0、实际也≈0 的"送分题"
 * 灌进样本 —— 气候基准被这些送分题拖到 10% 出头,skill 于是虚高到 0.40,
 * 而那个 0.40 描述的是"引擎知道远的地方够不着",不是"面板上那几行概率准不准"。
 * 所以这里整个走 `pressureLevels(co, null, day, hz)`,用它自己算出来的 `L.pReach`:
 * 合并、视野闸门、PX_KEEP、量纲修正全都按线上那一套走一遍。 */
const HZ_NAME = { 5: 'short', 21: 'mid', 63: 'long' };

function testReach(ctx, cos, horizons, { warm = 120 } = {}) {
  const out = [];
  for (const h of horizons) {
    const hz = HZ_NAME[h];
    /* es / sds 是给 tools/paramsearch.mjs 用的**原始入参留档**:每条观测在调 reachProb 时
     * 真正传进去的头两个参数(相对边距 edgeAbs/price 与日 σ)。留着它们,搜索 PX_REACH_C 时
     * 就能拿**同一个 reachProb 本尊**换个 c 再算一遍,而不必在搜索脚本里照抄一遍公式 ——
     * 照抄公式测的是抄得对不对,不是引擎算得对不对(见本文件开头第 1 条纪律)。
     * 这两个数组不进任何统计,G 组一行输出都不受影响。 */
    const ps = [], ys = [], tks = [], es = [], sds = [];
    const perTk = new Map();
    let skipC = 0, noLv = 0, wSum = 0, wN = 0;
    for (const [tk, px] of cos) {
      let used = 0;
      for (let t = warm; t + h < px.length; t++) {
        const hist = px.slice(0, t + 1);
        const day = hist[hist.length - 1].date;
        ctx.state.priceHist.set('__BT', hist);
        let pl = null;
        /* co 只给 ticker/price:'__BT' 在 state.options 里没有链,optionWalls 返回 null,
         * 于是这一组结算的是**纯技术轨**的位置 —— 期权轨 pending,本来就不许进统计。 */
        try { pl = ctx.pressureLevels({ ticker: '__BT', price: px[t].price }, null, day, hz); }
        catch { pl = null; }
        ctx.state.priceHist.delete('__BT');
        if (!pl || !isFinite(pl.u) || pl.u <= 0) { noLv++; continue; }
        const p0 = pl.price;
        /* 结算口径与 reachProb 的语义严格对齐:反射原理算的是"**触到那条边**至少一次",
         * 不是"收盘落在带子里"。所以上方位置看窗口最高价有没有摸到 lo,下方看最低价有没有
         * 摸到 hi —— 用"收盘落在 [lo,hi] 内"会把一根跳空穿过整条带的日子记成"没触及"。 */
        let hiW = -Infinity, loW = Infinity;
        for (let i = t + 1; i <= t + h; i++) { const p = px[i].price; if (p > hiW) hiW = p; if (p < loW) loW = p; }
        let any = false;
        for (const L of [...pl.up, ...pl.down]) {
          const p = L.pReach;                          /* 引擎自己算的那一列,不另算一遍 */
          if (!isFinite(p)) { skipC++; continue; }
          ps.push(p);
          ys.push(L.mid > p0 ? (hiW >= L.lo ? 1 : 0) : (loW <= L.hi ? 1 : 0));
          tks.push(tk);
          /* edgeU·u = edgeAbs(元),再除现价 = engine.js 传给 reachProb 的第一参(无量纲)。 */
          es.push(L.edgeU * pl.u / pl.price); sds.push(pl.sd);
          /* 平均带宽(单位 u)。SPEC 4.1 点名要它:半衰期扫描若与带宽同步变化,
           * 那条曲线测的是带宽不是半衰期,必须能当场看出来。 */
          wSum += (L.hi - L.lo) / pl.u; wN++;
          any = true;
        }
        if (any) used++;
      }
      if (used) perTk.set(tk, used);
    }
    const n = ps.length;
    if (!n) { out.push({ h, n: 0, thin: true }); continue; }
    const base = ys.reduce((a, b) => a + b, 0) / n;
    const skillIn = ctx.brierSkill(ps, ys, base);

    /* 10 折 CV,折 = 标的。折内的气候基准只用训练折算,别让基准偷看留出折。 */
    const keys = [...new Set(tks)];
    /* 10 是硬上限,不是"折数"。票数 ≤ 10 时 `i % nf` 给每只票单独一折,这就是 leave-one-ticker-out;
     * 票数一旦到 11,第 11 只票会被折回第 0 折,和另一只票共用一折 —— LOO 与 10 折从这一刻起
     * 不再是同一件事,而报告上那行字仍然写着「折 = 标的(10 只票 10 折)」。
     * 这种分叉不会抛错、不会让数字变难看,只会让"样本外"这三个字悄悄变了意思。
     * 所以把 capped 这个事实一路带到输出里,由 G 组打印时显式说出来(见下面的 capped 分支)。 */
    const nf = Math.min(10, keys.length);
    const capped = keys.length > nf;
    const foldOf = new Map(keys.map((k, i) => [k, i % nf]));
    let sumM = 0, sumB = 0;
    const foldSkill = [];
    for (let f = 0; f < nf; f++) {
      const te = [], tr = [];
      for (let i = 0; i < n; i++) (foldOf.get(tks[i]) === f ? te : tr).push(i);
      if (!te.length || !tr.length) continue;
      const b0 = tr.reduce((a, i) => a + ys[i], 0) / tr.length;
      const pm = te.map(i => ps[i]), yy = te.map(i => ys[i]);
      const bM = ctx.brier(pm, yy), bB = ctx.brier(yy.map(() => b0), yy);
      if (!isFinite(bM) || !isFinite(bB)) continue;
      sumM += bM * te.length; sumB += bB * te.length;
      if (bB > 0) foldSkill.push(1 - bM / bB);
    }
    const skillOOS = sumB > 0 ? 1 - sumM / sumB : NaN;
    const fm = mean(foldSkill);
    const fsd = foldSkill.length > 1
      ? Math.sqrt(foldSkill.reduce((a, x) => a + (x - fm) * (x - fm), 0) / (foldSkill.length - 1)) : NaN;
    /* 折数是 min(10, 票数),不是常数,所以临界值必须跟着自由度走(见 tCrit95 的注释)。 */
    const cvDf = foldSkill.length - 1;
    const cvT = tCrit95(cvDf);
    const cvLo = isFinite(fsd) && isFinite(cvT) ? fm - cvT * fsd / Math.sqrt(foldSkill.length) : NaN;

    /* 10 桶可靠性图。某桶为空是**警报**而不是细节:概率被挤在一头,多半是 σ 走错了门。 */
    const buckets = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, sp: 0, sy: 0 }));
    for (let i = 0; i < n; i++) {
      const bi = Math.min(9, Math.max(0, Math.floor(ps[i] * 10)));
      buckets[bi].n++; buckets[bi].sp += ps[i]; buckets[bi].sy += ys[i];
    }
    let maxDev = NaN, maxDev30 = NaN, empty = 0;
    for (const b of buckets) {
      if (!b.n) { empty++; continue; }
      b.pm = b.sp / b.n; b.ym = b.sy / b.n; b.dev = Math.abs(b.ym - b.pm);
      if (!(maxDev >= b.dev)) maxDev = b.dev;
      if (b.n >= 30 && !(maxDev30 >= b.dev)) maxDev30 = b.dev;
    }
    const effN = [...perTk.values()].reduce((a, d) => a + Math.max(1, Math.round(d / h)), 0);
    out.push({ h, n, effN, base, skillIn, skillOOS, foldSkill, cvLo, cvDf, cvT, nf, capped,
      minFold: foldSkill.length ? Math.min(...foldSkill) : NaN,
      buckets, maxDev, maxDev30, empty, skipC, noLv, clusters: keys.length,
      meanBandU: wN ? wSum / wN : NaN, ps, ys, tks, es, sds });
  }
  return out;
}

/* ── 7d. H / H2 组:价格网格的位移抑制 ───────────────────────────────────── */

/* 提案三留下的那条线索:整五十 / 整二十五的价格网格上,价格是不是"粘"得更紧一点。
 * 处理臂 = h 日后的价到**最近网格点**的标准化位移 |Δ|/u;
 * 对照臂 = 同一个未来价到**相邻两网格点的中点**的位移 —— 中点格与网格格同周期、同间距,
 * 在"价格对网格无所谓"的原假设下两者同分布(各自的期望都是 步长/4),
 * 所以这是一个**同距离、同宽度**的对照,而且是逐条配对的(同一个未来价、同一个 u)。
 *
 * 配对差 δ = (|Δ网格| − |Δ中点|)/u。δ 显著为负 = 价格更贴网格 = 位移被抑制。
 * 检验用**按标的的 cluster bootstrap**(2000 次):这些观测按天滚动、重叠严重,
 * 而且价位高低完全由标的决定(一只 30 元的票和一只 800 元的票,25 元网格根本不是一回事),
 * 唯一站得住的独立单位是"标的"。10 只票 → bootstrap 的 CI 一定很宽,那是实情,不是缺陷。 */
function testGridDisp(ctx, cos, horizons, { warm = 120, grid = 25, reps = 2000 } = {}) {
  const nearGrid = p => Math.round(p / grid) * grid;
  const nearMid = p => Math.round((p - grid / 2) / grid) * grid + grid / 2;
  const out = [];
  for (const h of horizons) {
    const all = new Map(), x50 = new Map(), x25 = new Map();   /* ticker → δ[] */
    const push = (m, tk, v) => { if (!m.has(tk)) m.set(tk, []); m.get(tk).push(v); };
    let n = 0, sumG = 0, sumM = 0, effN = 0;
    for (const [tk, px] of cos) {
      let used = 0;
      for (let t = warm; t + h < px.length; t++) {
        const hist = px.slice(0, t + 1);
        const day = hist[hist.length - 1].date;
        ctx.state.priceHist.set('__BT', hist);
        let sig = null;
        try { sig = ctx.sigmaD('__BT', day, ctx.PX.PX_SIGMA_WIN); } catch { sig = null; }
        ctx.state.priceHist.delete('__BT');
        if (!sig) continue;
        const u = ctx.scaleU(sig.sd, h, px[t].price);          /* u 只用 t 及以前的信息 */
        if (!isFinite(u) || u <= 0) continue;
        const pT = px[t + h].price;
        const g = nearGrid(pT), m = nearMid(pT);
        const dG = Math.abs(pT - g) / u, dM = Math.abs(pT - m) / u;
        const d = dG - dM;
        push(all, tk, d); sumG += dG; sumM += dM; n++; used++;
        const mk = ctx.optGridMark(g);                          /* 用引擎本尊的标记函数,别另写一遍 */
        if (mk.isGrid50) push(x50, tk, d); else if (mk.isGrid25) push(x25, tk, d);
      }
      if (used) effN += Math.max(1, Math.round(used / h));
    }
    const stat = m => {
      const vals = [...m.values()].flat();
      if (!vals.length) return { n: 0, thin: true };
      const pt = mean(vals);
      const bs = clusterBoot(m, reps, 20260807 + h);
      return { n: vals.length, k: m.size, mean: pt, lo: bs.lo, hi: bs.hi, sd: bs.sd,
        z: isFinite(bs.sd) && bs.sd > 0 ? pt / bs.sd : NaN };
    };
    out.push({ h, n, effN, maeGrid: n ? sumG / n : NaN, maeMid: n ? sumM / n : NaN,
      all: stat(all), x50: stat(x50), x25: stat(x25) });
  }
  return out;
}

/** 按 cluster(这里恒为标的)重采样的 bootstrap:整只票连人带数据一起抽,
 *  不是抽单个观测 —— 抽单个观测等于假装 250 个重叠的日观测是 250 条独立证据。 */
function clusterBoot(byKey, reps, seed) {
  const keys = [...byKey.keys()];
  if (keys.length < 2) return { lo: NaN, hi: NaN, sd: NaN, reps: 0 };
  const rnd = lcg(seed >>> 0);
  const ms = [];
  for (let r = 0; r < reps; r++) {
    let s = 0, c = 0;
    for (let i = 0; i < keys.length; i++) {
      const a = byKey.get(keys[Math.min(keys.length - 1, Math.floor(rnd() * keys.length))]);
      for (const v of a) { s += v; c++; }
    }
    if (c) ms.push(s / c);
  }
  if (ms.length < 2) return { lo: NaN, hi: NaN, sd: NaN, reps: ms.length };
  ms.sort((a, b) => a - b);
  const q = p => ms[Math.min(ms.length - 1, Math.max(0, Math.round(p * (ms.length - 1))))];
  const m = mean(ms);
  return { lo: q(0.025), hi: q(0.975), reps: ms.length,
    sd: Math.sqrt(ms.reduce((a, x) => a + (x - m) * (x - m), 0) / (ms.length - 1)) };
}

/* ── 7e. I 组:买入规则 vs 同频随机入场 ──────────────────────────────────── */

/* 处理臂 = 五条 `SIM_PRESETS` 在全样本上逐票回放(直接调 `simRun`,**不在这里另写一套回放**:
 * 面板上跑的是哪一段代码,这里就必须是同一段,否则回测验的是回测自己)。
 *
 * 对照臂 = **同频随机入场**:同一只票、同一持有期、同样的触发次数、种子固定
 * (`simHash(ticker + '|' + 规则文本)`,由 simRun 自己派生)。为什么必须是"同频"而不是
 * "买入并持有":这一年是单边上行年,随便哪天买、持有 21 天的胜率本来就有六七成。
 * 拿 50% 当基准,五条预设全部"跑赢",而它们赢的是**行情**,不是规则。
 *
 * 分母口径与 `simZ` 一字不差:两臂都用 min(n, effN)。这里有一处不对称是**真实的**、
 * 不是 bug:处理臂持仓期间不重复开仓,于是它的交易天然不重叠、effN 恒等于 n;
 * 对照臂是随机撒点,会撞出重叠持仓,effN < n。两臂各自按自己的独立事件数算,
 * 才不会把对照的重叠当成额外证据。
 *
 * LOO(留一票):3.9 预注册的第三道闸门 —— 去掉贡献最大的一只票后 z 仍 ≥ 1.5。
 * "贡献最大"的定义是**去掉它以后 z 掉得最狠的那只**,不是交易数最多的那只:
 * 十只票里有一只碰巧连赢十把就能把聚合 z 顶过 2,那种显著性经不起换一年行情。 */

/** 两比例 z(合并 p),分母是各臂的独立事件数。与 src/js/sim/engine.js 的 simZ 同一个式子。 */
function simPropZ(a, b) {
  if (!(a.eff > 0) || !(b.eff > 0) || !(a.n > 0) || !(b.n > 0)) return NaN;
  const ka = Math.round(a.win / a.n * a.eff), kb = Math.round(b.win / b.n * b.eff);
  const p = (ka + kb) / (a.eff + b.eff);
  const se = Math.sqrt(p * (1 - p) * (1 / a.eff + 1 / b.eff));
  if (!(se > 0)) return NaN;
  return (ka / a.eff - kb / b.eff) / se;
}

/** 把 per-ticker 的计数加总(skip 非空时留一票),再算 z。 */
function simAgg(per, skip) {
  const A = { n: 0, win: 0, eff: 0 }, C = { n: 0, win: 0, eff: 0 };
  for (const [tk, r] of per) {
    if (tk === skip) continue;
    A.n += r.n; A.win += r.win; A.eff += r.eff;
    C.n += r.cn; C.win += r.cwin; C.eff += r.ceff;
  }
  return { A, C, z: simPropZ(A, C) };
}

function testSimPresets(ctx, cos, holds) {
  /* simRun 从 state 里按 ticker 取价与公司,和浏览器里完全一样 —— 这一组不给它喂
   * 任何特制的 '__BT' 假票,因为对照的种子里含 ticker,换了名字就换了一批随机日。 */
  for (const [tk, px] of cos) {
    ctx.state.priceHist.set(tk, px);
    ctx.state.companies.set(tk, { ticker: tk, price: px[px.length - 1].price });
  }
  const out = [];
  for (const P of ctx.SIM_PRESETS) {
    for (const hold of holds) {
      const per = new Map();
      for (const [tk] of cos) {
        let R = null;
        try { R = ctx.simRun(tk, { all: P.all }, hold, {}); } catch { R = null; }
        if (!R || !R.n) continue;                      /* 一次都没触发的票不进分母 */
        per.set(tk, { n: R.n, win: R.win, eff: Math.min(R.n, R.effN),
          cn: R.ctrl.n, cwin: R.ctrl.win, ceff: Math.min(R.ctrl.n, R.ctrl.effN) });
      }
      const all = simAgg(per, null);
      /* 留一票:取"去掉之后 z 最低"的那只,这才是把 z 顶上去的那只票 */
      let looZ = NaN, looTk = null;
      for (const [tk] of per) {
        const z = simAgg(per, tk).z;
        if (!isFinite(z)) continue;
        if (!isFinite(looZ) || z < looZ) { looZ = z; looTk = tk; }
      }
      out.push({ id: P.id, hold, k: per.size,
        n: all.A.n, effN: all.A.eff, win: all.A.win,
        cn: all.C.n, cEffN: all.C.eff, cwin: all.C.win,
        winPct: all.A.n ? all.A.win / all.A.n * 100 : NaN,
        ctrlPct: all.C.n ? all.C.win / all.C.n * 100 : NaN,
        z: all.z, looZ, looTk });
    }
  }
  /* 用完就把沙箱里的 state 还原 —— 这一组是最后一组,但"最后"这件事随时会被下一次改动推翻。 */
  for (const [tk] of cos) { ctx.state.priceHist.delete(tk); ctx.state.companies.delete(tk); }
  return out;
}

/* ── 7f. J 组:要画到 K 线图上的技术指标,先过同一道闸 ─────────────────────── */

/* 用户问的是"要不要加一张 K 线图,把技术分析画上去",选中的答案是**「指标必须过同一道闸」**:
 * 均线、突破、RSI —— 任何带着判断意味、要在图上带颜色带徽章的东西,得先在样本外赢过
 * `reach` 轨被要求赢的那一类基准。过不了的画成素线:没颜色、没徽章、没判语。
 *
 * 门槛、指标集、临界值、样本要求**全部预注册在 SPEC 附录 K**,写在算出任何一个指标数字之前。
 * 这一节只是把那张表翻译成代码,一个数都不许在这里现定。为什么非得这么绕:
 * 能从收盘价上算出来的"标准指标"有几十个,挨个试一遍再报最好看的那个,
 * 在统计上和随机挑一个报出来是同一件事 —— 只是读者会把前者当研究。
 *
 * **这一组和别的组有一处本质不同:它测的不是 src/ 里跑着的代码,因为这四个指标还没画到面板上。**
 * 本文件开头第 1 条纪律(测的必须是仪表盘真在跑的那份代码)在这里没有对象可测。
 * 于是反过来:下面这四个函数就是它们在本仓库的**规范定义**,将来哪一格过了闸真画上去,
 * 渲染层必须调同一套公式,并且要有断言把两处钉住 —— 否则画的和验收的不是同一个东西。
 *
 * 四条判据并联(SPEC K.5),全过才算过:
 *   C1 有效样本 min(处理, 对照) ≥ 30           —— 不够一律 inconclusive,样本不足不给证伪的权利
 *   C2 留一标的的样本外 Brier skill > 0         —— 与 G 组同一套折,基准是训练折的气候概率
 *   C3 折间稳定:CV 下界(t(k−1))> 0           —— 临界值跟自由度走,不是 1.96
 *   C4 效应量:vs 同频随机对照的两比例 z ≥ 临界  —— 主检验 2.00,其余 11 格 Bonferroni 2.87
 */

const J_WARM = 120;                 /* 与 SIM_WARM / testBands 的 warm 对齐,三处热身长度必须一致 */
const J_MIN_EFF = 30;               /* C1,SPEC K.5 预注册 */
const J_Z_PRIMARY = 2.00;           /* 主检验(maState @ h=21)临界值,SPEC K.6 */
const J_Z_FAMILY = 2.87;            /* 其余 11 格:α=0.05,m=12,双侧 → Φ(−2.87)=0.002052 ≤ 0.002083 */
const J_PRIMARY = { id: 'maState', h: 21 };

const jSMA = (px, i, n) => {
  if (i - n + 1 < 0) return NaN;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += px[j].price;
  return s / n;
};
/** Wilder 的 RSI:首值用前 n 根涨跌幅的**简单平均**播种,之后走 (prev·(n−1)+今日)/n 的递推。
 *  不用"简单移动平均版 RSI" —— 两者在同一份数据上能差好几个点,而教科书上的 30/70 两条线
 *  是配 Wilder 平滑说的。换一种平滑再套 30/70,过不过闸测的就是平滑方式了。 */
function jRsiSeries(px, n) {
  const out = new Array(px.length).fill(NaN);
  if (px.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = px[i].price - px[i - 1].price; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < px.length; i++) {
    const d = px[i].price - px[i - 1].price;
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/* 四个指标,SPEC K.3 定死。窗口长度(20/60、55、14、20)与阈值(30/70、1.5×)
 * 全部来自外部惯例:20/60 是 rules.js 里 trendBuy 已经在用的那一对,55 是海龟系统的长周期突破,
 * 30/70 是 RSI 教科书线,1.5× 是量能确认最常见的写法。**没有一个数字是在这份数据上挑的。** */
const J_INDICATORS = [
  { id: 'maState', label: '均线状态 SMA20/60', two: true,
    sig: (px, i) => { const a = jSMA(px, i, 20), b = jSMA(px, i, 60);
      return (isFinite(a) && isFinite(b)) ? (a > b ? 1 : a < b ? -1 : 0) : 0; } },
  { id: 'breakout55', label: '55 日新高突破',
    sig: (px, i) => { if (i - 55 < 0) return 0;
      let m = -Infinity; for (let j = i - 55; j < i; j++) if (px[j].price > m) m = px[j].price;
      return px[i].price > m ? 1 : 0; } },
  { id: 'rsi14', label: 'RSI(14) 30/70', two: true,
    pre: px => ({ rsi: jRsiSeries(px, 14) }),
    sig: (px, i, pre) => { const r = pre.rsi[i]; return !isFinite(r) ? 0 : r < 30 ? 1 : r > 70 ? -1 : 0; } },
  { id: 'breakoutVol', label: '带量突破(>1.5× 20 日均量)', needVol: true,
    sig: (px, i) => { if (i - 55 < 0 || !(px[i].vol > 0)) return 0;
      let m = -Infinity; for (let j = i - 55; j < i; j++) if (px[j].price > m) m = px[j].price;
      if (!(px[i].price > m)) return 0;
      let v = 0, c = 0; for (let j = i - 20; j < i; j++) { if (j < 0 || !(px[j].vol > 0)) return 0; v += px[j].vol; c++; }
      return c === 20 && px[i].vol > 1.5 * (v / c) ? 1 : 0; } },
];

/** 贪心不重叠计数 —— 与 src/js/sim/engine.js 的 simEffN 同一套口径(那里按 entryI/exitI,
 *  这里按索引 + h)。天天触发的指标很容易连着 100 天出信号,那 100 天共享的是同一段行情。 */
function jEffN(idx, h) {
  let n = 0, until = -Infinity;
  for (const i of idx) if (i >= until) { n++; until = i + h; }
  return n;
}
/** FNV-1a:对照的种子必须由 票+指标+前瞻 唯一确定,不可挑。 */
function jHash(s) {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  return x >>> 0;
}

function testIndicators(ctx, cos, horizons, { warm = J_WARM } = {}) {
  const out = [];
  for (const ind of J_INDICATORS) {
    /* 信号序列与 h 无关,逐票算一次就够;pre 里放需要整段递推的东西(RSI)。 */
    const sigOf = new Map();
    for (const [tk, px] of cos) {
      if (ind.needVol && !px.some(d => d.vol > 0)) continue;   /* 没有成交量列的票整只排除,不拿 0 冒充 */
      const pre = ind.pre ? ind.pre(px) : null;
      sigOf.set(tk, px.map((_, i) => ind.sig(px, i, pre)));
    }
    for (const h of horizons) {
      const A = { n: 0, win: 0, eff: 0 }, C = { n: 0, win: 0, eff: 0 };
      const obs = [];                       /* {tk, s, y} —— s≠0 的那些日子,进 Brier */
      const allY = new Map();               /* tk → 全部可入场日的 y,气候基准用这个,不是只用触发日 */
      let fires = 0, ties = 0, span0 = 0, tks = 0;
      for (const [tk, px] of cos) {
        const sig = sigOf.get(tk); if (!sig) continue;
        const lo = warm, hi = px.length - 1 - h;
        if (hi < lo) continue;
        tks++; span0 = Math.max(span0, hi - lo + 1);
        const ys = []; allY.set(tk, ys);
        const idxA = [], claim = [];
        for (let i = lo; i <= hi; i++) {
          const r = Math.log(px[i + h].price / px[i].price);
          if (r === 0) { ties++; continue; }                   /* 平盘不进任何分母 */
          const y = r > 0 ? 1 : 0;
          ys.push(y);
          const s = sig[i];
          if (!s) continue;
          fires++;
          obs.push({ tk, s, y });
          idxA.push(i); claim.push(s);
          A.n++; if ((s > 0) === (y === 1)) A.win++;
        }
        A.eff += jEffN(idxA, h);
        /* ---- 同频随机对照:同一只票、同一段可入场区间、同样多天、同样的多空配比 ----
         * 不放回抽样后洗牌派方向。为什么不能分两次独立抽"涨的那批"和"跌的那批":
         * 两批会撞车,同一天既被派涨又被派跌,必定一对一错 —— 对照会被人为拉向 50%。 */
        const k = idxA.length;
        if (k > 0) {
          const kUp = claim.filter(v => v > 0).length;
          const rnd = lcg(jHash(`${tk}|${ind.id}|${h}`));
          const spanN = hi - lo + 1, want = Math.min(k, spanN);
          const picked = new Set();
          let guard = 0;
          while (picked.size < want && guard++ < want * 20 + 200) picked.add(lo + Math.floor(rnd() * spanN));
          const pick = [...picked];
          for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
          const idxC = [];
          for (let m = 0; m < pick.length; m++) {
            const i = pick[m], cs = m < kUp ? 1 : -1;
            const r = Math.log(px[i + h].price / px[i].price);
            if (r === 0) continue;
            idxC.push(i);
            C.n++; if ((cs > 0) === (r > 0)) C.win++;
          }
          idxC.sort((a, b) => a - b);
          C.eff += jEffN(idxC, h);
        }
      }
      if (!fires) { out.push({ ind, h, tks, fires: 0, none: true }); continue; }

      /* ---- C2/C3:折 = 标的(留一标的,上限 10 折,与 G 组同一套) ----
       * 模型 = 训练折上按状态拟合的 P(涨|s);基准 = 训练折上**全部可入场日**的无条件 P(涨)。
       * 基准取全部日而不是只取触发日,是故意的:这才是"气候",也才是这个指标要赢的对手 ——
       * 只拿触发日当基准,等于让它跟自己比,skill 会恒等于 0 附近的噪声。 */
      const keys = [...allY.keys()].filter(k => obs.some(o => o.tk === k));
      const nf = Math.min(10, keys.length);
      const capped = keys.length > nf;
      const foldOf = new Map(keys.map((k, i) => [k, i % nf]));
      let sumM = 0, sumB = 0;
      const foldSkill = [];
      const stateAgg = new Map();           /* s → {n, sp, sy} 状态表:可靠性图在 k≤3 个状态上的替身 */
      for (let f = 0; f < nf; f++) {
        const teO = obs.filter(o => foldOf.get(o.tk) === f);
        const trO = obs.filter(o => foldOf.get(o.tk) !== f);
        if (!teO.length || !trO.length) continue;
        let bn = 0, bs = 0;
        for (const [tk, ys] of allY) { if (foldOf.get(tk) === f) continue; for (const y of ys) { bs += y; bn++; } }
        if (!bn) continue;
        const b0 = bs / bn;
        const pByS = new Map();
        for (const o of trO) { const a = pByS.get(o.s) || { n: 0, s: 0 }; a.n++; a.s += o.y; pByS.set(o.s, a); }
        /* 训练折里没出现过这个状态 → 退回气候基准。不许静默用留出折自己的频率补,那是偷看。 */
        const pm = teO.map(o => { const a = pByS.get(o.s); return a && a.n ? a.s / a.n : b0; });
        const yy = teO.map(o => o.y);
        for (let i = 0; i < teO.length; i++) {
          const a = stateAgg.get(teO[i].s) || { n: 0, sp: 0, sy: 0 };
          a.n++; a.sp += pm[i]; a.sy += yy[i]; stateAgg.set(teO[i].s, a);
        }
        const bM = ctx.brier(pm, yy), bB = ctx.brier(yy.map(() => b0), yy);
        if (!isFinite(bM) || !isFinite(bB)) continue;
        sumM += bM * teO.length; sumB += bB * teO.length;
        if (bB > 0) foldSkill.push(1 - bM / bB);
      }
      const skillOOS = sumB > 0 ? 1 - sumM / sumB : NaN;
      const fm = mean(foldSkill);
      const fsd = foldSkill.length > 1
        ? Math.sqrt(foldSkill.reduce((a, x) => a + (x - fm) * (x - fm), 0) / (foldSkill.length - 1)) : NaN;
      const cvDf = foldSkill.length - 1, cvT = tCrit95(cvDf);
      const cvLo = isFinite(fsd) && isFinite(cvT) ? fm - cvT * fsd / Math.sqrt(foldSkill.length) : NaN;

      const states = [...stateAgg.entries()].sort((a, b) => b[0] - a[0]).map(([s, a]) => ({
        s, n: a.n, pm: a.sp / a.n, ym: a.sy / a.n, dev: Math.abs(a.sy / a.n - a.sp / a.n) }));
      out.push({ ind, h, tks, fires, ties, span0, A, C, keys: keys.length, nf, capped,
        z: simPropZ(A, C), skillOOS, foldSkill, cvLo, cvDf, cvT,
        minFold: foldSkill.length ? Math.min(...foldSkill) : NaN,
        states, maxStateDev: states.length ? Math.max(...states.map(s => s.dev)) : NaN,
        hitPct: A.n ? A.win / A.n * 100 : NaN, ctrlPct: C.n ? C.win / C.n * 100 : NaN,
        cover: A.eff > 0 ? C.eff / A.eff : NaN });
    }
  }
  return out;
}

/* ── 7g. K 组:情绪面(新闻强度),预注册于 SPEC 附录 M ─────────────────────── */

/* 用户最初的要求是「技术面、情绪面、期权多空博弈点、长期短期的逻辑都最后达到验收」。
 * 技术面走完了(附录 K → J 组),期权轨没有时间序列(pending_no_history),
 * 情绪面是唯一一块完全没动过的。这一组把它补上。
 *
 * 门槛、指标集、临界值、对齐规则、样本要求**全部预注册在 SPEC 附录 M**,写在算出任何一个数之前。
 * 这一节只是把那张表翻译成代码,一个数都不许在这里现定。
 *
 * 命名先澄清,否则读起来必岔:**回测组代号 `K` 与 SPEC 附录 K 不是一回事。**
 * 附录 K(技术面)对应 J 组;附录 M(情绪面)对应这里的 K 组。附录与组号错开一位是既成事实。
 *
 * 只做「新闻强度」(按日计数 / 相对该票自身基线的计数异常),**不做关键词词典**:
 * 本仓库已经有一条词典腿了(F 组 newsScore),再写一份是同一份证据用两次;
 * 而且词典是一组自由参数,在约 1800 条标题上挑词等于拟合噪声,且这种拟合不会在任何统计量上留下痕迹。
 *
 * 四条判据并联(SPEC M.7),全过才算过:
 *   C1 有效样本 floor(min(处理,对照) × (1−ρ_share)) ≥ 30  —— 折价见 M.6;不够一律 inconclusive
 *   C2 留一标的的样本外 Brier skill > 0                    —— 与 G/J 组同一套折
 *   C3 折间稳定:CV 下界(t(k−1))> 0                       —— 本轮只有 8 只票 → 8 折,t(7)=2.365
 *   C4 效应量:vs 同频随机对照的两比例 z ≥ 临界             —— 主检验 2.00,其余 8 格 Bonferroni 2.78
 */

const K_WARM = 120;                 /* 与 SIM_WARM / testBands / J_WARM 对齐,四处热身长度必须一致 */
const K_MIN_EFF = 30;               /* C1,SPEC M.7 预注册 */
const K_Z_PRIMARY = 2.00;           /* 主检验(newsBurst @ h=5)临界值,SPEC M.8 */
const K_Z_FAMILY = 2.78;            /* 其余 8 格:α=0.05,m=9,双侧 → Φ(−2.78)=0.002718 ≤ 0.002778
                                     * (Φ(−2.77)=0.002803 > 0.002778,不够,所以不是 2.77) */
const K_PRIMARY = { id: 'newsBurst', h: 5 };

/** 新闻日 → 交易日,**严格向后一天**(SPEC M.5)。
 *
 *  返回第一个 `date > d` 的交易日下标;没有(新闻晚于最后一根日线)返回 −1。
 *  为什么不是"当天或之后"而是"严格之后":标题里带着 `(~9:45ET)` 这类时刻碎片,
 *  但它既不是一列、也不是每条都有,更没有时区保证 —— 分不清盘中与盘后就不许猜。
 *  推后一根之后,t 日收盘做决策时用到的信息全部是昨天及以前公开的。
 *  代价是牺牲半天到一天的时效,这个代价是故意付的:**宁可信号迟一天,不可让它早一秒。**
 *  本项目在期权墙上栽过同型的一跤(没按 asof 过滤,回放读到六周后才登记的数据)。 */
function kFirstAfter(px, d) {
  let lo = 0, hi = px.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (px[m].date > d) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans;
}
/** 按 kFirstAfter 把新闻装桶,得到计数序列 c[]。
 *  `maxSrc[t]` 记住装进这一桶的最晚一条新闻日期 —— 它只有一个用途:给下面那条前瞻断言当证据。 */
function kBuckets(px, recs) {
  const c = new Array(px.length).fill(0), maxSrc = new Array(px.length).fill('');
  let dropped = 0;
  for (const r of recs) {
    const t = kFirstAfter(px, r.date);
    if (t < 0) { dropped++; continue; }              /* 晚于最后一根日线:它对应的未来收益也不存在 */
    c[t]++;
    if (r.date > maxSrc[t]) maxSrc[t] = r.date;
  }
  return { c, maxSrc, dropped };
}
/** 前瞻污染断言(SPEC M.5 / M.12 第 5 款)。
 *  一条早了一天的新闻不会让任何数字变成 NaN,它只会让所有数字好看一点点 —— 那正是最危险的形状。
 *  所以这条不许降级成警告:它返回非 0,自检就必须 FAIL。 */
function kAsofViolations(px, c, maxSrc) {
  let v = 0;
  for (let t = 0; t < px.length; t++) if (c[t] > 0 && !(maxSrc[t] < px[t].date)) v++;
  return v;
}

/** 跨票共享率 ρ_share(SPEC M.6)。
 *  `ids` 列意味着同一条新闻会同时挂在多只票下(例如一条同时提到 AMZN/GOOGL/NVDA 的)。
 *  对**计数**不做任何处理是对的:"今天关于 NVDA 的新闻有几条"本来就该把它算进去。
 *  对**有效样本**必须处理:两只票的触发日不是两份独立证据,按票聚类的 effN 是高估。
 *  这里给出的 (1−ρ_share) 是**保守近似**,不是精确方差修正 —— 选它的唯一理由是
 *  它的误差方向确定:只会让 C1 更难过,不会更好过。一条判据如果只能错,就让它往不敢发结论的方向错。 */
function kShareRate(news, tickers) {
  const owners = new Map();
  let total = 0;
  for (const tk of tickers) for (const r of news.get(tk) || []) {
    total++;
    const k = r.date + ' ' + r.headline;
    const s = owners.get(k) || new Set(); s.add(tk); owners.set(k, s);
  }
  let shared = 0;
  for (const tk of tickers) for (const r of news.get(tk) || [])
    if ((owners.get(r.date + ' ' + r.headline) || new Set()).size >= 2) shared++;
  return { total, shared, rho: total ? shared / total : 0 };
}

/* 三个指标,SPEC M.3 定死。窗口长度(20、20/60)与倍数(1.5×)全部抄自 J 组:
 * 1.5× 与 20 日均值来自 breakoutVol 的量能确认口径,20/60 来自 maState(而它又来自 rules.js 的 trendBuy)。
 * **没有一个新的自由度被引进来** —— 情绪面本来就是自由度最泛滥的一轨,
 * 唯一能让它不泛滥的办法是连一个新常数都不许出现。 */
const K_INDICATORS = [
  { id: 'newsBurst', label: '新闻放量(条数 >1.5× 近 20 日均)',
    sig: (c, t) => { if (t < 20) return 0;
      let s = 0; for (let j = t - 20; j < t; j++) s += c[j];
      return (c[t] >= 1 && c[t] > 1.5 * (s / 20)) ? 1 : 0; } },
  { id: 'newsDrought', label: '新闻沉寂(近 20 日 0 条)',
    sig: (c, t) => { if (t < 19) return 0;
      let s = 0; for (let j = t - 19; j <= t; j++) s += c[j];
      return s === 0 ? -1 : 0; } },
  { id: 'newsFlowState', label: '新闻流状态 20/60', two: true,
    sig: (c, t) => { if (t < 59) return 0;
      let a = 0, b = 0;
      for (let j = t - 19; j <= t; j++) a += c[j];
      for (let j = t - 59; j <= t; j++) b += c[j];
      const r20 = a / 20, r60 = b / 60;
      return r20 > r60 ? 1 : r20 < r60 ? -1 : 0; } },
];

/** K 组主体。结构与 testIndicators(J 组)逐段同构 —— 故意的:
 *  两组用的是同一套判据、同一套折、同一套对照造法,形状不一样就说明有一处偷偷换了口径。
 *  唯一的差别是信号来自计数序列 c[] 而不是价格序列。 */
function testSentiment(ctx, cos, news, horizons, { warm = K_WARM } = {}) {
  /* 参与票 = 既有日线又有新闻的那些。
   * SPCX 有新闻没日线(导出只有 36 根,loadDaily 的 40 根下限整份丢掉),
   * QQQ/SPY 有日线没新闻 —— 后者尤其不许当成"零新闻":没抓 ≠ 没有,
   * 拿零当事实会把它整年判成 drought,那是凭空造出来的信号。两者都不进这个矩阵。 */
  const tks = [...cos.keys()].filter(tk => (news.get(tk) || []).length > 0).sort();
  const share = kShareRate(news, tks);
  const defl = 1 - share.rho;
  const bk = new Map();
  let asofBad = 0, dropped = 0;
  for (const tk of tks) {
    /* `|| []` 不是为了兜住上面那行筛选(它已经保证了非空),是为了让筛选万一被人删掉时
     * 失败方式是**可诊断的**:整年零新闻 → newsDrought 天天触发,自检 F11 当场红,
     * 而不是抛一个 "recs is not iterable" 的栈让人去猜。 */
    const px = cos.get(tk), b = kBuckets(px, news.get(tk) || []);
    asofBad += kAsofViolations(px, b.c, b.maxSrc);
    dropped += b.dropped;
    bk.set(tk, b.c);
  }
  const out = [];
  for (const ind of K_INDICATORS) {
    /* 信号序列与 h 无关,逐票算一次就够 */
    const sigOf = new Map();
    for (const tk of tks) { const c = bk.get(tk); sigOf.set(tk, c.map((_, i) => ind.sig(c, i))); }
    for (const h of horizons) {
      const A = { n: 0, win: 0, eff: 0 }, C = { n: 0, win: 0, eff: 0 };
      const obs = [];                       /* {tk, s, y} —— s≠0 的那些日子,进 Brier */
      const allY = new Map();               /* tk → 全部可入场日的 y,气候基准用这个,不是只用触发日 */
      let fires = 0, ties = 0, nTk = 0;
      for (const tk of tks) {
        const px = cos.get(tk), sig = sigOf.get(tk);
        const lo = warm, hi = px.length - 1 - h;
        if (hi < lo) continue;
        nTk++;
        const ys = []; allY.set(tk, ys);
        const idxA = [], claim = [];
        for (let i = lo; i <= hi; i++) {
          const r = Math.log(px[i + h].price / px[i].price);
          if (r === 0) { ties++; continue; }                   /* 平盘不进任何分母 */
          const y = r > 0 ? 1 : 0;
          ys.push(y);
          const s = sig[i];
          if (!s) continue;
          fires++;
          obs.push({ tk, s, y });
          idxA.push(i); claim.push(s);
          A.n++; if ((s > 0) === (y === 1)) A.win++;
        }
        A.eff += jEffN(idxA, h);
        /* ---- 同频随机对照(SPEC M.7,与 J 组 K.5 逐字同款)----
         * 同一只票、同一段可入场区间、同样多天、同样的多空配比;不放回抽样后洗牌派方向。
         * 种子由 FNV-1a(票|指标|前瞻) 派生,固定不可挑。 */
        const k = idxA.length;
        if (k > 0) {
          const kUp = claim.filter(v => v > 0).length;
          const rnd = lcg(jHash(`${tk}|${ind.id}|${h}`));
          const spanN = hi - lo + 1, want = Math.min(k, spanN);
          const picked = new Set();
          let guard = 0;
          while (picked.size < want && guard++ < want * 20 + 200) picked.add(lo + Math.floor(rnd() * spanN));
          const pick = [...picked];
          for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
          const idxC = [];
          for (let m = 0; m < pick.length; m++) {
            const i = pick[m], cs = m < kUp ? 1 : -1;
            const r = Math.log(px[i + h].price / px[i].price);
            if (r === 0) continue;
            idxC.push(i);
            C.n++; if ((cs > 0) === (r > 0)) C.win++;
          }
          idxC.sort((a, b) => a - b);
          C.eff += jEffN(idxC, h);
        }
      }
      if (!fires) { out.push({ ind, h, tks: nTk, fires: 0, none: true, share, defl, asofBad, dropped }); continue; }

      /* ---- C2/C3:折 = 标的(留一标的,上限 10 折;本轮实际 8,因为只有 8 只票有新闻)----
       * 模型 = 训练折上按状态拟合的 P(涨|s);基准 = 训练折上**全部可入场日**的无条件 P(涨)。
       * M.6 已经声明过:留一折里的跨票泄漏(一条新闻挂多只票)会让 skill 偏高,不做修正,只声明方向 ——
       * C2/C3 没过是干净的失败,C2/C3 过了不算干净的成功。 */
      const keys = [...allY.keys()].filter(k => obs.some(o => o.tk === k));
      const nf = Math.min(10, keys.length);
      const capped = keys.length > nf;
      const foldOf = new Map(keys.map((k, i) => [k, i % nf]));
      let sumM = 0, sumB = 0;
      const foldSkill = [];
      const stateAgg = new Map();           /* s → {n, sp, sy} 状态表:可靠性图在 k≤3 个状态上的替身 */
      for (let f = 0; f < nf; f++) {
        const teO = obs.filter(o => foldOf.get(o.tk) === f);
        const trO = obs.filter(o => foldOf.get(o.tk) !== f);
        if (!teO.length || !trO.length) continue;
        let bn = 0, bs = 0;
        for (const [tk, ys] of allY) { if (foldOf.get(tk) === f) continue; for (const y of ys) { bs += y; bn++; } }
        if (!bn) continue;
        const b0 = bs / bn;
        const pByS = new Map();
        for (const o of trO) { const a = pByS.get(o.s) || { n: 0, s: 0 }; a.n++; a.s += o.y; pByS.set(o.s, a); }
        /* 训练折里没出现过这个状态 → 退回气候基准。不许静默用留出折自己的频率补,那是偷看。 */
        const pm = teO.map(o => { const a = pByS.get(o.s); return a && a.n ? a.s / a.n : b0; });
        const yy = teO.map(o => o.y);
        for (let i = 0; i < teO.length; i++) {
          const a = stateAgg.get(teO[i].s) || { n: 0, sp: 0, sy: 0 };
          a.n++; a.sp += pm[i]; a.sy += yy[i]; stateAgg.set(teO[i].s, a);
        }
        const bM = ctx.brier(pm, yy), bB = ctx.brier(yy.map(() => b0), yy);
        if (!isFinite(bM) || !isFinite(bB)) continue;
        sumM += bM * teO.length; sumB += bB * teO.length;
        if (bB > 0) foldSkill.push(1 - bM / bB);
      }
      const skillOOS = sumB > 0 ? 1 - sumM / sumB : NaN;
      const fm = mean(foldSkill);
      const fsd = foldSkill.length > 1
        ? Math.sqrt(foldSkill.reduce((a, x) => a + (x - fm) * (x - fm), 0) / (foldSkill.length - 1)) : NaN;
      const cvDf = foldSkill.length - 1, cvT = tCrit95(cvDf);
      const cvLo = isFinite(fsd) && isFinite(cvT) ? fm - cvT * fsd / Math.sqrt(foldSkill.length) : NaN;

      const states = [...stateAgg.entries()].sort((a, b) => b[0] - a[0]).map(([s, a]) => ({
        s, n: a.n, pm: a.sp / a.n, ym: a.sy / a.n, dev: Math.abs(a.sy / a.n - a.sp / a.n) }));
      /* C1 的有效样本是**折价后**的那个(M.6 第 2 条):effNUsed = floor(min(处理,对照) × (1−ρ_share))。
       * 两个数都留着 —— 台账里记原始 effN(与 J 组同口径,跨组可比),终端印折价后的(判据用的那个)。 */
      const effMin = Math.min(A.eff, C.eff);
      out.push({ ind, h, tks: nTk, fires, ties, A, C, keys: keys.length, nf, capped,
        z: simPropZ(A, C), skillOOS, foldSkill, cvLo, cvDf, cvT,
        minFold: foldSkill.length ? Math.min(...foldSkill) : NaN,
        states, maxStateDev: states.length ? Math.max(...states.map(s => s.dev)) : NaN,
        hitPct: A.n ? A.win / A.n * 100 : NaN, ctrlPct: C.n ? C.win / C.n * 100 : NaN,
        cover: A.eff > 0 ? C.eff / A.eff : NaN,
        effMin, effUsed: Math.floor(effMin * defl), share, defl, asofBad, dropped });
    }
  }
  return { rows: out, tks, share, defl, asofBad, dropped };
}

/* ── 8. 报告 ─────────────────────────────────────────────────────────────── */

const f1 = v => isFinite(v) ? v.toFixed(1) : '—';
const f2 = v => isFinite(v) ? v.toFixed(2) : '—';
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const H = s => '\n\x1b[1m' + s + '\x1b[0m';
/** 判语只有三种:够不着基准 / 看不出 / 站得住。中间那种最常见,也最该老实说。 */
const verdict = (z, thin) => thin ? '\x1b[90m样本太少,看不出\x1b[0m'
  : !isFinite(z) ? '\x1b[90m算不出\x1b[0m'
  : z > 2 ? '\x1b[32m站得住\x1b[0m' : z < -2 ? '\x1b[31m反了\x1b[0m' : '\x1b[33m看不出(与基准无异)\x1b[0m';

/* 跑一轮记一行,不是为了"看趋势"就下手改权重 —— 是为了让**判语翻转**这件事留得下痕迹。
 * 一条腿从"看不出"变成"反了",要能看出是哪一轮变的、那时样本多少。 */
const LOG = [];
/** 数字就留几位小数,不是数字(没算出来 / 这一组根本没有这个量)就留空。
 *  注意不能用 isFinite('') —— 它会把空串当成 0 放过去,于是 z 那列会出现一堆假的 0.000,
 *  而 z=0 在这份账里是有含义的("正好与基准无异"),和"没有这个数"必须分得开。 */
const cell = (v, d) => typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : '';
const rec = (group, metric, horizon, n, effN, value, baseline, z, verdict) =>
  LOG.push({ group, metric, horizon, n, effN,
    value: cell(value, 4), baseline: cell(baseline, 4), z: cell(z, 3), verdict });
/** 有 z 检验的组统一走这里,只出三个词。csv 里 verdict 这一列的全部合法取值:
 *    holds / inverted / inconclusive          —— 有基准、能做检验的
 *    too_narrow / too_wide                    —— A 组覆盖率专用
 *    trending / mean_reverting                —— A 组方差比专用(阈值判,不是检验)
 *    no_variance                              —— 这条腿整段历史是常数,一个字没说过
 *    biased                                   —— 符号没反,是整体挂偏了(D 组中枢)
 *    recorded                                 —— 没有基准,只记数不判对错
 *    degenerate_control                       —— 对照臂事件数不足处理臂 30%,两个比例没得比(B2)
 *    calibrated / miscalibrated               —— G 组可靠性图专用:最大偏差 ≤0.10 / >0.10
 *    pending_no_history                       —— 这条轨的输入根本没有时间序列(期权 OI),不是样本少,是没得测
 *    no_signal                                —— J / K 两组共用:这个指标在整段历史上一次都没触发。
 *                                                 和 inconclusive 分开写,是因为两者要做的事不一样:
 *                                                 样本少要等历史变长,一次没触发要先问这个指标是不是写错了。
 *    pending_no_ohlc                           —— J 组专用:这个指标需要 开/高/低,而导出的表里只有收盘和成交量。
 *                                                 不是没测出来,是没得测,而且用 |Δ收盘| 去凑 ATR 只会凑出一个假数。
 *  加词可以,改词不行:改了,几个月前那些行就跟今天的行对不上了。 */
const vTag = (z, thin) => thin || !isFinite(z) ? 'inconclusive' : z > 2 ? 'holds' : z < -2 ? 'inverted' : 'inconclusive';

function writeLog(runDate) {
  const dir = path.join(ASSETS, '_logs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'backtest-history.csv');
  const head = 'run_date,group,metric,horizon,n,effN,value,baseline,z,verdict\n';
  /* 同一天重跑就把那天的旧行换掉,不叠两份 —— 一天两条会让后面"哪轮翻的"读不出来 */
  let keep = '';
  if (fs.existsSync(f)) {
    keep = fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1)
      .filter(l => l.trim() && !l.startsWith(runDate + ',')).join('\n');
    if (keep) keep += '\n';
  }
  const body = LOG.map(r => [runDate, r.group, r.metric, r.horizon, r.n, r.effN,
    r.value, r.baseline, r.z, r.verdict].join(',')).join('\n');
  fs.writeFileSync(f, head + keep + body + '\n');
  return { file: f, rows: LOG.length, days: new Set((keep + body).split('\n').filter(Boolean).map(l => l.split(',')[0])).size };
}

/* ── 自检:Node 侧 OHLC 读取的夹具测试(`--selftest`)─────────────────────── */

/** 为什么这一段必须存在。
 *
 *  盘上今天每一份 charting 导出都只有 `Date` / `<公司名> - Close` / `Volume` 三列 ——
 *  于是 `loadDaily()` 里那段读 O/H/L 的代码**在真实数据上一行都不会执行**。
 *  它和浏览器侧 `src/js/ingest/charting.js` 的一致性此前只能靠肉眼比对:
 *  `npm test` 跑的是浏览器产物,根本看不到这个文件,`node tools/backtest.mjs` 又
 *  永远走不进那个分支。一段永远不执行、也永远没人断言过的代码,等到 FactSet 那边
 *  真的切出 K 线布局的那一天才第一次运行,那时候错了是静默的:蜡烛照画,值是错的。
 *
 *  所以这里在临时目录里造几份 xlsx 夹具,**真的调 `loadDaily()`** 读回来对答案。
 *
 *  夹具的两条设计纪律:
 *  1. O / H / L 三个值必须**两两不同,且都不等于 Close**。若实现偷懒拿 Close 冒充开盘价,
 *     一份 o=h=l=close 的夹具会全绿 —— 那种绿灯什么都不说明。
 *  2. 三列在表里的**位置是打乱的**(Close/Volume 夹在中间,High 排在 Open 前面)。
 *     按列序猜下标的实现会当场翻车,按列名找的不会。 */
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  →  ' + extra)); }
  };
  const N = 45;                                   /* > loadDaily() 的 40 行下限 */
  const DAY0 = 45300;                             /* Excel 序列日期;serialISO() 走数字分支 */
  const wr = (dir, fn, rows) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    XLSX.writeFile(wb, path.join(dir, fn));
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-selftest-'));
  let R;
  try {
    /* F1 齐三列。列序故意打乱:Date, Close, Volume, High, Open, Low */
    wr(dir, 'AAA-US Daily Charting.xlsx', [
      ['Date', 'AAA-US - Close', 'AAA-US - Volume', 'AAA-US - High', 'AAA-US - Open', 'AAA-US - Low'],
      ...Array.from({ length: N }, (_, i) => [DAY0 + i, 100 + i, 1000 + i, 105 + i, 97 + i, 93 + i]),
    ]);
    /* F2 只有 Open / High,缺 Low —— 整份当没有 OHLC。
     *    这里的每一根都是**阴线**(开 103 > 收 100),是有意为之:若实现改成"缺哪一列就拿
     *    Close 顶替",顶替出来的 Low = Close 在阳线上会被 `ll <= min(o,p)` 自己挡掉,夹具看不出区别;
     *    阴线上 min(o,p) 就是 Close,顶替值恰好过关,三列真的会被写进去 —— 断言这才抓得到。 */
    wr(dir, 'BBB-US Daily Charting.xlsx', [
      ['Date', 'BBB-US - Close', 'BBB-US - Open', 'BBB-US - High'],
      ...Array.from({ length: N }, (_, i) => [DAY0 + i, 100 + i, 103 + i, 108 + i]),
    ]);
    /* F3 今天盘上的真实形状:Date / Close / Volume,一列 OHLC 都没有 */
    wr(dir, 'CCC-US Daily Charting.xlsx', [
      ['Date', 'CCC-US - Close', 'CCC-US - Volume'],
      ...Array.from({ length: N }, (_, i) => [DAY0 + i, 100 + i, 1000 + i]),
    ]);
    /* F4 幌子列:"52 Week High" / "52 Week Low" 里也有 High / Low。
     *    两个幌子值(200 / 50)故意选得能通过下游那道自洽性检查 —— 否则正则写坏了
     *    也会被护栏挡掉,断言看不出区别(良性变异)。这样写,正则一坏就真的多出三列。 */
    wr(dir, 'DDD-US Daily Charting.xlsx', [
      ['Date', 'DDD-US - Close', '52 Week High', '52 Week Low', 'DDD-US - Open'],
      ...Array.from({ length: N }, (_, i) => [DAY0 + i, 100 + i, 200, 50, 97 + i]),
    ]);
    /* F5 齐三列,但第 3 根 high<low、第 7 根收盘跑到下影线外面 */
    wr(dir, 'EEE-US Daily Charting.xlsx', [
      ['Date', 'EEE-US - Close', 'EEE-US - Open', 'EEE-US - High', 'EEE-US - Low'],
      ...Array.from({ length: N }, (_, i) => {
        if (i === 3) return [DAY0 + i, 103, 100, 90, 110];            /* 最高 < 最低 */
        if (i === 7) return [DAY0 + i, 107, 104, 112, 108];           /* 最低 > 开盘/收盘 */
        return [DAY0 + i, 100 + i, 97 + i, 105 + i, 93 + i];
      }),
    ]);

    R = loadDaily(dir);
    const g = k => R.cos.get(k) || [];
    const A = g('AAA-US'), B = g('BBB-US'), C = g('CCC-US'), D = g('DDD-US'), E = g('EEE-US');
    const noOHLC = px => px.length > 0 && px.every(r => !('o' in r) && !('h' in r) && !('l' in r));

    console.log('\n\x1b[1m读盘自检 —— loadDaily() 的 OHLC 分支在真实数据上永不执行,只能靠夹具\x1b[0m\n');

    ok('五份夹具都读进来了,没有一份被当成市场级序列',
      R.cos.size === 5 && R.mkt.size === 0, `cos=${R.cos.size} mkt=${R.mkt.size}`);

    /* ---- 齐三列 ---- */
    ok('齐三列 → 每一根都带 o/h/l,行数不缩水', A.length === N && A.every(r => 'o' in r && 'h' in r && 'l' in r),
      `n=${A.length}`);
    ok('读到的是**真的** O/H/L,不是 Close 冒充的(三个值两两不同且都 ≠ Close)',
      A.every((r, i) => r.price === 100 + i && r.o === 97 + i && r.h === 105 + i && r.l === 93 + i
        && new Set([r.o, r.h, r.l, r.price]).size === 4),
      JSON.stringify(A[0]));
    ok('列序打乱也认得出来(按列名找,不是按下标猜)', A[0].o === 97 && A[0].h === 105 && A[0].l === 93,
      JSON.stringify({ o: A[0].o, h: A[0].h, l: A[0].l }));
    ok('齐三列时成交量照常读', A.every((r, i) => r.vol === 1000 + i));

    /* ---- 缺一列 ---- */
    ok('缺 Low 一列 → 整份当没有 OHLC,o/h/l 三个键一个都不许出现',
      B.length === N && noOHLC(B), JSON.stringify(B[0]));

    /* ---- 完全没有这三列:这是今天盘上的形状,记录必须逐字段与今天相同 ---- */
    ok('没有这三列 → 记录的键集合与今天逐字段相同(date,price,vol)',
      C.length === N && C.every(r => Object.keys(r).join(',') === 'date,price,vol'),
      JSON.stringify(Object.keys(C[0] || {})));

    /* ---- 幌子列 ---- */
    ok('"52 Week High" / "52 Week Low" 不许被认成当天的最高价/最低价',
      D.length === N && noOHLC(D), JSON.stringify(D[0]));

    /* ---- 自相矛盾的一根 ---- */
    const bad = E.map((r, i) => ('o' in r ? '' : String(i))).filter(Boolean).join(',');
    ok('自相矛盾的一根退回"只有收盘价":high<low 与收盘跑到影线外的那两根,且只有那两根',
      E.length === N && bad === '3,7', `缺 o/h/l 的下标 = [${bad}]`);
    ok('坏的一根不牵连其余根:另外 43 根的 o/h/l 一个不差',
      E.every((r, i) => (i === 3 || i === 7) ? true
        : (r.o === 97 + i && r.h === 105 + i && r.l === 93 + i)));
    ok('坏的那两根仍然保留收盘价(整根丢掉的话序列会缺口)',
      E[3] && E[3].price === 103 && E[7] && E[7].price === 107,
      JSON.stringify([E[3], E[7]]));

    /* ---- 计数 ---- */
    ok('ohlcFiles 只数真读到 O/H/L 的那几份(F1 + F5 = 2,缺列/幌子列的三份不算)',
      R.ohlcFiles === 2, String(R.ohlcFiles));

    /* ---- 默认路径不许被这个新参数碰到 ---- */
    const nrm = x => JSON.stringify({ cos: [...x.cos].map(([k, v]) => [k, v.length, JSON.stringify(v[0] || null)]),
      mkt: [...x.mkt].map(([k, v]) => [k, v.sym, v.px.length]), ohlc: x.ohlcFiles });
    ok('loadDaily() 不传参 === 传 Assets/charting(加可选目录参数没有改掉默认路径的行为)',
      nrm(loadDaily()) === nrm(loadDaily(path.join(ASSETS, 'charting'))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ── K 组(情绪面)的夹具 ────────────────────────────────────────────────
   *
   *  为什么这一段必须存在,而且必须钉死具体值。
   *
   *  K 组的三个指标全部长在一个中间量上:计数序列 `c[]`。而 `c[]` 是由 M.5 那条
   *  「新闻日期严格晚于 → 下一根交易日」的规则造出来的 —— 这条规则一旦写松半格
   *  (`>` 写成 `>=`),当天盘中发的新闻就会被算进当天,**所有数字只会变好看一点点,
   *  不会有任何一个变成 NaN、也不会有任何一处报错**。本项目在期权墙上栽的就是这一跤。
   *  所以下面每一条断言都钉**具体值**,不写 `>= 下界`,也不写 `a || b`:
   *  那两种写法在这里等于没写。
   *
   *  三条设计纪律:
   *  1. 桶序列断言的是**整个数组**,不是某一格。改 `>` 为 `>=` 会让首尾两格同时变,
   *     只查一格有可能恰好躲过去。
   *  2. 指标触发位置断言的是**完整的触发区间串**。1.5 改成 1.4、20 改成 21、
   *     `r20 > r60` 改成 `>=`,三种改法各自会动到区间串的不同段。
   *  3. 「抽不到」和「一致」必须是两种结果:前瞻检测器要在正确装桶上返回 0、
   *     在故意错装的桶上返回非 0;折价系数要在共享率 1 时把 effN 压到 0、
   *     在共享率 0 时原样放行。只测其中一种,等于只证明了函数会返回一个数。 */

  console.log('\n\x1b[1m情绪面自检 —— K 组的对齐规则、指标定义、折价系数,逐格钉死\x1b[0m\n');

  /* 把 0/1 序列压成 "19-39,60-79" 这样的区间串:比一串 41 个下标好读,而且照样是精确匹配 */
  const runs = (arr, want) => {
    const idx = []; for (let i = 0; i < arr.length; i++) if (arr[i] === want) idx.push(i);
    const out = []; let a = null, b = null;
    for (const i of idx) { if (a === null) { a = b = i; } else if (i === b + 1) b = i; else { out.push(a === b ? `${a}` : `${a}-${b}`); a = b = i; } }
    if (a !== null) out.push(a === b ? `${a}` : `${a}-${b}`);
    return out.join(',');
  };

  /* ---- F6 对齐规则:严格晚于 + 周末向后滚 + 晚于最后一根就丢 ----
   *  交易日故意跨一个周末(01-02 周五 → 01-05 周一),新闻里放了周六和周日各一条。 */
  const pxA = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12']
    .map((d, i) => ({ date: d, price: 100 + i }));
  const nwA = [
    { date: '2025-12-31', headline: 'n0' },   /* 早于第一根 → 落到 idx0 */
    { date: '2026-01-02', headline: 'n1' },   /* 与 idx0 同一天 → 必须落到 idx1,不许落 idx0 */
    { date: '2026-01-02', headline: 'n2' },
    { date: '2026-01-03', headline: 'n3' },   /* 周六 → idx1 */
    { date: '2026-01-04', headline: 'n4' },   /* 周日 → idx1 */
    { date: '2026-01-05', headline: 'n5' },   /* → idx2 */
    { date: '2026-01-12', headline: 'n6' },   /* 与最后一根同日 → 没有更晚的交易日 → 丢弃 */
    { date: '2026-01-20', headline: 'n7' },   /* 晚于最后一根 → 丢弃 */
  ];
  const bA = kBuckets(pxA, nwA);
  /* idx1(周一 01-05)收 4 条:01-02 两条(同日必须推后一根)+ 周六 + 周日。手算见注释里的逐条归属。 */
  ok('对齐规则:c[] 逐格等于 [1,4,1,0,0,0,0](严格晚于 + 周六周日向后滚到周一)',
    bA.c.join(',') === '1,4,1,0,0,0,0', `c=[${bA.c.join(',')}]`);
  ok('晚于最后一根日线的新闻被丢弃,恰好 2 条(与最后一根同日的那条也算晚)',
    bA.dropped === 2, String(bA.dropped));
  ok('同日新闻不许算在当日:idx0 只收到 2025-12-31 那一条(写成 >= 的话这里会是 3)',
    bA.c[0] === 1 && bA.maxSrc[0] === '2025-12-31', `c[0]=${bA.c[0]} maxSrc[0]=${bA.maxSrc[0]}`);

  /* ---- F7 前瞻检测器本身要能抓到东西 ----
   *  正确装桶 → 0;把 2026-01-02 那两条硬塞回 idx0 → 必须 ≥1。
   *  只测前者的话,一个 `return 0` 的空实现也会全绿。 */
  const okAsof = kAsofViolations(pxA, bA.c, bA.maxSrc);
  const badSrc = bA.maxSrc.slice(); badSrc[0] = '2026-01-02';      /* 与 px[0].date 同日 = 已经算污染 */
  const badC = bA.c.slice(); badC[0] = 3;
  const badAsof = kAsofViolations(pxA, badC, badSrc);
  ok('前瞻检测器在正确装桶上返回 0', okAsof === 0, String(okAsof));
  ok('前瞻检测器在故意错装的桶上返回 1(不是 0 —— 「抽不到」和「一致」必须是两种结果)',
    badAsof === 1, String(badAsof));

  /* ---- F8 三个指标的触发位置,逐区间钉死 ----
   *  这条 c[] 是特意设计的,四个关键点:
   *   · c[40]=2 / c[80]=1 / c[85]=3 造出稀疏放量与两段沉寂;
   *   · c[100..119]=2 连续 20 根,把 20 日均值顶到 2;
   *   · c[120]=3 —— 3 > 1.5×2 = 3 **不成立**(不是严格大于),所以它**不许触发**;
   *     倍数一旦从 1.5 改成 1.4,阈值变 2.8,这一格立刻会多触发一次,断言当场红。
   *   · t=80..84 上 r20 = 1/20 与 r60 = 3/60 精确相等 → flowState 必须给 0(平局分支)。 */
  const cB = new Array(130).fill(0);
  cB[40] = 2; cB[80] = 1; cB[85] = 3;
  for (let i = 100; i <= 119; i++) cB[i] = 2;
  cB[120] = 3; cB[122] = 7;
  const sigOf = id => { const f = K_INDICATORS.find(x => x.id === id).sig; return cB.map((_, t) => f(cB, t)); };
  const sB = sigOf('newsBurst'), sD = sigOf('newsDrought'), sF = sigOf('newsFlowState');
  ok('newsBurst 触发位置逐区间等于 40,80,85,100-113,122(c[120]=3 不触发:3 > 1.5×2 不成立)',
    runs(sB, 1) === '40,80,85,100-113,122', runs(sB, 1));
  ok('newsBurst 一次都不给负号(它是单向指标,只声明 s=+1)', runs(sB, -1) === '', runs(sB, -1));
  ok('newsDrought 触发位置逐区间等于 19-39,60-79,且全部是 −1',
    runs(sD, -1) === '19-39,60-79' && runs(sD, 1) === '', `${runs(sD, -1)} | +:${runs(sD, 1)}`);
  ok('newsFlowState 的 +1 逐区间等于 59,85-129', runs(sF, 1) === '59,85-129', runs(sF, 1));
  ok('newsFlowState 的 −1 逐区间等于 60-79', runs(sF, -1) === '60-79', runs(sF, -1));
  ok('newsFlowState 在 r20 与 r60 精确相等的 80-84 上给 0,不是 +1(平局不入样)',
    sF.slice(80, 85).join(',') === '0,0,0,0,0', sF.slice(80, 85).join(','));

  /* ---- F9 共享率:只数参与票,别人的重复不算 ---- */
  const nsMap = new Map([
    ['X-US', [{ date: '2026-01-01', headline: 'A' }, { date: '2026-01-02', headline: 'B' }, { date: '2026-01-03', headline: 'C' }]],
    ['Y-US', [{ date: '2026-01-01', headline: 'A' }, { date: '2026-01-04', headline: 'D' }]],
    ['Z-US', [{ date: '2026-01-02', headline: 'B' }, { date: '2026-01-03', headline: 'C' }]],
  ]);
  const shXY = kShareRate(nsMap, ['X-US', 'Y-US']);
  const shXYZ = kShareRate(nsMap, ['X-US', 'Y-US', 'Z-US']);
  ok('共享率只在参与票之间算:X/Y 两只 → 5 行里 2 行共享,ρ 恰好 0.4',
    shXY.total === 5 && shXY.shared === 2 && shXY.rho === 0.4,
    JSON.stringify(shXY));
  ok('把 Z 也算进参与票 → 7 行里 6 行共享,ρ 恰好 6/7(证明作用域真的按名单走,不是全语料)',
    shXYZ.total === 7 && shXYZ.shared === 6 && shXYZ.rho === 6 / 7, JSON.stringify(shXYZ));

  /* ---- F10 端到端:折价系数真的被用在 C1 的那个数上 ----
   *  两份夹具只差一件事:两只票的标题是不是同一批。
   *  全共享 → ρ=1 → 折价系数 0 → effUsed 必须被压到 0(哪怕原始 effN 是 18);
   *  全独家 → ρ=0 → 折价系数 1 → effUsed 必须原样等于 effN。
   *  **把折价那一行删掉,前一条会红;把折价写成常数 1,前一条会红;写成常数 0,后一条会红。**
   *  原始 effMin = min(处理臂 30, 对照臂 18) = 18:处理臂的 30 次触发正好每 5 个交易日一次、
   *  与 h=5 严丝合缝所以一次不丢;对照臂是同频随机抽,抽到的日子会互相压覆,贪心去重后只剩 18。
   *  这两个数都是确定性的(对照臂的种子由 FNV-1a 从票名派生),所以可以钉死。 */
  const bizDays = n => {
    const out = []; const d = new Date(Date.UTC(2025, 0, 1));
    while (out.length < n) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
  };
  const DAYS = bizDays(200);
  const mkCos = () => new Map([['XX-US', DAYS.map((d, i) => ({ date: d, price: 100 + i }))],
    ['YY-US', DAYS.map((d, i) => ({ date: d, price: 100 + i }))]]);
  /* 每 5 个交易日一条新闻 → 20 日窗口里恒有 4 条,均值 0.2,于是每个新闻日都是一次放量 */
  const mkNews = same => new Map([
    ['XX-US', DAYS.filter((_, i) => i % 5 === 0).map((d, i) => ({ date: d, headline: same ? 'S' + i : 'X' + i }))],
    ['YY-US', DAYS.filter((_, i) => i % 5 === 0).map((d, i) => ({ date: d, headline: same ? 'S' + i : 'Y' + i }))]]);
  /* ctx 在 K 组里只被用到 brier 一处,这里给一个最小实现即可(被测的是折价与计数,不是 Brier) */
  const fakeCtx = { brier: (p, y) => p.reduce((a, v, i) => a + (v - y[i]) * (v - y[i]), 0) / p.length };
  const eeShared = testSentiment(fakeCtx, mkCos(), mkNews(true), [5]);
  const eeUniq = testSentiment(fakeCtx, mkCos(), mkNews(false), [5]);
  const burstOf = R => R.rows.find(r => r.ind.id === 'newsBurst' && r.h === 5);
  const bs = burstOf(eeShared), bu = burstOf(eeUniq);
  ok('端到端:两只票标题全共享 → ρ 恰好 1、折价系数恰好 0',
    eeShared.share.rho === 1 && eeShared.defl === 0, JSON.stringify({ rho: eeShared.share.rho, defl: eeShared.defl }));
  ok('端到端:全共享时 C1 用的 effUsed 被压到 0,而原始 effMin 是 18(折价被删掉的话这里会是 18)',
    bs.A.eff === 30 && bs.C.eff === 18 && bs.effMin === 18 && bs.effUsed === 0,
    JSON.stringify({ Aeff: bs.A.eff, Ceff: bs.C.eff, effMin: bs.effMin, effUsed: bs.effUsed }));
  ok('端到端:标题全独家 → ρ 恰好 0、折价系数恰好 1,effUsed 原样等于 18(与上一条是两种结果)',
    eeUniq.share.rho === 0 && eeUniq.defl === 1 && bu.effMin === 18 && bu.effUsed === 18,
    JSON.stringify({ rho: eeUniq.share.rho, defl: eeUniq.defl, effMin: bu.effMin, effUsed: bu.effUsed }));
  ok('端到端:触发数 30、命中率 100.0(价格逐根递增,s=+1 全对)、前瞻违例 0',
    bu.A.n === 30 && bu.A.eff === 30 && bu.hitPct === 100 && eeUniq.asofBad === 0,
    JSON.stringify({ n: bu.A.n, eff: bu.A.eff, hit: bu.hitPct, asof: eeUniq.asofBad }));
  /* 「一次都没触发」必须走 none 分支(→ no_signal),不能和「触发了但样本少」压成同一格 */
  const drRow = eeUniq.rows.find(r => r.ind.id === 'newsDrought' && r.h === 5);
  ok('端到端:每 5 天就有新闻 → newsDrought 一次都不触发,走 none 分支(no_signal),而 newsBurst 不走',
    drRow.none === true && bu.none === undefined && drRow.fires === 0,
    JSON.stringify({ droughtNone: drRow.none, droughtFires: drRow.fires, burstNone: bu.none }));

  /* ---- F11 有日线没新闻的票不许进矩阵 ----
   *  QQQ / SPY 就是这种:抓取器没给它们建 News.csv。把它们当成"零新闻"会让 newsDrought
   *  整年触发 —— 那是凭空造出来的信号,不是观测。这一条在真实数据上恰好也成立,
   *  但真实数据里它们碰巧被别的原因挡掉过,所以必须在夹具里单独钉一次。 */
  const cos3 = mkCos(); cos3.set('ZZ-US', DAYS.map((d, i) => ({ date: d, price: 100 + i })));
  const ee3 = testSentiment(fakeCtx, cos3, mkNews(false), [5]);
  ok('有日线没新闻的票被排除在参与票之外:3 只日线 + 2 只有新闻 → 参与票恰好是 XX/YY 两只',
    ee3.tks.join(',') === 'XX-US,YY-US', ee3.tks.join(','));
  ok('被排除的那只票也不会偷偷贡献触发:newsDrought 仍然是 none(它没有被当成整年零新闻)',
    ee3.rows.find(r => r.ind.id === 'newsDrought' && r.h === 5).none === true,
    JSON.stringify(ee3.rows.find(r => r.ind.id === 'newsDrought' && r.h === 5).none));

  /* ---- F11b 平盘 (r===0) 不进任何分母(SPEC M.4)----
   *  价格走阶梯:price = 100 + floor(i/10)。h=5 时 i%10<5 的那些起点的 5 日收益**精确为 0**。
   *  新闻日是 i%5===0,于是触发日恰好一半是平盘、一半是真涨 —— 平盘被排除 ⇒ 命中率 100.0;
   *  一旦 `continue` 被删掉,平盘会被当成"没涨"计入分母,n 翻倍、命中率掉到 50 以下。
   *  上面那份逐根递增的夹具里 r 永远不为 0,所以这条**必须**单独造一份阶梯价。 */
  const cosStep = new Map([['XX-US', DAYS.map((d, i) => ({ date: d, price: 100 + Math.floor(i / 10) }))],
    ['YY-US', DAYS.map((d, i) => ({ date: d, price: 100 + Math.floor(i / 10) }))]]);
  const eeStep = testSentiment(fakeCtx, cosStep, mkNews(false), [5]);
  const bstep = eeStep.rows.find(r => r.ind.id === 'newsBurst' && r.h === 5);
  ok('平盘不进分母:阶梯价下触发 30 次里只有 14 次非平盘,n=14、命中率 100.0(删掉那句 continue 会变成 30 次)',
    bstep.fires === 14 && bstep.A.n === 14 && bstep.hitPct === 100,
    JSON.stringify({ fires: bstep.fires, n: bstep.A.n, hit: bstep.hitPct }));
  /* ties 数的是可入场区间 [120,194] 里**所有**平盘日,不只是触发日:75 天里 i%10<5 的有 40 天,两只票 80 天 */
  ok('被排除的平盘日被单独数出来了(ties 恰好 80),不是悄悄消失',
    bstep.ties === 80, String(bstep.ties));

  /* ---- F12 预注册常数的冻结哨兵 ----
   *  这四个数写在 SPEC 附录 M.7 / M.8 里,是**跑之前**定死的。M.12 第 1 款:跑完一个字符都不许动。
   *  这一条不是行为测试,它是**防篡改哨兵**:谁事后把临界值调松一点好让某一格过闸,自检当场红。
   *  之所以值得占一条,是因为这一类改动在数字上完全无痕 —— 报告照样打印,退出码照样 0。 */
  ok('预注册常数没被事后改动:K_WARM=120、K_MIN_EFF=30、主检验临界 2.00、家族临界 2.78(SPEC M.7/M.8)',
    K_WARM === 120 && K_MIN_EFF === 30 && K_Z_PRIMARY === 2.00 && K_Z_FAMILY === 2.78,
    JSON.stringify({ K_WARM, K_MIN_EFF, K_Z_PRIMARY, K_Z_FAMILY }));
  ok('主检验那一格仍然是 newsBurst @ 5 日(M.8 按先验挑,不许事后改挂到别的格上)',
    K_PRIMARY.id === 'newsBurst' && K_PRIMARY.h === 5, JSON.stringify(K_PRIMARY));
  ok('指标恰好三个、id 与顺序与 SPEC M.3 逐字相同(加第四个指标 = 违反 M.12 第 2 款)',
    K_INDICATORS.map(i => i.id).join(',') === 'newsBurst,newsDrought,newsFlowState',
    K_INDICATORS.map(i => i.id).join(','));

  console.log(`\n${fail ? '\x1b[31mSELFTEST FAILED\x1b[0m' : '\x1b[32mSELFTEST OK\x1b[0m'} ${pass}${fail ? ` / ${fail} FAIL` : ''}\n`);
  return fail === 0;
}

function main() {
  const argv = process.argv.slice(2);
  /* --selftest 只跑读盘夹具:不读 Assets/,不装沙箱,不出报告,也不写台账。
   * 放在 main() 里面(而不是改文件末尾那行守卫)是为了不碰 paramsearch 依赖的那条 import 守卫。 */
  if (argv.includes('--selftest')) { process.exit(selfTest() ? 0 : 1); }
  const hArg = (argv.find(a => a.startsWith('--h')) || '').split('=')[1];
  const HZ = hArg ? hArg.split(',').map(Number) : [5, 21, 63];
  const wantLog = argv.includes('--log');
  const runDate = new Date().toISOString().slice(0, 10);

  const ctx = loadDashboard();
  const { cos, mkt, ohlcFiles } = loadDaily();
  const est = loadEstimates();
  const tgt = loadTargets();
  const news = loadNews();

  console.log(H('数据盘点 —— 能测什么,是数据说了算'));
  console.log(`  日线      ${cos.size} 只标的 × ~${cos.size ? [...cos.values()][0].length : 0} 个交易日,市场序列 ${mkt.size} 条(${[...mkt.keys()].join('/')})`);
  console.log(`  估值月度  ${est.size} 家 × ~${est.size ? [...est.values()][0].length : 0} 个月`);
  console.log(`  目标价月度 ${tgt.size} 家 × ~${tgt.size ? [...tgt.values()][0].length : 0} 个月`);
  console.log(`  新闻标题  ${news.size} 家 × 共 ${[...news.values()].reduce((a, r) => a + r.length, 0)} 条(一年,fetcher 逐轮累积)`);
  console.log('  \x1b[90m测不了:期权轨 —— 已攒 4–5 个快照日,其中一日为残链(18–37 行)。这不是"样本小",是\x1b[0m');
  console.log('  \x1b[90m           **没有时间序列**:没有时间序列就答不了"这堵墙顶住了没有",这一轨永远进不了 z 检验。\x1b[0m');
  console.log('  \x1b[90m           下面 H 组测的是**价格网格**(整 25 / 整 50 的价位),不是 OI 历史 —— 别把两件事混起来读。\x1b[0m');
  /* 只在真读到 O/H/L 时才多印这一行:今天一份都没有,于是这一行不存在,终端输出与加 OHLC 之前逐字节相同。
   * 印出来也只是盘点 —— 附录 K.2 把需要 O/H/L 的指标全判成 pending_no_ohlc,本文件不会因此多测一格。 */
  if (ohlcFiles) {
    console.log(`  \x1b[90mO/H/L    ${ohlcFiles} 份导出带开/高/低三列(已读入,但 K.2 把依赖 O/H/L 的指标判为 pending_no_ohlc —— 本轮仍不测)。\x1b[0m`);
  }

  if (!cos.size) { console.log('\n  Assets/charting 里没有日线,回测无从谈起。'); process.exit(1); }

  /* A */
  console.log(H('A · 波动率区间的覆盖率(仪表盘画的是一年 ±1σ)'));
  console.log('  \x1b[90m一年期区间本身无法验证:盘上只有一年日线,一个前瞻样本都没有。\x1b[0m');
  console.log('  \x1b[90m这里验的是它脚下的两个假设 —— 滚动 σ 在短周期准不准,以及 √t 能不能外推。\x1b[0m');
  console.log(`  ${pad('周期', 6)}${lpad('样本', 7)}${lpad('独立', 6)}${lpad('±1σ%', 8)}${lpad('(应68.3)', 10)}${lpad('±2σ%', 8)}${lpad('(应95.4)', 10)}  判定`);
  for (const r of testVolCoverage(ctx, cos, HZ)) {
    const thin = r.effN < 30;
    rec('A', 'cover1sigma', r.h, r.n, r.effN, r.c1, 68.27, r.z1, thin ? 'inconclusive' : Math.abs(r.z1) < 2 ? 'holds' : r.z1 < -2 ? 'too_narrow' : 'too_wide');
    rec('A', 'cover2sigma', r.h, r.n, r.effN, r.c2, 95.45, r.z2, thin ? 'inconclusive' : Math.abs(r.z2) < 2 ? 'holds' : r.z2 < -2 ? 'too_narrow' : 'too_wide');
    console.log(`  ${pad(r.h + '日', 6)}${lpad(r.n, 7)}${lpad(r.effN, 6)}${lpad(f1(r.c1), 8)}${lpad('z=' + f1(r.z1), 10)}${lpad(f1(r.c2), 8)}${lpad('z=' + f1(r.z2), 10)}  ${
      /* 独立样本不够时不能判"合格" —— 那不是校准准,是这段数据没资格发言。
       * 这个方向的自欺比误报更隐蔽:一条 49.6%(应 68.3%)被 effN=9 洗成绿灯。 */
      r.effN < 30 ? '\x1b[90m样本太少,看不出\x1b[0m'
      : Math.abs(r.z1) < 2 && Math.abs(r.z2) < 2 ? '\x1b[32m校准合格\x1b[0m'
      : (r.z1 < -2 || r.z2 < -2) ? '\x1b[31m区间偏窄(低估风险)\x1b[0m'
      : '\x1b[33m区间偏宽(过度保守)\x1b[0m'}`);
  }
  console.log('\n  √t 缩放(方差比,=1 才能按 √t 外推到一年):');
  for (const r of testVarianceRatio(cos, HZ)) {
    /* VR 没有 z 检验,判语按阈值给;n/effN 留空,免得日后看历史时误以为它做过显著性检验 */
    rec('A', 'varianceRatio', r.h, '', '', r.vr, 1, '',
      !isFinite(r.vr) ? 'inconclusive' : r.vr > 1.25 ? 'trending' : r.vr < 0.8 ? 'mean_reverting' : 'holds');
    console.log(`    ${pad(r.h + '日', 6)} VR=${f2(r.vr)}  ${
      !isFinite(r.vr) ? '' : r.vr > 1.25 ? '\x1b[31m>1:有趋势/波动聚集,一年期区间被低估\x1b[0m'
      : r.vr < 0.8 ? '\x1b[33m<1:均值回复,一年期区间画宽了\x1b[0m' : '\x1b[32m≈1,可以外推\x1b[0m'}`);
  }

  /* B */
  console.log(H('B · 技术位(支撑/压力带)是不是真被尊重 —— 距离匹配对照'));
  console.log('  \x1b[90m对照带 = 同侧 + 逐条同宽 + 到现价的距离从同侧的经验分布里重抽。上一版对照只控了宽度,\x1b[0m');
  console.log('  \x1b[90m位置在整个价区里均匀撒 —— 真实带贴着现价、对照带平均远得多,比的其实是"近 vs 远"。\x1b[0m');
  for (const h of [5, 21]) {
    const B = testBands(ctx, cos, { h });
    const thin = Math.min(B.effReal, B.effCtrl) < 30;
    console.log(`  \x1b[1m持有期 ${h} 日\x1b[0m  ${B.rounds} 轮重算(每 21 日一次),${B.noBand} 轮没画出带;触碰窗口固定 21 日,判决窗口 ${B.hold} 日`);
    console.log(`  ${pad('臂', 8)}${lpad('带条数', 8)}${lpad('平均距离u', 11)}${lpad('触碰', 6)}${lpad('撑住', 6)}${lpad('击穿', 6)}${lpad('未决', 6)}${lpad('判决事件', 10)}${lpad('撑住率%', 9)}`);
    console.log(`  ${pad('真实带', 8)}${lpad(B.nBandR, 8)}${lpad(f2(B.distR), 11)}${lpad(B.real.touch, 6)}${lpad(B.real.bounce, 6)}${lpad(B.real.brk, 6)}${lpad(B.real.stall, 6)}${lpad(B.decR, 10)}${lpad(f1(B.realRate), 9)}`);
    console.log(`  ${pad('对照带', 8)}${lpad(B.nBandC, 8)}${lpad(f2(B.distC), 11)}${lpad(B.ctrl.touch, 6)}${lpad(B.ctrl.bounce, 6)}${lpad(B.ctrl.brk, 6)}${lpad(B.ctrl.stall, 6)}${lpad(B.decC, 10)}${lpad(f1(B.ctrlRate), 9)}`);
    console.log(`  \x1b[90m两臂平均距离 ${f2(B.distR)}u vs ${f2(B.distC)}u —— 这两个数不接近就说明距离匹配没做成,下面的 z 不用看。\x1b[0m`);
    console.log(`  \x1b[90m有效样本:真实 ${B.effReal} / 对照 ${B.effCtrl}(同一轮里的多条带共用同一段行情,只算一条证据)。\x1b[0m`);
    console.log(`  判定:${B.degenerate ? '\x1b[31m对照臂退化(事件数不足处理臂 30%)—— 这是距离匹配写错了,不是数据的问题\x1b[0m'
      : verdict(B.z, thin)}  (z=${f2(B.z)},阈值 |z|≥2;对照覆盖率 ${f1(B.cover * 100)}%)`);
    /* 基准存的是对照臂的撑住率,不是某个固定数字 —— 这一组的"应该多少"每轮都不一样,
     * 只记 64.3% 而不记它当时在跟 89.3% 比,几个月后这行就读不出意思了。 */
    rec('B', 'bandHoldRate', h, B.real.touch, B.effReal, B.realRate, B.ctrlRate,
      B.z, B.degenerate ? 'degenerate_control' : vTag(B.z, thin));
    /* B2 闸门单独记一行:对照覆盖率本身是这组结论能不能成立的前提,不该埋在 verdict 里 */
    rec('B', 'controlCoverage', h, B.decC, B.effCtrl, B.cover, 1, '',
      B.degenerate ? 'degenerate_control' : 'recorded');
  }

  /* C */
  console.log(H('C · 走向倾斜度的方向性(21 日前瞻)'));
  const C = testTilt(ctx, cos, mkt, {});
  console.log(`  \x1b[90m宏观/行业/流动性三条腿同一天对所有标的是同一个数 —— 择时信号,横截面不含信息。\x1b[0m`);
  console.log(`  \x1b[90m一年日线只有约 ${Math.round((C.__days || 0) / 21)} 个不重叠的 21 日窗口。下面的数字请当作"看一眼",不是检验。\x1b[0m`);
  console.log(`  ${pad('腿', 10)}${lpad('样本', 7)}${lpad('独立', 6)}${lpad('rho', 8)}${lpad('同向%', 8)}${lpad('低档收益', 10)}${lpad('高档收益', 10)}  判定`);
  for (const [k, lb] of [['tilt', '综合倾斜'], ['tech', '技术'], ['m', '宏观'], ['i', '行业'], ['l', '流动性']]) {
    const r = C[k]; if (!r) continue;
    if (r.thin) { rec('C', k, 21, r.n, '', NaN, 0, NaN, 'inconclusive'); console.log(`  ${pad(lb, 10)}${lpad(r.n, 7)}  ${verdict(NaN, true)}`); continue; }
    /* "恒为常数"要单独记一个词。它和"看不出"完全是两回事:
     * 看不出是这条腿说了话但听不清,恒为常数是它整段历史一个字没说过 —— 后者该考虑摘掉。 */
    if (r.flat) { rec('C', k, 21, r.n, '', r.val, '', NaN, 'no_variance'); console.log(`  ${pad(lb, 10)}${lpad(r.n, 7)}  \x1b[90m整段历史恒为 ${f2(r.val)},这条腿没产生过区分度\x1b[0m`); continue; }
    rec('C', k, 21, r.n, r.effN, r.rho, 0, r.z, vTag(r.z, r.effN < 20));
    console.log(`  ${pad(lb, 10)}${lpad(r.n, 7)}${lpad(r.effN, 6)}${lpad(f2(r.rho), 8)}${lpad(f1(r.hit), 8)}${lpad(f1(r.loBucket) + '%', 10)}${lpad(f1(r.hiBucket) + '%', 10)}  ${verdict(r.z, r.effN < 20)}`);
  }

  /* D */
  console.log(H('D · 估值核心区间 vs 实际(月度面板,不重叠 —— 全场样本最像样的一组)'));
  console.log('  \x1b[90m注意:Estimate History 是"对同一个财年"的估计史,和仪表盘今天用的 FY1 口径不完全一致;\x1b[0m');
  console.log('  \x1b[90m函数形式相同(EPS 情景 × P/E 分位),但结论要对口径打个折看。\x1b[0m');
  console.log(`  ${pad('前瞻', 6)}${lpad('样本', 7)}${lpad('独立', 6)}${lpad('落在核心%', 11)}${lpad('落在极端%', 11)}${lpad('中枢MAE%', 10)}${lpad('不动MAE%', 10)}${lpad('之比', 7)}${lpad('方向%', 8)}  判定`);
  const DV = testValuation(ctx, est);
  for (const r of DV) {
    /* 这一组没有 z,判语来自 MAE 之比。基准恒为 1.00 —— 也就是"价格不动"这个对手。
     * 存 ratio 而不存两个 MAE:MAE 会随行情整体缩放,比值才是跨轮可比的那个数。 */
    rec('D', 'valMaeRatio', r.h * 21, r.n, r.effN, r.ratio, 1, '',
      r.effN < 30 || !isFinite(r.ratio) ? 'inconclusive' : r.ratio < 0.95 ? 'holds' : r.ratio > 1.05 ? 'inverted' : 'inconclusive');
    /* 核心区间是 low×p25 .. high×p75,没有一个「理论上应该覆盖百分之几」的数,
     * 所以这一行只记数、不判对错(recorded)—— 没有基准还盖个 holds,就是自己给自己发绿灯。 */
    rec('D', 'valCoreCover', r.h * 21, r.n, r.effN, r.core, '', '', 'recorded');
    rec('D', 'valDirHit', r.h * 21, r.n, r.effN, r.dir, 50, '',
      r.effN < 30 ? 'inconclusive' : r.dir > 55 ? 'holds' : r.dir < 45 ? 'inverted' : 'inconclusive');
    console.log(`  ${pad(r.h + '月', 6)}${lpad(r.n, 7)}${lpad(r.effN, 6)}${lpad(f1(r.core), 11)}${lpad(f1(r.ext), 11)}${lpad(f1(r.mae), 10)}${lpad(f1(r.maeRW), 10)}${lpad(f2(r.ratio), 7)}${lpad(f1(r.dir), 8)}  ${
      (!isFinite(r.ratio) ? '—' : r.ratio < 0.95 ? '\x1b[32m比"价格不动"准\x1b[0m' : r.ratio > 1.05 ? '\x1b[31m不如"价格不动"\x1b[0m' : '\x1b[33m和"价格不动"打平\x1b[0m')
      + (r.effN < 30 ? '\x1b[90m(独立样本 ' + r.effN + ',只能算参考)\x1b[0m' : '')}`);
  }
  /* 输在哪里,比输了多少更有用:是四处乱飘,还是一直朝一个方向偏。 */
  /* 单边偏低这件事是这轮 D 组唯一确凿的结论,单独记一行:
   * 它要是随着行情从再评级转向回落而自己收敛回 0,那就证明是口径问题而非模型坏了。 */
  if (DV[0] && isFinite(DV[0].biasMed))
    rec('D', 'valAnchorBias', DV[0].h * 21, DV[0].n, DV[0].effN, DV[0].biasMed, 0, '',
      Math.abs(DV[0].biasMed) < 5 ? 'holds' : 'biased');   /* 不叫 inverted:符号没反,是整体挂偏了 */
  if (DV[0] && isFinite(DV[0].biasMed))
    console.log(`\n  \x1b[1m差在哪:中枢相对现价的偏离,中位 ${f1(DV[0].biasMed)}%,有 ${f1(DV[0].biasBelow)}% 的时点低于现价。\x1b[0m\n`
      + `  \x1b[90m这不是"误差大",是**单边偏低**:P/E 分位取自这只票自己的历史,而这一年是再评级行情 ——\n`
      + `  历史中位 P/E 一直追不上当前 P/E,于是中枢常年挂在现价下方,方向命中率也跟着掉到 50% 以下。\n`
      + `  区间还能当"贵没贵"的参照,但别拿中枢当目标价。\x1b[0m`);

  /* E */
  console.log(H('E · 情绪面两条能回放的腿(月度,不重叠)'));
  const revScore = (rs, t) => { const r = rs[t]; return r.n > 0 && isFinite(r.up) && isFinite(r.down)
    ? Math.max(-1, Math.min(1, (r.up - r.down) / r.n * 2)) : NaN; };
  const tgtScore = (rs, t) => { if (t < 3) return NaN; const a = rs[t], b = rs[t - 3];
    if (!(b.tgt > 0)) return NaN; const c = (a.tgt / b.tgt - 1) * 100;
    return c >= 8 ? 1 : c >= 3 ? 0.5 : c > -3 ? 0 : c > -8 ? -0.5 : -1; };
  const show = (label, rowsMap, metric, scorer) => {
    console.log(`  \x1b[1m${label}\x1b[0m`);
    for (const r of testMonthlySignal(rowsMap, scorer, [1, 3, 6])) {
      if (r.thin) { rec('E', metric, r.h * 21, r.n, '', NaN, 0, NaN, 'inconclusive'); console.log(`    ${pad(r.h + '月', 6)}${lpad(r.n, 7)}  ${verdict(NaN, true)}`); continue; }
      rec('E', metric, r.h * 21, r.n, r.effN, r.rho, 0, r.z, vTag(r.z, r.effN < 20));
      console.log(`    ${pad(r.h + '月', 6)}${lpad(r.n, 7)}${lpad(f2(r.rho), 8)}${lpad(f1(r.hit) + '%', 9)}${lpad(f1(r.loBucket) + '%', 10)}${lpad(f1(r.hiBucket) + '%', 10)}  ${verdict(r.z, r.effN < 20)}`);
    }
  };
  console.log(`    ${pad('前瞻', 6)}${lpad('样本', 7)}${lpad('rho', 8)}${lpad('同向', 9)}${lpad('低档收益', 10)}${lpad('高档收益', 10)}`);
  if (est.size) show('修正动量((上调−下调)/覆盖数,权重 —— 走向面板基本面腿)', est, 'revMomentum', revScore);
  if (tgt.size) show('目标价动量(3 个月变化分档,权重 0.35 —— 情绪腿里最重的一条)', tgt, 'tgtMomentum', tgtScore);

  /* F */
  console.log(H('F · 新闻情绪(30 日关键词打分,权重 0.25 —— 情绪腿里第二重的一条)'));
  if (!news.size) {
    console.log('  \x1b[90mAssets/news/ 里没有 News.csv,这一组跳过。\x1b[0m');
  } else {
    console.log('  \x1b[90mnewsScore(ticker, 参照日) 的第二个参数就是"站在哪一天看",\x1b[0m');
    console.log('  \x1b[90m未来的标题被 `年龄<0 就跳过` 挡在外面 —— 这条腿在构造上偷不了看,是最干净的一条。\x1b[0m');
    console.log(`  ${pad('前瞻', 6)}${lpad('样本', 7)}${lpad('独立', 6)}${lpad('rho', 8)}${lpad('同向%', 8)}${lpad('低档收益', 10)}${lpad('高档收益', 10)}  判定`);
    const FN = testNews(ctx, cos, news, HZ);
    for (const r of FN) {
      if (r.thin) { rec('F', 'newsScore', r.h, r.n, r.effN ?? '', NaN, 0, NaN, 'inconclusive'); console.log(`  ${pad(r.h + '日', 6)}${lpad(r.n, 7)}  ${verdict(NaN, true)}`); continue; }
      rec('F', 'newsScore', r.h, r.n, r.effN, r.rho, 0, r.z, vTag(r.z, r.effN < 30));
      console.log(`  ${pad(r.h + '日', 6)}${lpad(r.n, 7)}${lpad(r.effN, 6)}${lpad(f2(r.rho), 8)}${lpad(f1(r.hit), 8)}${lpad(f1(r.loBucket) + '%', 10)}${lpad(f1(r.hiBucket) + '%', 10)}  ${verdict(r.z, r.effN < 30)}`);
    }
    const f0 = FN.find(r => !r.thin);
    if (f0) console.log(`  \x1b[90m有效样本按 max(前瞻, 30) 折算 —— 打分窗口本身有 30 天记忆,相邻两天读到的是同一批标题。\x1b[0m\n`
      + `  \x1b[90m其中 ${f0.quiet} 个时点是"30 日内无新闻"(记 0 分,不进同向率的分母)。\x1b[0m`);
  }

  /* G */
  console.log(H('G · 可达性概率的校准(reachProb vs 气候基准,样本外)'));
  console.log('  \x1b[90m这是压力位引擎唯一有资格进验收的声明:"未来 h 日内至少触到这条位置的概率是 p"。\x1b[0m');
  console.log('  \x1b[90m对照是**气候基准** —— 一个常数预测,值 = 训练折的实际触及率。赢不了常数,这条腿就是装饰。\x1b[0m');
  console.log('  \x1b[90m折 = 标的(10 只票 10 折):同一只票的滚动窗口互相重叠,拆到同一折里才算样本外。\x1b[0m');
  console.log(`  ${pad('周期', 6)}${lpad('样本', 8)}${lpad('独立', 6)}${lpad('基准触及率', 12)}${lpad('样本内skill', 12)}${lpad('OOS skill', 11)}${lpad('CV下界', 9)}${lpad('门槛', 8)}  判定`);
  const GTH = { 5: 0, 21: 0.15, 63: 0.25 };            /* 3.9 预注册,跑完不许改 */
  const GDEV = 0.10;                                   /* 同上:可靠性图最大偏差门槛,预注册值 */
  const GR = testReach(ctx, cos, HZ, {});
  for (const r of GR) {
    if (r.thin) { rec('G', 'brierSkill', r.h, 0, '', NaN, NaN, '', 'inconclusive'); console.log(`  ${pad(r.h + '日', 6)}${lpad(0, 8)}  ${verdict(NaN, true)}`); continue; }
    const th = GTH[r.h] ?? 0;
    /* 3.9 给这一格预注册的是**三条**判据,而且是并联的:样本外 skill 过门槛、CV 下界 > 0、
     * 可靠性图 10 桶最大偏差 ≤ 0.10。这一行以前只 AND 了前两条 —— 第三条被丢到下面的
     * 可靠性图分节里单独判、单独打印,于是同一个持有期可以在这里印绿色「过线」、
     * 在十行之后印红色「校准不良」,而**整份报告里没有任何一句话说 reach 这条腿没过**。
     * 一个人只看这张汇总表就会带走"过了"这个结论,这不是显示问题,是判据被拆散了。
     * 现在三条一起 AND。门槛一个字没改,只是终于都被算进同一个 ok 里,
     * 后果就是本来绿的格子要变红 —— 那正是这三个数一直在说的事。 */
    const devOk = isFinite(r.maxDev) && r.maxDev <= GDEV;
    const ok = isFinite(r.skillOOS) && r.skillOOS > th && isFinite(r.cvLo) && r.cvLo > 0 && devOk;
    /* 基准列按 3.4 的行模板写死 0(= 气候基准自己的 skill),门槛只印在终端。
     * 判语用 calibrated/miscalibrated 也是照 3.4 的模板 —— 语义上它和下面那行
     * reliabilityMaxDev 的同名判语指的不是一回事(这里是"三条判据全过没全过",
     * 那里是"单看偏差偏不偏"),读账时要靠 metric 列区分,不能只看 verdict 列。 */
    rec('G', 'brierSkill', r.h, r.n, r.effN, r.skillOOS, 0, '', ok ? 'calibrated' : 'miscalibrated');
    rec('G', 'brierSkillCvLo', r.h, r.n, r.effN, r.cvLo, 0, '', 'recorded');
    console.log(`  ${pad(r.h + '日', 6)}${lpad(r.n, 8)}${lpad(r.effN, 6)}${lpad(f1(r.base * 100) + '%', 12)}${lpad(f2(r.skillIn), 12)}${lpad(f2(r.skillOOS), 11)}${lpad(f2(r.cvLo), 9)}${lpad('>' + th.toFixed(2), 8)}  ${
      ok ? '\x1b[32m过线\x1b[0m' : '\x1b[31m未过线\x1b[0m'}`);
    /* 未过线时把**是哪一条**没过写出来:三条并联的判据,只印一个"未过线"等于让读者去猜。 */
    if (!ok) {
      const why = [];
      if (!(isFinite(r.skillOOS) && r.skillOOS > th)) why.push(`样本外 skill ${f2(r.skillOOS)} ≤ 门槛 ${th.toFixed(2)}`);
      if (!(isFinite(r.cvLo) && r.cvLo > 0)) why.push(`CV 下界 ${f2(r.cvLo)} ≤ 0`);
      if (!devOk) why.push(`可靠性图最大偏差 ${f2(r.maxDev)} > ${GDEV.toFixed(2)}`);
      console.log(`    \x1b[31m未过项:${why.join(';')}\x1b[0m`);
    }
    /* CV 下界的临界值跟着实际折数走,不是常数 1.96 —— 把 df 和用到的 t 值印出来,
     * 免得下一个人看到"下界"两个字就默认它是正态的。 */
    console.log(`    \x1b[90mCV:${r.nf} 折(折 = 标的),有效折 ${r.foldSkill.length},`
      + `临界值 t(${r.cvDf}) = ${isFinite(r.cvT) ? r.cvT.toFixed(3) : '—'}(不是 1.96);最差折 skill ${f2(r.minFold)}。\x1b[0m`);
    /* 折数封顶的分叉必须自己喊出来,不能靠人记得去数票数(见 testReach 里 nf 的注释)。 */
    if (r.capped) {
      console.log(`    \x1b[33m警告:标的数 ${r.clusters} > 折数上限 ${r.nf},已有标的被折回同一折 —— `
        + `这已经不是 leave-one-ticker-out,同折内两只票互为"样本外"的说法不再成立。\x1b[0m`);
    }
  }
  /* 只报一个 skill 数是看不出偏在哪一头的:整列概率贴到 0 或贴到 1(σ 量纲走错门的典型症状)
   * 都可能留下一个不难看的 skill。10 桶表必须打出来,空桶本身就是警报。 */
  for (const r of GR) {
    if (r.thin) continue;
    const th = GDEV;                                   /* 与上面 ok 里用的是同一个常数,不许分家 */
    rec('G', 'reliabilityMaxDev', r.h, r.n, r.effN, r.maxDev, th, '',
      !isFinite(r.maxDev) ? 'inconclusive' : r.maxDev > th ? 'miscalibrated' : 'calibrated');
    console.log(`\n  \x1b[1m${r.h} 日可靠性图(10 桶)\x1b[0m   最大偏差 ${f2(r.maxDev)}(门槛 ≤0.10)→ ${
      !isFinite(r.maxDev) ? '\x1b[90m算不出\x1b[0m' : r.maxDev > th ? '\x1b[31m校准不良 miscalibrated\x1b[0m' : '\x1b[32m校准合格 calibrated\x1b[0m'}`);
    console.log(`    ${pad('预测概率区间', 14)}${lpad('样本', 8)}${lpad('平均预测', 10)}${lpad('实际触及率', 12)}${lpad('偏差', 8)}`);
    for (const b of r.buckets) {
      if (!b.n) { console.log(`    ${pad(b.lo.toFixed(1) + '–' + b.hi.toFixed(1), 14)}${lpad(0, 8)}${lpad('—', 10)}${lpad('—', 12)}${lpad('—', 8)}  \x1b[33m空桶\x1b[0m`); continue; }
      console.log(`    ${pad(b.lo.toFixed(1) + '–' + b.hi.toFixed(1), 14)}${lpad(b.n, 8)}${lpad(f2(b.pm), 10)}${lpad(f2(b.ym), 12)}${lpad((b.ym - b.pm >= 0 ? '+' : '') + f2(b.ym - b.pm), 8)}${
        b.dev > th ? '  \x1b[31m超门槛\x1b[0m' : ''}`);
    }
    /* 空桶通常是"概率被挤在一头"的警报(σ 量纲走错门的典型症状),但这一组的低位空桶是
     * **结构性**的:视野闸门只放 edgeU ≤ PX_REACH_U(=1u) 的位置进表,于是 pReach 有一个
     * 硬下限 2Φ(−PX_REACH_U/c),低于它的概率这张表里根本不可能出现。先把这个下限打出来,
     * 空桶数对得上就不是量纲事故;对不上才该回头查 σ。 */
    if (r.empty) {
      const floor = 2 * ctx.normCdf(-ctx.PX.PX_REACH_U / ctx.PX.PX_REACH_C[r.h]);
      const expect = Math.floor(floor * 10);
      console.log(`    \x1b[33m有 ${r.empty} 个空桶。\x1b[0m\x1b[90m视野闸门 edgeU ≤ ${ctx.PX.PX_REACH_U}u 给 pReach 压了一个硬下限 `
        + `2Φ(−${ctx.PX.PX_REACH_U}/${ctx.PX.PX_REACH_C[r.h]}) = ${f2(floor)},${expect} 个低位桶结构上就进不去 —— `
        + `${r.empty === expect ? '数对得上,不是 σ 量纲事故' : '\x1b[31m数对不上,回头查 σ 量纲(日 vs 年化)\x1b[0m'}。\x1b[0m`);
    }
    console.log(`    \x1b[90m仅看 n≥30 的桶,最大偏差 ${f2(r.maxDev30)};10 折中最差一折 skill ${f2(r.minFold)};pReach 为 NaN 被跳过 ${r.skipC} 条,${r.noLv} 个时点一条位置都没报出来。\x1b[0m`);
  }

  /* H / H2 */
  console.log(H('H · 价格网格的位移抑制(整 25 网格 vs 相邻中点,配对)'));
  console.log('  \x1b[90m处理臂 = h 日后的价到最近网格点的标准化位移 |Δ|/u;对照臂 = 同一个未来价到相邻两网格中点的位移。\x1b[0m');
  console.log('  \x1b[90m中点格与网格格同间距、同周期,原假设下两者同分布(期望都是 步长/4)—— 同距离、同宽度的对照。\x1b[0m');
  console.log('  \x1b[90m检验按标的做 cluster bootstrap(2000 次):日观测按天滚动、重叠严重,唯一站得住的独立单位是标的。\x1b[0m');
  console.log('  \x1b[90m63 日按 3.9 预注册为 N/A:一个季度之后价格早已漂出好几个网格,"最近网格点"不再是同一个点。\x1b[0m');
  console.log(`  ${pad('周期', 6)}${lpad('样本', 8)}${lpad('独立', 6)}${lpad('票数', 6)}${lpad('MAE网格', 10)}${lpad('MAE中点', 10)}${lpad('配对差δ', 10)}${lpad('95%CI', 18)}${lpad('z', 7)}  判定`);
  const HR = testGridDisp(ctx, cos, HZ.filter(h => h !== 63), {});
  for (const r of HR) {
    const a = r.all;
    if (a.thin) { rec('H', 'containDisp', r.h, 0, '', NaN, 0, '', 'inconclusive'); console.log(`  ${pad(r.h + '日', 6)}${lpad(0, 8)}  ${verdict(NaN, true)}`); continue; }
    /* 3.9 预注册:CI 上界 < 0 且点估计 z ≤ −2 才算 holds,否则一律 inconclusive。
     * 注意方向:δ<0 = 网格位移更小 = 抑制成立,所以这里要的是**负**的 z,和别的组反着看。 */
    const holds = isFinite(a.hi) && a.hi < 0 && isFinite(a.z) && a.z <= -2;
    rec('H', 'containDisp', r.h, a.n, r.effN, a.mean, 0, a.z, holds ? 'holds' : 'inconclusive');
    console.log(`  ${pad(r.h + '日', 6)}${lpad(a.n, 8)}${lpad(r.effN, 6)}${lpad(a.k, 6)}${lpad(f2(r.maeGrid), 10)}${lpad(f2(r.maeMid), 10)}${lpad(f2(a.mean), 10)}${lpad('[' + f2(a.lo) + ', ' + f2(a.hi) + ']', 18)}${lpad(f2(a.z), 7)}  ${
      holds ? '\x1b[32m抑制成立\x1b[0m' : '\x1b[33m看不出(CI 上界未过 0 或 |z|<2)\x1b[0m'}`);
  }
  console.log(H('H2 · 按 x50 / x25 分层(只记录,不判对错)'));
  console.log('  \x1b[90m提案三的 z=−1.70 / −1.82 在 x25 上没能复现。这是一条**等待复现的线索**,不是等待验收的结论 ——\x1b[0m');
  console.log('  \x1b[90m所以 3.9 给这一层的判语恒为 recorded,不设门槛:先记着,等历史长了再回来看它站不站得住。\x1b[0m');
  console.log(`  ${pad('周期', 6)}${pad('层', 8)}${lpad('样本', 8)}${lpad('票数', 6)}${lpad('配对差δ', 10)}${lpad('95%CI', 18)}${lpad('z', 7)}`);
  for (const r of HR) {
    for (const [k, lb, met] of [['x50', '整五十', 'containDispX50'], ['x25', '整二十五', 'containDispX25']]) {
      const s = r[k];
      if (s.thin) { rec('H', met, r.h, 0, '', NaN, 0, '', 'recorded'); console.log(`  ${pad(r.h + '日', 6)}${pad(lb, 8)}${lpad(0, 8)}  \x1b[90m这一层没有观测\x1b[0m`); continue; }
      rec('H', met, r.h, s.n, s.k, s.mean, 0, s.z, 'recorded');
      console.log(`  ${pad(r.h + '日', 6)}${pad(lb, 8)}${lpad(s.n, 8)}${lpad(s.k, 6)}${lpad(f2(s.mean), 10)}${lpad('[' + f2(s.lo) + ', ' + f2(s.hi) + ']', 18)}${lpad(f2(s.z), 7)}`);
    }
  }
  console.log('  \x1b[90m分层本身高度依赖标的:哪个网格点最近完全由价位决定,一只 30 元的票几乎只落在 x25 那一层。\x1b[0m');

  /* I */
  console.log(H('I · 买入规则模拟(五条预设 vs 同频随机入场)'));
  console.log('  \x1b[90m测的是"这条规则挑的时点,比在同一段历史里随便挑同样多的时点更好吗"——直接调面板那份 simRun,\x1b[0m');
  console.log('  \x1b[90m不另写一套回放。对照必须是**同频随机**:这一年是单边上行年,随便哪天买持有 21 天胜率本就六七成,\x1b[0m');
  console.log('  \x1b[90m拿 50% 当基准会让五条预设全部"跑赢",而它们赢的是行情不是规则。种子由 票+规则文本 派生,不可挑。\x1b[0m');
  console.log('  \x1b[90m63 日按 3.9 预注册为 N/A → 前瞻记账:252 根 / 63 = 4 个不重叠窗口 × 2.1 只有效票 ≈ 8,MDE 远大于任何合理效应。\x1b[0m');
  console.log(`  ${pad('预设', 13)}${lpad('持有', 5)}${lpad('票数', 5)}${lpad('触发', 6)}${lpad('独立', 6)}${lpad('对照独立', 9)}${lpad('胜率%', 8)}${lpad('对照%', 8)}${lpad('z', 7)}${lpad('留一z', 8)}  判定`);
  const IR = testSimPresets(ctx, cos, HZ.filter(h => h !== 63));
  for (const r of IR) {
    /* 3.9 预注册的三道闸门,全部通过才算 holds:z ≥ 2、effN ≥ 30、去掉贡献最大的一只票后 z ≥ 1.5。
     * effN 取两臂较小的那个 —— 对照臂样本不够时,这个 z 一样没资格发言。 */
    const effMin = Math.min(r.effN, r.cEffN);
    const holds = isFinite(r.z) && r.z >= 2 && effMin >= 30 && isFinite(r.looZ) && r.looZ >= 1.5;
    rec('I', r.id, r.hold, r.n, r.effN, r.winPct, r.ctrlPct, r.z, holds ? 'holds' : 'inconclusive');
    if (!r.n) {
      console.log(`  ${pad(r.id, 13)}${lpad(r.hold + '日', 5)}${lpad(r.k, 5)}${lpad(0, 6)}  \x1b[90m整段历史一次都没触发 —— 没有样本,不是"看不出",是"没得看"\x1b[0m`);
      continue;
    }
    console.log(`  ${pad(r.id, 13)}${lpad(r.hold + '日', 5)}${lpad(r.k, 5)}${lpad(r.n, 6)}${lpad(r.effN, 6)}${lpad(r.cEffN, 9)}${lpad(f1(r.winPct), 8)}${lpad(f1(r.ctrlPct), 8)}${lpad(f2(r.z), 7)}${lpad(f2(r.looZ), 8)}  ${
      holds ? '\x1b[32m站得住\x1b[0m' : verdict(r.z, effMin < 30)}${
      r.looTk ? '\x1b[90m(留一去掉 ' + r.looTk + ')\x1b[0m' : ''}`);
  }
  console.log('  \x1b[90m三道闸门是 3.9 预注册的:z ≥ 2 且 effN ≥ 30 且留一 z ≥ 1.5,三条缺一不可,跑完再改就是作弊。\x1b[0m');
  console.log('  \x1b[90m处理臂持仓期间不重复开仓,交易天然不重叠(effN = 触发数);对照臂随机撒点会撞出重叠,所以它的独立数更小。\x1b[0m');

  /* J */
  console.log(H('J · K 线图技术指标(预注册于 SPEC 附录 K,写在算出任何一个数之前)'));
  console.log('  \x1b[90m用户的裁决是「指标必须过同一道闸」:要在图上带颜色带徽章的东西,先在样本外赢过 reach 轨那类基准。\x1b[0m');
  console.log('  \x1b[90m四条判据并联,全过才算过 —— C1 有效样本 min(处理,对照)≥30;C2 留一标的的样本外 Brier skill>0;\x1b[0m');
  console.log('  \x1b[90mC3 折间稳定 CV 下界(t(k−1))>0;C4 vs 同频随机对照的两比例 z ≥ 临界。缺一格就是素线,没有「差一点」这回事。\x1b[0m');
  console.log(`  \x1b[90m多重比较:家族恰好 12 格 = 4 指标 × 3 前瞻。主检验一格(${J_PRIMARY.id} @ ${J_PRIMARY.h} 日)临界 |z|≥${f2(J_Z_PRIMARY)},\x1b[0m`);
  console.log(`  \x1b[90m其余 11 格 Bonferroni m=12(主检验也算进分母)临界 |z|≥${f2(J_Z_FAMILY)}。测 12 格只报最好看的那格,是加了工序的 p-hacking。\x1b[0m`);
  console.log('  \x1b[90m附录 K.7 的预注册预期写着:1 年数据上 12 格全部 inconclusive、零格 holds。真跑出 holds,第一件事是回头查 as-of 截断。\x1b[0m');
  console.log(`  ${pad('指标', 12)}${lpad('前瞻', 5)}${lpad('票', 4)}${lpad('触发', 6)}${lpad('独立', 6)}${lpad('对照独立', 9)}${lpad('命中%', 8)}${lpad('对照%', 8)}${lpad('z', 7)}${lpad('临界', 6)}${lpad('skill', 8)}${lpad('CV下界', 9)}  判定`);
  const JR = testIndicators(ctx, cos, HZ);
  for (const r of JR) {
    const id = r.ind.id;
    if (r.none) {
      /* 「一次都没触发」和「触发了但样本少」得分开记 —— 前者要先问指标是不是写错了,后者只能等历史变长 */
      rec('J', id, r.h, 0, '', NaN, NaN, '', 'no_signal');
      console.log(`  ${pad(id, 12)}${lpad(r.h + '日', 5)}${lpad(r.tks, 4)}${lpad(0, 6)}  \x1b[90m整段历史一次都没触发 —— no_signal,不是样本少,是没有样本\x1b[0m`);
      continue;
    }
    const crit = (id === J_PRIMARY.id && r.h === J_PRIMARY.h) ? J_Z_PRIMARY : J_Z_FAMILY;
    const effMin = Math.min(r.A.eff, r.C.eff);
    const degenerate = r.A.eff > 0 && r.C.eff < 0.3 * r.A.eff;
    const c1 = effMin >= J_MIN_EFF, c2 = r.skillOOS > 0, c3 = r.cvLo > 0, c4 = isFinite(r.z) && r.z >= crit;
    const holds = c1 && c2 && c3 && c4;
    /* inverted 故意不要求 C2/C3:让一条线开始带颜色要四条全过,让它停止被当成正向信号只需要它稳定地错。
     * 举证责任在「要画」的那一边(K.8)。 */
    const inverted = c1 && isFinite(r.z) && r.z <= -crit;
    const v = degenerate ? 'degenerate_control' : holds ? 'holds' : inverted ? 'inverted' : 'inconclusive';
    rec('J', id, r.h, r.A.n, r.A.eff, r.hitPct, r.ctrlPct, degenerate ? NaN : r.z, v);
    rec('J', id + 'Skill', r.h, r.keys, r.foldSkill.length, r.skillOOS, 0, '', 'recorded');
    rec('J', id + 'StateDev', r.h, r.states.length, '', r.maxStateDev, 0, '', 'recorded');
    const tag = v === 'holds' ? '\x1b[32m站得住\x1b[0m'
      : v === 'inverted' ? '\x1b[31m反了\x1b[0m'
      : v === 'degenerate_control' ? '\x1b[90m对照臂退化,z 不发布\x1b[0m'
      : '\x1b[33m未过线\x1b[0m';
    console.log(`  ${pad(id, 12)}${lpad(r.h + '日', 5)}${lpad(r.tks, 4)}${lpad(r.fires, 6)}${lpad(r.A.eff, 6)}${lpad(r.C.eff, 9)}${lpad(f1(r.hitPct), 8)}${lpad(f1(r.ctrlPct), 8)}${lpad(f2(r.z), 7)}${lpad(f2(crit), 6)}${lpad(f2(r.skillOOS), 8)}${lpad(f2(r.cvLo), 9)}  ${tag}`);
    /* 光印「未过线」会让读者去猜是四条里的哪一条挂了。挂哪条,决定的是接下来该干什么:
     * C1 挂了等历史变长,C4 挂了是效应本身不够大 —— 两件完全不同的事,不能压成同一句话。 */
    if (!holds && v !== 'degenerate_control') {
      const miss = [];
      if (!c1) miss.push(`C1 有效样本 ${effMin}<${J_MIN_EFF}`);
      if (!c2) miss.push(`C2 样本外 skill ${f2(r.skillOOS)}≤0`);
      if (!c3) miss.push(`C3 CV 下界 ${f2(r.cvLo)}≤0(t(${r.cvDf})=${f2(r.cvT)},${r.foldSkill.length} 折)`);
      if (!c4) miss.push(`C4 效应量 z=${f2(r.z)}<${f2(crit)}`);
      console.log(`  ${pad('', 12)}\x1b[90m未过项:${miss.join(';')}${r.capped ? ';折数封顶 10(共 ' + r.keys + ' 只票)' : ''}\x1b[0m`);
    }
  }
  console.log('  \x1b[90m状态表(只记不判,recorded):逐状态的样本外平均预测 vs 实际涨频。指标最多给 k≤3 个不同预测值,\x1b[0m');
  console.log('  \x1b[90m套 G 组那张 10 桶可靠性图会有七个以上结构性空桶,而那里写着「空桶本身就是警报」—— 那条警报在这里没有信息。\x1b[0m');
  console.log(`  ${pad('指标', 12)}${lpad('前瞻', 5)}${lpad('状态', 6)}${lpad('样本', 7)}${lpad('预测', 8)}${lpad('实际', 8)}${lpad('偏差', 8)}`);
  for (const r of JR) {
    if (r.none || !r.states.length) continue;
    for (const s of r.states) {
      console.log(`  ${pad(r.ind.id, 12)}${lpad(r.h + '日', 5)}${lpad(s.s > 0 ? '看涨' : s.s < 0 ? '看跌' : '中性', 6)}${lpad(s.n, 7)}${lpad(f2(s.pm), 8)}${lpad(f2(s.ym), 8)}${lpad(f2(s.dev), 8)}`);
    }
  }
  console.log('  \x1b[90m被 O/H/L 卡死、本轮一格都没测的东西(K.2):判 pending_no_ohlc,写前瞻台账。\x1b[0m');
  console.log('  \x1b[90m注意 K 线的实体与影线本身就在这一列 —— 导出的表只有 Date/Close/Volume,今天这张图只能是收盘折线,\x1b[0m');
  console.log('  \x1b[90m叫它 K 线图是名不副实;而用 |Δ收盘| 凑一个「差不多的 ATR」再拿去过闸,验收的就不是用户以为的那个指标了。\x1b[0m');
  for (const [k, lb] of [['ohlcCandle', 'K 线实体与影线'], ['atrChannel', 'ATR / 真实波幅通道'],
    ['stochKD', '随机指标 KD、Williams %R'], ['pivotPoint', '枢轴点 PP/R1/S1'],
    ['ichimoku', '一目均衡表转换线/基准线'], ['gapOpen', '跳空缺口']]) {
    rec('J', k, '', 0, '', NaN, NaN, '', 'pending_no_ohlc');
    console.log(`  ${pad(k, 12)}\x1b[90m${lb} —— 需要 开/高/低,导出里没有\x1b[0m`);
  }
  console.log('  \x1b[90mK.9 的兜底条款:上面四行指标定义、四条判据、两个临界值,跑完之后一个字符都不许动;不许加第五个指标;\x1b[0m');
  console.log('  \x1b[90m5 年数据到位后原样重跑同一条命令。J 组这四个函数是这些指标在本仓库的规范定义 ——\x1b[0m');
  console.log('  \x1b[90m将来哪一格过了闸真画上去,渲染层必须调同一套公式并加断言钉住,否则画的和验收的不是同一个东西。\x1b[0m');

  /* K */
  console.log(H('K · 情绪面:新闻强度(预注册于 SPEC 附录 M,写在算出任何一个数之前)'));
  console.log('  \x1b[90m注意命名:这里的「K 组」与 SPEC 附录 K(技术面)不是一回事。附录 K → J 组,附录 M → 这里的 K 组。\x1b[0m');
  console.log('  \x1b[90m只做**新闻强度**(按日计数 / 相对该票自身基线的计数异常),不做关键词词典:F 组已经有一条词典腿,\x1b[0m');
  console.log('  \x1b[90m再写一份是同一份证据用两次;而且词典是一组自由参数,在约 1800 条标题上挑词等于拟合噪声。\x1b[0m');
  console.log('  \x1b[90m三个指标里的窗口(20、20/60)与倍数(1.5×)全部抄自 J 组,**没有一个新的自由度**。\x1b[0m');
  const KR = testSentiment(ctx, cos, news, HZ);
  const kNoDaily = [...news.keys()].filter(t => !cos.has(t)).sort();
  const kNoNews = [...cos.keys()].filter(t => !(news.get(t) || []).length).sort();
  console.log(`  \x1b[90m参与票 ${KR.tks.length} 只:${KR.tks.join(' / ')}。`
    + `${kNoDaily.length ? '有新闻没日线(整份 <40 根,loadDaily 丢掉):' + kNoDaily.join('/') + ';' : ''}`
    + `${kNoNews.length ? '有日线没新闻:' + kNoNews.join('/') : ''} —— 两类都不进这个矩阵,\x1b[0m`);
  console.log('  \x1b[90m也不进台账:没抓到新闻 ≠ 这只票没有新闻,拿「零新闻」当事实会把它整年判成 drought,那是凭空造出来的信号。\x1b[0m');
  console.log(`  \x1b[90m对齐(M.5):新闻日期 D 归属到**第一个日期严格晚于 D 的交易日** —— 标题里的时刻碎片(~9:45ET)既非列也非必有,\x1b[0m`);
  console.log(`  \x1b[90m分不清盘中盘后就不许猜,一律推后一根。宁可信号迟一天,不可让它早一秒(期权墙那一跤就是这么栽的)。\x1b[0m`);
  console.log(`  \x1b[90m前瞻断言:被计入 c[t] 的每一条新闻,发布日期必须严格 < date(t)。本轮违例 ${KR.asofBad} 条`
    + `${KR.asofBad ? ' \x1b[31m← 非 0 就是前瞻污染,下面所有数字作废\x1b[0m' : '(必须是 0)'}\x1b[0m`
    + `\x1b[90m;晚于最后一根日线被丢弃 ${KR.dropped} 条。\x1b[0m`);
  console.log(`  \x1b[90m跨票相关(M.6):一条新闻挂多只票 → ${KR.share.shared}/${KR.share.total} = `
    + `ρ_share ${f2(KR.share.rho * 100)}% 的行是共享行。计数不折价(那本就该算进去),`
    + `**有效样本折价** ×${KR.defl.toFixed(4)}。\x1b[0m`);
  console.log('  \x1b[90m这是保守近似不是精确方差修正 —— 选它的唯一理由是误差方向确定:只会让 C1 更难过,不会更好过。\x1b[0m');
  console.log(`  \x1b[90m多重比较:家族恰好 9 格 = 3 指标 × 3 前瞻。主检验一格(${K_PRIMARY.id} @ ${K_PRIMARY.h} 日)临界 |z|≥${f2(K_Z_PRIMARY)},\x1b[0m`);
  console.log(`  \x1b[90m其余 8 格 Bonferroni m=9(主检验也算进分母)临界 |z|≥${f2(K_Z_FAMILY)}。M.8 交代过:主检验按**先验**挑(注意力效应是短周期现象),\x1b[0m`);
  console.log('  \x1b[90m不按功效挑 —— 按功效挑就该是 newsFlowState@5(它几乎天天触发),我放弃了那一格。\x1b[0m');
  console.log('  \x1b[90m附录 M.10 的预注册预期写着:9 格全部 inconclusive、零格 holds。真跑出 holds,第一件事是回头查 M.5 那条截断。\x1b[0m');
  console.log(`  ${pad('指标', 14)}${lpad('前瞻', 5)}${lpad('票', 4)}${lpad('触发', 6)}${lpad('独立', 6)}${lpad('对照独立', 9)}${lpad('折价后', 7)}${lpad('命中%', 8)}${lpad('对照%', 8)}${lpad('z', 7)}${lpad('临界', 6)}${lpad('skill', 8)}${lpad('CV下界', 9)}  判定`);
  /* 共享率单独记一行:它是这一组每一格 C1 的分母上的一个乘数,埋在别的行里将来读不出来。
   * 它每轮从语料重算、不是常数 —— 语料变长它就会变,这正是记进台账而不是写成常量的原因。 */
  rec('K', 'newsShareRate', '', KR.share.total, KR.share.shared, KR.share.rho, 0, '', 'recorded');
  /* 前瞻违例也记一行:它恒等于 0 才对。哪一轮不是 0,台账里要看得见是哪一轮。 */
  rec('K', 'asofViolations', '', KR.asofBad, '', KR.asofBad, 0, '', 'recorded');
  for (const r of KR.rows) {
    const id = r.ind.id;
    if (r.none) {
      /* 「所有票一次都没触发」和「触发了但样本少」得分开记 —— 前者要先问指标是不是写错了,后者只能等历史变长 */
      rec('K', id, r.h, 0, '', NaN, NaN, '', 'no_signal');
      console.log(`  ${pad(id, 14)}${lpad(r.h + '日', 5)}${lpad(r.tks, 4)}${lpad(0, 6)}  \x1b[90m所有参与票一次都没触发 —— no_signal,不是样本少,是没有样本\x1b[0m`);
      continue;
    }
    const crit = (id === K_PRIMARY.id && r.h === K_PRIMARY.h) ? K_Z_PRIMARY : K_Z_FAMILY;
    const degenerate = r.A.eff > 0 && r.C.eff < 0.3 * r.A.eff;
    const c1 = r.effUsed >= K_MIN_EFF, c2 = r.skillOOS > 0, c3 = r.cvLo > 0, c4 = isFinite(r.z) && r.z >= crit;
    const holds = c1 && c2 && c3 && c4;
    /* inverted 故意不要求 C2/C3(M.11,同 K.8):让一条腿开始被当成信号要四条全过,
     * 让它停止被当成正向信号只需要它稳定地错。举证责任在「要发结论」的那一边。 */
    const inverted = c1 && isFinite(r.z) && r.z <= -crit;
    const v = degenerate ? 'degenerate_control' : holds ? 'holds' : inverted ? 'inverted' : 'inconclusive';
    /* 台账里 effN 记**原始**的 min(处理,对照),与 J 组同口径、跨组可比;
     * 折价后的那个数是判据用的,只印在终端 —— 两者混在同一列会让历史行读不出来是哪种口径。 */
    rec('K', id, r.h, r.A.n, r.effMin, r.hitPct, r.ctrlPct, degenerate ? NaN : r.z, v);
    rec('K', id + 'Skill', r.h, r.keys, r.foldSkill.length, r.skillOOS, 0, '', 'recorded');
    rec('K', id + 'StateDev', r.h, r.states.length, '', r.maxStateDev, 0, '', 'recorded');
    const tag = v === 'holds' ? '\x1b[32m站得住\x1b[0m'
      : v === 'inverted' ? '\x1b[31m反了\x1b[0m'
      : v === 'degenerate_control' ? '\x1b[90m对照臂退化,z 不发布\x1b[0m'
      : '\x1b[33m未过线\x1b[0m';
    console.log(`  ${pad(id, 14)}${lpad(r.h + '日', 5)}${lpad(r.tks, 4)}${lpad(r.fires, 6)}${lpad(r.A.eff, 6)}${lpad(r.C.eff, 9)}${lpad(r.effUsed, 7)}${lpad(f1(r.hitPct), 8)}${lpad(f1(r.ctrlPct), 8)}${lpad(f2(r.z), 7)}${lpad(f2(crit), 6)}${lpad(f2(r.skillOOS), 8)}${lpad(f2(r.cvLo), 9)}  ${tag}`);
    /* 挂哪条,决定的是接下来该干什么:C1 挂了等历史变长,C4 挂了是效应本身不够大 ——
     * 两件完全不同的事,不能压成同一句「未过线」。 */
    if (!holds && v !== 'degenerate_control') {
      const miss = [];
      if (!c1) miss.push(`C1 折价后有效样本 ${r.effUsed}<${K_MIN_EFF}(原始 ${r.effMin} × ${r.defl.toFixed(4)})`);
      if (!c2) miss.push(`C2 样本外 skill ${f2(r.skillOOS)}≤0`);
      if (!c3) miss.push(`C3 CV 下界 ${f2(r.cvLo)}≤0(t(${r.cvDf})=${f2(r.cvT)},${r.foldSkill.length} 折)`);
      if (!c4) miss.push(`C4 效应量 z=${f2(r.z)}<${f2(crit)}`);
      console.log(`  ${pad('', 14)}\x1b[90m未过项:${miss.join(';')}${r.capped ? ';折数封顶 10(共 ' + r.keys + ' 只票)' : ''}\x1b[0m`);
    }
  }
  console.log('  \x1b[90m状态表(只记不判,recorded):逐状态的样本外平均预测 vs 实际涨频。指标最多给 k≤3 个不同预测值,\x1b[0m');
  console.log('  \x1b[90m套 G 组那张 10 桶可靠性图会有七个以上结构性空桶,那条「空桶就是警报」在这里没有信息。\x1b[0m');
  console.log(`  ${pad('指标', 14)}${lpad('前瞻', 5)}${lpad('状态', 6)}${lpad('样本', 7)}${lpad('预测', 8)}${lpad('实际', 8)}${lpad('偏差', 8)}`);
  for (const r of KR.rows) {
    if (r.none || !r.states.length) continue;
    for (const s of r.states) {
      console.log(`  ${pad(r.ind.id, 14)}${lpad(r.h + '日', 5)}${lpad(s.s > 0 ? '看涨' : s.s < 0 ? '看跌' : '中性', 6)}${lpad(s.n, 7)}${lpad(f2(s.pm), 8)}${lpad(f2(s.ym), 8)}${lpad(f2(s.dev), 8)}`);
    }
  }
  console.log('  \x1b[90mM.6 声明过的不对称:留一折里的跨票泄漏(一条新闻同时挂 NVDA 和 AMZN)会让 skill **偏高**。\x1b[0m');
  console.log('  \x1b[90m于是 C2/C3 没过是**干净的失败**(在被污染成偏好看的条件下都没过);C2/C3 过了**不算干净的成功**。\x1b[0m');
  console.log('  \x1b[90mM.12 的兜底条款:上面三行指标定义、M.5 的对齐规则、M.6 的折价公式、四条判据、两个临界值(2.00/2.78),\x1b[0m');
  console.log('  \x1b[90m跑完之后一个字符都不许动;不许加第四个指标,也不许事后补一个关键词词典;语料变长后原样重跑同一条命令。\x1b[0m');

  console.log(H('怎么读这份报告'));
  console.log('  · "看不出"占多数是正常的,也是诚实的:一年日线撑不起统计检验。');
  console.log('    真要下结论,需要的是更长的历史,不是更花的指标。');
  console.log('  · 唯一会推翻结论的是"反了"。看到红色,那条腿的符号或分档就该动。');
  console.log('  · A 组若判"区间偏窄",风险被系统性低估 —— 这比区间宽要危险得多。');
  console.log('  · 期权轨仍然没有出现在上面任何一组里:已攒 4–5 个快照日,其中一日是残链 ——');
  console.log('    没有时间序列就无法回答"OI 墙顶住没有",它写前瞻台账、不产生任何百分比。');
  console.log('    H 组测的是价格网格(整 25 / 整 50 的价位),不是 OI 历史,两者别混起来读。\n');

  if (wantLog) {
    const w = writeLog(runDate);
    console.log(`\x1b[1m已记账\x1b[0m  ${w.rows} 行 → ${path.relative(ROOT, w.file)}(累计 ${w.days} 轮)`);
    /* 不在这里替用户"看趋势":两轮之间数字动了不等于模型变了,多半只是又多了几个月行情。
     * 真正值得回头翻这个文件的时刻只有一个 —— 某条腿的判语从"看不出"变成了"反了"。 */
    if (w.days > 1) console.log('\x1b[90m        判语翻成"反了"的那一轮才值得回头翻这份账;数字小幅进退是行情在动,不是模型在变。\x1b[0m');
  }
}

/* 只有被**直接**跑的时候才出报告。tools/paramsearch.mjs 是 `import` 它的:
 * 调参台必须复用这里的装载、读盘和 testReach 本尊,而不是照抄一份 ——
 * 照抄出来的搜索结果和线上跑的不是同一套代码,那种"提升"没人敢信(本文件开头第 1 条纪律)。 */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();

/* 导出面**只有装载/读盘/testReach 三样**,不导出 rec/writeLog:
 * 记账是"跑了一轮回测"这件事的产物,调参跑了几十轮,一轮都不该进那本账。 */
export { loadDashboard, loadDaily, testReach, HZ_NAME, tCrit95 };
