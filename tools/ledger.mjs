/* tools/ledger.mjs —— 前瞻台账:只追加的证据簿
 * ============================================================================
 * 本文件里没有回填函数,以后也不要加。用今天的代码给昨天写预测,写出来的不是证据,
 * 是拟合。台账从第一次运行那天开始有意义,在此之前的空白就让它空着。
 * ============================================================================
 *
 * 【为什么它不在 tools/backtest.mjs 里】(SPEC 3.6 开头那段)
 * 台账是**只追加**的证据,回测是**反复重跑**的调参台。同一个进程里既能写台账又能调参,
 * 迟早有人跑一次调参就顺手往台账里写进一批用调完的参数事后生成的「预测」——
 * 那批行看起来和真预测一模一样,而且再也分不出来。所以两件事分两个文件、两个 npm script,
 * 而且 backtest.mjs 里搜不到 `ledger` / `forward-` 任何字样(第 9 步的验收项之一)。
 *
 * 【五道机制,每一道都对着一种具体的作弊】
 *   ① pred_id = 内容哈希(engine_ver|ticker|asof|horizon_d|claim|level_lo|level_hi 的 sha256 前 16 位)
 *      → 同一天同一引擎版本重跑得到同一个 id,重复写入被拒绝。这就是「不回填」的**执行**机制:
 *        光写一句"不许回填"是注释,内容哈希才是锁。
 *   ② engine_ver = 引擎源文件拼接的 sha256 前 8 位(名单见 ENGINE_FILES,那里逐条写了入选标准)
 *      → 参数一动分区就换,老预测和新预测永远不会被混在一起统计。
 *   ③ resolve_after = asof 往后数 horizon_d 个**交易日**(不是自然日),这一天之前不许结算
 *      → 防的是"提前收工":跌了就早两天结算,涨了就多等两天。
 *   ④ features_sha = 写入时刻全部输入特征的哈希,特征在写入时**冻结**
 *      → 结算时重算对不上就标 tainted,不许悄悄换一套新特征把旧预测算成对的。
 *   ⑤ seal = 本行前面所有字段 + 上一行 seal 的 sha256 前 12 位(哈希链)
 *      → 中间删一行、改一个数,后面全部对不上。`--verify` 会把断点指出来。
 *   ⑥ 作废簿 engine-void.csv:给某个 engine_ver 盖"这批不算数"的戳,--resolve 从此拒结它的行
 *      → 分区换代只解决"新旧不混统"，解决不了"旧的那批本身是脏的"。发现某一版引擎偷看了未来,
 *        它已经写下的预测既不能删(删了哈希链就断,而且"删掉不利证据"本身就是最该防的动作),
 *        也不能让它照常结算(结算出来的胜率是用未来数据换来的)。所以第三条路:**留着,盖戳,拒结**。
 *        作废簿自己也是只追加 + 哈希链,盖过的戳同样撤不掉、改不动。
 *   ⑦ 调参裁决簿 param-adjudication.csv:某个参数被搜过了,结果是什么,谁也改不回去
 *      → 防的是"重搜"。一次搜索若只活在终端里,半年后没人分得清某个参数是"测过没效应"
 *        还是"根本没测过";于是下一个人再搜一遍、挑一个当时最好看的值,并且真心以为
 *        自己是第一次搜。裁决留痕之后,重搜就得先解释上一次的结论错在哪。
 *        它同样**不跑搜索**:数由 tools/paramsearch.mjs 出,这里只封签(理由见下一段)。
 *

 * 【停表规则】asof 与 resolve_after 之间发生拆股/并股/停牌 > 3 日 → 记 stopped 并**永久排除**。
 *   不许"顺延" —— 顺延等于按结果挑窗口。
 *
 * 【唯一允许的历史读法:淘汰赛式】同一个 engine_ver 分区内累积到 30 个**独立**事件,
 *   才第一次出判语;判语一旦是「反了」,那个 claim 在面板上立刻降级为 falsified。
 *   本工具只出判语、只打印,不去改 src/ 里的任何一个字 —— 让代码改代码是另一类事故。
 *
 * 用法:
 *   node tools/ledger.mjs --write      写预测(fetcher 每轮拉数之后调一次)
 *   node tools/ledger.mjs --resolve    结算所有 resolve_after <= 今天且尚无 outcome 的预测
 *   node tools/ledger.mjs --void <engine_ver> <理由>   给一个引擎版本盖作废戳(只追加)
 *   node tools/ledger.mjs --param key=value …          记一次调参裁决(只追加,不搜索)
 *   node tools/ledger.mjs --verify     校验四份 CSV 的哈希链与内容哈希
 *   node tools/ledger.mjs --selftest   自检(不碰真台账,全在临时目录里跑)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* 往上找到带 package.json 的那一层当仓库根:这样工具放在 tools/ 还是 tools/scratch/ 都能跑。 */
const ROOT = (() => {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    d = path.dirname(d);
  }
  throw new Error('找不到仓库根(没有 package.json)');
})();
const ASSETS = path.join(ROOT, 'Assets');
/* 输出目录可被环境变量顶掉,**只**给 --selftest 用:自检不许碰真台账。 */
const OUTDIR = process.env.LEDGER_DIR || path.join(ASSETS, '_logs');
const LEDGER = () => path.join(OUTDIR, 'forward-ledger.csv');
const OUTCOMES = () => path.join(OUTDIR, 'forward-outcomes.csv');
const VOIDS = () => path.join(OUTDIR, 'engine-void.csv');
const PARAMS = () => path.join(OUTDIR, 'param-adjudication.csv');

/* 列名与列顺序照 SPEC 3.6,一字不改。改了,几个月前那些行就跟今天的行对不上了。 */
const LEDGER_COLS = ['pred_id', 'written_at', 'engine_ver', 'ticker', 'asof', 'horizon_d', 'claim',
  'resolve_after', 'level_lo', 'level_hi', 'level_mid', 'dist_u', 'edge_u', 'p_reach', 'tracks',
  'evidence', 'sigma_d', 'price_asof', 'ctrl_of', 'features_sha', 'seal'];
const OUTCOME_COLS = ['pred_id', 'resolved_at', 'px_asof', 'px_resolve', 'touched', 'touch_date',
  'side_from', 'outcome', 'displacement_u', 'mae_u', 'note', 'seal'];
/* 作废簿。**只追加**,和台账同一种哈希链;它不删任何一行,只是给某个 engine_ver
 * 盖一个"这批预测不算数"的戳。列序同样不许改。 */
const VOID_COLS = ['voided_at', 'engine_ver', 'reason', 'rows_voided', 'seal'];
/* 调参裁决簿。**只追加**,同一种哈希链。它记的不是预测,是"某个参数被搜过了,结果是什么"。
 * 为什么这件事也要上台账:一次搜索如果只活在终端回滚缓冲里,半年后没人记得
 * PX_HALFLIFE_D 到底是"测过没效应"还是"根本没测过",于是下一个人再搜一遍、
 * 挑一个当时最好看的值,并且真心认为自己是第一次搜 —— 那才是最贵的一种拟合。
 * 所以裁决本身要留痕,而且和作废戳一样:撤不掉、改不动、只能再追加一行新事实。
 * 列序不许改。 */
const PARAM_COLS = ['adjudicated_at', 'engine_ver', 'param', 'grid', 'criterion',
  'oos_range', 'prereg_rule', 'rule_fired', 'nested_gain', 'verdict',
  'value_before', 'value_after', 'note', 'seal'];
/* verdict 只有这三个值,不许现编:
 *   moved      —— 参数动了。value_before ≠ value_after,note 里必须写清凭什么动。
 *   no_effect  —— 搜过了,没测出可以据以移动的效应,参数留在原处。
 *   no_move    —— 搜过了,看见了差别,但差别不归这个参数(混杂)或过不了预注册判据,故不动。
 * 「没搜」不在此列:没搜就别写行。空白就让它空着,和文件头那句是同一条规矩。 */
const PARAM_VERDICTS = ['moved', 'no_effect', 'no_move'];

/* 引擎版本 = 这几个文件的拼接哈希。少一个都不行:params 改了不换分区,
 * 就会把"0.35 个 u 的带宽"下写的预测和"0.50 个 u"下写的预测统计在一起。
 *
 * 入选标准只有一条:**改了它,写进 CSV 的某个数会变**。按这条标准逐个查过一遍,
 * 压力引擎在 src/js/pressure/ 之外只用到四个外部符号:
 *   · hasVol      ← src/js/ingest/companies.js  —— priceDensity 靠它决定按成交量还是按时间加权,
 *                    加权方式一换,带的 lo/hi/mid 立刻不同,而分区不换。**必须在列表里。**
 *   · pePos       ← src/js/valuation/calc.js    —— 只被 valuationRefs 用;估值线永不进 up/down,
 *                    而且 --write 调 pressureLevels 时 r 传的是 null,valRefs 恒为空数组。
 *                    它改不动台账里任何一个数,收进来只会让 calcRange 之类的无关改动白白换分区
 *                    (换一次分区就把之前累积的独立事件全部清零)。故不收。
 *   · LANG / t    ← src/js/core/i18n.js         —— 只影响 why 里的句子,不影响数。故不收。
 *   · state       ← src/js/core/state.js        —— 纯容器声明,没有逻辑。故不收。
 * 这四条判断写在这里而不是在提交信息里:下一个人要加文件,得先说清它属于哪一类。 */
const ENGINE_FILES = ['src/js/pressure/params.js', 'src/js/pressure/scale.js', 'src/js/pressure/grid.js',
  'src/js/pressure/optionwalls.js', 'src/js/pressure/engine.js', 'src/js/ingest/companies.js'];

const HZ_NAME = { 5: 'short', 21: 'mid', 63: 'long' };
const HORIZONS = [5, 21, 63];

const sha = (s, n) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, n);
const fx = (v, d) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : '';
const todayISO = () => new Date().toISOString().slice(0, 10);

/* ── 交易日算术 ───────────────────────────────────────────────────────────
 * 只跳周末,不查节假日表:仓库里没有交易日历,硬编一份反而会悄悄过期。
 * 后果是 resolve_after 可能比真正的第 h 个交易日**早**一两天(中间夹了节假日),
 * 所以结算时还有第二道闸门:实际到手的 K 线根数必须 ≥ horizon_d。
 * 两道闸门的方向是一致的 —— 都只会让结算更晚,不会更早。 */
function addTradingDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
/** 两个日期之间跳过了几个工作日(不含两端)。用来认"停牌 > 3 日"。 */
function weekdaysBetween(a, b) {
  const x = new Date(a + 'T00:00:00Z'), y = new Date(b + 'T00:00:00Z');
  let n = 0;
  x.setUTCDate(x.getUTCDate() + 1);
  while (x < y) { const w = x.getUTCDay(); if (w !== 0 && w !== 6) n++; x.setUTCDate(x.getUTCDate() + 1); }
  return n;
}

/* ── 确定性 RNG:对照的种子就是真实行的 pred_id ─────────────────────────── */
/** 32 位 FNV-1a,与 src/js/sim/engine.js 的 simHash 同一个式子。 */
function seedOf(s) {
  let h = 2166136261;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h >>> 0;
}
function rngOf(seed) {
  let s = (seed >>> 0) & 0x7fffffff; if (s <= 0) s = 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/* ── 把 src/ 里的真引擎装进沙箱(和 backtest 同一套装法,同一份代码) ────── */
function loadEngine() {
  const need = [
    'src/js/core/utils.js', 'src/js/core/i18n.js', 'src/js/core/state.js',
    /* companies.js 得装:priceDensity 用的 hasVol() 定义在它里面,少一个文件
     * 就是运行期 ReferenceError,而不是编译期报错。它同时也在 ENGINE_FILES 里
     * (改了 hasVol 就改了写进 CSV 的带宽,所以它必须参与 engine_ver),
     * 于是这份清单会出现重名 —— 沙箱里同一个文件跑两遍,`const hasVol` 会直接
     * 抛 "Identifier 'hasVol' has already been declared",而且是在 --resolve
     * 真跑起来的时候才抛。下面按首次出现去重:装载顺序不变,每个文件只跑一次。 */
    'src/js/ingest/companies.js', 'src/js/ingest/resolve.js', 'src/js/ingest/signals.js',
    'src/js/valuation/calc.js', 'src/js/valuation/volstats.js',
    ...ENGINE_FILES,
  ];
  const files = [...new Set(need)];
  const stub = () => ({ className: '', textContent: '', appendChild() {}, setAttribute() {}, style: {} });
  const ctx = vm.createContext({
    console, Math, Date, JSON, Map, Set, Array, Object, Number, String, isFinite, parseFloat, parseInt,
    document: { getElementById: () => null, createElement: stub, createElementNS: stub },
  });
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) throw new Error(`台账要用的模块不在:${f}`);
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  }
  /* const 是词法声明,不挂沙箱 globalThis —— 漏一行桥接,Node 侧读到的是 undefined 且不抛错。 */
  vm.runInContext(`globalThis.state = state;
    globalThis.PX = { PX_REACH_C, PX_REACH_U, PX_HALF_U, PX_SIGMA_WIN, PX_HORIZONS, PX_EVIDENCE };`,
    ctx, { filename: '<bridge>' });
  for (const fn of ['pressureLevels', 'sigmaD', 'scaleU', 'reachProb', 'asOfSlice'])
    if (typeof ctx[fn] !== 'function') throw new Error(`装进来了但没有 ${fn}() —— 引擎改名了,台账跟着改`);
  if (!ctx.PX || !ctx.PX.PX_REACH_C) throw new Error('桥接没带出 PX —— 新增常量忘了加进 bridge');
  return ctx;
}

function engineVer() {
  return sha(ENGINE_FILES.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'), 8);
}

/* ── 读盘 ─────────────────────────────────────────────────────────────────── */
function loadXLSX() {
  const req = createRequire(import.meta.url);
  for (const p of ['xlsx', path.join(ROOT, 'fetcher', 'node_modules', 'xlsx'), path.join(ROOT, 'node_modules', 'xlsx')]) {
    try { return req(p); } catch { /* 下一个 */ }
  }
  console.error('缺 xlsx:cd fetcher && npm i xlsx');
  process.exit(3);
}
const numOf = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : NaN; };
const serialISO = v => {
  if (typeof v === 'number' && isFinite(v)) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const M = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const m = String(v || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+'?(\d{2,4})$/);
  if (!m) return null;
  const mo = M[m[2].toLowerCase()]; if (!mo) return null;
  return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + mo + '-' + m[1].padStart(2, '0');
};

/** 日线。**必须带 vol** —— priceDensity 有量就按成交量加权,没量就按时间加权,
 *  丢掉 vol 会让台账里的带和面板上的带不是同一条,那样写下的预测验的就不是线上那套。 */
function loadDaily(XLSX) {
  const dir = path.join(ASSETS, 'charting');
  const cos = new Map();
  if (!fs.existsSync(dir)) return cos;
  for (const fn of fs.readdirSync(dir).filter(f => /\.xlsx?$/i.test(f))) {
    if (/^_MARKET-/i.test(fn)) continue;
    const wb = XLSX.read(fs.readFileSync(path.join(dir, fn)), { type: 'buffer' });
    const a = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const hdr = (a[0] || []).map(c => String(c || '').trim());
    const di = hdr.findIndex(h => /^date$/i.test(h));
    const ci = hdr.findIndex(h => / - Close$/i.test(h));
    const vi = hdr.findIndex(h => / - Volume$/i.test(h) || /^volume$/i.test(h));
    if (di < 0 || ci < 0) continue;
    const px = [];
    for (let i = 1; i < a.length; i++) {
      const r = a[i] || [], d = serialISO(r[di]), p = numOf(r[ci]);
      if (!d || !(p > 0)) continue;
      const rec = { date: d, price: p };
      if (vi >= 0) { const v = numOf(r[vi]); if (v > 0) rec.vol = v; }
      px.push(rec);
    }
    if (px.length < 40) continue;
    px.sort((x, y) => x.date < y.date ? -1 : 1);
    cos.set(fn.replace(/\s+Daily Charting\.xlsx?$/i, '').toUpperCase(), px);
  }
  return cos;
}

/** 期权链。口径与 src/js/ingest/signals.js 的 ingestOptions 一致:
 *  同一个 (到期日, 行权价) 只留 asof 最新的一条 —— OI 是存量数字,昨天的快照没有意义。 */
function loadOptions() {
  const dir = path.join(ASSETS, 'options');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const fn of fs.readdirSync(dir).filter(f => /\.csv$/i.test(f))) {
    const tk = ((/^([A-Z.]{1,6}-[A-Z]{2})/.exec(fn) || [])[1] || '').toUpperCase();
    if (!tk) continue;
    const lines = fs.readFileSync(path.join(dir, fn), 'utf8').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) continue;
    const hdr = lines[0].split(',').map(s => s.trim().toLowerCase());
    const ix = k => hdr.indexOf(k);
    const seen = new Map();
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const expiry = String(c[ix('expiry')] || '').trim();
      const strike = numOf(c[ix('strike')]);
      const callOI = numOf(c[ix('call_oi')]), putOI = numOf(c[ix('put_oi')]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !(strike > 0)) continue;
      if (!isFinite(callOI) && !isFinite(putOI)) continue;
      const rec = { asof: String(c[ix('asof')] || '').trim(), expiry, strike,
        callOI: isFinite(callOI) ? callOI : 0, putOI: isFinite(putOI) ? putOI : 0 };
      const key = expiry + '|' + strike, old = seen.get(key);
      if (!old || (rec.asof || '') >= (old.asof || '')) seen.set(key, rec);
    }
    out.set(tk, [...seen.values()].sort((a, b) => a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike));
  }
  return out;
}

/** 拉取清单。没有 roster.csv 就用盘上所有有日线的票 —— 但要在终端说出来。 */
function loadRoster() {
  const f = path.join(ASSETS, 'summary', 'roster.csv');
  if (!fs.existsSync(f)) return null;
  const out = [];
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1)) {
    if (!l.trim() || l.startsWith('#')) continue;
    const c = l.split(',');
    if (String(c[2] || '').trim() !== '1') continue;
    const tk = String(c[0] || '').trim().toUpperCase();
    if (tk) out.push(tk);
  }
  return out.length ? out : null;
}

/* ── CSV 读写 + 哈希链 ───────────────────────────────────────────────────── */
function readCsv(file, cols) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return [];
  const head = lines[0].split(',');
  if (head.join(',') !== cols.join(',')) throw new Error(`${path.basename(file)} 的表头和 SPEC 3.6 对不上 —— 列名/列序不许改`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const o = {}; cols.forEach((k, j) => { o[k] = c[j] === undefined ? '' : c[j]; });
    o.__line = i + 1;
    rows.push(o);
  }
  return rows;
}
/** seal = 本行前面所有字段 + 上一行 seal 的 sha256 前 12 位。 */
function sealOf(row, cols, prevSeal) {
  return sha(cols.slice(0, -1).map(k => row[k]).join(',') + '|' + (prevSeal || ''), 12);
}
function appendCsv(file, cols, rows) {
  /* 这两份 CSV 没有引号转义,也不该有:一旦某个字段里混进逗号,读回来列就错位,
   * seal 全盘对不上,而且看上去像"有人动过文件"。宁可当场炸,不要留个哑谜。 */
  for (const r of rows) for (const k of cols)
    if (/[,\r\n]/.test(String(r[k] == null ? '' : r[k])))
      throw new Error(`字段 ${k} 里有逗号或换行,会把 CSV 撑错位:${r[k]}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, cols.join(',') + '\n');
  fs.appendFileSync(file, rows.map(r => cols.map(k => r[k]).join(',')).join('\n') + (rows.length ? '\n' : ''));
}
function lastSeal(file, cols) {
  const rows = readCsv(file, cols);
  return rows.length ? rows[rows.length - 1].seal : '';
}

/* ── 作废簿:给一个引擎版本盖"这批不算数"的戳 ───────────────────────────────
 * 为什么不是删行、也不是加一列 `voided` 就地改:
 *   · 删行 —— 哈希链当场断,而且"把不利的证据删掉"正是这套机制存在的理由,不能自己先破。
 *   · 就地改 —— 台账是只追加的,任何"回去改老行"的入口一旦开出来,下一次就会被用来
 *     改别的字段;而且改完 seal 全盘对不上,和被人篡改长得一模一样,分不出来。
 * 所以作废是**另写一行新事实**:某年某月某日,发现某个 engine_ver 的产出不可用,理由如下。
 * 老行原封不动躺在那里 —— 它们本身就是"当时确实这么预测过"的证据,只是不再有资格结算。 */

/** 读作废簿 → Set(engine_ver)。file 可传,只给自检用(OUTDIR 是模块级 const,改不动)。 */
function loadVoids(file) {
  const f = file || VOIDS();
  if (!fs.existsSync(f)) return new Set();
  return new Set(readCsv(f, VOID_COLS).map(r => r.engine_ver).filter(Boolean));
}

function mkVoidRow(o) {
  return { voided_at: o.voided_at, engine_ver: o.engine_ver, reason: o.reason,
    rows_voided: String(o.rows_voided), seal: '' };
}

/* ── 调参裁决簿:某个参数被搜过了,结果是什么 ─────────────────────────────
 * 这里**不跑搜索**,一行搜索代码都不许有。理由和文件头那段是同一条:
 * 能一边搜一边写台账的进程,迟早会被用来"搜到好看的那个值,顺手记一笔说它是测出来的"。
 * 数由 tools/paramsearch.mjs 出,这里只负责封签。所以字段全部从命令行传进来,
 * 传的人得把自己写的数念一遍 —— 念错了链还在,行还在,谁写的、写了什么,一样赖不掉。 */

const PARAM_REQ = ['param', 'grid', 'criterion', 'oos_range', 'prereg_rule',
  'rule_fired', 'nested_gain', 'verdict', 'value_before', 'value_after', 'note'];

function mkParamRow(o) {
  const r = { adjudicated_at: o.adjudicated_at, engine_ver: o.engine_ver, seal: '' };
  for (const k of PARAM_REQ) r[k] = String(o[k]);
  return r;
}

/** 已裁决过的 (engine_ver, param) 对 —— 同一版引擎上同一个参数不重复盖戳。 */
function loadParamAdj(file) {
  const f = file || PARAMS();
  if (!fs.existsSync(f)) return new Set();
  return new Set(readCsv(f, PARAM_COLS).map(r => `${r.engine_ver}|${r.param}`));
}

/** 校验一组 key=value。返回 {row} 或 {err}。抽成纯函数,好让自检验的是线上这一份。 */
function parseParamArgs(args, ver, now) {
  const kv = {};
  for (const a of args) {
    const i = String(a).indexOf('=');
    if (i <= 0) return { err: `参数要写成 key=value,给的是:${a}` };
    const k = a.slice(0, i);
    if (!PARAM_REQ.includes(k)) return { err: `不认识的字段 ${k};只收:${PARAM_REQ.join(' ')}` };
    if (k in kv) return { err: `字段 ${k} 给了两次` };
    kv[k] = a.slice(i + 1);
  }
  const miss = PARAM_REQ.filter(k => !(k in kv) || !kv[k].length);
  /* 缺字段一律拒收,不许留空:一行"参数 X 判了 no_effect"而不附判据、不附网格、
   * 不附数,和没写没有区别 —— 半年后没人能复核它。 */
  if (miss.length) return { err: `这些字段缺了或为空:${miss.join(' ')}` };
  if (!PARAM_VERDICTS.includes(kv.verdict))
    return { err: `verdict 只能是 ${PARAM_VERDICTS.join(' / ')},给的是:${kv.verdict}` };
  if (kv.verdict === 'moved' && kv.value_before === kv.value_after)
    return { err: 'verdict=moved 但 value_before 与 value_after 相同 —— 没动就别说动了' };
  if (kv.verdict !== 'moved' && kv.value_before !== kv.value_after)
    return { err: `verdict=${kv.verdict} 但 value_before ≠ value_after —— 参数动了就得写 moved` };
  for (const k of PARAM_REQ)
    if (/[,\r\n]/.test(kv[k])) return { err: `字段 ${k} 里有半角逗号或换行(CSV 没有引号转义):${kv[k]}` };
  return { row: mkParamRow({ adjudicated_at: now, engine_ver: ver, ...kv }) };
}

function cmdParam(args) {
  const ver = engineVer();
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const { row, err } = parseParamArgs(args, ver, now);
  if (err) { console.error(err); process.exit(2); }
  if (loadParamAdj().has(`${ver}|${row.param}`)) {
    console.log(`\x1b[1m台账 · 调参裁决\x1b[0m  ${row.param} 在引擎版本 ${ver} 上已经裁决过,不重复追加。`);
    console.log('  \x1b[90m要改判就改参数(引擎版本自然会换),或者写清理由再在新版本上重裁 —— 老行不动。\x1b[0m');
    return { added: 0 };
  }
  row.seal = sealOf(row, PARAM_COLS, lastSeal(PARAMS(), PARAM_COLS));
  appendCsv(PARAMS(), PARAM_COLS, [row]);
  console.log(`\x1b[1m台账 · 调参裁决\x1b[0m  ${row.param} @ ${ver}:\x1b[1m${row.verdict}\x1b[0m`);
  console.log(`  网格 ${row.grid}`);
  console.log(`  判据 ${row.criterion}`);
  console.log(`  ${row.value_before} → ${row.value_after}`);
  console.log(`  ${row.note}`);
  console.log(`  → ${path.relative(ROOT, PARAMS())}`);
  return { added: 1 };
}

/** 结算前的三道闸门收在一处,让 --resolve 和自检验的是**同一个**判据 ——
 *  把闸门写在循环体里、自检另写一份等价逻辑,是"测试通过但线上没这道闸"的经典形态。 */
function resolveGate(r, done, today, voided) {
  if (done.has(r.pred_id)) return 'done';
  if (voided.has(r.engine_ver)) return 'voided';        // 作废分区:一行都不许结
  if (today < r.resolve_after) return 'notYet';
  return null;
}

function cmdVoid(ver, reason) {
  const v = String(ver || '').trim(), why = String(reason || '').trim();
  if (!/^[0-9a-f]{8}$/.test(v)) { console.error('engine_ver 要是 8 位十六进制,给的是:' + v); process.exit(2); }
  if (!why) { console.error('必须写理由:作废一批证据而不说为什么,和悄悄删掉没有区别。'); process.exit(2); }
  if (/[,\r\n]/.test(why)) { console.error('理由里不许有逗号或换行(CSV 没有引号转义)。'); process.exit(2); }
  const already = loadVoids();
  if (already.has(v)) { console.log(`\x1b[1m台账 · 作废\x1b[0m  ${v} 已经盖过戳了,不重复追加。`); return { added: 0 }; }
  const rows = readCsv(LEDGER(), LEDGER_COLS).filter(r => r.engine_ver === v);
  const row = mkVoidRow({ voided_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    engine_ver: v, reason: why, rows_voided: rows.length });
  row.seal = sealOf(row, VOID_COLS, lastSeal(VOIDS(), VOID_COLS));
  appendCsv(VOIDS(), VOID_COLS, [row]);
  console.log(`\x1b[1m台账 · 作废\x1b[0m  ${v} 已盖戳:${why}`);
  console.log(`  该分区 ${rows.length} 行原样留在 forward-ledger.csv 里(一行没删,哈希链照旧自洽),`
    + '但 --resolve 从此拒结它们。');
  console.log(`  → ${path.relative(ROOT, VOIDS())}`);
  return { added: 1, rows_voided: rows.length };
}

/* ── 写:一天的预测 ───────────────────────────────────────────────────────── */

/** 冻结输入特征。哈希的是**引擎真正读到的那些数**:as-of 截断后的整段价格序列
 *  + 那一刻的期权链。数据源日后被重述(拆股复权、修正收盘价),这个哈希就对不上,
 *  该行标 tainted —— 而不是用新数据把旧预测算成对的。 */
function featuresJson(tk, asof, hd, px, opt) {
  const seg = px.filter(r => r.date <= asof).map(r => [r.date, +r.price.toFixed(6), r.vol || 0]);
  const oc = (opt || []).map(r => [r.expiry, r.strike, r.callOI, r.putOI]);
  return JSON.stringify({ v: 1, ticker: tk, asof, horizon_d: hd, px: seg, opt: oc });
}

/** 真实行:从引擎的输出里挑出这一期要下的注。
 *  claim ∈ reach | contain | bounce | opt_wall,一个 claim 一行,配一行对照。
 *  ——「每只票 × 三个持有期各写一行真实 + 一行配对对照」是 3.6 的最少写法;
 *    但 3.9 要求期权轨(opt_wall)与 63 日的 contain 走**前瞻记账**,而这两件事
 *    只有在台账里真有对应 claim 的行时才成立。所以这里按 claim 分行:
 *    只有一个 claim 可写时,它就退化成 3.6 字面上的"一行"。 */
function pickClaims(P, hd) {
  const inView = [...P.up, ...P.down];
  if (!inView.length) return [];
  const near = inView.reduce((a, b) => (b.edgeU < a.edgeU ? b : a));
  const out = [
    { claim: 'reach', L: near },
    { claim: 'contain', L: near },
  ];
  /* bounce 在 3.9 里 h=63 一格是"结构上不可能通过"(效应天花板 11pp < 所需 14pp),
   * 那一格连前瞻记账都不给 —— 写下去也永远不会有人拿它做判语,不如不写。 */
  if (hd !== 63) out.push({ claim: 'bounce', L: near });
  const wall = inView.filter(L => L.tracks.indexOf('opt') >= 0)
    .sort((a, b) => a.edgeU - b.edgeU)[0];
  if (wall) out.push({ claim: 'opt_wall', L: wall });
  return out;
}

/** 配对随机对照:同宽、同在视野闸门内,位置随机。
 *  种子 = 真实行的 pred_id,所以这一行**不可能被挑选** —— 换一个种子就得先换真实行的内容,
 *  而真实行的内容一变 pred_id 就变,重复写入又会被拒。 */
function controlLevel(realRow, ctx, sd, price, hd) {
  const rnd = rngOf(seedOf(realRow.pred_id));
  const u = ctx.scaleU(sd, hd, price);
  const w = (parseFloat(realRow.level_hi) - parseFloat(realRow.level_lo)) / 2;   /* 同宽 */
  const up = rnd() < 0.5;
  const edgeU = Math.max(1e-4, rnd() * ctx.PX.PX_REACH_U);                        /* 同一道视野闸门之内 */
  const edgeAbs = edgeU * u;
  const lo = up ? price + edgeAbs : price - edgeAbs - 2 * w;
  const hi = lo + 2 * w;
  const mid = (lo + hi) / 2;
  return { lo, hi, mid, distU: (mid - price) / u, edgeU,
    pReach: ctx.reachProb(edgeAbs / price, sd, hd, ctx.PX.PX_REACH_C[hd]) };
}

function mkRow(o) {
  const r = {
    pred_id: '', written_at: o.written_at, engine_ver: o.engine_ver, ticker: o.ticker, asof: o.asof,
    horizon_d: String(o.hd), claim: o.claim, resolve_after: o.resolve_after,
    level_lo: fx(o.lo, 4), level_hi: fx(o.hi, 4), level_mid: fx(o.mid, 4),
    dist_u: fx(o.distU, 4), edge_u: fx(o.edgeU, 4), p_reach: fx(o.pReach, 4),
    tracks: o.tracks, evidence: o.evidence, sigma_d: fx(o.sd, 6), price_asof: fx(o.price, 4),
    ctrl_of: o.ctrl_of || '', features_sha: o.features_sha, seal: '',
  };
  /* pred_id 用**写进 CSV 的那串字符**去算,不是用内存里的浮点数 ——
   * 否则重跑时最后一位小数的抖动就能生出一个新 id,去重整个失效。 */
  r.pred_id = sha([r.engine_ver, r.ticker, r.asof, r.horizon_d, r.claim, r.level_lo, r.level_hi].join('|'), 16);
  return r;
}

function cmdWrite() {
  const ctx = loadEngine();
  const XLSX = loadXLSX();
  const ver = engineVer();
  /* 当前引擎版本已被盖戳作废 → 一行都不写。写下去的注既不能结算也不能统计,
   * 只会把作废分区越堆越大,还让人误以为台账在正常累积。 */
  if (loadVoids().has(ver)) {
    console.log(`\x1b[31m台账 · 写预测被拒\x1b[0m  当前 engine_ver=${ver} 在作废簿里。`);
    console.log('  \x1b[90m先把引擎改到一个新版本(分区自然会换),再来写。作废戳撤不掉,这是它的用处。\x1b[0m');
    return { real: 0, ctrl: 0, dup: 0, refused: true };
  }
  const cos = loadDaily(XLSX);
  const opts = loadOptions();
  const roster = loadRoster();
  const tickers = (roster ? roster.filter(t => cos.has(t)) : [...cos.keys()]).sort();
  const written_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const today = todayISO();

  console.log(`\x1b[1m台账 · 写预测\x1b[0m  engine_ver=${ver}  ${tickers.length} 只票 × ${HORIZONS.length} 个持有期`);
  if (!roster) console.log('  \x1b[90mAssets/summary/roster.csv 不在,改用盘上所有有日线的票。\x1b[0m');
  if (!tickers.length) { console.log('  没有可写的标的。'); return { real: 0, ctrl: 0, dup: 0 }; }

  for (const [tk, px] of cos) {
    ctx.state.priceHist.set(tk, px);
    ctx.state.companies.set(tk, { ticker: tk, price: px[px.length - 1].price });
    if (opts.has(tk)) ctx.state.options.set(tk, opts.get(tk));
  }

  const have = new Set(readCsv(LEDGER(), LEDGER_COLS).map(r => r.pred_id));
  const batch = [];
  let dup = 0, skipped = 0;
  const seen = new Set(), errs = [];

  for (const tk of tickers) {
    const px = cos.get(tk);
    const asof = px[px.length - 1].date;
    const co = { ticker: tk, price: px[px.length - 1].price };
    for (const hd of HORIZONS) {
      let P = null;
      /* 引擎抛错要**说出来**:一次静默 catch 就能把「装漏了一个模块」伪装成
       * 「今天没有位置可写」,台账于是安静地写下 0 行,而且看着很正常。 */
      try { P = ctx.pressureLevels(co, null, asof, HZ_NAME[hd]); }
      catch (e) { P = null; errs.push(`${tk} ${hd}日:${e.message}`); }
      if (!P || !isFinite(P.u) || P.u <= 0) { skipped++; continue; }
      const claims = pickClaims(P, hd);
      if (!claims.length) { skipped++; continue; }
      const features_sha = sha(featuresJson(tk, asof, hd, px, opts.get(tk)), 16);
      const resolve_after = addTradingDays(asof, hd);
      for (const { claim, L } of claims) {
        const real = mkRow({ written_at, engine_ver: ver, ticker: tk, asof, hd, claim, resolve_after,
          lo: L.lo, hi: L.hi, mid: L.mid, distU: L.distU, edgeU: L.edgeU, pReach: L.pReach,
          tracks: L.tracks.join('+') || 'none', evidence: L.evidence, sd: P.sd, price: P.price,
          ctrl_of: '', features_sha });
        const C = controlLevel(real, ctx, P.sd, P.price, hd);
        const ctrl = mkRow({ written_at, engine_ver: ver, ticker: tk, asof, hd, claim, resolve_after,
          lo: C.lo, hi: C.hi, mid: C.mid, distU: C.distU, edgeU: C.edgeU, pReach: C.pReach,
          tracks: 'random', evidence: 'pending', sd: P.sd, price: P.price,
          ctrl_of: real.pred_id, features_sha });
        for (const r of [real, ctrl]) {
          if (have.has(r.pred_id) || seen.has(r.pred_id)) { dup++; continue; }
          seen.add(r.pred_id); batch.push(r);
        }
      }
    }
  }

  let prev = lastSeal(LEDGER(), LEDGER_COLS);
  for (const r of batch) { r.seal = sealOf(r, LEDGER_COLS, prev); prev = r.seal; }
  if (batch.length) appendCsv(LEDGER(), LEDGER_COLS, batch);

  const real = batch.filter(r => !r.ctrl_of).length;
  console.log(`  写入 ${batch.length} 行(真实 ${real} + 对照 ${batch.length - real});重复被拒 ${dup} 行;`
    + `${skipped} 个 (票×持有期) 引擎没报出位置,跳过。`);
  if (errs.length) {
    console.log(`  \x1b[31m引擎抛错 ${errs.length} 次(这些不是"没位置",是坏了):\x1b[0m`);
    for (const e of errs.slice(0, 5)) console.log('    ' + e);
  }
  console.log(`  → ${path.relative(ROOT, LEDGER())}(累计 ${readCsv(LEDGER(), LEDGER_COLS).length} 行)`);
  if (dup && !batch.length) console.log('  \x1b[90m全部被拒 = 今天已经写过了。内容哈希去重生效,这正是"不回填"的执行机制。\x1b[0m');
  console.log(`  \x1b[90m最早可结算日:${addTradingDays(today, 5)}(5 日档)。在那之前 --resolve 一行都不会结。\x1b[0m`);
  tally();
  return { real, ctrl: batch.length - real, dup, skipped };
}

/* ── 结算 ─────────────────────────────────────────────────────────────────── */

/** 停表:asof 与 resolve_after 之间发生拆股/并股/停牌 > 3 日 → stopped,**永久排除**。
 *  拆股靠单根 K 线的比价认:一天之内价格变成 0.62 倍或 1.6 倍以上,在真实的
 *  大盘股里不是行情,是股本动作。认错了也只是少一条证据,认漏了会污染一整批。 */
function stopEvent(bars) {
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].price / bars[i - 1].price;
    if (!(r > 0.625) || !(r < 1.6)) return `split_or_reverse:${bars[i].date}:${r.toFixed(3)}`;
    if (weekdaysBetween(bars[i - 1].date, bars[i].date) > 3) return `halt_gt_3d:${bars[i - 1].date}~${bars[i].date}`;
  }
  return null;
}

function cmdResolve() {
  const ctx = loadEngine();
  const XLSX = loadXLSX();
  const cos = loadDaily(XLSX);
  const opts = loadOptions();
  const today = todayISO();
  const rows = readCsv(LEDGER(), LEDGER_COLS);
  const done = new Set(readCsv(OUTCOMES(), OUTCOME_COLS).map(r => r.pred_id));
  const voided = loadVoids();
  console.log(`\x1b[1m台账 · 结算\x1b[0m  台账 ${rows.length} 行,已有结果 ${done.size} 行,今天 ${today}`);
  if (voided.size) console.log(`  \x1b[90m作废分区 ${[...voided].join(' ')} —— 这些 engine_ver 的行一律拒结。\x1b[0m`);

  const out = [];
  let notYet = 0, noData = 0, voidSkip = 0;
  for (const r of rows) {
    /* ①⓪ 三道前置闸门(已结 / 作废分区 / 还没到日子)收在 resolveGate 里,自检验的是同一个判据。 */
    const gate = resolveGate(r, done, today, voided);
    if (gate === 'done') continue;
    if (gate === 'voided') { voidSkip++; continue; }
    if (gate === 'notYet') { notYet++; continue; }
    const px = cos.get(r.ticker);
    if (!px) { noData++; continue; }
    const hd = parseInt(r.horizon_d, 10);
    const i0 = px.findIndex(b => b.date === r.asof);
    /* ② 根数闸门:节假日会让 resolve_after 比真正的第 h 个交易日早一两天,
     *    K 线不够就再等 —— 宁可晚结,不可早结。 */
    if (i0 < 0 || px.length - 1 - i0 < hd) { noData++; continue; }
    const bars = px.slice(i0, i0 + hd + 1);
    const pxAsof = parseFloat(r.price_asof), pxRes = bars[bars.length - 1].price;
    const sd = parseFloat(r.sigma_d);
    const u = ctx.scaleU(sd, hd, pxAsof);
    const lo = parseFloat(r.level_lo), hi = parseFloat(r.level_hi), mid = parseFloat(r.level_mid);
    const above = mid > pxAsof;
    const note = [];

    /* ③ 特征闸门:重算写入时刻的特征,对不上说明输入被重述过 → tainted,不许悄悄用新特征。 */
    const fsha = sha(featuresJson(r.ticker, r.asof, hd, px, opts.get(r.ticker)), 16);
    let outcome = null;
    if (fsha !== r.features_sha) { outcome = 'tainted'; note.push('features_changed'); }

    /* ④ 停表闸门。 */
    if (!outcome) { const st = stopEvent(bars); if (st) { outcome = 'stopped'; note.push(st); } }

    let touched = '', touchDate = '', disp = NaN, mae = NaN;
    if (!outcome || outcome === 'stopped' || outcome === 'tainted') {
      let t = false;
      for (let i = 1; i < bars.length; i++) {
        const p = bars[i].price;
        if (above ? p >= lo : p <= hi) { t = true; touchDate = bars[i].date; break; }
      }
      touched = t ? '1' : '0';
      disp = isFinite(u) && u > 0 ? Math.abs(pxRes - mid) / u : NaN;
      let worst = 0;
      for (let i = 1; i < bars.length; i++) {
        const away = above ? pxAsof - bars[i].price : bars[i].price - pxAsof;   /* 朝远离目标位的方向走了多少 */
        if (away > worst) worst = away;
      }
      mae = isFinite(u) && u > 0 ? worst / u : NaN;
      if (!outcome) {
        if (r.claim === 'reach' || r.claim === 'opt_wall') outcome = t ? 'hit' : 'miss';
        else if (r.claim === 'contain') {
          /* contain 的判据用**已预注册**的 PX_REACH_U(视野闸门那个 1u),不新造门槛:
           * h 日之后价格离这条位置还在一个 u 之内,算这条位置"框住"了它。 */
          outcome = isFinite(disp) && disp <= ctx.PX.PX_REACH_U ? 'hit' : 'miss';
        } else if (r.claim === 'bounce') {
          /* bounce 以"碰到了"为前提。没碰到就是这一注**没结成**,不是赢也不是输 ——
           * 记 unresolved 并就此终结,不许留着等下一次碰(那等于按结果挑窗口)。 */
          if (!t) { outcome = 'unresolved'; note.push('never_touched'); }
          else outcome = (above ? pxRes < lo : pxRes > hi) ? 'hit' : 'miss';
        } else { outcome = 'unresolved'; note.push('unknown_claim'); }
      }
    }
    out.push({ pred_id: r.pred_id, resolved_at: today, px_asof: fx(pxAsof, 4), px_resolve: fx(pxRes, 4),
      touched, touch_date: touchDate, side_from: above ? 'below' : 'above', outcome,
      displacement_u: fx(disp, 4), mae_u: fx(mae, 4), note: note.join(';'), seal: '' });
  }

  let prev = lastSeal(OUTCOMES(), OUTCOME_COLS);
  for (const r of out) { r.seal = sealOf(r, OUTCOME_COLS, prev); prev = r.seal; }
  if (out.length) appendCsv(OUTCOMES(), OUTCOME_COLS, out);
  const by = {};
  for (const r of out) by[r.outcome] = (by[r.outcome] || 0) + 1;
  console.log(`  结算 ${out.length} 行${out.length ? '(' + Object.entries(by).map(([k, v]) => k + ' ' + v).join(', ') + ')' : ''};`
    + `${notYet} 行还没到 resolve_after;${noData} 行到期了但 K 线还没到齐;${voidSkip} 行属于作废分区,永不结算。`);
  /* 两种"零结算"要分清:全在未来 = 台账刚开张;到期但缺 K 线 = 数据还没导出来。
   * 后者不能报成前者,否则一份长期停更的数据集会伪装成"一切正常"。 */
  if (!out.length && !noData)
    console.log('  \x1b[90m一行都没结算是正常的:resolve_after 全在未来。台账从第一次运行那天开始有意义。\x1b[0m');
  if (!out.length && noData)
    console.log(`  \x1b[90m零结算:${notYet} 行还在未来,另有 ${noData} 行已过 resolve_after 但导出的日线还没覆盖到那天 —— `
      + '等下次导数据再跑 --resolve,它们会自己结,不需要也不允许人工补。\x1b[0m');
  tally();
  return { resolved: out.length, notYet, noData, by };
}

/* ── 淘汰赛式读法:够 30 个独立事件才第一次出判语 ─────────────────────────── */

/** 独立事件:同一只票、同一持有期下,窗口不重叠才算两条证据。贪心取,和 simEffN 同一种数法。 */
function effEvents(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = r.ticker + '|' + r.horizon_d;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  let n = 0;
  for (const arr of byKey.values()) {
    arr.sort((a, b) => a.asof < b.asof ? -1 : 1);
    let until = '';
    for (const r of arr) if (r.asof >= until) { n++; until = r.resolve_after; }
  }
  return n;
}

function tally() {
  const rows = readCsv(LEDGER(), LEDGER_COLS);
  const res = new Map(readCsv(OUTCOMES(), OUTCOME_COLS).map(r => [r.pred_id, r]));
  if (!rows.length) return;
  const voided = loadVoids();
  /* 作废分区先当着面数出来再排除。第二道防线:哪怕将来有人绕过 --resolve
   * 硬塞了几行 outcome 进去,判语这一层也不会把它们算进任何胜率。 */
  if (voided.size) {
    for (const v of [...voided].sort()) {
      const n = rows.filter(r => r.engine_ver === v).length;
      console.log(`  \x1b[90m作废分区 ${v}:${n} 行留档但不结算、不统计、不出判语。\x1b[0m`);
    }
  }
  const parts = new Map();
  for (const r of rows) {
    if (voided.has(r.engine_ver)) continue;
    const o = res.get(r.pred_id);
    if (!o || (o.outcome !== 'hit' && o.outcome !== 'miss')) continue;
    const k = r.engine_ver + '|' + r.claim;
    if (!parts.has(k)) parts.set(k, { real: [], ctrl: [] });
    parts.get(k)[r.ctrl_of ? 'ctrl' : 'real'].push({ ...r, hit: o.outcome === 'hit' });
  }
  console.log('  \x1b[1m淘汰赛式判语\x1b[0m(同一 engine_ver 分区内,独立事件满 30 才第一次出判语)');
  if (!parts.size) {
    console.log(`  \x1b[90m还没有一条预测被结算过 —— 一个判语都不发。台账从第一次运行那天开始有意义。\x1b[0m`);
    return;
  }
  for (const [k, p] of [...parts.entries()].sort()) {
    const [ver, claim] = k.split('|');
    const eff = effEvents(p.real);
    const kr = p.real.filter(r => r.hit).length, nr = p.real.length;
    const kc = p.ctrl.filter(r => r.hit).length, nc = p.ctrl.length;
    if (eff < 30) {
      console.log(`  ${ver} · ${claim}:独立事件 ${eff}/30,真实 ${kr}/${nr} 对照 ${kc}/${nc} —— \x1b[90m不够,不出判语\x1b[0m`);
      continue;
    }
    const pr = kr / nr, pc = nc ? kc / nc : NaN;
    const pb = (kr + kc) / (nr + nc);
    const z = (nr && nc && pb > 0 && pb < 1)
      ? (pr - pc) / Math.sqrt(pb * (1 - pb) * (1 / Math.min(nr, eff) + 1 / Math.min(nc, eff))) : NaN;
    const v = !isFinite(z) ? 'inconclusive' : z >= 2 ? 'holds' : z <= -2 ? 'inverted' : 'inconclusive';
    console.log(`  ${ver} · ${claim}:独立事件 ${eff},真实 ${(pr * 100).toFixed(1)}% vs 对照 ${(pc * 100).toFixed(1)}%,z=${z.toFixed(2)} → ${v}`);
    if (v === 'inverted') console.log(`  \x1b[31m  ↑「反了」:${claim} 这条腿在面板上必须立刻降级为 falsified(PX_EVIDENCE.${claim})。\x1b[0m`
      + '\n  \x1b[90m  台账只出判语,不去改 src/ 里的字 —— 让工具改代码是另一类事故。\x1b[0m');
  }
}

/* ── 校验:哈希链 + 内容哈希 ─────────────────────────────────────────────── */

/** 从头重算整条链。往下推用的是**重算出来的** seal,不是文件里写着的那个。
 *  差别很大:拿文件里的 seal 往下推,链就退化成逐行校验和,中间删一行只坏一个链节,
 *  后面照样"通过";重算着推,断点之后每一行都对不上 —— 这才是链。 */
function chainScan(rows, cols) {
  let prev = '', bad = 0, first = 0;
  for (const r of rows) {
    const want = sealOf(r, cols, prev);
    if (want !== r.seal) { bad++; if (!first) first = r.__line || 0; }
    prev = want;
  }
  return { bad, first };
}

function verifyFile(file, cols, label) {
  if (!fs.existsSync(file)) { console.log(`  ${label}:文件还不存在,跳过。`); return { rows: 0, bad: 0 }; }
  const rows = readCsv(file, cols);
  const { bad, first } = chainScan(rows, cols);
  let badId = 0;
  if (cols === LEDGER_COLS) {
    for (const r of rows) {
      const want = sha([r.engine_ver, r.ticker, r.asof, r.horizon_d, r.claim, r.level_lo, r.level_hi].join('|'), 16);
      if (want !== r.pred_id) badId++;
    }
  }
  console.log(`  ${label}:${rows.length} 行,seal 对不上 ${bad} 行${first ? `(从第 ${first} 行起)` : ''}` +
    (cols === LEDGER_COLS ? `,pred_id 与内容对不上 ${badId} 行` : '') +
    (bad || badId ? ' \x1b[31m← 有人动过这个文件\x1b[0m' : ' \x1b[32m✓\x1b[0m'));
  return { rows: rows.length, bad, badId, first };
}
function cmdVerify() {
  console.log('\x1b[1m台账 · 校验\x1b[0m');
  const a = verifyFile(LEDGER(), LEDGER_COLS, 'forward-ledger.csv');
  const b = verifyFile(OUTCOMES(), OUTCOME_COLS, 'forward-outcomes.csv');
  /* 作废簿也要验:一个能被人静悄悄改掉的作废戳等于没盖。 */
  const c = verifyFile(VOIDS(), VOID_COLS, 'engine-void.csv');
  /* 调参裁决簿同理:一条能被人改掉的"这个参数没效应"等于没裁。 */
  const d = verifyFile(PARAMS(), PARAM_COLS, 'param-adjudication.csv');
  const ok = !a.bad && !a.badId && !b.bad && !c.bad && !d.bad;
  if (!ok) console.log('  \x1b[90m哈希链的意义就在这里:中间删一行或改一个数,从那一行起后面全部对不上,补不回去。\x1b[0m');
  return { ok, a, b, c, d };
}

/* ── 自检:全在临时目录里跑,一个字都不碰真台账 ─────────────────────────── */
function cmdSelftest() {
  let n = 0, bad = 0;
  const ok = (name, cond) => { n++; if (cond) console.log(`  PASS  ${name}`); else { bad++; console.log(`  \x1b[31mFAIL  ${name}\x1b[0m`); } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-selftest-'));
  const saved = process.env.LEDGER_DIR;
  process.env.LEDGER_DIR = dir;
  /* OUTDIR 是模块级 const,自检里直接用局部路径,不指望改环境变量能改到它 */
  const L = path.join(dir, 'forward-ledger.csv');

  ok('交易日不是自然日:周五 + 1 个交易日是下周一,不是周六', addTradingDays('2026-08-07', 1) === '2026-08-10');
  ok('往后数 5 个交易日整整跨一周(周四 → 下周四)', addTradingDays('2026-08-06', 5) === '2026-08-13');
  ok('往后数 21 个交易日约一个月,且落在工作日上',
    addTradingDays('2026-08-06', 21) === '2026-09-04' && new Date(addTradingDays('2026-08-06', 21) + 'T00:00:00Z').getUTCDay() === 5);
  ok('停牌探测按工作日数,周末不算停牌', weekdaysBetween('2026-08-07', '2026-08-10') === 0);
  ok('中间空掉四个工作日算停牌 > 3 日', weekdaysBetween('2026-08-06', '2026-08-13') === 4);

  const base = { written_at: '2026-08-06T00:00:00Z', engine_ver: 'abcdef12', ticker: 'TEST-US',
    asof: '2026-08-06', hd: 5, claim: 'reach', resolve_after: '2026-08-13',
    lo: 100, hi: 102, mid: 101, distU: 0.5, edgeU: 0.4, pReach: 0.5, tracks: 'tech',
    evidence: 'verified', sd: 0.02, price: 98, ctrl_of: '', features_sha: 'ff00ff00ff00ff00' };
  const r1 = mkRow(base), r1b = mkRow({ ...base, written_at: '2026-08-06T23:59:59Z' });
  ok('pred_id 是内容哈希:写入时刻变了 id 不变(同一天重跑必被去重)', r1.pred_id === r1b.pred_id);
  ok('pred_id 只认七个字段:位置改了 id 就变', mkRow({ ...base, lo: 100.5 }).pred_id !== r1.pred_id);
  ok('pred_id 是 16 位十六进制', /^[0-9a-f]{16}$/.test(r1.pred_id));

  const r2 = mkRow({ ...base, claim: 'contain' });
  let prev = '';
  for (const r of [r1, r2]) { r.seal = sealOf(r, LEDGER_COLS, prev); prev = r.seal; }
  appendCsv(L, LEDGER_COLS, [r1, r2]);
  const back = readCsv(L, LEDGER_COLS);
  ok('CSV 表头与 SPEC 3.6 的列名列序逐字相同', fs.readFileSync(L, 'utf8').split('\n')[0] === LEDGER_COLS.join(','));
  ok('读回来的行数与写进去的一致', back.length === 2);
  ok('原样读回时哈希链自洽', chainScan(back, LEDGER_COLS).bad === 0);
  /* 改中间一行的一个数,从那一行起后面必须全错 */
  const lines = fs.readFileSync(L, 'utf8').split('\n');
  lines[1] = lines[1].replace(/,100\.0000,/, ',100.5000,');
  fs.writeFileSync(L, lines.join('\n'));
  const tampered = readCsv(L, LEDGER_COLS);
  ok('改一个数,从那一行起后面每一行的 seal 都对不上',
    chainScan(tampered, LEDGER_COLS).bad === tampered.length);
  ok('改一个数,pred_id 也跟内容对不上了',
    sha([tampered[0].engine_ver, tampered[0].ticker, tampered[0].asof, tampered[0].horizon_d,
      tampered[0].claim, tampered[0].level_lo, tampered[0].level_hi].join('|'), 16) !== tampered[0].pred_id);
  /* 删中间一行,后面必须全错 */
  fs.writeFileSync(L, [LEDGER_COLS.join(','), lines[2]].join('\n') + '\n');
  ok('删掉前一行,后面那行的 seal 也对不上(哈希链是链,不是逐行校验和)',
    chainScan(readCsv(L, LEDGER_COLS), LEDGER_COLS).bad === 1);

  ok('停表:一天之内价格腰斩当拆股,不当行情',
    /^split_or_reverse/.test(stopEvent([{ date: '2026-08-06', price: 100 }, { date: '2026-08-07', price: 50 }]) || ''));
  ok('停表:连续四个工作日没有 K 线算停牌 > 3 日',
    /^halt_gt_3d/.test(stopEvent([{ date: '2026-08-06', price: 100 }, { date: '2026-08-14', price: 101 }]) || ''));
  ok('停表:正常两天不触发', stopEvent([{ date: '2026-08-06', price: 100 }, { date: '2026-08-07', price: 103 }]) === null);

  /* 对照种子 = 真实行 pred_id:同一行跑两次必须得到同一个对照位置 */
  const fake = { scaleU: (sd, h, price) => sd * Math.sqrt(h) * price, reachProb: () => 0.5,
    PX: { PX_REACH_U: 1, PX_REACH_C: { 5: 0.6 } } };
  const c1 = controlLevel(r1, fake, 0.02, 98, 5), c2 = controlLevel(r1, fake, 0.02, 98, 5);
  ok('配对对照的种子就是真实行的 pred_id —— 同一行跑两次得到同一个对照',
    c1.lo === c2.lo && c1.hi === c2.hi);
  ok('换一行真实行,对照位置就不一样(种子真的进了 RNG)',
    controlLevel(r2, fake, 0.02, 98, 5).lo !== c1.lo);
  ok('对照带与真实带同宽', Math.abs((c1.hi - c1.lo) - 2) < 1e-9);
  ok('对照带落在视野闸门之内(edgeU ≤ PX_REACH_U)', c1.edgeU > 0 && c1.edgeU <= 1);

  /* ---- 作废机制:老分区盖了戳就永远结不了 ----------------------------------
   * 每一条都对着一种具体的失效方式:戳没落到盘上、戳落错了分区、戳能被人改回去、
   * 戳在 --resolve 那道循环里其实没被读到。最后一条最难测也最要紧,所以闸门被抽成
   * resolveGate() 一个函数,线上和自检验的是**同一份判据**,不是两份长得像的。 */
  const V = path.join(dir, 'engine-void.csv');
  const v1 = mkVoidRow({ voided_at: '2026-08-06T00:00:00Z', engine_ver: '2a80ddb1',
    reason: '前瞻污染:期权墙未按 asof 过滤', rows_voided: 164 });
  v1.seal = sealOf(v1, VOID_COLS, '');
  appendCsv(V, VOID_COLS, [v1]);
  ok('作废簿表头就是 VOID_COLS 的列名列序',
    fs.readFileSync(V, 'utf8').split('\n')[0] === VOID_COLS.join(','));
  ok('作废理由用中文写清楚,而且被原样存下来(作废而不说理由 = 悄悄删证据)',
    readCsv(V, VOID_COLS)[0].reason === '前瞻污染:期权墙未按 asof 过滤');
  ok('作废行记下了这一批有多少行被作废', readCsv(V, VOID_COLS)[0].rows_voided === '164');
  ok('作废簿自己也是哈希链,原样读回自洽', chainScan(readCsv(V, VOID_COLS), VOID_COLS).bad === 0);
  const vd = loadVoids(V);
  ok('loadVoids 读出被作废的 engine_ver', vd.has('2a80ddb1') && vd.size === 1);
  ok('没盖过戳的 engine_ver 不受影响(作废是点名的,不是连坐)', !vd.has('abcdef12'));

  const doneSet = new Set();
  const gRow = { pred_id: 'x', engine_ver: '2a80ddb1', resolve_after: '2020-01-01' };
  const gOk = { pred_id: 'y', engine_ver: 'abcdef12', resolve_after: '2020-01-01' };
  ok('--resolve 拒结作废分区的行:早就过了 resolve_after 也不结',
    resolveGate(gRow, doneSet, '2026-08-06', vd) === 'voided');
  ok('--resolve 照常结算未作废分区的行',
    resolveGate(gOk, doneSet, '2026-08-06', vd) === null);
  ok('作废闸门排在日期闸门之前:作废分区里没到期的行报的也是 voided,不是 notYet',
    resolveGate({ ...gRow, resolve_after: '2099-01-01' }, doneSet, '2026-08-06', vd) === 'voided');
  ok('已结算过的行仍然优先返回 done(作废不改写已经写下的结果)',
    resolveGate(gRow, new Set(['x']), '2026-08-06', vd) === 'done');
  ok('没有作废簿文件时一切照旧(空 Set,不是崩)',
    loadVoids(path.join(dir, '不存在.csv')).size === 0
    && resolveGate(gRow, doneSet, '2026-08-06', new Set()) === null);

  /* 改作废行里的任何一个字,链就断 —— 一个能被静悄悄改掉的作废戳等于没盖。 */
  const vlines = fs.readFileSync(V, 'utf8').split('\n');
  fs.writeFileSync(V, [vlines[0], vlines[1].replace(',164,', ',1,')].join('\n') + '\n');
  ok('改掉作废行的行数,seal 立刻对不上(作废戳撤不掉也改不动)',
    chainScan(readCsv(V, VOID_COLS), VOID_COLS).bad === 1);

  /* ---- 调参裁决簿:搜过什么、结论是什么,留痕且改不动 ----------------------
   * 每一条对着一种具体的失效方式:字段缺了照样收(=记了个空壳)、verdict 现编、
   * 说 no_effect 却把值改了(或反过来)、同一版引擎上重复盖戳、盖完还能被人改。 */
  const P = path.join(dir, 'param-adjudication.csv');
  const pArgs = ['param=PX_TEST_D', 'grid=45/90/180', 'criterion=LOO-CV-OOS-Brier(nested)',
    'oos_range=h5=0.0031', 'prereg_rule=range<0.005→no_effect', 'rule_fired=yes',
    'nested_gain=h5=-0.0012', 'verdict=no_effect', 'value_before=365', 'value_after=365',
    'note=极差 0.0031 低于预注册门槛;参数留在原处'];
  const pr = parseParamArgs(pArgs, 'abcdef12', '2026-08-06T00:00:00Z');
  ok('调参裁决:齐全的一组 key=value 能组成行', !pr.err && !!pr.row);
  ok('调参裁决:缺字段一律拒收(记一条没有判据的结论 = 没记)',
    !!parseParamArgs(pArgs.filter(a => !a.startsWith('criterion=')), 'abcdef12', 'x').err);
  ok('调参裁决:字段给空串也算缺(空壳行比没有行更糟,它看上去像证据)',
    !!parseParamArgs(pArgs.map(a => a.startsWith('note=') ? 'note=' : a), 'abcdef12', 'x').err);
  ok('调参裁决:verdict 不许现编,只收 moved / no_effect / no_move',
    !!parseParamArgs(pArgs.map(a => a.startsWith('verdict=') ? 'verdict=看起来不错' : a), 'abcdef12', 'x').err);
  ok('调参裁决:说 no_effect 却把值改了 → 拒收(判语和动作必须一致)',
    !!parseParamArgs(pArgs.map(a => a.startsWith('value_after=') ? 'value_after=180' : a), 'abcdef12', 'x').err);
  ok('调参裁决:说 moved 却前后同值 → 拒收',
    !!parseParamArgs(pArgs.map(a => a.startsWith('verdict=') ? 'verdict=moved' : a), 'abcdef12', 'x').err);
  ok('调参裁决:不认识的字段拒收(免得数被写进一个谁也不会去读的列)',
    !!parseParamArgs([...pArgs, 'winner=0.42'], 'abcdef12', 'x').err);
  ok('调参裁决:字段里混进半角逗号 → 当场拒收,不留错位的 CSV',
    !!parseParamArgs(pArgs.map(a => a.startsWith('grid=') ? 'grid=45,90' : a), 'abcdef12', 'x').err);

  pr.row.seal = sealOf(pr.row, PARAM_COLS, '');
  appendCsv(P, PARAM_COLS, [pr.row]);
  ok('调参裁决簿表头就是 PARAM_COLS 的列名列序',
    fs.readFileSync(P, 'utf8').split('\n')[0] === PARAM_COLS.join(','));
  ok('调参裁决簿自己也是哈希链,原样读回自洽', chainScan(readCsv(P, PARAM_COLS), PARAM_COLS).bad === 0);
  ok('裁决行把网格、判据、数、前后值一并存下来(少一样就没法复核)',
    readCsv(P, PARAM_COLS)[0].grid === '45/90/180'
    && readCsv(P, PARAM_COLS)[0].oos_range === 'h5=0.0031'
    && readCsv(P, PARAM_COLS)[0].value_before === '365');
  const padj = loadParamAdj(P);
  ok('同一版引擎上同一个参数只裁一次(重复盖戳被认出来)', padj.has('abcdef12|PX_TEST_D'));
  ok('换个参数、或换版引擎,就是另一条裁决(裁决是点名的,不是连坐)',
    !padj.has('abcdef12|PX_OTHER') && !padj.has('99999999|PX_TEST_D'));
  const plines = fs.readFileSync(P, 'utf8').split('\n');
  fs.writeFileSync(P, [plines[0], plines[1].replace('no_effect', 'moved   ')].join('\n') + '\n');
  ok('把裁决结论改一个字,seal 立刻对不上(裁决撤不掉也改不动)',
    chainScan(readCsv(P, PARAM_COLS), PARAM_COLS).bad === 1);

  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  ok('作废走的是"再追加一行新事实",源码里没有任何就地改老行或删老行的入口',
    !/fs\.writeFileSync\(\s*(?:LEDGER|OUTCOMES|VOIDS|PARAMS)\(/.test(self)
    && !/unlinkSync\(\s*(?:LEDGER|OUTCOMES|VOIDS|PARAMS)\(/.test(self));
  /* 台账不许自己跑搜索:能一边搜一边写裁决的进程,迟早会写下"搜到的最好看的那个值是测出来的"。
   * 只查代码,不查注释 —— 注释里必须能提这几个名字,否则上面那段解释自己就把自己判死;
   * 名字同样拼出来写,否则这条断言的源码本身就是它要找的那个字符串。 */
  const code = self.split('\n').filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  const runner = new RegExp('\\b(import|require)\\b[^\\n]*(' +
    ['param' + 'search', 'back' + 'test', 'child_' + 'process'].join('|') + ')');
  /* 前面那个否定回顾是要紧的:`re.exec(` 是正则,不是起进程,不能被误伤。 */
  const spawner = new RegExp('(?<![.\\w])(' +
    ['spa' + 'wn', 'exe' + 'cSync', 'exe' + 'cFile', 'fo' + 'rk'].join('|') + ')\\s*\\(');
  ok('台账自己不跑搜索:代码里既不引入搜索/回测模块,也不起子进程',
    !runner.test(code) && !spawner.test(code));
  /* 禁用词拼出来写,否则这行断言自己就会把自己判死。 */
  const banned = new RegExp(['back' + 'fill', '补' + '写历史', '--as' + '-of-past'].join('|'), 'i');
  ok('本文件里没有任何回填入口(拼出来的禁用词一个都不许出现在源码里)', !banned.test(self));
  ok('文件头那段"不回填"的话在(它是这份工具的宪法,不许删)',
    self.indexOf('用今天的代码给昨天写预测,写出来的不是证据,是拟合') > 0);

  fs.rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.LEDGER_DIR; else process.env.LEDGER_DIR = saved;
  console.log(bad ? `\x1b[31mSELFTEST FAILED\x1b[0m ${bad}/${n}` : `\x1b[32mSELFTEST OK\x1b[0m ${n}`);
  return bad === 0;
}

/* ── 入口 ─────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) process.exit(cmdSelftest() ? 0 : 1);
else if (argv.includes('--write')) cmdWrite();
else if (argv.includes('--resolve')) cmdResolve();
else if (argv.includes('--void')) {
  const i = argv.indexOf('--void');
  cmdVoid(argv[i + 1], argv.slice(i + 2).join(' '));
}
else if (argv.includes('--param')) {
  cmdParam(argv.slice(argv.indexOf('--param') + 1));
}
else if (argv.includes('--verify')) process.exit(cmdVerify().ok ? 0 : 1);
else {
  console.log('用法:node tools/ledger.mjs --write | --resolve | --void | --param | --verify | --selftest');
  console.log('  --write    写今天的预测(内容哈希去重,重复写入被拒)');
  console.log('  --resolve  结算 resolve_after <= 今天且尚无结果的预测(作废分区一律拒结)');
  console.log('  --void <engine_ver> <理由>  给一个引擎版本盖作废戳:老行留档,从此不结算、不统计');
  console.log(`  --param ${PARAM_REQ.map(k => k + '=…').join(' ')}`);
  console.log('             记一次调参裁决(只追加)。数由 tools/paramsearch.mjs 出,本工具只封签,不搜索');
  console.log('  --verify   校验四份 CSV 的哈希链与内容哈希');
  console.log('  --selftest 自检,不碰真台账');
  process.exit(2);
}
