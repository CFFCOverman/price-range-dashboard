/**
 * 仪表盘逻辑验证(无头浏览器)
 * 重点:核心区间与情景矩阵必须是同一把尺子算出来的;EPS 情景清洗的护栏必须真的生效。
 * 运行:node tests/test-app.mjs
 *
 * 注意:测的是**构建产物** price-range-dashboard.html,不是 src/ 里的模块 ——
 * 用户双击打开的是产物,所以断言必须落在产物上。开头先校验产物与 src/ 同步,
 * 否则"改了 src 忘了 build"会让测试对着旧代码全绿,那比测试失败更危险。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'url';
import { build } from '../tools/build.mjs';
/* Node 侧读取层本体。tools/backtest.mjs 有
 * `import.meta.url === pathToFileURL(process.argv[1]).href` 守卫,import 不会触发 main()。
 * [16] 节靠它把**同一份 xlsx 夹具**同时喂进两个实现对答案。 */
import { loadDaily } from '../tools/backtest.mjs';
/* 授权数据在不在,判据只有一个来源:tools/doctor.mjs 的 chartingStatus()。
 * 这里**只消费,不重造** —— 这个项目的规矩是"指标必须过同一道闸":
 * 要是测试自己再手写一遍 readdirSync,体检和测试的判据迟早漂开,
 * 用户会同时拿到"你没装数据"和"你数据坏了"两个互相打架的结论。 */
import { chartingStatus } from '../tools/doctor.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const APP = 'file://' + path.join(ROOT, 'price-range-dashboard.html');
/* SheetJS 本地文件:根目录或 fetcher/ 下装了哪个用哪个(fetcher 早就有一份,不强制再装一次) */
const XLSX_PATH = ['node_modules', 'fetcher/node_modules']
  .map(d => path.join(ROOT, d, 'xlsx/dist/xlsx.full.min.js'))
  .find(p => fs.existsSync(p))
  || path.join(ROOT, 'node_modules/xlsx/dist/xlsx.full.min.js');
/* Node 侧也要一份 SheetJS —— [16] 用它**写**夹具。解析路径与 tools/backtest.mjs 里的 loadXLSX() 一致。 */
const XLSX = (() => {
  for (const base of [import.meta.url, path.join(ROOT, 'tools/'), path.join(ROOT, 'fetcher/')]) {
    try { return createRequire(base)('xlsx'); } catch { /* 下一个候选 */ }
  }
  throw new Error('找不到 xlsx 包:npm i 之后再跑');
})();

let pass = 0, fail = 0;
/* 第三个计数器:跳过。它**不是** pass 也**不是** fail,单独记账,不影响退出码。
 * 只有一种情形能进这个数组:Assets/charting 整个目录不存在(见 [18])。
 * 为什么要单独记:FactSet 导出是授权数据,.gitignore 挡掉了 Assets/,
 * 新克隆一定没有 —— 把这种情况算 FAIL 是撒谎(代码没坏),算 PASS 更是撒谎(压根没测)。 */
const skipped = [];

/* 跳过不影响退出码 —— 这是用户拍的板,对**人**在新机器上第一次跑是对的。
 * 但它留了一个口子:一台只看退出码、或者只拿 /\d+ passed, 0 failed/ 抓日志的 CI,
 * 会把"没数据的半套"当成全绿收下。摘要那块横幅是喊给人看的,机器不看横幅。
 * 所以给机器留一个开关:`--require-data`(或环境变量 PRD_REQUIRE_DATA=1)一旦打开,
 * 有跳过就退 1。默认关 —— 开着它,新克隆第一次跑必红,那就把"跳过"这条路白修了。
 * 判定拆成纯函数是为了能在 [21] 里直接钉住,而不是靠"跑一遍看看退出码几"。 */
const REQUIRE_DATA = process.argv.includes('--require-data') || process.env.PRD_REQUIRE_DATA === '1';
function exitCodeFor(failN, skipN, requireData) {
  if (failN) return 1;                      // 真 FAIL 永远退 1,跟开关无关
  return (requireData && skipN) ? 1 : 0;    // 没 FAIL:只有开了开关且真跳过了才退 1
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  →  ' + extra : '')); }
}

/* ---------- 唯一的跳过入口:只对 'no-dir' 开放 ----------
 * 危险在哪(先说清楚,别哪天顺手放宽):跳过是一条**不影响退出码**的路,
 * 谁都可以拿它把一条真 FAIL 变成绿。所以入口收窄成这一个函数、一个判据:
 *   1. 参数必须是 chartingStatus() 的返回值,state 不是 'no-dir' 就**抛异常** ——
 *      抛在段体里会被 section() 记成一条有计数的 FAIL,误用只会更红,不会更绿;
 *   2. 打出来的话必须刺眼(整块横幅 + 结尾摘要再喊一次),不许退化成一行灰 note ——
 *      看不见的跳过等于没跳过,下次就有人拿它当"绿了"汇报;
 *   3. 不许把它改成通用的 skip(name, cond):这里要的是"缺授权数据"这一种豁免,
 *      不是一个万能免死金牌。([21] 用假树钉住了 1 和 3) */
const BAR = '  ' + '═'.repeat(72);
function skipNoDirOnly(title, st) {
  if (!st || st.state !== 'no-dir') {
    throw new Error('跳过只对 state=\'no-dir\' 开放,收到 state=' + (st && st.state)
      + ' —— 这条路不许拿来掩盖别的状态(目录在却读不出东西是回归,该红)');
  }
  skipped.push(title);
  console.log(BAR);
  console.log('  ⚠  SKIP —— ' + title + ' 整段没跑(既不是 PASS 也不是 FAIL)');
  console.log(BAR);
  console.log('  找不到 ' + st.dir);
  console.log('  这不是仓库坏了,是设计如此:FactSet 导出是**授权数据**,');
  console.log('  .gitignore 里 Assets/ 整个挡掉了 —— 所以**任何新克隆一定没有这些文件**,');
  console.log('  新机器上第一次跑就该看到这段话,不用去修任何东西。');
  console.log('  只有这一段依赖真实导出(它把每一只标的都喂进页面画一遍);');
  console.log('  没有数据 = 没得测,和"测出了问题"是两回事。');
  console.log('  想跑全套验收,把导出放进 Assets/charting/ 后重跑即可(不用改任何代码):');
  console.log('    · 有 FactSet 账号:npm run fetch:login 登录一次,再 npm run fetch');
  console.log('    · 手动导出:FactSet Charting 里存 "<代码> Daily Charting.xlsx",');
  console.log('      连同 _MARKET-BENCH / SECTOR / CREDIT / RATES 四份市场级序列一起放进去');
  console.log(BAR);
}

/* ---------- 段落护栏:段体抛异常 = 一条有计数的 FAIL,不是整套崩掉 ----------
 * 钉的是变异测试里的一个自欺:某些变异(例如往 renderCandles 传进去的对象缺字段,
 * 抛 "Cannot read properties of undefined")会让 page.evaluate 的 promise 被拒,
 * 异常从段落里一路冒到顶层 await —— node 带着 stack trace 退出,一条 FAIL 都统计不到。
 * "检测到了但没计数"和"没检测到"在报表上长得一模一样,那等于没测。
 *
 * 规则(不许改松):
 *   1. 异常一律 fail++ —— 不许吞成 PASS,不许当 skip,不许只 console.warn;
 *   2. FAIL 文案里必须带上**原始异常文本**和**它发生在哪一段**,否则没法定位;
 *   3. 段体崩了就往下一段继续跑 —— 后面的段落还能贡献真实的 PASS/FAIL 计数。
 * 一段崩溃只记 1 条 FAIL(段内剩余断言根本没执行,凭空补计数是编数字), */
async function section(title, body) {
  console.log('\n' + title);
  try {
    await body();
  } catch (e) {
    fail++;
    const raw = (e && (e.message || e.stack)) ? String(e.message || e.stack) : String(e);
    console.log('  FAIL  ' + title + ' —— 段体抛异常,该段剩余断言未执行(崩溃 ≠ 通过)  →  '
      + raw.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3).join(' ⏎ '));
  }
}

/* ---------- [0] 构建新鲜度:产物必须与 src/ 一致 ---------- */
await section('[0] 构建产物与 src/ 同步', async () =>
{
  const { manifest, out } = build();
  for (const rel of manifest.outputs) {
    const cur = fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : null;
    ok(`${rel} 与 src/ 一致(不一致请先跑 node tools/build.mjs)`, cur === out);
  }
  ok('产物恰好只有一个 <script>(顶层函数对 page.evaluate 可见的前提)',
    (out.match(/<script>/g) || []).length === 1);
});

/* ---------- 浏览器可执行文件:不许写死路径 ----------
 * 曾经这里是 `executablePath: '/opt/pw-browsers/chromium'` —— 那是**云端沙箱**的路径
 * (那台机器设了 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers + SKIP_BROWSER_DOWNLOAD=1)。
 * 写死之后这套测试在 Windows / macOS / 任何普通开发机上都跑不起来:
 *   browserType.launch: Failed to launch chromium because executable doesn't exist at /opt/pw-browsers/chromium
 * 规则(不许改回去):
 *   1. 有 PLAYWRIGHT_EXECUTABLE_PATH 环境变量就用它(显式覆盖优先);
 *   2. 否则探测沙箱那个路径,**存在才用**;
 *   3. 都没有就交给 playwright 自己解析(读它自己的浏览器缓存目录)—— 这是普通机器的正路。
 * 另外这行在任何 section() 之外,崩了就是整套退出 —— 所以额外兜一层,
 * 把 playwright 那句"executable doesn't exist"翻译成"你要跑 npx playwright install chromium"。 */
const BROWSER_EXE = (() => {
  const envPath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (envPath) return envPath;                                  // 1. 显式覆盖
  for (const p of ['/opt/pw-browsers/chromium']) {              // 2. 沙箱探测:存在才用
    if (fs.existsSync(p)) return p;
  }
  return undefined;                                             // 3. 交给 playwright 自己找
})();
const browser = await chromium.launch(BROWSER_EXE ? { executablePath: BROWSER_EXE } : {})
  .catch(e => {
    console.log('\n浏览器启动失败 —— 这套测试要一个 chromium 才能跑。');
    console.log('  用的可执行文件:' + (BROWSER_EXE || '(playwright 默认解析)'));
    console.log('  多半是本机还没下载浏览器,请先跑:  npx playwright install chromium');
    console.log('  若浏览器装在别处,可用环境变量指定:  PLAYWRIGHT_EXECUTABLE_PATH=<路径>');
    console.log('  原始报错:' + String((e && e.message) || e).split('\n')[0]);
    process.exit(1);
  });
const page = await browser.newPage();
page.on('pageerror', e => { fail++; console.log('  FAIL  页面异常: ' + e.message); });
await page.goto(APP);
// 沙箱里 cdnjs 不可达,SheetJS 本地注入(仅 xlsx 解析用得到,区间计算不依赖)
await page.addScriptTag({ path: XLSX_PATH }).catch(() => {});
await page.waitForFunction(() => typeof calcRange === 'function');

/* ---------- 造一份可控数据:PE 序列取 12 个已知值,分位可手算 ---------- */
const setup = async (eps, peSeries, price = 100) => page.evaluate(([eps, peSeries, price]) => {
  state.companies.clear(); state.history.clear(); state.overrides.clear(); state.peManual.clear();
  state.companies.set('TST-US', { ticker: 'TST-US', name: 'Test Co', currency: 'USD', price, priceSrc: 'user', eps: { fy1: eps, fy2: null }, extra: null });
  state.history.set('TST-US', peSeries.map((pe, i) => ({ date: '20' + String(10 + i).padStart(2, '0') + '-01', pe })));
  state.selected = 'TST-US'; state.horizon = 'fy1'; state.mxPick = { eps: 'base', pe: 'p50' };
  const r = calcRange(state.companies.get('TST-US'), 'fy1');
  renderMatrix(state.companies.get('TST-US'), r);
  const pe = peStats('TST-US');
  return { r: r && { mid: r.mid, coreLow: r.coreLow, coreHigh: r.coreHigh, extLow: r.extLow, extHigh: r.extHigh, flags: r.flags, eps: r.eps }, pe };
}, [eps, peSeries, price]);

const PE12 = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];

await section('[1] 乘数法定义 —— 区间三个数必须严格等于 EPS 情景 × 对应分位', async () =>
{
  const { r, pe } = await setup({ low: 4, mean: 5, high: 6 }, PE12);
  ok('coreLow = eps.low × pe.p25', near(r.coreLow, 4 * pe.p25), `${r.coreLow} vs ${4 * pe.p25}`);
  ok('mid = eps.mean × pe.p50', near(r.mid, 5 * pe.p50), `${r.mid} vs ${5 * pe.p50}`);
  ok('coreHigh = eps.high × pe.p75', near(r.coreHigh, 6 * pe.p75), `${r.coreHigh} vs ${6 * pe.p75}`);
  ok('extLow = eps.low × pe.p10', near(r.extLow, 4 * pe.p10));
  ok('extHigh = eps.high × pe.p90', near(r.extHigh, 6 * pe.p90));
  ok('区间有序 extLow ≤ coreLow ≤ mid ≤ coreHigh ≤ extHigh',
    r.extLow <= r.coreLow && r.coreLow <= r.mid && r.mid <= r.coreHigh && r.coreHigh <= r.extHigh);
  ok('无异常时不产生 flags', (r.flags || []).length === 0, JSON.stringify(r.flags));
});

await section('[2] 情景矩阵 —— 两个角必须与表头核心区间是同一个数(同源)', async () =>
{
  const cells = await page.evaluate(() => {
    const tb = document.querySelector('#mxWrap table.mx');
    const heads = [...tb.rows[0].cells].slice(1).map(c => c.textContent.trim());
    const grab = cls => [...tb.querySelectorAll('td.' + cls)].map(td => ({
      col: heads[[...td.parentNode.cells].indexOf(td) - 1],
      row: td.parentNode.cells[0].textContent.trim(),
      val: parseFloat(td.firstChild.textContent.replace(/,/g, '')),
      tip: td.title,
    }));
    return { core: grab('core'), base: grab('base'), nCols: heads.length, nRows: tb.rows.length - 1 };
  });
  const { r } = await page.evaluate(() => ({ r: calcRange(state.companies.get('TST-US'), 'fy1') }));
  ok('矩阵 3 行 5 列(P10..P90 全为正分位)', cells.nRows === 3 && cells.nCols === 5, `${cells.nRows}×${cells.nCols}`);
  ok('恰好标出 2 个 core 角', cells.core.length === 2, JSON.stringify(cells.core));
  const lo = cells.core.find(c => /P25/.test(c.col)), hi = cells.core.find(c => /P75/.test(c.col));
  ok('core 下沿在 悲观行 × P25 列', !!lo && /悲观|Low/.test(lo.row), JSON.stringify(lo));
  ok('core 上沿在 乐观行 × P75 列', !!hi && /乐观|High/.test(hi.row), JSON.stringify(hi));
  ok('矩阵 P25 角 = coreLow(显示精度内)', Math.abs(lo.val - r.coreLow) < 0.05, `${lo.val} vs ${r.coreLow}`);
  ok('矩阵 P75 角 = coreHigh(显示精度内)', Math.abs(hi.val - r.coreHigh) < 0.05, `${hi.val} vs ${r.coreHigh}`);
  ok('core 角带有解释性 tooltip', cells.core.every(c => c.tip && c.tip.length > 8));
  ok('base 格唯一且 = mid', cells.base.length === 1 && Math.abs(cells.base[0].val - r.mid) < 0.05);
  ok('图例两个色块都渲染出来了',
    await page.evaluate(() => document.querySelectorAll('#mxWrap .mxKey').length === 2));
  const picker = await page.evaluate(() => {
    const sels = document.querySelectorAll('#mxWrap .mxControls select');
    const before = document.querySelector('#mxWrap .mxResult strong').textContent;
    sels[0].value = 'opt'; sels[0].dispatchEvent(new Event('change'));
    const afterEps = document.querySelector('#mxWrap .mxResult strong').textContent;
    const sels2 = document.querySelectorAll('#mxWrap .mxControls select');
    sels2[1].value = 'p75'; sels2[1].dispatchEvent(new Event('change'));
    return {
      before, afterEps,
      afterBoth: document.querySelector('#mxWrap .mxResult strong').textContent,
      picked: document.querySelectorAll('#mxWrap table.mx td.picked').length,
      state: { ...state.mxPick },
    };
  });
  ok('盈利情景下拉会单独改变隐含价', picker.before !== picker.afterEps, JSON.stringify(picker));
  ok('估值情景下拉会继续改变隐含价', picker.afterEps !== picker.afterBoth, JSON.stringify(picker));
  ok('下拉选择与矩阵高亮格保持同源', picker.picked === 1 && picker.state.eps === 'opt' && picker.state.pe === 'p75', JSON.stringify(picker));
});

await section('[3] EPS 情景清洗护栏', async () =>
{
  const a = await setup({ low: -1, mean: 5, high: 6 }, PE12);
  ok('悲观 EPS 为负 → 退回均值,不产生负价格', a.r.coreLow > 0 && near(a.r.coreLow, 5 * a.pe.p25), String(a.r.coreLow));
  ok('并打出 lossLow 标记', (a.r.flags || []).includes('lossLow'), JSON.stringify(a.r.flags));
  ok('矩阵里出现可见告警行',
    await page.evaluate(() => [...document.querySelectorAll('#mxWrap .hint.warn')].length >= 1));

  const b = await setup({ low: 6, mean: 5, high: 4 }, PE12);
  ok('低/高颠倒 → 自动对调', near(b.r.coreLow, 4 * b.pe.p25) && near(b.r.coreHigh, 6 * b.pe.p75));
  ok('并打出 swapped 标记', (b.r.flags || []).includes('swapped'), JSON.stringify(b.r.flags));

  const c = await setup({ low: 1, mean: 9, high: 2 }, PE12);
  ok('均值落在区间外 → meanOutside 提示(但不改数)',
    (c.r.flags || []).includes('meanOutside') && near(c.r.mid, 9 * c.pe.p50), JSON.stringify(c.r.flags));

  const d = await setup({ low: 4, mean: 0, high: 6 }, PE12);
  ok('基准 EPS ≤ 0 → 整体不出区间(calcRange 返回 null)', d.r === null);

  const e = await setup({ low: 4, mean: 5, high: 6 }, [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7]);
  ok('负 P/E 分位被剔除:p25<0 时不出核心区间', e.r === null || e.pe.p25 > 0, JSON.stringify(e.pe));

  const f = await setup({ low: 4, mean: 5, high: 6 }, [-5, -4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  ok('只有 p10 为负时:核心区间照出,极端下沿留空', f.r && isFinite(f.r.coreLow) && !isFinite(f.r.extLow), JSON.stringify(f.pe));
  ok('且矩阵少一列(P10 列被过滤掉)',
    await page.evaluate(() => document.querySelectorAll('#mxWrap table.mx tr').length &&
      document.querySelector('#mxWrap table.mx').rows[0].cells.length - 1 === 4));
});

await section('[4] 新闻情绪打分', async () =>
{
  const res = await page.evaluate(() => {
    const iso = d => new Date(Date.UTC(2026, 6, 29) - d * 86400000).toISOString().slice(0, 10);
    const out = {};
    state.news.set('TST-US', [
      { date: iso(2), headline: 'Analyst upgrades TST, raises target' },
      { date: iso(5), headline: 'TST wins major partnership' },
      { date: iso(9), headline: 'TST beats quarterly estimates' },
      { date: iso(12), headline: 'Regulator opens probe into TST' },
      { date: iso(50), headline: 'Old news downgrade cut lower' },
    ]);
    out.mixed = newsScore('TST-US', '2026-07-29');
    state.news.set('TST-US', [{ date: iso(70), headline: 'Something happened' }]);
    out.quiet = newsScore('TST-US', '2026-07-29');
    state.news.set('TST-US', [{ date: iso(400), headline: 'Ancient headline' }]);
    out.none = newsScore('TST-US', '2026-07-29');
    state.news.delete('TST-US');
    out.absent = newsScore('TST-US', '2026-07-29');
    return out;
  });
  ok('30日窗口内 3 利多 1 利空 → 得分为正', res.mixed && res.mixed.s > 0, JSON.stringify(res.mixed));
  ok('分母有下限 max(4, n) → 3-1=2, 2/4 = 0.5', res.mixed && near(res.mixed.s, 0.5, 1e-6), String(res.mixed && res.mixed.s));
  ok('31–90 日的旧新闻只计入 prev,不进得分', res.mixed && res.mixed.tot === 4 && res.mixed.prev === 1, JSON.stringify(res.mixed));
  ok('近30日无新闻但前60日有 → 中性 0 并说明', res.quiet && res.quiet.s === 0 && /无新闻|No news/.test(res.quiet.why));
  ok('90 日外全无 → null(该腿不参与,权重重新归一)', res.none === null);
  ok('无新闻文件 → null', res.absent === null);
});

await section('[5] 情绪面四腿权重归一', async () =>
{
  const w = await page.evaluate(() => {
    const src = sentScores.toString();
    return (src.match(/parts\.push\(\[[^\]]*?,\s*([0-9.]+)\]\)/g) || []).join(' ');
  });
  ok('sentScores 含 0.35/0.15/0.25/0.25 四腿', /0\.35/.test(w) && /0\.15/.test(w) && (w.match(/0\.25/g) || []).length === 2, w);
  const norm = await page.evaluate(() => {
    // 只留一条腿时,wsum 归一必须让合成分等于该腿本身
    state.companies.set('N-US', { ticker: 'N-US', name: 'N', currency: 'USD', price: 10, priceSrc: 'user', eps: { fy1: null, fy2: null }, extra: null });
    state.news.set('N-US', [{ date: new Date(Date.UTC(2026, 6, 28)).toISOString().slice(0, 10), headline: 'Company wins record approval, upgrades follow' }]);
    const s = sentScores(state.companies.get('N-US'));
    const n = newsScore('N-US');
    state.companies.delete('N-US'); state.news.delete('N-US');
    return { s: s && s.s, n: n && n.s };
  });
  ok('仅新闻一腿时 合成分 = 新闻分(wsum 归一生效)', norm.s !== null && near(norm.s, norm.n, 1e-9), JSON.stringify(norm));
  const missingRatings = await page.evaluate(() => {
    state.companies.set('RAT-US', { ticker: 'RAT-US', name: 'RAT', currency: 'USD', price: 10,
      priceSrc: 'user', eps: { fy1: null, fy2: null }, extra: null });
    const aoa = [
      ['Date', 'Mean Rating', '# of Ratings', 'Buy', 'Overweight', 'Mean Tgt Price'],
      ["28 Apr '26", '', '20', '', '', '100'],
      ["28 May '26", '', '20', '', '', '102'],
      ["28 Jun '26", '', '20', '', '', '105'],
      ["28 Jul '26", '', '20', '', '', '110'],
      ["28 Jul '26", '', '20', '', '', '120'],
    ];
    ingestTargetsSheet('RAT-US', aoa, 'RAT-US Targets Ratings.xlsx');
    const co = state.companies.get('RAT-US'), s = sentScores(co);
    const out = { missing: co.targets.every(x => !isFinite(x.buyPct)), score: s && s.s,
      n: co.targets.length, latest: co.targets[co.targets.length - 1].tgt };
    state.companies.delete('RAT-US');
    return out;
  });
  ok('Buy/Overweight 两列都缺失时保留为未知,不伪造 0% 评级动量',
    missingRatings.missing && near(missingRatings.score, 1, 1e-9), JSON.stringify(missingRatings));
  ok('Targets 同日修订以后出现者覆盖,不会把重复月当成额外月份',
    missingRatings.n === 4 && missingRatings.latest === 120, JSON.stringify(missingRatings));
  const signalRevisions = await page.evaluate(() => {
    state.shortInt.delete('REV-US');
    ingestShortInt([{ ticker: 'REV-US', date: '2026-07-01', days_to_cover: '2', pct_of_float: '5' }]);
    ingestShortInt([{ ticker: 'REV-US', date: '2026-07-01', days_to_cover: '3', pct_of_float: '2' }]);
    const si = state.shortInt.get('REV-US');
    state.shortInt.delete('REV-US');
    return { n: si.length, days: si[0].days, pct: si[0].pct };
  });
  ok('同日 short-interest 修订以后导入值覆盖,不重复也不保留旧值',
    signalRevisions.n === 1 && signalRevisions.days === 3 && signalRevisions.pct === 2, JSON.stringify(signalRevisions));
});

await section('[6] 页面无 localStorage 依赖 / 基本健全', async () =>
{
  ok('源码不含 localStorage/sessionStorage',
    await page.evaluate(() => !/\b(localStorage|sessionStorage)\b/.test(document.documentElement.innerHTML)));
  const keys = await page.evaluate(() => {
    const miss = [];
    const walk = (o, p) => { for (const k of Object.keys(o)) if (!(k in I18N.en)) miss.push(p + k); };
    walk(I18N.zh, 'zh.');
    const missZh = Object.keys(I18N.en).filter(k => !(k in I18N.zh));
    return { miss, missZh };
  });
  ok('中英词表键完全对齐', keys.miss.length === 0 && keys.missZh.length === 0, JSON.stringify(keys));
  ok('新增矩阵词条齐全(含 mxFlag 四种)',
    await page.evaluate(() => ['zh', 'en'].every(L =>
      ['mxCoreTip', 'mxLegBase', 'mxLegCore'].every(k => typeof I18N[L][k] === 'string') &&
      ['swapped', 'meanOutside', 'lossLow', 'lossHigh'].every(k => typeof I18N[L].mxFlag[k] === 'string'))));
});

await section('[7] 压力位 / 支撑位(技术轨 × 估值轨)', async () =>
/* 本节的位置只会来自技术轨 tech —— 估值轨降级成图上的虚线参考,永不进上下两张表;
 * 期权轨整轨在 [8]。末尾那条极简期权链只为把渲染层的 pending 分支点亮,不验期权算法本身。
 *
 * ---------- fixture 换过一次,理由写在这里,免得下一个人又换回去 ----------
 * 旧 fixture 后 180 根是严格线性斜坡 `100 + 12*(i-320)/180`:相邻两天的对数收益几乎是常数,
 * 60 根窗口的样本标准差只有 4.397e-5,于是 1u = σd·√h·P 只有 0.011 / 0.022 / 0.038 元 ——
 * 比价格本身小三个数量级。PX_REACH_U = 1.0 的视野闸门会把每一个位置都剔掉,up/down 恒为空,
 * 本节大半条断言会"因为没有东西可比"而恒真。**那不是绿,是空。**
 * (顺带:那条斜坡上冒出来的四条"密集带"间距恰好都是 2.09,是成交量正弦 sin(i/5) 与箱宽
 *  拍出来的混叠条纹,不是筹码结构 —— 拿它验证"长期盘整形成支撑带"是在验证一个假象。)
 *
 * 现 fixture = **几何布朗运动**,完全确定性、可逐位复现:
 *   seed = 20260806;LCG  s = (s * 1103515245 + 12345) & 0x7fffffff,r = s / 0x7fffffff;
 *   正态用 12 个均匀数求和减 6 近似;每天 p *= exp(0.018 · g − 0.00016),
 *   其中 −0.00016 ≈ ½σ² 是鞅修正(零漂移,不给它塞进一条趋势);
 *   p0 = 100,500 根日线,成交量 1e6 · (1 + 0.5·sin(i/5))(不喂 vol 的那份用来验 time 口径降级)。
 * 实测日 σ:全窗口 1.754%,PX_SIGMA_WIN=60 窗口 1.869%(年化 27.85%)—— 真实个股的量级。
 * 选它的依据只有一条:**它像真的股价**。不许为了让某条断言变绿去调它的几何,
 * 更不许去动 src/js/pressure/params.js 里的任何一个数。 */
{
  const load = async (tk, vol, price) => page.evaluate(([tk, vol, price]) => {
    const start = Date.UTC(2024, 6, 1);
    let seed = 20260806;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
    const px = []; let p = 100;
    for (let i = 0; i < 500; i++) {
      p *= Math.exp(0.018 * gauss() - 0.00016);
      const rec = { date: new Date(start + i * 86400000).toISOString().slice(0, 10), price: +p.toFixed(2) };
      if (vol) rec.vol = 1e6 * (1 + 0.5 * Math.sin(i / 5));
      px.push(rec);
    }
    state.companies.set(tk, { ticker: tk, name: tk, currency: 'USD',
      price: isFinite(price) ? price : px[px.length - 1].price, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    state.priceHist.set(tk, px);
    state.history.set(tk, [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]
      .map((pe, i) => ({ date: '20' + (10 + i) + '-01', pe })));
    state.selected = tk; state.horizon = 'fy1';
    return { dates: px.map(d => d.date), prices: px.map(d => d.price) };
  }, [tk, vol, price]);

  const SER = await load('P-US', true);
  const LASTP = SER.prices[SER.prices.length - 1];

  const V = await page.evaluate(() => {
    const co = state.companies.get('P-US'), r = calcRange(co, 'fy1');
    const strip = L => ({
      lo: L.lo, hi: L.hi, mid: L.mid, distU: L.distU, distPct: L.distPct, edgeU: L.edgeU,
      pReach: L.pReach, tracks: L.tracks, evidence: L.evidence,
      hasStrength: 'strength' in L, hasKind: 'kind' in L, hasDist: 'dist' in L,
      touch: L.src.tech ? L.src.tech.touch : null, nOpts: L.src.opts.length,
    });
    const brief = P => P && ({
      horizon: P.horizon, h: P.h, sd: P.sd, u: P.u, price: P.price, asOf: P.asOf,
      basis: P.dens ? P.dens.basis : null,
      nBands: P.dens ? P.dens.bands.length : 0,
      nBins: P.dens ? P.dens.bins.length : 0,
      binW: P.dens && P.dens.bins.length ? P.dens.bins[0].hi - P.dens.bins[0].lo : NaN,
      span: P.dens ? P.dens.max - P.dens.min : NaN,
      bands: P.dens ? P.dens.bands.map(b => ({ lo: b.lo, hi: b.hi, peak: b.peak, touch: b.touch || 0 })) : [],
      up: P.up.map(strip), down: P.down.map(strip), inBand: P.inBand ? strip(P.inBand) : null,
      valRefs: P.valRefs.map(v => v.price),
      evidence: P.evidence, why: P.why,
    });
    const out = { byH: {},
      params: { BIN_U: PX_BIN_U, HALF_U: PX_HALF_U, REACH_U: PX_REACH_U, KEEP: PX_KEEP,
        EVID: JSON.stringify(Object.entries(PX_EVIDENCE).sort()) } };
    for (const hz of ['short', 'mid', 'long']) out.byH[hz] = brief(pressureLevels(co, r, null, hz));
    out.undef = brief(pressureLevels(co, r, null, undefined));
    out.fy1 = brief(pressureLevels(co, r, null, 'fy1'));

    /* σ 量纲:同一批样本喂给两个函数 —— sigmaD 给日,volStats 给年化 */
    const sFull = sigmaD('P-US', null, 500), sDef = sigmaD('P-US', null);
    const VS = volStats('P-US');
    out.sigma = { full: sFull.sd, fullN: sFull.n, def: sDef.sd, defN: sDef.n,
      ann: VS.sigma, ratioFull: VS.sigma / sFull.sd, ratioDef: VS.sigma / sDef.sd };

    /* 触及概率的单调性:直接打 reachProb,不经过带的几何 —— 这里要测的是公式本身 */
    const sd = sDef.sd;
    const pByEdge = [0, 0.005, 0.01, 0.02, 0.04, 0.08].map(e => reachProb(e, sd, 21, PX_REACH_C[21]));
    const pByH = ['short', 'mid', 'long'].map(k => PX_HORIZONS[k])
      .map(h => reachProb(0.02, sd, h, PX_REACH_C[h]));
    const pAll = [];
    for (const h of [5, 21, 63]) for (let e = 0; e <= 0.2; e += 0.004) pAll.push(reachProb(e, sd, h, PX_REACH_C[h]));
    out.prob = { pByEdge, pByH, pAll, zero: reachProb(0, sd, 21, PX_REACH_C[21]) };

    /* as-of:refISO 指到一年前 */
    const all = state.priceHist.get('P-US');
    const iBack = all.length - 1 - 252;
    const back = all[iBack];
    const Pb = pressureLevels(co, r, back.date, 'mid');
    out.asOf = { refISO: back.date, want: back.price, coPrice: co.price,
      got: Pb ? Pb.price : null, gotAsOf: Pb ? Pb.asOf : null,
      fn: asOfPrice('P-US', back.date, co.price), fnNull: asOfPrice('P-US', null, co.price) };

    /* asOfSlice 的三条防线 */
    const tryIt = f => { try { return { ok: true, v: f() }; } catch (e) { return { ok: false, e: String(e.message) }; } };
    const mk = d => ({ date: d, price: 100 });
    out.slice = {
      /* 正常:末尾那些晚于 refISO 的行必须被切掉,而不是留在结果里 */
      trunc: tryIt(() => asOfSlice([mk('2024-01-01'), mk('2024-02-01'), mk('2024-06-01'), mk('2024-09-01')], '2024-03-01').map(d => d.date)),
      /* 乱序:一根晚于 refISO 的行夹在前面 —— 前缀截断会把它连同后面本该参与的历史一起炸出来 */
      unsorted: tryIt(() => asOfSlice([mk('2024-01-01'), mk('2024-06-01'), mk('2024-02-01')], '2024-03-01').length),
      beforeAll: tryIt(() => asOfSlice([mk('2024-05-01'), mk('2024-06-01')], '2024-01-01').length),
      nullRef: tryIt(() => asOfSlice([mk('2024-01-01'), mk('2024-06-01')], null).length),
    };

    /* 55 个 as-of 日期上扫一遍:上下分档的不变量在每一天都要成立,
     * 同时统计三种情形各出现过多少次 —— 断言不能是"因为没样本所以恒真"。 */
    const scan = { n: 0, up: 0, down: 0, inBand: 0, nullP: 0,
      badKeep: 0, badSide: 0, badOrder: 0, badDup: 0, badView: 0, badVal: 0, badEdge: 0, badDistU: 0, badPct: 0 };
    for (let i = 120; i < all.length; i += 7) {
      const ref = all[i].date;
      const P = pressureLevels(co, r, ref, 'mid');
      scan.n++;
      if (!P) { scan.nullP++; continue; }
      if (P.up.length) scan.up++;
      if (P.down.length) scan.down++;
      if (P.inBand) scan.inBand++;
      if (P.up.length > PX_KEEP || P.down.length > PX_KEEP) scan.badKeep++;
      if (!P.up.every(L => L.mid > P.price) || !P.down.every(L => L.mid < P.price)) scan.badSide++;
      if (!P.up.every((L, k, a) => k === 0 || L.mid >= a[k - 1].mid)
        || !P.down.every((L, k, a) => k === 0 || L.mid <= a[k - 1].mid)) scan.badOrder++;
      if (P.inBand) {
        const dup = [...P.up, ...P.down].some(L => L === P.inBand || (L.lo === P.inBand.lo && L.hi === P.inBand.hi));
        if (dup) scan.badDup++;
        if (!(P.price >= P.inBand.lo && P.price <= P.inBand.hi)) scan.badDup++;
      } else if (P.dens) {
        /* 反向:现价真落在某条带里却没命中 inBand,同样是 bug */
        const inSome = P.dens.bands.some(b => P.price >= b.lo && P.price <= b.hi
          && (P.price < b.lo ? b.lo - P.price : P.price > b.hi ? P.price - b.hi : 0) / P.u <= PX_REACH_U);
        if (inSome) scan.badDup++;
      }
      for (const L of [...P.up, ...P.down, ...(P.inBand ? [P.inBand] : [])]) {
        if (!(L.edgeU <= PX_REACH_U)) scan.badView++;
        if (L.tracks.includes('val')) scan.badVal++;
        const edgeAbs = P.price < L.lo ? L.lo - P.price : P.price > L.hi ? P.price - L.hi : 0;
        if (Math.abs(L.edgeU - edgeAbs / P.u) > 1e-9) scan.badEdge++;
        if (Math.abs(L.distU - (L.mid - P.price) / P.u) > 1e-9) scan.badDistU++;
        if (Math.abs(L.distPct - (L.mid / P.price - 1) * 100) > 1e-9) scan.badPct++;
        if (P.valRefs.some(v => Math.abs(v.price - L.mid) < 1e-12 && L.lo === L.hi)) scan.badVal++;
      }
    }
    out.scan = scan;

    /* 渲染一次(默认 mid):图、表、常驻正文 */
    state.plHold = 'mid';
    renderPressure(co, r);
    const tds = [...document.querySelectorAll('#plTable table td')].map(td => td.textContent.trim());
    out.dom = {
      hidden: $('plSec').hidden,
      rects: document.querySelectorAll('#plChart svg rect').length,
      rows: document.querySelectorAll('#plTable table tr').length,
      dashed: document.querySelectorAll('#plChart svg line[stroke-dasharray]').length,
      plbar: document.querySelectorAll('.plbar, .plbarf').length,
      tables: document.querySelectorAll('#plTable table').length,
      heads: [...document.querySelectorAll('#plTable table th')].map(th => th.textContent.trim()),
      bareInt: tds.filter(s => /^\d{1,3}$/.test(s)),
      note: $('plNote').textContent,
      say: [...document.querySelectorAll('.plsay p')].map(p => p.textContent),
    };
    return out;
  });

  /* ---------- SPEC 3.7 表里点名的 15 条 ---------- */
  ok('σ 是日波动率不是年化 —— sigmaD 与 volStats 相差约 √252 倍',
    near(V.sigma.ratioFull, Math.sqrt(252), 1e-9) && V.sigma.ratioDef > 12 && V.sigma.ratioDef < 18
    && V.sigma.full > 0.01 && V.sigma.full < 0.03,
    JSON.stringify({ day: V.sigma.full, ann: V.sigma.ann, ratio: V.sigma.ratioFull }));
  ok('持有期从短换到长,带宽必须按 √h 变宽(5→63 应约 3.5 倍)',
    near(V.byH.long.u / V.byH.short.u, Math.sqrt(63 / 5), 1e-9)
    && near(V.byH.mid.u / V.byH.short.u, Math.sqrt(21 / 5), 1e-9)
    && Math.abs(V.byH.long.u / V.byH.short.u - 3.5) < 0.06,
    JSON.stringify([V.byH.short.u, V.byH.mid.u, V.byH.long.u]));
  ok('horizon 传 undefined 时退回 mid,不产生 NaN 带宽',
    V.undef.horizon === 'mid' && V.undef.h === 21 && isFinite(V.undef.u) && V.undef.u > 0
    && near(V.undef.u, V.byH.mid.u, 1e-12) && V.undef.up.length === V.byH.mid.up.length,
    JSON.stringify({ hz: V.undef.horizon, h: V.undef.h, u: V.undef.u }));
  ok('refISO 指定为一年前时,面板用的是一年前的价,不是 co.price',
    V.asOf.got === V.asOf.want && V.asOf.got !== V.asOf.coPrice && V.asOf.gotAsOf === V.asOf.refISO
    && V.asOf.fn === V.asOf.want && V.asOf.fnNull === V.asOf.coPrice,
    JSON.stringify(V.asOf));
  ok('asOfSlice 收到末日期晚于 refISO 的序列时抛错,不静默通过',
    V.slice.trunc.ok && V.slice.trunc.v.join(',') === '2024-01-01,2024-02-01'
    && V.slice.unsorted.ok === false && /as-of 越界/.test(V.slice.unsorted.e)
    && V.slice.beforeAll.ok === false && V.slice.nullRef.ok && V.slice.nullRef.v === 2,
    JSON.stringify(V.slice));
  ok('上下各自最多 PX_KEEP 档,且 up 全在现价上方、down 全在下方',
    V.scan.n === 55 && V.scan.nullP === 0 && V.scan.badKeep === 0 && V.scan.badSide === 0
    && V.scan.up > 0 && V.scan.down > 0,
    JSON.stringify(V.scan));
  ok('现价落在密集带内时 inBand 命中,且该带不重复出现在 up/down',
    V.scan.badDup === 0 && V.scan.inBand > 0, JSON.stringify(V.scan));
  ok('触及概率单调:同一持有期下 edge 越大 pReach 越小',
    V.prob.pByEdge.every((p, i, a) => i === 0 || p < a[i - 1]), JSON.stringify(V.prob.pByEdge));
  ok('触及概率单调:同一 edge 下持有期越长 pReach 越大',
    V.prob.pByH.every((p, i, a) => i === 0 || p > a[i - 1]), JSON.stringify(V.prob.pByH));
  ok('pReach 恒在 [0,1] 且 edge=0 时为 1',
    V.prob.zero === 1 && V.prob.pAll.every(p => isFinite(p) && p >= 0 && p <= 1)
    && [...V.byH.short.up, ...V.byH.mid.down, ...V.byH.long.down].every(L => L.pReach >= 0 && L.pReach <= 1),
    JSON.stringify({ zero: V.prob.zero, min: Math.min(...V.prob.pAll), max: Math.max(...V.prob.pAll) }));
  ok('表格里不出现任何 0–100 的强度数字,也不渲染 .plbar',
    V.dom.plbar === 0 && V.dom.bareInt.length === 0
    && V.dom.heads.every(h => !/强度|Strength/i.test(h))
    && [...V.byH.mid.up, ...V.byH.mid.down].every(L => !L.hasStrength),
    JSON.stringify({ plbar: V.dom.plbar, bare: V.dom.bareInt, heads: V.dom.heads }));
  ok('估值参考线画在图上,但一条都不在 up/down 里',
    V.byH.mid.valRefs.length === 5 && V.dom.dashed === 5 && V.scan.badVal === 0
    && [...V.byH.mid.up, ...V.byH.mid.down].every(L => !L.tracks.includes('val')),
    JSON.stringify({ refs: V.byH.mid.valRefs.map(x => +x.toFixed(2)), dashed: V.dom.dashed }));

  /* evidence=pending 的位置在本节的纯技术轨数据里根本不存在(没有期权腿),
   * 所以这里单独喂一条极简链把渲染层那个分支点亮。到期日按运行日 +21 天动态生成,
   * 免得一条写死的日期在某个未来的运行日突然过期,把断言变成"没有 pending 行也算过"。
   * 期权轨自身的算法(选到期日、零 OI 分母、网格标记)整轨在 [8] 验,这里不碰。 */
  const PEND = await page.evaluate(() => {
    const co = state.companies.get('P-US'), r = calcRange(co, 'fy1');
    const iso = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const rows = [];
    for (let k = 100; k <= 135; k += 5) {
      const big = k === 120 ? 25 : 1;
      rows.push({ asof: iso(0), expiry: iso(21), strike: k, call_oi: 600 * big, put_oi: 300 * big });
    }
    state.options.delete('P-US');
    ingestOptions(rows, 'P-US Options.csv');
    state.plHold = 'mid';
    renderPressure(co, r);
    const P = pressureLevels(co, r, null, 'mid');
    const trs = [...document.querySelectorAll('#plTable table tr')].slice(0);
    const cls = k => [...document.querySelectorAll('#plTable table tr')]
      .filter(tr => tr.querySelector('.plev.' + k));
    const txt = list => list.map(tr => tr.textContent);
    const out = {
      levels: [...P.up, ...P.down, ...(P.inBand ? [P.inBand] : [])]
        .map(L => ({ mid: L.mid, tracks: L.tracks, ev: L.evidence, nOpts: L.src.opts.length })),
      nPendRow: cls('pending').length, nVerRow: cls('verified').length,
      pendText: txt(cls('pending')), verText: txt(cls('verified')),
      pendHasPct: cls('pending').some(tr => /%/.test(tr.textContent)),
      pendSpan: [...document.querySelectorAll('#plTable .plpend')].map(s => s.textContent),
      reachSpanInPend: cls('pending').some(tr => !!tr.querySelector('.plreach')),
      nTrs: trs.length,
    };
    state.options.delete('P-US');
    return out;
  });
  ok('evidence 为 pending 的位置,DOM 里不含任何 % 号',
    PEND.nPendRow > 0 && PEND.pendHasPct === false && PEND.reachSpanInPend === false
    && PEND.pendSpan.length > 0 && PEND.pendSpan.every(s => !/%/.test(s))
    && PEND.levels.filter(L => L.nOpts > 0).every(L => L.ev === 'pending'),
    JSON.stringify(PEND));

  const DEG = await page.evaluate(() => {
    const co = state.companies.get('P-US'), r = calcRange(co, 'fy1');
    const full = state.priceHist.get('P-US');
    state.priceHist.set('P-US', full.slice(0, 20));
    const shortDens = priceDensity('P-US', null, 21);
    const shortP = pressureLevels(co, r, null, 'mid');
    state.priceHist.delete('P-US');
    const noneDens = priceDensity('P-US', null, 21);
    const noneP = pressureLevels(co, r, null, 'mid');
    const noPrice = pressureLevels({ ...co, price: NaN }, r, null, 'mid');
    const noPrice0 = pressureLevels({ ...co, price: 0 }, r, null, 'mid');
    renderPressure({ ...co, price: NaN }, r);
    const hidden = $('plSec').hidden;
    state.priceHist.set('P-US', full);
    return { shortDens, shortP, noneDens, noneP, noPrice, noPrice0, hidden };
  });
  ok('历史不足 40 根 → 返回 null,不硬算',
    DEG.shortDens === null && DEG.shortP === null, JSON.stringify(DEG));
  ok('现价缺失 → 整体返回 null,面板隐藏',
    DEG.noPrice === null && DEG.noPrice0 === null && DEG.hidden === true, JSON.stringify(DEG));

  /* ---------- 以下是上一版 [7] 里仍然成立、按新 API 改过名的覆盖 ----------
   * 只删了指名已废符号的那几条(strength / kind / multi / P.all / P.basis / valuationLevels),
   * 其余一条不减:重写不许净减少覆盖。 */
  ok('有成交量 → 口径为 volume(真实筹码分布)', V.byH.mid.basis === 'volume', String(V.byH.mid.basis));
  ok('面板可见并渲染出图与表',
    !V.dom.hidden && V.dom.rects > 10 && V.dom.tables >= 1 && V.dom.rows >= 2 && V.dom.heads.length === 5,
    JSON.stringify({ rects: V.dom.rects, tables: V.dom.tables, rows: V.dom.rows }));
  ok('说明文字标明了口径与样本区间',
    /成交量|volume/i.test(V.dom.note) && /\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/.test(V.dom.note),
    V.dom.note.slice(0, 80));
  ok('短持有期下识别出多条价位带(1 ≤ nBands ≤ 6)',
    V.byH.short.nBands >= 2 && V.byH.short.nBands <= 6
    && ['short', 'mid', 'long'].every(k => V.byH[k].nBands >= 1 && V.byH[k].nBands <= 6),
    JSON.stringify(['short', 'mid', 'long'].map(k => V.byH[k].nBands)));
  ok('价位带互不重叠且已合并(相邻碎带不该同时存在)',
    ['short', 'mid', 'long'].every(k => {
      const b = V.byH[k].bands.slice().sort((x, y) => x.lo - y.lo);
      return b.every((L, i) => i === 0 || L.lo > b[i - 1].hi);
    }), JSON.stringify(V.byH.short.bands.map(b => [+b.lo.toFixed(1), +b.hi.toFixed(1)])));
  ok('峰值落在自己的带里(band.peak 必须被 lo/hi 夹住)',
    ['short', 'mid', 'long'].every(k => V.byH[k].bands.every(b => b.peak >= b.lo && b.peak <= b.hi)),
    JSON.stringify(V.byH.short.bands.map(b => [+b.lo.toFixed(1), +b.peak.toFixed(1), +b.hi.toFixed(1)])));
  ok('箱宽 = PX_BIN_U · u(三个持有期各自成立,ceil 量化误差在 1/nb 以内)',
    ['short', 'mid', 'long'].every(k => {
      const B = V.byH[k], want = V.params.BIN_U * B.u;
      return B.binW <= want + 1e-9 && B.binW > want * (1 - 1 / B.nBins) - 1e-9
        && B.nBins === Math.ceil(B.span / want);
    }), JSON.stringify(['short', 'mid', 'long'].map(k => [V.byH[k].nBins, +V.byH[k].binW.toFixed(4)])));
  ok('带宽下限 = 2 · PX_HALF_U · u(比这更窄的带在本持有期上只是一个点)',
    ['short', 'mid', 'long'].every(k => V.byH[k].bands.every(b => b.hi - b.lo >= 2 * V.params.HALF_U * V.byH[k].u - 1e-9)),
    JSON.stringify(['short', 'mid', 'long'].map(k => [+(2 * V.params.HALF_U * V.byH[k].u).toFixed(3),
      Math.min(...V.byH[k].bands.map(b => +(b.hi - b.lo).toFixed(3)))])));
  ok('distPct 与 mid / as-of 现价自洽(旧字段名 dist 已彻底改名)',
    V.scan.badPct === 0 && [...V.byH.mid.up, ...V.byH.mid.down].every(L => !L.hasDist),
    JSON.stringify(V.byH.mid.down.map(L => [L.mid, L.distPct])));
  ok('distU = (mid − 现价) / u,三个持有期同一把尺子', V.scan.badDistU === 0, String(V.scan.badDistU));
  ok('edgeU 量到最近边缘而不是量到中心(现价在带内时 edgeU = 0)',
    V.scan.badEdge === 0, String(V.scan.badEdge));
  ok('视野闸门:入表的位置 edgeU 一律 ≤ PX_REACH_U', V.scan.badView === 0, String(V.scan.badView));
  ok('上方按由近及远、下方按由近及远排序', V.scan.badOrder === 0, String(V.scan.badOrder));
  ok('as-of 扫描 55 天里 up / down / inBand 三种情形都真实出现过(断言不是空跑)',
    V.scan.up >= 3 && V.scan.down >= 3 && V.scan.inBand >= 3,
    JSON.stringify({ up: V.scan.up, down: V.scan.down, inBand: V.scan.inBand, n: V.scan.n }));
  ok('位置对象上不再有 strength / kind 字段(已由 tracks 取代)',
    [...V.byH.mid.up, ...V.byH.mid.down, ...(V.byH.mid.inBand ? [V.byH.mid.inBand] : [])]
      .every(L => !L.hasStrength && !L.hasKind && Array.isArray(L.tracks) && L.tracks.length > 0),
    JSON.stringify(V.byH.mid.down.map(L => L.tracks)));
  ok('why 里明说"守不守得住"这件事测不出来(少一个功能不许只藏在 tooltip 里)',
    V.byH.mid.why.some(s => /不预测支撑位会不会守住|do not predict whether a level holds/.test(s))
    && V.dom.say.length === 3 && V.dom.say.some(s => /不预测支撑位会不会守住/.test(s)),
    JSON.stringify(V.dom.say.map(s => s.slice(0, 24))));
  ok('传进一个财年标签 fy1 时退回 mid 并留下一句可见的提示',
    V.fy1.horizon === 'mid' && V.fy1.why.some(s => /不认识的持有期|Unrecognised horizon/.test(s)),
    JSON.stringify(V.fy1.why[0] && V.fy1.why[0].slice(0, 40)));
  ok('引擎交出的 evidence 是 PX_EVIDENCE 的快照(五个 claim 齐全)',
    JSON.stringify(Object.entries(V.byH.mid.evidence).sort()) === V.params.EVID,
    JSON.stringify(V.byH.mid.evidence));

  await load('T-US', false);
  const T = await page.evaluate(() => {
    const co = state.companies.get('T-US'), r = calcRange(co, 'fy1');
    const P = pressureLevels(co, r, null, 'mid');
    renderPressure(co, r);
    return { basis: P.dens.basis, nBands: P.dens.bands.length,
      nLevels: P.up.length + P.down.length + (P.inBand ? 1 : 0),
      note: $('plNote').textContent };
  });
  ok('无成交量 → 自动退回 time(停留时间)口径', T.basis === 'time', String(T.basis));
  ok('退回口径时说明文字如实标注', /停留时间|time-at-price/i.test(T.note), T.note.slice(0, 80));
  ok('两种口径都能给出价位带(降级不失效)', T.nBands >= 1 && T.nLevels >= 1, JSON.stringify(T));

  /* setPriceHist 择优:带量的序列按 1.5 倍长度计分 */
  const pick = await page.evaluate(() => {
    const mk = (n, vol, tag) => Array.from({ length: n }, (_, i) => {
      const r = { date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), price: 100 + i * 0.01, tag };
      if (vol) r.vol = 1e6;
      return r;
    });
    const out = {};
    state.priceHist.delete('S-US');
    setPriceHist('S-US', mk(300, false, 'long-novol'));
    setPriceHist('S-US', mk(250, true, 'short-vol'));
    out.a = state.priceHist.get('S-US')[0].tag;          // 250×1.5=375 > 300 → 换成带量的
    state.priceHist.delete('S-US');
    setPriceHist('S-US', mk(600, false, 'longer-novol'));
    setPriceHist('S-US', mk(250, true, 'short-vol'));
    out.b = state.priceHist.get('S-US')[0].tag;          // 375 < 600 → 保留更长的
    state.priceHist.delete('S-US');
    setPriceHist('S-US', mk(200, true, 'vol'));
    setPriceHist('S-US', []);
    setPriceHist('S-US', null);
    out.c = state.priceHist.get('S-US')[0].tag;          // 空输入不得覆盖已有序列
    state.priceHist.delete('S-US');
    setPriceHist('S-US', mk(20, false, 'old'));
    setPriceHist('S-US', mk(20, false, 'new'));
    out.d = state.priceHist.get('S-US')[0].tag;          // 同质量同长度:后导入的新文件覆盖
    const dup = mk(20, false, 'base');
    dup.push({ ...dup[5], price: 999, tag: 'last-duplicate' });
    state.priceHist.delete('S-US'); setPriceHist('S-US', dup);
    const got = state.priceHist.get('S-US');
    out.e = { n: got.length, p: got.find(x => x.date === dup[5].date).price,
      sorted: got.every((x, i) => !i || got[i - 1].date < x.date) };
    state.priceHist.delete('S-US');
    return out;
  });
  ok('带量序列按 1.5 倍长度计分 → 稍短但有量的胜出', pick.a === 'short-vol', pick.a);
  ok('但长度差距足够大时仍保留更长的序列', pick.b === 'longer-novol', pick.b);
  ok('空序列/null 不覆盖已有数据', pick.c === 'vol', pick.c);
  ok('同长度同质量的新价格文件覆盖旧文件', pick.d === 'new', pick.d);
  ok('价格序列同日重复行按输入末行覆盖,并保持严格升序',
    pick.e.n === 20 && pick.e.p === 999 && pick.e.sorted, JSON.stringify(pick.e));
  const marketDup = await page.evaluate(() => {
    const rows = [['Date', 'Bench - Close']];
    for (let i = 0; i < 13; i++) rows.push([new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), 100 + i]);
    rows.push(['2026-01-06', 999]);
    state.market.delete('BENCH');
    ingestChartingSheet('Sheet1', rows, '_MARKET-BENCH SPY-US Daily Charting.xlsx');
    const px = state.market.get('BENCH').px;
    const out = { n: px.length, p: px.find(x => x.date === '2026-01-06').price,
      sorted: px.every((x, i) => !i || px[i - 1].date < x.date) };
    state.market.delete('BENCH');
    return out;
  });
  ok('市场级 Charting 同日末行覆盖且严格升序,收益与均线不会重复计日',
    marketDup.n === 13 && marketDup.p === 999 && marketDup.sorted, JSON.stringify(marketDup));

  /* 摆动高低点:局部极值判定 */
  const sw = await page.evaluate(() => {
    const s = Array.from({ length: 60 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      price: 100 + 10 * Math.sin(i * Math.PI / 15),   // 周期 30 天,一高一低
    }));
    const pts = swingPoints(s, 8);
    return { n: pts.length, kinds: [...new Set(pts.map(p => p.kind))].sort(),
      hiOK: pts.filter(p => p.kind === 'high').every(p => p.price > 105),
      loOK: pts.filter(p => p.kind === 'low').every(p => p.price < 95) };
  });
  ok('摆动点同时识别出前高与前低', sw.n >= 2 && sw.kinds.join(',') === 'high,low', JSON.stringify(sw));
  ok('前高取在波峰、前低取在波谷', sw.hiOK && sw.loOK, JSON.stringify(sw));
  ok('摆动点被计入价位带的 touch 次数',
    V.byH.mid.bands.some(b => b.touch > 0), JSON.stringify(V.byH.mid.bands.map(b => b.touch)));

  ok('完全没有价格历史时也不报错(返回 null,不抛)',
    DEG.noneDens === null && DEG.noneP === null, JSON.stringify({ d: DEG.noneDens, p: DEG.noneP }));

  /* 词表:旧的 plStr / plMultiTip / plKind.multi 随强度分与 multi 档一起删掉了,
   * 这里连"它们必须消失"一起钉住 —— 只查新键会让一个被遗弃的旧键继续躺在词表里。 */
  ok('压力位词条中英齐全(plKind/plKindTip 只剩三轨,plStr/plMultiTip 已随强度分一起删)',
    await page.evaluate(() => ['zh', 'en'].every(L => {
      const D = I18N[L];
      const str13 = ['plHorizon', 'plHorizonNote', 'plDistU', 'plReach', 'plReachTip', 'plNoStrength',
        'plBounceNote', 'plValRef', 'plValRefTip', 'plOptPendingTip', 'plTracks', 'plEvidenceCol', 'plDte'];
      return str13.every(k => typeof D[k] === 'string' && D[k].length > 0)
        && typeof D.plOptPending === 'function' && typeof D.plOptPending(2) === 'string'
        && ['verified', 'pending', 'descriptive', 'falsified']
          .every(k => typeof D.plEvidence[k] === 'string' && typeof D.plEvidenceTip[k] === 'string')
        && ['plUp', 'plDown', 'plZone', 'plBasis', 'plBasisVol', 'plBasisTime', 'plNone', 'plAxisWt']
          .every(k => typeof D[k] === 'string')
        && ['plNote', 'plInBand', 'plSwing', 'plWall', 'plOptNote', 'mOptRows'].every(k => typeof D[k] === 'function')
        && Object.keys(D.plKind).sort().join(',') === 'opt,tech,val'
        && Object.keys(D.plKindTip).sort().join(',') === 'opt,tech,val'
        && !('plStr' in D) && !('plMultiTip' in D);
    })));
});

await section('[8] 期权轨:未平仓量(OI)墙', async () =>
{
  /* 日线沿用 [7] 那份 GBM(seed 20260806),现价取它的最后一根收盘 —— 期权链的
   * ±25% 窗口与 call/put 偏斜都以这个价为轴,别再回到写死的 108。
   * 期权链本身保持上一版的构造,它每一条干扰链都在验一件具体的事:
   *   2026-06-19  已过期            → 过期即失效
   *   2026-07-29  就是 as-of 当天到期 → 今晚归零,不该占名额(这条 OI 故意做得最大)
   *   07-31/08-07/08-14  薄周度链   → 真导出把到期日精确到天,"日历上最近的几个"经常
   *                                    正好是这种没人参与的周度链;选谁要看 OI,不看远近
   *   2026-08-21 / 09-18  月度链    → OI 真正堆着的地方,必须被选中
   *   2026-12-18  远月              → 超出 PX_OPT_MAX_DTE = 60 天视野 */
  const O = await page.evaluate(() => {
    const start = Date.UTC(2024, 6, 1);
    let seed = 20260806;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
    const px = []; let p = 100;
    for (let i = 0; i < 500; i++) {
      p *= Math.exp(0.018 * gauss() - 0.00016);
      px.push({ date: new Date(start + i * 86400000).toISOString().slice(0, 10), price: +p.toFixed(2),
        vol: 1e6 * (1 + 0.5 * Math.sin(i / 5)) });
    }
    const PXL = px[px.length - 1].price;
    state.companies.set('O-US', { ticker: 'O-US', name: 'O', currency: 'USD', price: PXL, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    state.priceHist.set('O-US', px);
    state.history.set('O-US', [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]
      .map((pe, i) => ({ date: '20' + (10 + i) + '-01', pe })));
    const rows = [];
    for (const [expiry, mult] of [['2026-06-19', 1], ['2026-07-29', 1.2], ['2026-07-31', 0.01],
      ['2026-08-07', 0.02], ['2026-08-14', 0.03], ['2026-08-21', 1], ['2026-09-18', 0.7], ['2026-12-18', 1]]) {
      for (let k = 60; k <= 150; k += 5) {
        const big = k === 120 ? 9 : k === 95 ? 7 : 1;
        rows.push({ asof: '2026-07-29', expiry, strike: k,
          call_oi: Math.round(1200 * big * mult * (k > PXL ? 1.6 : 0.5)),
          put_oi: Math.round(1200 * big * mult * (k < PXL ? 1.6 : 0.5)) });
      }
    }
    state.options.delete('O-US');
    const msg = ingestOptions(rows, 'O-US Options.csv');
    /* 不同 asof 必须同时保留，行为面板需要相邻快照；压力位会自行选参照日前最新一份。 */
    const upd = ingestOptions([{ asof: '2026-07-30', expiry: '2026-08-21', strike: 120, call_oi: 1, put_oi: 1 },
      { asof: '2026-07-01', expiry: '2026-08-21', strike: 115, call_oi: 999999, put_oi: 0 },
      { asof: '2026-07-29', expiry: 'garbage', strike: 100, call_oi: 5, put_oi: 5 }], 'O-US Options.csv');
    const chain = state.options.get('O-US');
    const at = (e, s, a) => chain.find(r => r.expiry === e && r.strike === s && (!a || r.asof === a));
    const latestAt = (e, s) => chain.filter(r => r.expiry === e && r.strike === s)
      .sort((a, b) => a.asof < b.asof ? 1 : -1)[0];
    state.selected = 'O-US'; state.horizon = 'fy1'; state.plHold = 'mid';
    const co = state.companies.get('O-US'), r = calcRange(co, 'fy1');
    const W = optionWalls(co, '2026-07-29', 21);
    const P = pressureLevels(co, r, '2026-07-29', 'mid');
    /* 同一条链换三个持有期:evidence 是字面量,不该被 h 或任何输入改动 */
    const evByH = ['short', 'mid', 'long'].map(hz => optionWalls(co, '2026-07-29', PX_HORIZONS[hz]).evidence);
    const noChain = (() => {
      const saved = state.options.get('O-US'); state.options.delete('O-US');
      const w = optionWalls(co, '2026-07-29', 21);
      const p = pressureLevels(co, r, '2026-07-29', 'mid');
      state.options.set('O-US', saved);
      return { w, tracks: [...new Set([...p.up, ...p.down, ...(p.inBand ? [p.inBand] : [])].flatMap(L => L.tracks))],
        n: p.up.length + p.down.length + (p.inBand ? 1 : 0) };
    })();
    /* max pain 手算校验。
     * 旧夹具是两个行权价 100/110、各挂 1000 张的对称链,两边的总内在价值都是 10000 ——
     * **平局**。于是断言只能写成 `mp === 100 || mp === 110`,而 `return rows[0].strike`
     * 这种一行桩函数也能过。一个平局夹具证明不了"取的是最小值",它只证明了"取的是这两个之一"。
     * 换成最小值唯一的四档链:总付出 25000 / 20000 / 22500 / 30000,唯一最小在 100。
     * 唯一性不靠嘴说,pays 一起带出去,由断言现场核对(min 只出现一次、且在下标 1)。 */
    const MPROWS = [{ strike: 95, callOI: 1000, putOI: 0 }, { strike: 100, callOI: 1500, putOI: 0 },
      { strike: 105, callOI: 0, putOI: 1000 }, { strike: 110, callOI: 0, putOI: 1000 }];
    const mp = maxPain(MPROWS);
    const mpPays = MPROWS.map(s => MPROWS.reduce((a, r) =>
      a + r.callOI * Math.max(0, s.strike - r.strike) + r.putOI * Math.max(0, r.strike - s.strike), 0));
    renderPressure(co, r);
    const OB = optionBehavior('O-US'); renderOptionsBehavior(co);
    const lv = L => ({ lo: L.lo, hi: L.hi, mid: L.mid, tracks: L.tracks, ev: L.evidence,
      strikes: L.src.opts.map(w => w.strike), hasStrength: 'strength' in L });
    return {
      price: PXL, msg: msg.text, upd: upd.text, updRows: chain.length,
      newer: latestAt('2026-08-21', 120).callOI, older: latestAt('2026-08-21', 115).callOI,
      oldSnapshotKept: at('2026-08-21', 115, '2026-07-01').callOI,
      snapshots: OB.snaps, behaviorVisible: !$('optBehaviorSec').hidden,
      behaviorCards: document.querySelectorAll('#optBehaviorGrid .optHorizon').length,
      behaviorText: $('optBehaviorSec').textContent,
      badExpiry: !!at('garbage', 100),
      expiries: W.expiries.map(e => ({ expiry: e.expiry, dte: e.dte, w: e.w, maxPain: e.maxPain,
        nStrike: e.nStrike, callOI: e.callOI, putOI: e.putOI })),
      walls: W.walls.map(w => ({ strike: w.strike, oi: w.oi, callOI: w.callOI, putOI: w.putOI,
        expiry: w.expiry, dte: w.dte, w: w.w, align: w.align, isGrid50: w.isGrid50, isGrid25: w.isGrid25,
        keys: Object.keys(w).sort().join(',') })),
      window: W.window, evidence: W.evidence, evByH, mp, mpPays,
      pxEvidence: Object.assign({}, PX_EVIDENCE),
      noChainWalls: noChain.w, noChainTracks: noChain.tracks, noChainN: noChain.n,
      up: P.up.map(lv), down: P.down.map(lv), inBand: P.inBand ? lv(P.inBand) : null,
      note: $('plNote').textContent,
      rects: document.querySelectorAll('#plChart svg rect').length,
    };
  });

  /* ---------- SPEC 3.7 表里点名的 6 条 ---------- */
  ok('walls 里不再有 strength 字段(旧的 55/20/25 加权分已删)',
    O.walls.length > 0 && O.walls.every(w => !('strength' in w))
    && O.walls.every(w => w.keys === 'align,callOI,dte,expiry,isGrid25,isGrid50,oi,putOI,strike,w')
    && [...O.up, ...O.down].every(L => !L.hasStrength),
    JSON.stringify(O.walls[0] && O.walls[0].keys));
  ok('今天到期的链被排除(expiry <= today,不是 <)',
    O.expiries.every(e => e.expiry !== '2026-07-29') && O.walls.every(w => w.expiry !== '2026-07-29')
    && O.expiries.every(e => e.dte > 0),
    JSON.stringify(O.expiries.map(e => [e.expiry, e.dte])));
  ok('取窗口内 OI 最重的三个到期日,不是日历上最近的三个',
    O.expiries.length === 3
    && O.expiries.map(e => e.expiry).join(',') === '2026-08-14,2026-08-21,2026-09-18'
    && O.expiries.map(e => e.expiry).join(',') !== '2026-07-31,2026-08-07,2026-08-14',
    JSON.stringify(O.expiries.map(e => e.expiry)));
  /* SPEC 3.7 点名的另外两条 —— 「均值分母只含有参与的行权价(零 OI 行不进分母)」与
   * 「x50 网格标记正确:150 是 isGrid50,175 是 isGrid25,163 两者皆非」—— 各自需要一条
   * 专门构造的链(Z-US 全平链 / G-US 网格链),写在本节末尾,名字逐字照抄。 */
  ok('期权轨的 evidence 恒为 pending,不因任何输入变成 verified',
    O.evidence === 'pending' && O.evByH.join(',') === 'pending,pending,pending'
    && [...O.up, ...O.down].filter(L => L.strikes.length).every(L => L.ev === 'pending'),
    JSON.stringify({ ev: O.evidence, byH: O.evByH }));

  /* ---------- 上一版 [8] 里仍然成立的覆盖(按新 API 改名后逐条保留) ---------- */
  ok('Options.csv 归属到 ticker 并按行权价入库', /O-US/.test(O.msg) && O.updRows > 10, O.msg);
  ok('同一合约的最新 asof 仍用于当前压力位', O.newer === 1 && O.older !== 999999, JSON.stringify([O.newer, O.older]));
  ok('旧 asof 快照保留下来供行为时间轴比较', O.oldSnapshotKept === 999999 && O.snapshots === 3, JSON.stringify([O.oldSnapshotKept, O.snapshots]));
  ok('期权行为时间轴渲染短中长期三层且明说 OI 不能证明方向', O.behaviorVisible && O.behaviorCards === 3
    && /短期|Short/.test(O.behaviorText) && /中期|Medium/.test(O.behaviorText) && /长期|Long/.test(O.behaviorText)
    && /不能单独证明|cannot prove/.test(O.behaviorText), O.behaviorText);
  ok('非法到期日被丢弃', O.badExpiry === false);
  ok('已过期的链被排除(2026-06-19 不出现)', O.expiries.every(e => e.expiry !== '2026-06-19'));
  ok('远月被排除(2026-12-18 超出 PX_OPT_MAX_DTE=60)',
    O.expiries.every(e => e.expiry !== '2026-12-18') && O.expiries.every(e => e.dte <= 60),
    JSON.stringify(O.expiries.map(e => e.dte)));
  ok('选到期日看 OI 不看远近:最近的薄周度链 07-31 / 08-07 落选,月度 08-21 / 09-18 入选',
    O.expiries.every(e => e.expiry !== '2026-07-31' && e.expiry !== '2026-08-07')
    && ['2026-08-21', '2026-09-18'].every(x => O.expiries.some(e => e.expiry === x)),
    JSON.stringify(O.expiries.map(e => e.expiry)));
  ok('到期日按日期排序交出(面板要按时间读)',
    O.expiries.map(e => e.expiry).join(',') === O.expiries.map(e => e.expiry).slice().sort().join(','),
    JSON.stringify(O.expiries.map(e => e.expiry)));
  ok('时间权重 w = 1/(1+dte/PX_OPT_DTE_HALF) 连续衰减,不再是写死的 1.0 / 0.6',
    O.expiries.every(e => Math.abs(e.w - 1 / (1 + e.dte / 30)) < 1e-9)
    && O.expiries.every((e, i, a) => i === 0 || e.w < a[i - 1].w),
    JSON.stringify(O.expiries.map(e => [e.dte, +e.w.toFixed(3)])));
  ok('剩余天数 dte 为正且递增',
    O.expiries[0].dte > 0 && O.expiries.every((e, i, a) => i === 0 || e.dte > a[i - 1].dte),
    JSON.stringify(O.expiries.map(e => e.dte)));
  ok('墙上带着 dte / w 且与所属到期日一致(渲染层要按它分近月远月)',
    O.walls.every(w => { const e = O.expiries.find(x => x.expiry === w.expiry); return e && e.dte === w.dte && e.w === w.w; }),
    JSON.stringify(O.walls.map(w => [w.expiry, w.dte])));
  ok('行权价窗口 = 现价 ±25%(PX_OPT_WINDOW)',
    O.window === 0.25 && O.walls.every(w => Math.abs(w.strike / O.price - 1) <= 0.2500001),
    JSON.stringify({ price: O.price, strikes: O.walls.map(w => w.strike) }));
  ok('只有真正堆量的行权价被判为墙(120 与 95)',
    O.walls.length > 0 && [...new Set(O.walls.map(w => w.strike))].sort((a, b) => a - b).join(',') === '95,120',
    JSON.stringify(O.walls.map(w => w.strike)));
  ok('墙的 OI 门槛同时满足 PX_OPT_MIN_OI 与 avg×PX_OPT_WALL_X',
    O.walls.every(w => w.oi >= 500 && w.oi === w.callOI + w.putOI),
    JSON.stringify(O.walls.map(w => w.oi)));
  ok('每个到期日的墙不超过 PX_OPT_KEEP=4',
    O.expiries.every(e => O.walls.filter(w => w.expiry === e.expiry).length <= 4),
    JSON.stringify(O.expiries.map(e => O.walls.filter(w => w.expiry === e.expiry).length)));
  ok('方位一致(上方看涨为主 / 下方看跌为主)→ align=1',
    O.walls.every(w => w.align === 1), JSON.stringify(O.walls.map(w => [w.strike, w.align])));
  ok('align 只是三档原始标签(1 / 0.5 / 0.25),不再乘进任何合成分',
    O.walls.every(w => [1, 0.5, 0.25].includes(w.align)), JSON.stringify(O.walls.map(w => w.align)));
  /* 断言名从"两腿链"改成"四档链",因为夹具换了 —— 名字得和它验的东西对得上。
   * 三件事一起验:总付出逐个对上手算值、最小值唯一(只出现一次)、maxPain 取的正是那一个。
   * 少了"唯一"这一条,断言就会退回成平局夹具那种谁都能过的样子。 */
  ok('max pain 手算校验(四档链取内在价值最小的行权价,最小值唯一)',
    JSON.stringify(O.mpPays) === JSON.stringify([25000, 20000, 22500, 30000])
    && O.mpPays.filter(v => v === Math.min(...O.mpPays)).length === 1
    && O.mp === 100,
    JSON.stringify({ mp: O.mp, pays: O.mpPays }));
  ok('每个到期日都给出 max pain 与 call/put 总量(面板要打印 P/C)',
    O.expiries.every(e => isFinite(e.maxPain) && e.callOI > 0 && e.putOI > 0),
    JSON.stringify(O.expiries.map(e => [e.maxPain, e.callOI, e.putOI])));
  ok('期权墙进入压力位面板(存在含 opt 的位置)',
    [...O.up, ...O.down, ...(O.inBand ? [O.inBand] : [])].some(L => L.tracks.includes('opt')),
    JSON.stringify([...O.up, ...O.down].map(L => L.tracks)));
  ok('120 的看涨墙落在上行压力表里',
    O.up.some(L => L.tracks.includes('opt') && L.strikes.includes(120)), JSON.stringify(O.up));
  ok('95 的看跌墙落在下行支撑表里',
    O.down.some(L => L.tracks.includes('opt') && L.strikes.includes(95)), JSON.stringify(O.down));
  /* 期待值不再写死 'verified' / 'pending',而是从 PX_EVIDENCE 现读:
   * 引擎那一行已经改成 `L.opts.length ? PX_EVIDENCE.opt : PX_EVIDENCE.reach`,
   * 这里若还钉字面量,等级一降级测试就红,人会顺手去改测试而不是去想为什么降级 ——
   * 那正好把 3.9 的兜底条款重新变成一句空话。取"更弱的那一档"这条不变量与等级取值无关,
   * 所以它照旧钉死:含期权腿的位置绝不允许出现比纯技术轨更高的等级。 */
  ok('含期权腿的位置整条取更弱的那一档(不许被旁边的等级更高的腿洗白)',
    [...O.up, ...O.down, ...(O.inBand ? [O.inBand] : [])]
      .every(L => L.ev === (L.strikes.length ? O.pxEvidence.opt : O.pxEvidence.reach))
    && [...O.up, ...O.down].some(L => L.tracks.length === 2 && L.ev === O.pxEvidence.opt)
    && O.pxEvidence.opt !== 'verified',
    JSON.stringify([...O.up, ...O.down].map(L => [L.tracks.join('+'), L.ev])));
  ok('说明文字写出到期日、剩余天数与 max pain', /max pain/.test(O.note) && /P\/C/.test(O.note), O.note.slice(-140));
  ok('OI 墙在图上画出竖条(rect 数多于纯技术轨)', O.rects > 20, String(O.rects));
  ok('没有期权链时 optionWalls 返回 null(不硬造)', O.noChainWalls === null);
  ok('没有期权链时技术轨照常工作',
    O.noChainN > 0 && !O.noChainTracks.includes('opt'), JSON.stringify(O.noChainTracks));

  /* ---------- as-of 闸门:参照日之后拍下的快照不许进 ----------
   * 这是这一轨最后一个未来函数,而且此前**一条覆盖都没有**。构造刻意做成单变量对照:
   * 两次调用只差一天(2026-07-28 / 2026-07-29),价格全程恒为 100,
   * 于是 expiry 闸门、dte 闸门、行权价窗口在两次调用里给出完全相同的判断 ——
   * 唯一变的是 refISO 与新快照 asof('2026-07-29')的先后。只要还有一面 110 的墙
   * 在 07-28 那天冒出来,就说明 OI 是从一天之后借来的。
   * 两份快照特意挂在不同的到期日上:ingestOptions 按 (到期日,行权价) 去重、只留 asof 最新的一条,
   * 同键放两个 asof 的话老快照在入库时就没了,测出来的是去重不是闸门。 */
  const AS = await page.evaluate(() => {
    const px = [];
    for (let i = 0; i < 320; i++) {
      px.push({ date: new Date(Date.UTC(2025, 9, 1) + i * 86400000).toISOString().slice(0, 10),
        price: 100, vol: 1e6 });
    }
    state.companies.set('AS-US', { ticker: 'AS-US', name: 'AS', currency: 'USD', price: 100, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    state.priceHist.set('AS-US', px);
    const rows = [];
    /* 老快照(2026-06-15 拍的):堆在 95。 */
    for (let k = 90; k <= 110; k += 5) {
      rows.push({ asof: '2026-06-15', expiry: '2026-08-07', strike: k,
        call_oi: k === 95 ? 9000 : 600, put_oi: k === 95 ? 9000 : 600 });
    }
    /* 新快照(2026-07-29 拍的):堆在 110。站在 07-28 看,这批数字还不存在。 */
    for (let k = 90; k <= 110; k += 5) {
      rows.push({ asof: '2026-07-29', expiry: '2026-08-13', strike: k,
        call_oi: k === 110 ? 9000 : 600, put_oi: k === 110 ? 9000 : 600 });
    }
    state.options.delete('AS-US');
    ingestOptions(rows, 'AS-US Options.csv');
    const pick = W => W ? {
      exps: W.expiries.map(e => e.expiry).sort(),
      strikes: [...new Set(W.walls.map(w => w.strike))].sort((a, b) => a - b),
      oi: W.walls.reduce((s, w) => s + w.oi, 0),
    } : null;
    return {
      rows: state.options.get('AS-US').length,
      before: pick(optionWalls(state.companies.get('AS-US'), '2026-07-28', 21)),
      onDay: pick(optionWalls(state.companies.get('AS-US'), '2026-07-29', 21)),
      deep: pick(optionWalls(state.companies.get('AS-US'), '2026-06-30', 21)),
      early: pick(optionWalls(state.companies.get('AS-US'), '2026-06-14', 21)),
    };
  });
  ok('两份快照都入了库(不同到期日,不会被 asof 去重吃掉)', AS.rows === 10, String(AS.rows));
  ok('as-of 闸门:回放到 2026-07-28,只看得见 06-15 那份快照,07-29 才登记的 OI 一行都进不来',
    AS.before !== null && AS.before.exps.join(',') === '2026-08-07'
    && AS.before.strikes.join(',') === '95',
    JSON.stringify(AS.before));
  ok('as-of 闸门是单变量的:同一条链只把参照日往后挪一天,110 那面墙才出现(差的就是这一行闸门)',
    AS.onDay !== null && AS.onDay.exps.join(',') === '2026-08-07,2026-08-13'
    && AS.onDay.strikes.join(',') === '95,110'
    && AS.onDay.oi > AS.before.oi,
    JSON.stringify([AS.before, AS.onDay]));
  ok('判据是 asof > refISO 不是 >=:参照日**当天**拍的快照是当天就存在的存量,照常算数',
    AS.onDay.strikes.includes(110), JSON.stringify(AS.onDay));
  ok('回放到更早的 2026-06-30 仍然只看得见老快照(闸门不是只挡住相邻一天)',
    AS.deep !== null && AS.deep.exps.join(',') === '2026-08-07' && AS.deep.strikes.join(',') === '95',
    JSON.stringify(AS.deep));
  /* 2026-06-14 这个日子是挑过的:两个到期日的 dte 分别是 54 / 60,都还**没有**越过
   * PX_OPT_MAX_DTE=60 —— 所以这里的 null 只能是 as-of 闸门造成的,不是远月闸门顺手挡掉的。
   * 差一天(比如挑 06-13)这条断言就会退化成在验 MAX_DTE,验的东西和名字对不上。 */
  ok('回放到两份快照都还没拍下的日子,一面墙都报不出来(宁可没有,不许借未来的 OI)',
    AS.early === null, JSON.stringify(AS.early));

  /* ---------- 行权价窗口的中心必须是 as-of 那天的价 ----------
   * 这条修复此前也没有覆盖。构造:价格在 2026-07-01 从 100 跳到 200,co.price 恒为 200(今天的价),
   * 行权价全部铺在 85~115。以 as-of 价 100 为心,±25% = 75~125,整条链在窗口内;
   * 以 co.price 200 为心,±25% = 150~250,整条链在窗口外 —— 两种写法给出的是"有墙"和"没有墙"。 */
  const WC = await page.evaluate(() => {
    const px = [];
    for (let i = 0; i < 320; i++) {
      const date = new Date(Date.UTC(2025, 9, 1) + i * 86400000).toISOString().slice(0, 10);
      px.push({ date, price: date <= '2026-06-30' ? 100 : 200, vol: 1e6 });
    }
    state.companies.set('WC-US', { ticker: 'WC-US', name: 'WC', currency: 'USD', price: 200, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    state.priceHist.set('WC-US', px);
    const rows = [];
    for (let k = 85; k <= 115; k += 5) {
      rows.push({ asof: '2026-06-15', expiry: '2026-08-14', strike: k,
        call_oi: k === 105 ? 9000 : 600, put_oi: k === 105 ? 9000 : 600 });
    }
    state.options.delete('WC-US');
    ingestOptions(rows, 'WC-US Options.csv');
    const co = state.companies.get('WC-US');
    const old = optionWalls(co, '2026-06-30', 21);
    return {
      pxAsOf: asOfPrice('WC-US', '2026-06-30', co.price),
      pxNull: asOfPrice('WC-US', null, co.price),
      oldStrikes: old ? [...new Set(old.walls.map(w => w.strike))].sort((a, b) => a - b) : null,
      after: optionWalls(co, '2026-08-01', 21),
    };
  });
  ok('asOfPrice 交出的是 as-of 那天的收盘价,refISO 为空才退回 co.price',
    WC.pxAsOf === 100 && WC.pxNull === 200, JSON.stringify([WC.pxAsOf, WC.pxNull]));
  ok('行权价窗口以 as-of 价为心:回放到价格还是 100 的那天,85~115 的链落在 ±25% 内,墙报得出来',
    WC.oldStrikes !== null && WC.oldStrikes.join(',') === '105', JSON.stringify(WC.oldStrikes));
  ok('同一条链在价格已经翻倍的日子整条落到窗口外 → null(证明窗口真的跟着 as-of 价走,不是跟着 co.price)',
    WC.after === null, JSON.stringify(WC.after));

  /* 网格链:现价 150,窗口 ±25% = 112.5 ~ 187.5,150 / 163 / 175 都落在里面。
   * H2 组按这个标记分层,标记漂一次那一组的结论就整个作废,所以直接函数级 + 端到端各钉一遍。 */
  const G = await page.evaluate(() => {
    state.companies.set('G-US', { ticker: 'G-US', name: 'G', currency: 'USD', price: 150, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    const rows = [];
    for (const k of [115, 120, 125, 130, 135, 140, 145, 150, 155, 160, 163, 165, 170, 175, 180, 185]) {
      const oi = k === 150 ? 30000 : k === 163 ? 25000 : k === 175 ? 20000 : 800;
      rows.push({ asof: '2026-07-29', expiry: '2026-08-21', strike: k,
        call_oi: k > 150 ? Math.round(oi * 0.8) : Math.round(oi * 0.2),
        put_oi: k < 150 ? Math.round(oi * 0.8) : Math.round(oi * 0.2) });
    }
    state.options.delete('G-US'); ingestOptions(rows, 'G-US Options.csv');
    const W = optionWalls(state.companies.get('G-US'), '2026-07-29', 21);
    const m = s => { const g = optGridMark(s); return [g.isGrid50, g.isGrid25]; };
    return {
      walls: W.walls.map(w => [w.strike, w.isGrid50, w.isGrid25]), evidence: W.evidence,
      mark: { 150: m(150), 175: m(175), 163: m(163), 100: m(100), 125: m(125), 152.5: m(152.5), nan: m(NaN) },
    };
  });
  ok('x50 网格标记正确:150 是 isGrid50,175 是 isGrid25,163 两者皆非',
    G.mark['150'].join() === 'true,false' && G.mark['175'].join() === 'false,true'
    && G.mark['163'].join() === 'false,false'
    && G.walls.find(w => w[0] === 150).slice(1).join() === 'true,false'
    && G.walls.find(w => w[0] === 175).slice(1).join() === 'false,true'
    && G.walls.find(w => w[0] === 163).slice(1).join() === 'false,false',
    JSON.stringify(G));
  ok('整五十优先于整二十五(150 只标 isGrid50,不同时标 isGrid25)',
    G.mark['100'].join() === 'true,false' && G.mark['125'].join() === 'false,true',
    JSON.stringify(G.mark));
  ok('半档行权价 152.5 与非法输入都不标网格(用整数分取模,不靠浮点)',
    G.mark['152.5'].join() === 'false,false' && G.mark.nan.join() === 'false,false',
    JSON.stringify(G.mark));

  /* 零 OI 行不该进均值的分母。刮屏时代看到的只有价平附近那二十来行,均值天然偏高;
   * 真导出把整条链都给了,一大半行权价 OI 是 0,分母一涨 `avg × 1.5` 这道门槛就形同虚设。
   * 下面这条链**每个有人参与的行权价 OI 完全相同**——没有任何一个价位突出,正确答案是"一面墙都没有"。
   * 旧算法在这里会因为分母被零行稀释,把其中随便四个判成"墙"。 */
  const Z = await page.evaluate(() => {
    state.companies.set('Z-US', { ticker: 'Z-US', name: 'Z', currency: 'USD', price: 108, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    const rows = [];
    for (let k = 60; k <= 150; k += 2) {
      const live = k % 10 === 0;                     // 五个里只有一个有人参与,其余整条链都是 0
      rows.push({ asof: '2026-07-29', expiry: '2026-08-21', strike: k,
        call_oi: live ? 1200 : 0, put_oi: live ? 1200 : 0 });
    }
    state.options.delete('Z-US');
    ingestOptions(rows, 'Z-US Options.csv');
    const W = optionWalls(state.companies.get('Z-US'), '2026-07-29', 21);
    return { walls: W ? W.walls.length : -1, nExp: W ? W.expiries.length : -1,
      nStrike: W ? W.expiries[0].nStrike : -1, evidence: W ? W.evidence : null };
  });
  ok('均值分母只含有参与的行权价(零 OI 行不进分母)',
    Z.walls === 0 && Z.nExp === 1 && Z.nStrike === 5, JSON.stringify(Z));
  ok('零 OI 行不计入 nStrike(只数真有人参与的那些)', Z.nStrike === 5, JSON.stringify(Z));
  ok('一面墙都没有时 evidence 仍是 pending(不因为没内容就升级或降级)',
    Z.evidence === 'pending' && G.evidence === 'pending', JSON.stringify([Z.evidence, G.evidence]));
});

/* ---------- [11] 拉取清单:清单外的公司隐藏但不丢 ---------- */
await section('[11] 拉取清单(roster.csv)', async () =>
{
  const R = await page.evaluate(() => {
    const mk = tk => ({ ticker: tk, name: tk, currency: 'USD', price: 100, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    state.companies.clear(); state.history.clear(); state.options.clear();
    for (const tk of ['AAA-US', 'BBB-US', 'CCC-US']) state.companies.set(tk, mk(tk));
    state.roster = null; state.showOffRoster = false;
    const noRoster = visibleCompanies().length;              // 没有清单 → 不过滤

    /* 真走一遍 CSV:表头识别、# 注释行、市场序列不算公司,三件事一起验 */
    const csv = 'ticker,role,active\nAAA-US,company,1\nBBB-US,company,1\n'
      + 'SPY-US,bench,1\n# 这份文件由 fetcher 自动生成 —— 请改 tickers.txt\n';
    const got = ingestRoster(parseCSV(csv));

    const vis = visibleCompanies().map(c => c.ticker).sort().join(',');
    const hidden = offRosterCount();
    state.showOffRoster = true;
    const visOpen = visibleCompanies().length;
    state.showOffRoster = false;

    /* 清单和数据完全对不上:宁可全显示,也不要交出一张空表格 */
    state.roster = new Set(['ZZZ-US']);
    const orphanAll = { vis: visibleCompanies().length, hidden: offRosterCount() };

    /* 选中的那家被藏起来时,renderAll 要改选一家画得出来的 */
    state.roster = new Set(['AAA-US']); state.selected = 'CCC-US';
    renderAll();
    const reselected = state.selected;
    const line = document.querySelector('#ovTableWrap .offroster');
    const lineText = line ? line.textContent : '';
    const rowCount = document.querySelectorAll('#ovTableWrap table.ov tbody tr').length;
    const optCount = document.querySelectorAll('#coSel option').length;
    /* 数据本身一行都没少 —— 隐藏只是不画 */
    const stillLoaded = state.companies.size;
    state.roster = null; state.showOffRoster = false;
    return { noRoster, got, vis, hidden, visOpen, orphanAll, reselected, lineText, rowCount, optCount, stillLoaded };
  });
  ok('没有 roster.csv 时一个都不过滤(旧 Assets 文件夹、演示数据照常全显示)', R.noRoster === 3, String(R.noRoster));
  ok('按表头 ticker/role/active 认出拉取清单', R.got && R.got.n === 2, JSON.stringify(R.got));
  ok('末尾的 # 说明行不会变成一家公司', R.vis === 'AAA-US,BBB-US', R.vis);
  ok('市场级序列(bench)不算公司,不进过滤集合', R.got && R.got.markets === 1, JSON.stringify(R.got));
  ok('清单外的算作"已隐藏 N 家"', R.hidden === 1, String(R.hidden));
  ok('开关打开后全部显示', R.visOpen === 3, String(R.visOpen));
  ok('清单与数据完全对不上时不过滤(空表格看起来就像 app 坏了)',
    R.orphanAll.vis === 3 && R.orphanAll.hidden === 0, JSON.stringify(R.orphanAll));
  ok('选中的公司被隐藏时自动改选画得出来的那家', R.reselected === 'AAA-US', R.reselected);
  ok('表格只画清单内的公司', R.rowCount === 1, String(R.rowCount));
  ok('详情下拉也只列清单内的公司', R.optCount === 1, String(R.optCount));
  ok('表格下方给出可点开的隐藏提示', /不在拉取清单里/.test(R.lineText), R.lineText);
  ok('隐藏不删数据:state.companies 一行都没少', R.stillLoaded === 3, String(R.stillLoaded));
});

/* ---------- [12] 财年判定:Estimate History 跟的是第几个财年 ----------
 * 钉的是一次真实事故:2026-07-27 那两轮抓错财年,存下一批 *FY3* 文件,
 * 老代码只问"文件名里有没有 FY2",答否就当 FY1 —— Jan '29E 的 P/E 分位
 * 配上了 Jan '27E 的 EPS,NVDA 中枢从 +11.9% 翻成 -16.5%。全程不报错。 */
await section('[12] 财年判定与口径护栏', async () =>
{
  const R = await page.evaluate(() => {
    /* 造一份和 FactSet 导出同构的 aoa:A1=代码,第二行右边写财年末,第三行列名 */
    const sheet = (fyLabel, rows) => [
      ['NVDA-US'],
      ['Estimate History', 'FactSet Estimate History ' + fyLabel + " | 2026-07-30 01:21Z"],
      ['Date', 'Mean', 'Sharp Cons', 'Num of Est', 'Num Up', 'Num Down', 'Low', 'High', 'Std Dev', 'Chg (%)', 'Chg Amt', 'P/E (x)', 'PEG (x)'],
      ...rows,
    ];
    /* 逐月倒序(FactSet 就是新的在上),从 2026-07 往回数,给足 24 个点让分位库成立。
     * 最新那一行的 P/E 正好等于 pe —— 后面靠它认出"分位库到底是谁写的"。 */
    const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const months = (n, mean, pe) => Array.from({ length: n }, (_, i) => {
      const tot = 2026 * 12 + 7 - 1 - i, y = Math.floor(tot / 12), mm = tot % 12;
      return ['28 ' + MN[mm] + " '" + String(y % 100), String(mean), '-', '47', '35', '1',
        String(mean * 0.9), String(mean * 1.1), '0.3', '0.3', '0.02', String(pe + i * 0.1), '0.6'];
    });
    const newestPe = tk => { const h = state.history.get(tk) || []; return h.length ? h[h.length - 1].pe : NaN; };
    const reset = () => { state.companies.clear(); state.history.clear(); state.priceHist.clear(); state.overrides.clear(); };

    /* 文件名说 FY3,表里说 Jan '27E —— 认表不认文件名 */
    reset();
    ingestEstimateSheet('NVDA-US', sheet("Jan '27E", months(24, 9, 21)), "NVDA-US FY3 Estimate History.xlsx");
    const labelWins = { eps: state.companies.get('NVDA-US').eps.fy1.mean, pe: (state.history.get('NVDA-US') || []).length };

    /* 真正的 FY3(Jan '29E):EPS 不收,分位库不收 */
    reset();
    ingestEstimateSheet('NVDA-US', sheet("Jan '29E", months(24, 15.23, 12.9)), "NVDA-US FY1 Estimate History.xlsx");
    const far = { eps: state.companies.get('NVDA-US').eps.fy1.mean, pe: (state.history.get('NVDA-US') || []).length,
                  rev: !!state.companies.get('NVDA-US').rev, px: (state.priceHist.get('NVDA-US') || []).length };

    /* FY1 先进,FY3 后进:FY3 一个字也改不动 */
    reset();
    ingestEstimateSheet('NVDA-US', sheet("Jan '27E", months(24, 9, 21)), 'a.xlsx');
    ingestEstimateSheet('NVDA-US', sheet("Jan '29E", months(24, 15.23, 12.9)), 'b.xlsx');
    const mixA = { eps: state.companies.get('NVDA-US').eps.fy1.mean, cur: newestPe('NVDA-US') };
    /* 反过来:FY3 先进 —— 这正是事故当天的载入顺序,分位库当时被 FY3 占住了 */
    reset();
    ingestEstimateSheet('NVDA-US', sheet("Jan '29E", months(24, 15.23, 12.9)), 'b.xlsx');
    ingestEstimateSheet('NVDA-US', sheet("Jan '27E", months(24, 9, 21)), 'a.xlsx');
    const mixB = { eps: state.companies.get('NVDA-US').eps.fy1.mean, cur: newestPe('NVDA-US') };

    /* FY2(Jan '28E)照旧:进 fy2 槽,不进分位库 */
    reset();
    ingestEstimateSheet('NVDA-US', sheet("Jan '28E", months(24, 12.75, 15.3)), 'x.xlsx');
    const fy2 = { fy1: state.companies.get('NVDA-US').eps.fy1.mean, fy2: state.companies.get('NVDA-US').eps.fy2.mean,
                  pe: (state.history.get('NVDA-US') || []).length };

    /* 读不到财年标签时才回头信文件名 */
    reset();
    ingestEstimateSheet('NVDA-US', sheet('(无标签)', months(24, 15.23, 12.9)), "NVDA-US FY3 Estimate History.xlsx");
    const fallback = (state.history.get('NVDA-US') || []).length;

    /* 尾部有日期但 Mean 为空:跳过坏行，不得覆盖上一条有效 EPS，也不得半提交后抛错。 */
    reset();
    const malformedRows = months(24, 9, 21);
    malformedRows.unshift(["29 Jul '26", '', '-', '47', '35', '1', '', '', '', '', '', '22', '']);
    let malformedThrow = null;
    try { ingestEstimateSheet('NVDA-US', sheet("Jan '27E", malformedRows), 'bad-tail.xlsx'); }
    catch (e) { malformedThrow = e.message; }
    const malformed = { threw: malformedThrow, eps: state.companies.get('NVDA-US').eps.fy1.mean,
      current: newestPe('NVDA-US') };
    reset();
    const duplicateRows = months(24, 9, 21);
    duplicateRows.unshift(["28 Jul '26", '10', '-', '50', '2', '9', '9', '11', '', '', '', '22', '']);
    ingestEstimateSheet('NVDA-US', sheet("Jan '27E", duplicateRows), 'duplicate.xlsx');
    const duplicate = { histN: state.history.get('NVDA-US').length,
      eps: state.companies.get('NVDA-US').eps.fy1.mean, rev: state.companies.get('NVDA-US').rev };

    /* 口径护栏:分位库最新点 × 基准 EPS 与现价差 >25% 就报警 */
    reset();
    const co = { ticker: 'NVDA-US', name: 'NVDA-US', currency: 'USD', price: 195.04,
      eps: { fy1: { low: 8.2, mean: 9, high: 9.85 }, fy2: null }, extra: null };
    state.companies.set('NVDA-US', co); state.selected = 'NVDA-US'; state.horizon = 'fy1';
    /* 序列按时间升序,最后一点(= peStats 的 current)正好是 n */
    const band = n => Array.from({ length: 24 }, (_, i) => ({ date: '2025-' + String(i % 12 + 1).padStart(2, '0') + '-01', pe: n + (23 - i) * 0.1 }));
    state.history.set('NVDA-US', band(12.9));                     // FY3 口径:12.9 × 9 = 116 ≠ 195
    const bad = calcRange(co, 'fy1').baseGap;
    state.history.set('NVDA-US', band(21.1));                     // FY1 口径:21.1 × 9 = 190 ≈ 195
    const good = calcRange(co, 'fy1').baseGap;
    renderAll();
    const warned = /不是同一个口径|different bases/.test(($('mxWrap') || {}).textContent || '');
    state.history.set('NVDA-US', band(12.9)); renderAll();
    const warnedBad = /不是同一个口径|different bases/.test(($('mxWrap') || {}).textContent || '');
    reset(); state.selected = null; renderAll();

    return { labelWins, far, mixA, mixB, fy2, fallback, malformed, duplicate, bad, good, warned, warnedBad };
  });
  ok('认表里的财年标签,不认文件名(文件名写 FY3、表里是 Jan \'27E → 当 FY1)',
    R.labelWins.eps === 9 && R.labelWins.pe === 24, JSON.stringify(R.labelWins));
  ok('真正的第三财年:EPS 不进 fy1 槽(三年后的盈利乘不上明年的估值分位)',
    !isFinite(R.far.eps), JSON.stringify(R.far));
  ok('真正的第三财年:P/E 分位库一个点都不收', R.far.pe === 0, String(R.far.pe));
  ok('真正的第三财年:修正动量也不收(上调下调家数是 FY1 的方向信号)', R.far.rev === false, String(R.far.rev));
  ok('第三财年仍借出价格序列(还原的是同一支股票的股价,与财年无关)', R.far.px === 24, String(R.far.px));
  ok('FY1 先进、FY3 后进:分位库仍是 FY1 的', R.mixA.eps === 9 && R.mixA.cur === 21, JSON.stringify(R.mixA));
  ok('FY3 先进、FY1 后进:分位库照样是 FY1 的 —— 这一条正是当初翻车的顺序',
    R.mixB.eps === 9 && R.mixB.cur === 21, JSON.stringify(R.mixB));
  ok('FY2 进第二财年槽,且不污染 P/E 分位库',
    !isFinite(R.fy2.fy1) && R.fy2.fy2 === 12.75 && R.fy2.pe === 0, JSON.stringify(R.fy2));
  ok('读不到财年标签才回头信文件名(FY3 → 仍然不收分位)', R.fallback === 0, String(R.fallback));
  ok('Estimate History 的空 Mean 尾行被原子跳过,不会污染 EPS 或抛错',
    R.malformed.threw === null && R.malformed.eps === 9 && R.malformed.current === 21, JSON.stringify(R.malformed));
  ok('Estimate 同日修订整条覆盖,EPS/PE/rev 来自同一个末版本',
    R.duplicate.histN === 24 && R.duplicate.eps === 9 && R.duplicate.rev.n === 47
      && R.duplicate.rev.up === 35 && R.duplicate.rev.down === 1, JSON.stringify(R.duplicate));
  ok('口径护栏:12.9x × 9.00 = 116 与现价 195 差 40% → 报警',
    R.bad && Math.abs(R.bad.dev + 40.5) < 1, JSON.stringify(R.bad));
  ok('口径护栏:21.1x × 9.00 = 190 与现价 195 差 2.6% → 不报警', R.good === null, JSON.stringify(R.good));
  ok('口径不一致时卡片上真的写出来了(护栏只在控制台响等于没响)', R.warnedBad === true && R.warned === false,
    JSON.stringify({ warned: R.warned, warnedBad: R.warnedBad }));
});

/* ---------- [13] 买入模拟:解析器 · 未来函数 · 成本 · 面板不撒谎 ----------
 * 这一节里最值钱的是第 3 条(未来函数)和第 1 条(不许 eval)。其余六条防的是
 * "面板上那个数看起来像结论、其实是别的东西"。
 * fixture 沿用 [7] 的 GBM(seed 20260806,同一条 LCG),理由同 [7]:它像真的股价,
 * 且逐位可复现。**不许为了让某条断言变绿去动它的几何,更不许动 params.js。** */
await section('[13] 买入模拟(规则解析 / 回放 / 面板)', async () =>
{
  const F = await page.evaluate(() => {
    /* 与 [7] 完全同款的 GBM,只是长度给到 420 根:回放要热身 SIM_WARM=120 根,
     * 再扣掉持有期,短于这个数就只剩几十根可扫,任何统计都变成噪声。 */
    const mk = (tk, n) => {
      const start = Date.UTC(2024, 6, 1);
      let seed = 20260806;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
      const px = []; let p = 100;
      for (let i = 0; i < n; i++) {
        p *= Math.exp(0.018 * gauss() - 0.00016);
        px.push({ date: new Date(start + i * 86400000).toISOString().slice(0, 10), price: +p.toFixed(2), vol: 1e6 * (1 + 0.5 * Math.sin(i / 5)) });
      }
      state.companies.set(tk, { ticker: tk, name: tk, currency: 'USD', price: px[px.length - 1].price,
        priceSrc: 'user', eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
      state.priceHist.set(tk, px);
      state.history.set(tk, [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]
        .map((pe, i) => ({ date: '20' + (10 + i) + '-01', pe })));
      return px;
    };
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    const px = mk('SIM-US', 420);
    state.selected = 'SIM-US'; state.horizon = 'fy1';

    /* ---- (1) 解析器:凡是"谓词(数字,…)用 and 连"以外的东西一律拒 ---- */
    const evil = [
      'eval("1")', 'new Function("1")()', 'window.alert(1)', '1+1', 'nearSupport(0.5) or nearSupport(0.5)',
      'nearSupport(0.5); alert(1)', '(nearSupport(0.5))', 'not nearSupport(0.5)', 'foo(1)',
      'nearSupport(`x`)', 'nearSupport(0.5)&&1', 'constructor', '__proto__', 'nearSupport',
      'nearSupport(', 'nearSupport(0.5,0.5)' /* 多给一个参数也算看不懂:多的会被无声丢掉 */,
    ];
    const rejected = evil.filter(s => parseRule(s).ok === false);
    const legit = ['nearSupport(0.5)', 'nearSupport(0.5) and reachBelow(0.4)', 'breakResistance()',
      'pullbackPct(20,0.08)', 'maCross(20,60) and nearSupport(1)'].every(s => parseRule(s).ok === true);
    /* 源码层面再钉一次:sim/* 两个文件里不许出现 eval / new Function / setTimeout(字符串) */
    const src = document.documentElement.innerHTML;
    const simSrc = src.slice(src.indexOf('function simArg('), src.indexOf('function renderSim('));
    const noEval = simSrc.indexOf('eval(') < 0 && simSrc.indexOf('new Function') < 0 && simSrc.indexOf('Function(') < 0;

    /* ---- (2) 解析失败不抛:含空串、超长噪声、纯符号 ---- */
    let threw = null, allShaped = true;
    const junk = ['', '   ', 'nearSupport(', 'foo(1)', '1+1', 'nearSupport(0.5) or x',
      'x'.repeat(200), '((((', ',,,,', '中文', '0.5', 'and', 'and and'];
    const errs = [];
    for (const s of junk) {
      try {
        const r = parseRule(s);
        errs.push({ in: s.length > 24 ? s.slice(0, 24) + '…' : s, ok: r.ok, at: r.at, err: r.error });
        if (r.ok !== false || r.error !== 'simRuleErr' || typeof r.at !== 'string') allShaped = false;
      } catch (e) { threw = s + ' → ' + e.message; }
    }

    /* ---- (3) 未来函数:把序列尾部换成完全不同的价格,前半段的交易必须逐条不变 ---- */
    const rule = parseRule('nearSupport(0.8)').rule;
    const HOLD = PX_HORIZONS.short;
    const key = t => t.entryDate + '|' + t.entryPx + '|' + t.exitDate + '|' + t.exitPx + '|' + t.retPct.toFixed(6) + '|' + t.maePct.toFixed(6);
    const A = simRun('SIM-US', rule, HOLD, {});
    const CUT = px.length - 80;                      /* 篡改区 = 最后 80 根,远宽于 hold=5 */
    const mut = px.map((d, i) => i < CUT ? d : { date: d.date, price: +(d.price * 3 + 47).toFixed(2), vol: d.vol });
    state.priceHist.set('SIM-US', mut);
    const B = simRun('SIM-US', rule, HOLD, {});
    state.priceHist.set('SIM-US', px);               /* 立刻换回来,后面的断言用原序列 */
    const keepA = A.trades.filter(x => x.exitI < CUT).map(key);
    const keepB = B.trades.filter(x => x.exitI < CUT).map(key);
    const lookahead = { nA: A.trades.length, nB: B.trades.length, kA: keepA.length, kB: keepB.length,
      same: keepA.length > 0 && keepA.length === keepB.length && keepA.every((v, i) => v === keepB[i]) };

    /* ---- (4) 同一规则同一票跑两次:trades 与对照都必须逐条相同 ---- */
    const C = simRun('SIM-US', rule, HOLD, {});
    const det = {
      trades: A.trades.length === C.trades.length && A.trades.every((x, i) => key(x) === key(C.trades[i])),
      seed: A.seed === C.seed,
      ctrl: A.ctrl.trades.length === C.ctrl.trades.length && A.ctrl.trades.every((x, i) => key(x) === key(C.ctrl.trades[i])),
      ctrlN: A.ctrl.trades.length,
      /* 规则文本不同 → 种子必须不同,否则"对照跟着规则走"这句话是假的 */
      seedVaries: simHash('SIM-US|nearSupport(0.8)') !== simHash('SIM-US|nearSupport(0.5)'),
    };

    /* ---- (6) maxDD 是权益曲线的回撤,不是最大单笔亏损 ---- */
    const mkT = rets => rets.map((v, i) => ({ retPct: v, maePct: Math.min(0, v), mfePct: Math.max(0, v), entryI: i * 10, exitI: i * 10 + 1 }));
    const ddLiteral = simStats(mkT([-10, 5, -10])).maxDD;   /* 断言名里那三笔的字面顺序 */
    const ddTwoLegs = simStats(mkT([5, -10, -10])).maxDD;   /* 两条 -10% 复利叠在同一个峰值之下 */
    const ddOne = simStats(mkT([-10])).maxDD;

    /* ---- (7) 成本真的被扣掉 ---- */
    const Z = simRun('SIM-US', rule, HOLD, { costBps: 0 });
    const T = simRun('SIM-US', rule, HOLD, { costBps: 10 });
    const cost = { n: Z.n, d: Z.avgRet - T.avgRet, perTrade: Z.trades.length && (Z.trades[0].retPct - T.trades[0].retPct) };
    const custom = simRun('SIM-US', rule, HOLD, { costBps: 37, warm: 180 });
    const ctrlOpts = { cost: custom.ctrl.trades.length ? ((px[custom.ctrl.trades[0].exitI].price / px[custom.ctrl.trades[0].entryI].price - 1) * 100
      - custom.ctrl.trades[0].retPct) : NaN,
      earliest: custom.ctrl.trades.length ? Math.min(...custom.ctrl.trades.map(x => x.entryI)) : NaN,
      n: custom.ctrl.n, effN: custom.ctrl.effN, targetN: custom.n,
      nonOverlap: custom.ctrl.trades.every((x, i, a) => !i || x.entryI > a[i - 1].exitI) };
    const za = simStats([
      { retPct: 10, maePct: 0, mfePct: 10, entryI: 1, exitI: 10 },
      { retPct: -10, maePct: -10, mfePct: 0, entryI: 2, exitI: 3 },
      { retPct: -10, maePct: -10, mfePct: 0, entryI: 11, exitI: 12 },
    ]);
    const zb = simStats([
      { retPct: -10, maePct: -10, mfePct: 0, entryI: 1, exitI: 2 },
      { retPct: 10, maePct: 0, mfePct: 10, entryI: 3, exitI: 4 },
    ]);
    const effZ = { effN: za.effN, effWin: za.effWin, z: simZ(za, zb) };

    /* ---- (5)(8) 面板:先跑一次真实的,数表格行数;再喂一组 3 笔的薄样本看胜率有没有藏住 ---- */
    state.simPref.hold = 'short'; state.simPref.presetId = 'custom'; state.simPref.custom = 'nearSupport(0.8)';
    renderSim(state.companies.get('SIM-US'));
    simGo();
    const rows = document.querySelectorAll('#simTrig table.mx.sim tr').length - 1;   /* 减表头 */
    const full = { rows, n: simLast.result.n, tiles: document.querySelectorAll('#simOut .tile').length,
      hasWin: document.getElementById('simOut').textContent.indexOf(t('simWin')) >= 0,
      hasCtrl: /\d/.test(document.querySelector('#simOut .simctrl') ? document.querySelector('#simOut .simctrl').textContent : ''),
      /* 分页/折叠控件一个都不许有 */
      noPager: !document.querySelector('#simTrig button') && !document.querySelector('#simTrig details'),
      /* 处理组 / 对照 / 区间三个数的实际渲染字号字重。取 computed style 而不是读样式表:
       * 样式表里写对了、被别处的选择器盖掉,读源码是看不出来的。 */
      typo: (() => {
        const q = s => document.querySelector(s);
        const vl = q('#simOut .tile.simwin .vl'), ct = q('#simOut .simctrl'), ci = q('#simOut .simci');
        const cs = n => { const s = getComputedStyle(n); return s.fontSize + '/' + s.fontWeight + '/' + s.color; };
        return { has: !!(vl && ct && ci), vl: vl && cs(vl), ctrl: ct && cs(ct), ci: ci && cs(ci),
          /* 邻格(平均收益)仍是 21px 的展示号,拿它当对照证明本条测的是"降下来了",
           * 而不是碰巧整排格子都被改小了 */
          other: (() => { const o = [...document.querySelectorAll('#simOut .tile')].find(d => !d.classList.contains('simwin'));
            const v = o && o.querySelector('.vl'); return v && getComputedStyle(v).fontSize; })() };
      })() };

    const thin3 = simLast.result.trades.slice(0, 3);
    simLast = { ticker: 'SIM-US', ruleText: 'nearSupport(0.8)', rule, presetId: 'custom', hold: 'short', at: Date.now(),
      result: Object.assign(simStats(thin3), { trades: thin3, ctrl: simStats([]), z: NaN, warn: ['thin'],
        hold: HOLD, horizon: 'short', ruleText: 'nearSupport(0.8)', seed: 1, costBps: 10, scanned: 100,
        from: px[0].date, to: px[px.length - 1].date }) };
    simPaint(state.companies.get('SIM-US'));
    const thin = { txt: document.getElementById('simOut').textContent,
      trigTxt: document.getElementById('simTrig').textContent,
      tiles: document.querySelectorAll('#simOut .tile').length,
      rows: document.querySelectorAll('#simTrig table.mx.sim tr').length - 1,
      minTrig: SIM_MIN_TRIG };

    return { rejected: rejected.length, evil: evil.length, legit, noEval, threw, allShaped, errs,
      lookahead, det, ddLiteral, ddTwoLegs, ddOne, cost, ctrlOpts, effZ, full, thin };
  });

  ok('规则解析器拒绝任何含括号函数调用以外的内容(不许 eval)',
    F.rejected === F.evil && F.legit && F.noEval,
    JSON.stringify({ rejected: F.rejected, of: F.evil, legit: F.legit, noEval: F.noEval }));
  ok('解析失败返回 {ok:false},不抛异常(输入框不能把页面搞挂)',
    F.threw === null && F.allShaped, F.threw || JSON.stringify(F.errs));
  ok('谓词只能读 ctx.i 及之前的价格 —— 喂一段结尾被篡改的序列,结果不变',
    F.lookahead.same, JSON.stringify(F.lookahead));
  ok('同一规则同一票跑两次,trades 数组逐条相同(随机对照种子固定)',
    F.det.trades && F.det.seed && F.det.ctrl && F.det.ctrlN > 0 && F.det.seedVaries, JSON.stringify(F.det));
  ok('触发次数 < SIM_MIN_TRIG 时不显示胜率,只列时点',
    F.thin.tiles === 1 && F.thin.txt.indexOf('%') < 0 && F.thin.rows === 3 && /只触发了/.test(F.thin.trigTxt),
    JSON.stringify({ tiles: F.thin.tiles, rows: F.thin.rows, txt: F.thin.txt.slice(0, 80) }));
  /* ---- 断言名照 SPEC 3.7 逐字抄,但那个 -19% 与它自己给的序列对不上,两个数都钉住 ----
   * SPEC 的定义是"把每一笔按时间顺序接成权益曲线后的最大回撤"。按这个定义:
   *   字面序列 [-10, +5, -10] → 0.9 / 0.945 / 0.8505,峰值 1 → maxDD = **-14.95%**;
   *   -19.0% 是**两条 -10% 落在同一个峰值之下**的结果(0.9×0.9 = 0.81,或 [+5,-10,-10] 的 0.8505/1.05)。
   * 也就是说断言名里的 -19% 对应的是 [+5,-10,-10] 这个顺序,不是它写的那个顺序。
   * 规格不许改,所以这里把两个都验:字面序列 = -14.95,两腿版 = -19.0,且都 ≠ -10(那才是要防的事故)。 */
  ok('maxDD 按权益曲线算:两笔 -10%、+5%、-10% 的序列应得 -19%,不是 -10%',
    near(F.ddLiteral, -14.95, 1e-6) && near(F.ddTwoLegs, -19.0, 1e-6) && near(F.ddOne, -10, 1e-9)
    && F.ddLiteral < -10 && F.ddTwoLegs < -10,
    JSON.stringify({ literal: F.ddLiteral, twoLegs: F.ddTwoLegs, single: F.ddOne }));
  ok('成本被真的扣掉:零成本与 10bp 的平均收益差约 0.1%',
    F.cost.n > 0 && near(F.cost.d, 0.1, 1e-9) && near(F.cost.perTrade, 0.1, 1e-9), JSON.stringify(F.cost));
  ok('自定义成本与热身窗口同样传给随机对照',
    near(F.ctrlOpts.cost, 0.37, 1e-9) && F.ctrlOpts.earliest >= 181, JSON.stringify(F.ctrlOpts));
  ok('随机对照从生成时即不重叠,并与策略组保持 n/effN 同频',
    F.ctrlOpts.nonOverlap && F.ctrlOpts.n === F.ctrlOpts.effN && F.ctrlOpts.n === F.ctrlOpts.targetN, JSON.stringify(F.ctrlOpts));
  ok('z 的胜场来自实际非重叠子样本,不是整体胜率乘 effN',
    F.effZ.effN === 2 && F.effZ.effWin === 1 && isFinite(F.effZ.z), JSON.stringify(F.effZ));
  ok('每一次触发都在触发时点表里,一条不漏(不分页不截断)',
    F.full.n > 0 && F.full.rows === F.full.n && F.full.noPager, JSON.stringify(F.full));
  /* 这条以前写成 `F.full.n >= 8 ? (六格 …) : (一格)` —— 一个**按被测数据分叉的三元式**。
   * 夹具跑出来的 n 是 9,离 SIM_MIN_TRIG=8 只差一根柱子:随便哪次改动让触发少一次,
   * 断言会静静地滑到 else 分支,只要求"一格",然后照样打印 PASS。
   * 也就是说它在设计上就没法发现"胜率不再并排显示"这件事,反而会替这件事打掩护。
   * 现在把 n 钉死成 9(夹具是固定种子的 GBM,n 本来就该是常数),漂移直接红 ——
   * 漂移未必是 bug,但它必须由人来看一眼,不能由测试自己降级处理。 */
  ok('胜率旁边并排显示随机对照与 z(不折进 tooltip)',
    F.full.n === 9 && F.full.n >= F.thin.minTrig
    && F.full.tiles === 6 && F.full.hasWin && F.full.hasCtrl,
    JSON.stringify({ n: F.full.n, minTrig: F.thin.minTrig, tiles: F.full.tiles, hasWin: F.full.hasWin, hasCtrl: F.full.hasCtrl }));

  /* ---- 排版本身不许替没有技能的数字说话 ----
   * 上一条只管"对照在不在同一个视野里"。它管不到的是**大小**:对照可以老老实实地
   * 待在格子里,同时被排成 11px 的灰脚注,而处理组是 21px 的近黑主标题。那样一来
   * 「并排」这条规矩在字面上过关了,读者拿走的却仍然只有一个数。
   * 这不是审美问题。supportBuy 的处理组 45.0% 对照 62.5%,z ≈ −0.93,对照自己重抽
   * 200 次的 sd 是 7.9pp —— 被排版捧成结论的那个数,是三个数里最没有内容的一个。
   * 所以这里钉的是关系而不是某个具体数值:三个数的 font-size / font-weight / color
   * 必须逐字相等。谁哪天想让胜率再大一号,得先把对照和区间一起带上来。
   * 两头都验:computed style 证明"渲染出来真的相等",样式表文本证明"它们共用同一条
   * 声明"—— 只验前者,三条各写各的、恰好写成一样,下一次改动就会静默分家。 */
  {
    const T = F.full.typo;
    const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'sim.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = CSS.split('}').map(s => s.split('{')).filter(a => a.length === 2)
      .map(([sel, body]) => ({ sel: sel.trim().replace(/\s+/g, ' '), body: body.trim() }));
    /* 全表里"给 .simctrl 定字号"的声明必须有且只有一条,且那一条同时管着 .vl 和 .simci */
    const sized = rules.filter(r => /\.simctrl|\.simci|\.simwin/.test(r.sel) && /font-size|font-weight/.test(r.body));
    const shared = sized.length === 1 ? sized[0] : null;
    ok('胜率 / 随机对照 / 置信区间三个数同号同重(排版不许把没有技能的数字捧成结论)',
      T.has && T.vl === T.ctrl && T.ctrl === T.ci
      /* 确认这一格确实从 21px 的展示号降了下来,而不是整排格子一起被改小 */
      && T.other === '21px' && T.vl.indexOf('21px/') !== 0
      /* 样式表里三者共用同一条声明,不是三处凑巧写成一样 */
      && !!shared && /\.simwin \.vl/.test(shared.sel) && /\.simctrl/.test(shared.sel) && /\.simci/.test(shared.sel)
      && /font-size/.test(shared.body) && /font-weight/.test(shared.body) && /color/.test(shared.body),
      JSON.stringify({ typo: T, sized: sized.map(r => r.sel) }));
  }
});

await section('[14] 证据分级的对外承诺(词表 × 渲染层)', async () =>
/* PX_EVIDENCE 把每条 claim 标成 verified / pending / descriptive / falsified。
 * 前三档在 [7]/[8] 里已按行为验过;这一节只管**对外承诺**这一面:
 *   1. 标成 falsified 的 claim,面板上必须有一句人话说明它被证伪了 —— 不能只是"这个功能没做";
 *   2. 新加的那批 pl* 词条中英必须真的对齐(不只是键在,值也得非空、类型也得一致);
 *   3. pending 的腿在**源码层面**就走不到百分比格式化 —— 不是运行时碰巧没走到。
 * 第 3 条故意是源码文本检查,别改成运行时断言:运行时只能证明"这次没显示",
 * 证明不了"不存在能显示出来的那条路"。 */
{
  const E = await page.evaluate(() => {
    /* [11] 装过 roster,这里先摘掉,免得过滤逻辑干扰面板 */
    state.roster = null; state.showOffRoster = false;
    /* 与 [7] 同一条 GBM(seed 20260806),换个代号,自带自足 */
    const start = Date.UTC(2024, 6, 1);
    let seed = 20260806;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
    const px = []; let p = 100;
    for (let i = 0; i < 500; i++) {
      p *= Math.exp(0.018 * gauss() - 0.00016);
      px.push({ date: new Date(start + i * 86400000).toISOString().slice(0, 10),
        price: +p.toFixed(2), vol: 1e6 * (1 + 0.5 * Math.sin(i / 5)) });
    }
    state.companies.set('E-US', { ticker: 'E-US', name: 'E', currency: 'USD',
      price: px[px.length - 1].price, priceSrc: 'user',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null });
    state.priceHist.set('E-US', px);
    state.history.set('E-US', [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]
      .map((pe, i) => ({ date: '20' + (10 + i) + '-01', pe })));
    state.selected = 'E-US'; state.horizon = 'fy1'; state.plHold = 'mid';
    const co = state.companies.get('E-US'), r = calcRange(co, 'fy1');
    renderPressure(co, r);

    const norm = s => String(s == null ? '' : s).replace(/\*\*/g, '').replace(/\s+/g, '');
    /* ---- 1. 需要面板出面交代的负面等级 ----
     * 以前只收 'falsified'。bounce 在 2026-08-06 从 falsified 降为 inconclusive
     * (z −0.35 / −0.76,effN 17 / 16,预注册要求 30 —— 样本不够不给人宣告证伪的权利),
     * 只收 falsified 的话这个集合会变成空集,而空集上的 every() 恒真:
     * 这条断言会从"面板必须为 bounce 说一句人话"悄悄变成"什么都不用做",并且照样 PASS。
     * 所以收的是**所有负面等级**:falsified(测过,没有)和 inconclusive(测了,判不出)
     * 都必须在正文里有人替它说话 —— 前者交代结论,后者交代空白,二者都不许只藏在 tooltip 里。 */
    const NEGATIVE = ['falsified', 'inconclusive'];
    const falsified = Object.entries(PX_EVIDENCE).filter(([, v]) => NEGATIVE.includes(v)).map(([k]) => k);
    /* claim 名 → 面板上负责为它说话的那条词条。多一条负面等级而这里没登记,下面的 every 会直接红。 */
    const SPOKESMAN = { bounce: 'plBounceNote' };
    const sayP = [...document.querySelectorAll('#plTable .plsay p')];
    const sayTxt = sayP.map(n => norm(n.textContent));
    /* 同一句话是否也被塞进了某个 title(降级成 tooltip 就等于没说) */
    const titles = [...document.querySelectorAll('#plSec [title]')].map(n => norm(n.getAttribute('title')));
    const said = falsified.map(k => {
      const key = SPOKESMAN[k];
      const want = key ? norm(t(key)) : null;
      const i = want ? sayTxt.indexOf(want) : -1;
      return { claim: k, key, found: i >= 0,
        /* plRich 把 **第一句** 渲染成 <strong>:证伪结论要用正文强调,不能埋在段中 */
        strong: i >= 0 ? sayP[i].querySelector('strong') !== null : false,
        onlyTip: i < 0 && want ? titles.some(x => x.includes(want)) : false,
        zh: key ? String(I18N.zh[key] || '') : '', en: key ? String(I18N.en[key] || '') : '' };
    });
    const evValues = [...new Set(Object.values(PX_EVIDENCE))].sort();
    /* 词表里实际提供文案的档位(中英各取一次,两边不齐时交集会短一档,断言就红) */
    const evGrades = Object.keys(I18N.zh.plEvidence).filter(k => k in I18N.en.plEvidence).sort();
    const evTips = Object.keys(I18N.zh.plEvidenceTip).filter(k => k in I18N.en.plEvidenceTip).sort();

    /* ---- 2. 新增 pl* 词条中英深度对齐 ---- */
    const plKeys = [...new Set([...Object.keys(I18N.zh), ...Object.keys(I18N.en)])].filter(k => /^pl[A-Z]/.test(k)).sort();
    const bad = [];
    for (const k of plKeys) {
      const a = I18N.zh[k], b = I18N.en[k];
      if (a === undefined || b === undefined) { bad.push(k + ':缺一边'); continue; }
      if (typeof a !== typeof b) { bad.push(k + ':类型不一致 ' + typeof a + '/' + typeof b); continue; }
      if (typeof a === 'function') continue;          // 函数词条的调用结果在下面单独试
      if (typeof a === 'string') {
        if (!a.trim() || !b.trim()) bad.push(k + ':空串');
        continue;
      }
      if (a && typeof a === 'object') {
        const ka = Object.keys(a).sort().join(','), kb = Object.keys(b).sort().join(',');
        if (ka !== kb) { bad.push(k + ':子键不齐 ' + ka + ' / ' + kb); continue; }
        for (const s of Object.keys(a)) {
          if (typeof a[s] !== 'string' || typeof b[s] !== 'string') bad.push(k + '.' + s + ':非字符串');
          else if (!a[s].trim() || !b[s].trim()) bad.push(k + '.' + s + ':空串');
        }
        continue;
      }
      bad.push(k + ':未知类型');
    }
    /* 函数词条两边都得真能调、都得吐出非空字符串 */
    const fnKeys = plKeys.filter(k => typeof I18N.zh[k] === 'function');
    for (const k of fnKeys) {
      for (const L of ['zh', 'en']) {
        try {
          const v = I18N[L][k](1, 2, 3, 4, 5);
          if (typeof v !== 'string' || !v.trim()) bad.push(L + '.' + k + '():返回非字符串');
        } catch (e) { bad.push(L + '.' + k + '():抛错 ' + e.message); }
      }
    }
    /* 这一版新加/改写的那批键,一个都不许漏 —— 名字硬写在这里,删掉某条会立刻红 */
    const ADDED = ['plKind', 'plKindTip', 'plDistU', 'plReach', 'plReachTip', 'plTracks', 'plEvidence',
      'plEvidenceTip', 'plEvidenceCol', 'plOptPending', 'plOptPendingTip', 'plNoStrength', 'plBounceNote',
      /* reach 降级后纯技术轨走的那条文案:不登记的话删掉它只会让面板印出「OI 墙 0 面」 */
      'plReachPending', 'plReachPendingTip',
      'plHorizon', 'plHorizonNote', 'plValRef', 'plValRefTip', 'plWall', 'plDte', 'plOptNote'];
    const missAdded = ADDED.filter(k => !(k in I18N.zh) || !(k in I18N.en));
    /* plKind / plKindTip 只剩三轨:multi 那一档随合流打分一起删了,不许悄悄回来 */
    const kinds = { zh: Object.keys(I18N.zh.plKind).sort().join(','), en: Object.keys(I18N.en.plKind).sort().join(','),
      tipZh: Object.keys(I18N.zh.plKindTip).sort().join(','), tipEn: Object.keys(I18N.en.plKindTip).sort().join(',') };
    const gone = ['plStr', 'plMultiTip'].filter(k => (k in I18N.zh) || (k in I18N.en));

    return { falsified, said, evValues, evGrades, evTips, plKeys, bad, missAdded, kinds, gone,
      nSay: sayP.length, hidden: $('plSec').hidden };
  });

  /* 断言名里的"证伪"改成"负面等级":bounce 现在是 inconclusive,不是 falsified,
   * 名字继续写"证伪"就是在测试报告里重复那个刚被撤回的结论。 */
  ok('PX_EVIDENCE 里标 falsified / inconclusive 的 claim,面板上必须有一句正文说明它是什么状况',
    E.hidden === false && E.falsified.length === 1 && E.falsified[0] === 'bounce'
    && E.said.every(s => s.found && s.strong && !s.onlyTip)
    /* 光"有一句话"不够,那句话得真的在讲"测不出",而不是"暂未支持" */
    && E.said.every(s => /不预测|测不出/.test(s.zh) && /do not predict|no track beat/i.test(s.en))
    /* 用到的每一档都得在 plEvidence / plEvidenceTip 词表里有对应文案,
     * 否则等级降下来了徽章却是空的(evValues 以前只被采集、从没被断言过)。 */
    && E.evValues.length > 0 && E.evValues.every(v => E.evGrades.includes(v) && E.evTips.includes(v))
    && E.evValues.includes('inconclusive'),
    JSON.stringify({ negative: E.falsified, evValues: E.evValues,
      said: E.said.map(s => [s.claim, s.key, s.found, s.strong, s.onlyTip]), nSay: E.nSay }));

  /* [6] 那条同名断言只走**顶层**键、且只看"键在不在";这一节补的是它够不到的三件事:
   * 嵌套子表(plKind / plKindTip / plEvidence / plEvidenceTip)的子键、值非空、函数词条两边都得是函数且能调。
   * 名字照抄 SPEC 3.7,靶子换成新增的这批 pl*,免得与 [6] 完全重合成一条空跑。 */
  ok('中英词表键完全对齐(现有 [6] 节断言自动覆盖新增的 30 余条)',
    E.plKeys.length >= 30 && E.bad.length === 0 && E.missAdded.length === 0 && E.gone.length === 0
    && E.kinds.zh === 'opt,tech,val' && E.kinds.en === 'opt,tech,val'
    && E.kinds.tipZh === 'opt,tech,val' && E.kinds.tipEn === 'opt,tech,val',
    JSON.stringify({ n: E.plKeys.length, bad: E.bad, missAdded: E.missAdded, gone: E.gone, kinds: E.kinds }));

  /* ---- 3. 源码文本检查:pending 腿根本没有通向百分比的那条路 ----
   * 运行时断言只能说"这次没渲染出 %";要说"不存在这条代码路径",只能去读源码。
   * 别把它改成运行时检查 —— 那会把这条断言的意义整条抽掉。 */
  {
    const SRC = fs.readFileSync(path.join(ROOT, 'src', 'js', 'render', 'pressure.js'), 'utf8');
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');     // 去掉块注释,只看真代码
    const cnt = (s, n) => s.split(n).length - 1;
    /* 从 `if (L.evidence === 'verified')` 起做花括号配对,切出两个互斥分支 */
    const blk = (s, from) => {
      const i = s.indexOf('{', from);
      let d = 0;
      for (let j = i; j < s.length; j++) {
        if (s[j] === '{') d++;
        else if (s[j] === '}') { d--; if (!d) return [s.slice(i + 1, j), j + 1]; }
      }
      return ['', -1];
    };
    const i0 = code.indexOf("if (L.evidence === 'verified')");
    const [ver, after] = i0 >= 0 ? blk(code, i0) : ['', -1];
    const [pend] = after > 0 ? blk(code, code.indexOf('else', after)) : [''];
    const forbidden = ['plReachPct', '%', 'toFixed', '100', 'pReach'];
    const hit = forbidden.filter(w => pend.includes(w));
    ok('渲染层不存在把 pending 腿格式化成百分数的代码路径(源码文本检查)',
      i0 >= 0 && ver.includes('plReachPct(L.pReach)') && pend.includes("t('plOptPending')")
      && hit.length === 0
      /* 全文件只有一处产出 '%' 字面量,就是 plReachPct 自己;它只被调用一次,就在 verified 分支里 */
      && cnt(code, "'%'") === 1 && cnt(code, 'plReachPct') === 2
      && /function plReachPct\(p\)[^\n]*'%'/.test(code),
      JSON.stringify({ i0, hit, pct: cnt(code, "'%'"), calls: cnt(code, 'plReachPct'),
        pend: pend.trim().slice(0, 120) }));
  }

  /* ---- 4. PX_EVIDENCE.reach 与渲染之间那根线是**通的** ----
   * 上面第 3 条证明的是"pending 分支里没有百分比";它证明不了"pending 这一档真的会被用上"。
   * 引擎那一行以前写死成 `L.opts.length ? 'pending' : 'verified'`,于是 PX_EVIDENCE.reach
   * 是个断了线的开关 —— 实测把它翻成 'pending',面板给的是
   * {before:'已验证', after:'已验证', changed:false}。3.9 的兜底条款(任何一格未过就把
   * 该腿落为 pending)全靠这根线执行,线断了,条款就是一句没有执行机构的法律。
   * 所以这一条必须是**端到端的 DOM 检查**:改常量 → 重渲染 → 数真实表格里的百分号。
   * 别把它降级成对 L.evidence 字段的单元断言 —— 字段对了而渲染没跟上,正是原来的那个缺陷。
   * 夹具是纯技术轨(E-US 没有期权链),所以整表走的都是 PX_EVIDENCE.reach 这一支。 */
  const W = await page.evaluate(() => {
    const co = state.companies.get('E-US'), r = calcRange(co, 'fy1');
    const snap = () => {
      const txt = $('plTable').textContent;
      return { pct: (txt.match(/%/g) || []).length,
        badges: [...new Set([...document.querySelectorAll('#plTable .plev')].map(n => n.textContent))].sort(),
        cls: [...new Set([...document.querySelectorAll('#plTable .plev')].map(n => n.className))].sort(),
        reachSpans: document.querySelectorAll('#plTable .plreach').length,
        pendSpans: document.querySelectorAll('#plTable .plpend').length,
        rows: document.querySelectorAll('#plTable table.mx.pl tr').length };
    };
    const was = PX_EVIDENCE.reach;
    PX_EVIDENCE.reach = 'verified'; renderPressure(co, r);
    const on = snap();
    PX_EVIDENCE.reach = 'pending'; renderPressure(co, r);
    const off = snap();
    PX_EVIDENCE.reach = was; renderPressure(co, r);            /* 立刻还原,后面的断言用真值 */
    const now = snap();
    return { on, off, now, was, restored: PX_EVIDENCE.reach };
  });

  ok('PX_EVIDENCE.reach 真的驱动渲染:翻成 pending 后整张压力表里一个百分号都不剩',
    /* 先证明夹具本身有话可说:verified 时表里确实有行、确实印出了百分比 */
    W.on.rows > 1 && W.on.pct > 0 && W.on.reachSpans > 0 && W.on.pendSpans === 0
    && W.on.badges.length === 1 && W.on.badges[0] === '已验证'
    /* 再证明开关是通的:同样的行数,百分号归零,概率格全换成 pending 文案 */
    && W.off.rows === W.on.rows && W.off.pct === 0 && W.off.reachSpans === 0
    && W.off.pendSpans === W.on.reachSpans
    && W.off.badges.length === 1 && W.off.badges[0] === '未验证'
    /* 最后证明它不是单向的、也确实被还原了(本轮真值就是 pending) */
    && W.restored === W.was && W.was === 'pending' && W.now.pct === 0,
    JSON.stringify(W));
});

/* ---------- [15] OHLC 读取 × 价格走势面板 ----------
 * 盘上今天一份 OHLC 都没有(Assets/charting/*.xlsx 只有 Date / Close / Volume),
 * 所以**降级路径**(收盘折线)是唯一能对着真数据验的那条,OHLC 路径只能靠构造的夹具。
 * 夹具因此必须能证明"读到的是真的 O/H/L,不是拿 Close 冒充":
 *   o = close − 2、h = close + 5、l = close − 7,四个数两两不等,
 *   任何"用收盘价顶替"的实现都会当场读出 close,断言必挂。
 * 面板那几条同样避开"恒真"陷阱:不数"有没有元素",而是数**根数对不对**、
 * 实体高度**比例对不对**(2:6 = 1:3)—— 只有真的按开收两个价位画,比例才成立。 */
await section('[15] OHLC 读取 × 价格走势面板(蜡烛 / 收盘折线)', async () =>
{
  const K = await page.evaluate(() => {
    const reset = () => {
      state.companies.clear(); state.history.clear(); state.priceHist.clear();
      state.overrides.clear(); state.roster = null; state.showOffRoster = false;
    };
    const D = i => new Date(Date.UTC(2026, 0, 5) + i * 86400000).toISOString().slice(0, 10);
    /* close 单调上行只是为了好读;O/H/L 相对 close 的偏移是固定的,便于逐根核对 */
    const close = i => 100 + i;
    const mkRows = (n, cols) => Array.from({ length: n }, (_, i) => cols(i, close(i)));

    /* --- 1) 有 O/H/L:三列都要读进来,且读到的必须是 O/H/L 本身 --- */
    reset();
    ingestChartingSheet('s', [
      ['Date', 'Test Co - Close', 'Test Co - Open', 'Test Co - High', 'Test Co - Low', 'Test Co - Volume'],
      ...mkRows(40, (i, c) => [D(i), c, c - 2, c + 5, c - 7, 1000 + i]),
    ], 'TSTK-US Daily Charting.xlsx');
    const withO = (state.priceHist.get('TSTK-US') || []).map(d => ({ p: d.price, o: d.o, h: d.h, l: d.l, v: d.vol }));

    /* --- 2) 没有 O/H/L:记录形状必须与今天**逐字段**相同(多一个键都算行为变了) --- */
    reset();
    ingestChartingSheet('s', [
      ['Date', 'Test Co - Close', 'Test Co - Volume'],
      ...mkRows(40, (i, c) => [D(i), c, 1000 + i]),
    ], 'TSTK-US Daily Charting.xlsx');
    const plain = state.priceHist.get('TSTK-US') || [];
    const plainKeys = [...new Set(plain.flatMap(d => Object.keys(d)))].sort();
    const plainSame = plain.length === 40 && plain.every((d, i) => d.date === D(i) && d.price === close(i) && d.vol === 1000 + i);

    /* --- 3) 幌子列:"52 Week High / Low" 不是当天的高低价,认进来等于凭空造三列日内数据 --- */
    reset();
    ingestChartingSheet('s', [
      ['Date', 'Test Co - Close', 'Test Co - Open', '52 Week High', '52 Week Low'],
      ...mkRows(40, (i, c) => [D(i), c, c - 2, c + 40, c - 40]),
    ], 'TSTK-US Daily Charting.xlsx');
    const decoyKeys = [...new Set((state.priceHist.get('TSTK-US') || []).flatMap(d => Object.keys(d)))].sort();

    /* --- 4) 自相矛盾的一根:high < low、或收盘跑到影线外 → 那一根退回"只有收盘价" --- */
    reset();
    ingestChartingSheet('s', [
      ['Date', 'Test Co - Close', 'Test Co - Open', 'Test Co - High', 'Test Co - Low'],
      ...mkRows(40, (i, c) => i === 3 ? [D(i), c, c - 2, c - 9, c + 9]        /* high < low */
        : i === 7 ? [D(i), c, c - 2, c - 1, c - 7]                            /* close > high */
          : [D(i), c, c - 2, c + 5, c - 7]),
    ], 'TSTK-US Daily Charting.xlsx');
    const mixed = (state.priceHist.get('TSTK-US') || []).map(d => ({ p: d.price, has: isFinite(d.o) }));

    /* --- 面板 --- */
    const co = { ticker: 'TSTK-US', name: 'Test Co', currency: 'USD', price: 139,
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null };
    const probe = () => {
      const svg = $('klChart').querySelector('svg');
      return {
        hidden: $('klSec').hidden,
        bodies: svg ? svg.querySelectorAll('rect.klbody').length : 0,
        wicks: svg ? svg.querySelectorAll('line.klwick').length : 0,
        lines: svg ? svg.querySelectorAll('path.klline').length : 0,
        pts: svg && svg.querySelector('path.klline')
          ? (svg.querySelector('path.klline').getAttribute('d').match(/[ML]/g) || []).length : 0,
        heights: svg ? [...svg.querySelectorAll('rect.klbody')].map(r => +r.getAttribute('height')) : [],
        wickLens: svg ? [...svg.querySelectorAll('line.klwick')]
          .map(r => Math.abs(+r.getAttribute('y2') - +r.getAttribute('y1'))) : [],
        fills: svg ? [...new Set([...svg.querySelectorAll('rect.klbody')].map(r => r.getAttribute('fill')))].sort() : [],
        svgHtml: svg ? svg.outerHTML : '',
        text: ($('klNote').textContent || '') + ' ' + ($('klLegend').textContent || ''),
      };
    };

    /* 5) 蜡烛模式。实体高度之比必须等于 |开−收| 之比:
     *    第 0 根 收−开=+2、第 1 根 收−开=−6(一根阴线,顺带把两种填色都逼出来)、第 2 根 =0(十字星)。
     *    任何"拿收盘价当开盘价"的实现会把三根都压成 1px 保底高度,比例立刻穿帮。 */
    reset();
    state.companies.set(co.ticker, co); state.selected = co.ticker;
    state.priceHist.set(co.ticker, Array.from({ length: 40 }, (_, i) => {
      const c = close(i), d = i === 0 ? 2 : i === 1 ? -6 : i === 2 ? 0 : 3;
      return { date: D(i), price: c, o: c - d, h: c + 8, l: c - 8 - (i === 1 ? 8 : 0) };
    }));
    state.klWin = 'all'; renderCandles(co);
    const cand = probe();

    /* 6) 降级:同一条序列去掉 o/h/l,必须变成一条收盘折线,且图里不出现涨跌色 */
    state.priceHist.set(co.ticker, Array.from({ length: 40 }, (_, i) => ({ date: D(i), price: close(i) })));
    renderCandles(co);
    const line = probe();

    /* 7) 窗口截断:200 根 + 'w120' 只画尾部 120 根,并在正文里说清楚总共有多少根 */
    state.priceHist.set(co.ticker, Array.from({ length: 200 }, (_, i) => ({ date: D(i), price: close(i) })));
    state.klWin = 'w120'; renderCandles(co);
    const win = probe();

    /* 8) 一根都不够画:整块收起,而不是留一个空框 */
    state.priceHist.set(co.ticker, [{ date: D(0), price: 100 }]);
    renderCandles(co);
    const tiny = probe();

    /* 9) 混着有 / 没有 OHLC 的一段:整段降级,不许半根蜡烛半个点地混排 */
    state.priceHist.set(co.ticker, Array.from({ length: 40 }, (_, i) => {
      const c = close(i);
      return i === 5 ? { date: D(i), price: c } : { date: D(i), price: c, o: c - 2, h: c + 5, l: c - 7 };
    }));
    state.klWin = 'all'; renderCandles(co);
    const half = probe();

    state.klWin = 'w120'; reset(); state.selected = null; renderAll();
    return { withO, plainKeys, plainSame, decoyKeys, mixed, cand, line, win, tiny, half,
      enNoInd: I18N.en.klNoInd, zhNoInd: I18N.zh.klNoInd };
  });

  ok('有 O/H/L 列时三列都读进来,且读到的是 O/H/L 本身 —— 不是拿 Close 冒充',
    K.withO.length === 40 && K.withO.every((d, i) => d.o === 100 + i - 2 && d.h === 100 + i + 5 && d.l === 100 + i - 7)
    && K.withO.every(d => d.o !== d.p && d.h !== d.p && d.l !== d.p),
    JSON.stringify(K.withO.slice(0, 2)));
  ok('有 O/H/L 时成交量与收盘价照旧读', K.withO.every((d, i) => d.p === 100 + i && d.v === 1000 + i));
  ok('没有 O/H/L 列时记录形状与今天逐字段相同(多一个键都算行为变了)',
    K.plainSame && K.plainKeys.join(',') === 'date,price,vol', JSON.stringify(K.plainKeys));
  ok('"52 Week High / Low" 是幌子列,一个都不许认(那不是当天的高低价)',
    K.decoyKeys.join(',') === 'date,price', JSON.stringify(K.decoyKeys));
  ok('自相矛盾的一根(high<low / 收盘在影线外)退回"只有收盘价",其余根不受牵连',
    K.mixed.length === 40 && K.mixed[3].has === false && K.mixed[7].has === false
    && K.mixed.filter(d => !d.has).length === 2 && K.mixed.every((d, i) => d.p === 100 + i),
    JSON.stringify(K.mixed.map(d => d.has ? 1 : 0).join('')));

  ok('有 OHLC → 画蜡烛:40 根实体 + 40 根影线,且没有收盘折线',
    K.cand.hidden === false && K.cand.bodies === 40 && K.cand.wicks === 40 && K.cand.lines === 0,
    JSON.stringify({ b: K.cand.bodies, w: K.cand.wicks, l: K.cand.lines }));
  ok('实体高度真的由开盘↔收盘决定:Δ=6 的那根正好是 Δ=2 那根的 3 倍,Δ=0 的那根落到 1px 保底',
    Math.abs(K.cand.heights[1] / K.cand.heights[0] - 3) < 1e-6 && K.cand.heights[2] === 1
    && K.cand.heights[0] > 1,
    JSON.stringify(K.cand.heights.slice(0, 3)));
  ok('影线长度真的由最高↔最低决定:第 1 根的振幅是别根的 1.5 倍(16 vs 24)',
    Math.abs(K.cand.wickLens[1] / K.cand.wickLens[0] - 1.5) < 1e-6,
    JSON.stringify(K.cand.wickLens.slice(0, 3)));
  ok('蜡烛只有涨/跌两种填色,且都来自 --delta-* 主题变量(不写死颜色)',
    K.cand.fills.length === 2 && K.cand.fills.every(f => /^var\(--delta-(up|down)\)$/.test(f)),
    JSON.stringify(K.cand.fills));
  ok('蜡烛模式下正文写明红绿是"描述当天开收方向",不是信号',
    /只描述/.test(K.cand.text) && /不是买卖信号/.test(K.cand.text) && /颜色只描述当日开收方向/.test(K.cand.text));

  ok('没有 OHLC → 降级成收盘折线:一条 path、40 个点、零根蜡烛',
    K.line.hidden === false && K.line.bodies === 0 && K.line.wicks === 0
    && K.line.lines === 1 && K.line.pts === 40,
    JSON.stringify({ b: K.line.bodies, l: K.line.lines, pts: K.line.pts }));
  ok('降级模式下图里一点涨跌色都不许有(折线没有"当天开收"这个事实可描述,涂色就只剩暗示)',
    !/--delta-(up|down)/.test(K.line.svgHtml));
  ok('降级模式下正文明说"这是收盘折线,不是 K 线",并点出缺的是 Open/High/Low',
    /收盘折线,不是 K 线/.test(K.line.text) && /Open \/ High \/ Low/.test(K.line.text)
    && /pending_no_ohlc/.test(K.line.text));
  ok('混着有/没有 OHLC 的一段整段降级,不许半根蜡烛半个点地混排',
    K.half.bodies === 0 && K.half.lines === 1 && K.half.pts === 40,
    JSON.stringify({ b: K.half.bodies, l: K.half.lines, pts: K.half.pts }));
  ok('窗口截断:200 根 + "近 120 根" 只画尾部 120 根,并在正文里说清序列总长',
    K.win.pts === 120 && /序列共 200 根/.test(K.win.text), JSON.stringify({ pts: K.win.pts }));
  ok('少于两根画不出东西 → 整块收起,不留空框', K.tiny.hidden === true);

  /* ---- 这一组是附录 K.8 的对外承诺,不是装饰:12 格全挂,图上就不许出现任何判断性视觉语言 ---- */
  ok('面板正文常驻那句"12 格全部未过验收闸门",两种模式都在',
    /12 格/.test(K.cand.text) && /全部未过验收闸门/.test(K.cand.text)
    && /12 格/.test(K.line.text) && /全部未过验收闸门/.test(K.line.text));
  ok('面板上一个百分号都没有(没有胜率、没有强度分、没有"看涨概率")',
    !/%/.test(K.cand.text) && !/%/.test(K.line.text) && !/%/.test(K.enNoInd),
    JSON.stringify({ c: K.cand.text.slice(0, 60), l: K.line.text.slice(0, 60) }));
  ok('面板上没有任何判断性词汇(看涨/看跌/金叉/死叉/超买/超卖/bullish/bearish)',
    ![K.cand.text, K.line.text].some(s => /看涨|看跌|金叉|死叉|超买|超卖|bullish|bearish/i.test(s)));
  /* 源码文本检查,别改成运行时断言:运行时只能证明"这次没画指标",
   * 证明不了"渲染层里根本没有能算出指标的那条路"(与 [14] 第 3 条同一个理由)。
   * SPEC K.9 第 4 条要求"画到图上的公式必须与验收的是同一套" —— 一条都不画时,
   * 兑现这条承诺最直接的办法就是渲染层里连算都不算。 */
  {
    const srcKl = fs.readFileSync(path.join(ROOT, 'src/js/render/candles.js'), 'utf8');
    const code = srcKl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* 词尾**不**加 \b:`sma20` / `rsi14` 这种带窗口长度的命名才是最可能出现的写法,
     * 加了 \b 就正好漏掉它们(这条断言的第一版就是这么漏的,被变异测试 M15 抓了出来)。 */
    const IND = /\b(sma|ema|rsi|macd|macross|breakout|golden)/i;
    ok('价格走势渲染层里连指标都不算(源码文本检查:无 SMA / EMA / RSI / MACD / maCross)',
      !IND.test(code), (code.match(IND) || [])[0]);
  }

  /* ---- 三处 OHLC 列名正则必须字字相同 ----------------------------------------
   * "这份导出算不算含 OHLC" 这条判断在仓库里被独立实现了三遍:
   *   fetcher/steps/charting.mjs  hasCol()        —— 抓取器用它写"含 OHLC / 仅收盘价"那行日志
   *   src/js/ingest/charting.js   ohlcIdx()       —— 浏览器侧读取
   *   tools/backtest.mjs          loadDaily()     —— Node 侧读取
   * 三处只要有一处走样,就会出现"抓取器说这份有 OHLC、读取层却不读"的静默错位:
   * 没有报错,只是蜡烛悄悄变回折线(或者更糟,幌子列被当成日内高低)。三处都没有
   * 覆盖到对方的测试,所以这条断言只能落在源码文本上。
   *
   * 抽取方式刻意不写成"匹配当前这一行":变量名、引号、空白、字面量内容、标志位
   * 全都放开。定位靠的是**语义**而不是行文 —— 先找所有 `new RegExp(字面量 + 标识符 + 字面量, 标志)`
   * 形状的**赋值**,再要求这个被赋值的名字在同一个文件里确实被 'Open' / 'High' / 'Low'
   * 三个词各调用过一次。tools/backtest.mjs 里 overrideParamSrc() 那条动态正则形状完全一样,
   * 就是靠这一步被排除的。
   *
   * 抽不到 ≠ 一致:抽不到就 FAIL(下面第一条),绝不允许 [null,null,null] 走进
   * `new Set(...).size === 1` 里冒充"三者相同"。 */
  {
    const FILES = ['fetcher/steps/charting.mjs', 'src/js/ingest/charting.js', 'tools/backtest.mjs'];
    /* JS 字符串字面量(单/双引号,允许转义);`n` = 开引号那一组的组号,用于回引配对 */
    const STR = n => "(['\"])((?:\\\\.|(?!\\" + n + ")[^\\\\])*)\\" + n;
    const DYN = new RegExp(
      '\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;]{0,300}?'       /* 1 = 被赋值的名字;不跨语句 */
      + 'new RegExp\\(\\s*' + STR(2)                                       /* 2/3 = 前缀字面量 */
      + '\\s*\\+\\s*[A-Za-z_$][\\w$]*\\s*\\+\\s*' + STR(4)                 /* 4/5 = 后缀字面量 */
      + '\\s*,\\s*' + STR(6) + '\\s*\\)', 'g');                            /* 6/7 = 标志位 */
    const pick = rel => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const hits = [];
      for (const m of src.matchAll(DYN)) {
        const [, name, , pre, , suf, , flags] = m;
        /* 语义定位:这个 helper 必须真的被 Open / High / Low 三个词各用过 */
        const usedWith = w => new RegExp('\\b' + name + '\\s*\\([^)]*[\'"]' + w + '[\'"]').test(src);
        if (usedWith('Open') && usedWith('High') && usedWith('Low')) hits.push({ pre, suf, flags });
      }
      return hits;
    };
    const got = FILES.map(f => ({ f, hits: pick(f) }));
    ok('三处 OHLC 列名正则都从源码里抽得出来,且每个文件恰好一条(抽不到 = FAIL,不是跳过)',
      got.every(g => g.hits.length === 1),
      JSON.stringify(got.map(g => [g.f, g.hits.length])));
    const norm = got.map(g => g.hits.length === 1
      ? JSON.stringify([g.hits[0].pre, g.hits[0].suf, g.hits[0].flags]) : null);
    ok('抓取器 / 浏览器读取层 / Node 读取层的 OHLC 列名正则字字相同(前缀、后缀、标志位)',
      norm.every(Boolean) && new Set(norm).size === 1,
      JSON.stringify(FILES.map((f, i) => [f, norm[i]])));
  }
});

/* ---------- [16] 两个读取层的**行为**交叉验证 ----------------------------------
 * [15] 末尾那两条只钉住了三处 OHLC 列名**正则的文本**相同。文本相同不等于行为相同:
 * 正则一致而自洽性公式(`hh >= ll && hh >= max(o,p) && ll <= min(o,p)`)在某一侧被
 * 改写、或者 vol/date 的解析口径漂了,两边照样会读出不同的序列 —— 而且今天盘上
 * 一份 OHLC 都没有,这种漂移在真实数据上永远不会暴露。
 *
 * 所以这里造一份 xlsx 夹具,**同一份文件**同时喂进:
 *   浏览器侧 ingestChartingSheet()(走 playwright 页面,与用户双击打开的产物同一份代码)
 *   Node 侧   loadDaily(dir)(直接 import tools/backtest.mjs 的导出,不是抄一份实现)
 * 然后逐字段比对两边输出的记录序列。
 *
 * 「抽不到」与「一致」必须是两种结果:下面第一条先钉死两侧各自读出了哪几只票、各多少根,
 * 读空了就 FAIL —— 绝不允许"两边都返回空 Map"冒充"完全相同"。
 *
 * 夹具纪律(沿用 tools/backtest.mjs selfTest() 踩过的坑):
 *   · O/H/L 两两不等且都不等于 Close —— 拿 Close 顶替的实现当场穿帮。
 *   · 正常根一律用**阴线**(开 = 收 + 3)。阳线上"缺列就拿 Close 顶替"顶出来的
 *     Low = Close 会被 `ll <= min(o,p)` 自己挡掉,夹具看不出区别;阴线上 min(o,p) 就是
 *     Close,顶替值恰好过关,三列真的会被写进去 —— 断言这才抓得到。
 *   · 幌子列 `52 Week High/Low` 排在**真列前面**:findIndex 取第一个命中,
 *     正则一旦放宽,取到的就是幌子列而不是真列。 */
await section('[16] 浏览器侧 ingestChartingSheet() × Node 侧 loadDaily():同一份 xlsx 夹具,逐字段对答案', async () =>
{
  const XVDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xv-charting-'));
  const DAY0 = 45300;                                   /* Excel 序列日期,两侧都走数字分支 */
  const wr = (fn, rows) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    XLSX.writeFile(wb, path.join(XVDIR, fn));
  };
  const N = 45;                                          /* > Node 侧 40 行下限,两边都收 */
  const rows = (n, cols) => Array.from({ length: n }, (_, i) => cols(i, 100 + i));

  /* F-A 齐三列 + 成交量 + 幌子列 + 两根坏根。列序打乱,幌子列压在真列前面。 */
  wr('XVA-US Daily Charting.xlsx', [
    ['Date', 'XV Alpha - Close', '52 Week High', 'XV Alpha - High', 'Volume', 'XV Alpha - Open', '52 Week Low', 'XV Alpha - Low'],
    ...rows(N, (i, c) => {
      /* i=9 最高 < 最低;i=17 收盘跑到影线上沿之外(开盘仍在影线内,单独逼出"收盘"这一项) */
      const [o, hh, ll] = i === 9 ? [c + 3, c - 5, c + 5]
        : i === 17 ? [c - 2, c - 1, c - 4]
          : [c + 3, c + 6, c - 4];                       /* 阴线:开 > 收 */
      return [DAY0 + i, c, c + 40, hh, 1000 + i, o, c - 40, ll];
    }),
  ]);
  /* F-B 缺 Low(只有 Open/High,外加一个幌子 Low)→ 整份当没有 OHLC */
  wr('XVB-US Daily Charting.xlsx', [
    ['Date', 'XV Beta - Close', 'XV Beta - Open', 'XV Beta - High', '52 Week Low', 'XV Beta - Volume'],
    ...rows(N, (i, c) => [DAY0 + i, c, c + 3, c + 6, c - 40, 2000 + i]),
  ]);
  /* F-C 纯幌子列:一列真 OHLC 都没有,记录里只许有 date/price */
  wr('XVC-US Daily Charting.xlsx', [
    ['Date', 'XV Gamma - Close', '52 Week High', '52 Week Low'],
    ...rows(N, (i, c) => [DAY0 + i, c, c + 40, c - 40]),
  ]);
  /* F-L* 最短行数门槛:12 / 13 / 39 / 40 四档,专钉两侧下限(详见本节末尾那两条断言) */
  const LENS = { 'XVLA-US': 12, 'XVLB-US': 13, 'XVLC-US': 39, 'XVLD-US': 40 };
  for (const [tk, n] of Object.entries(LENS)) {
    wr(tk + ' Daily Charting.xlsx', [
      ['Date', tk + ' - Close'], ...rows(n, (i, c) => [DAY0 + i, c]),
    ]);
  }
  const FIX = fs.readdirSync(XVDIR).sort();

  /* ---- Node 侧:直接调 tools/backtest.mjs 导出的 loadDaily(),不是抄一份 ---- */
  const nres = loadDaily(XVDIR);
  const nodeSide = {};
  for (const [k, v] of nres.cos) nodeSide[k] = v;

  /* ---- 浏览器侧:同一批 .xlsx 的字节,base64 送进页面,用产物里的 ingestChartingSheet() 读 ---- */
  const payload = FIX.map(fn => ({ fn, b64: fs.readFileSync(path.join(XVDIR, fn)).toString('base64') }));
  const B = await page.evaluate(files => {
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    state.overrides.clear(); state.market.clear(); state.roster = null; state.showOffRoster = false;
    const nulls = [];
    for (const f of files) {
      const wb = XLSX.read(f.b64, { type: 'base64' });
      /* header:1 / raw:true —— 与 src/js/ingest/files.js 真正的载入路径同一组选项 */
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
      const res = ingestChartingSheet(wb.SheetNames[0], aoa, f.fn);
      if (!res || !res.ticker) nulls.push(f.fn);
    }
    const out = {};
    for (const [k, v] of state.priceHist) out[k] = v;
    const r = { out, nulls, cos: [...state.companies.keys()].sort() };
    state.companies.clear(); state.history.clear(); state.priceHist.clear(); state.market.clear();
    state.selected = null; renderAll();
    return r;
  }, payload);

  /* 逐字段规范化:键排序后连值一起序列化 —— 多一个键、少一个键、值差一位都算不同 */
  const canon = arr => (arr || []).map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
  const nKeys = Object.keys(nodeSide).sort(), bKeys = Object.keys(B.out).sort();

  /* ① 先证明"两边都真的读出东西了"。读空了必须 FAIL,不能静默变成"完全相同"。 */
  ok('夹具两侧都真的读出来了:Node 收 XVA/XVB/XVC/XVLD 四只,浏览器多收 XVLB/XVLC 两只短序列(读空 = FAIL,不是跳过)',
    nKeys.join(',') === 'XVA-US,XVB-US,XVC-US,XVLD-US'
    && bKeys.join(',') === 'XVA-US,XVB-US,XVC-US,XVLB-US,XVLC-US,XVLD-US',
    JSON.stringify({ node: nKeys, browser: bKeys }));

  /* ② 主断言:两侧都收的那几只,记录序列必须逐字段完全相同 */
  const both = nKeys.filter(k => bKeys.includes(k));
  const diff = both.filter(k => canon(nodeSide[k]).join('|') !== canon(B.out[k]).join('|'));
  ok('两侧都收的四只票,记录序列逐字段完全相同(date / price / vol / o / h / l,多一个键都算不同)',
    both.length === 4 && diff.length === 0,
    JSON.stringify(diff.map(k => ({
      k, node: canon(nodeSide[k]).slice(0, 2), browser: canon(B.out[k]).slice(0, 2),
    }))));

  /* ③ "两边一样"还不够 —— 一起错也是一样。这条钉死值本身。
   *    正常根:o = c+3、h = c+6、l = c−4、vol = 1000+i;坏根第 9 / 17 退回只有收盘价。 */
  const expA = Array.from({ length: N }, (_, i) => {
    const c = 100 + i, d = { date: null, price: c, vol: 1000 + i };
    if (i !== 9 && i !== 17) { d.o = c + 3; d.h = c + 6; d.l = c - 4; }
    return d;
  });
  const shapeA = side => (side || []).map((r, i) => {
    const e = expA[i];
    return r.price === e.price && r.vol === e.vol
      && (e.o === undefined ? !('o' in r) && !('h' in r) && !('l' in r)
        : r.o === e.o && r.h === e.h && r.l === e.l);
  });
  /* 下面几条一律走 (… || []):某一侧整个读空时要**干净地 FAIL**,而不是抛 TypeError
   * 把后面的断言连同 pass/fail 总数一起带走(读空本来就该由第 ① 条报出来)。 */
  const nA = nodeSide['XVA-US'] || [], bA = B.out['XVA-US'] || [];
  ok('F-A 的值本身对得上(不是"两边一起错"):43 根带真 O/H/L,第 9(高<低)与第 17(收盘在影线外)两根退回只有收盘价',
    nA.length === N && bA.length === N
    && shapeA(nA).every(Boolean) && shapeA(bA).every(Boolean)
    && nA.filter(r => r.o > 0).length === N - 2
    && bA.filter(r => r.o > 0).length === N - 2,
    JSON.stringify({ nLen: nA.length, bLen: bA.length,
      n: nA.filter(r => r.o > 0).length, b: bA.filter(r => r.o > 0).length }));

  /* ④ 幌子列在两侧都不许被认成日内高低 —— 认了就等于凭空造三列不存在的数据 */
  const keysOf = arr => [...new Set((arr || []).flatMap(r => Object.keys(r)))].sort().join(',');
  ok('缺 Low(F-B)与纯幌子列(F-C)在两侧都退回"只有收盘价",52 Week High/Low 一个都不认',
    keysOf(nodeSide['XVB-US']) === 'date,price,vol' && keysOf(B.out['XVB-US']) === 'date,price,vol'
    && keysOf(nodeSide['XVC-US']) === 'date,price' && keysOf(B.out['XVC-US']) === 'date,price',
    JSON.stringify({ nB: keysOf(nodeSide['XVB-US']), bB: keysOf(B.out['XVB-US']),
      nC: keysOf(nodeSide['XVC-US']), bC: keysOf(B.out['XVC-US']) }));

  /* ⑤ 日期口径:Node 的 serialISO() 与浏览器的 toISODate() 是两份独立实现,
   *    这里连同首末两个具体日期一起钉死(只比"两边相同"抓不到"两边一起偏一天")。 */
  ok('Excel 序列日期在两侧还原成同一个 ISO 日,且值本身正确(45300 → 2024-01-09,末根 2024-02-22)',
    nA.length === N && bA.length === N
    && nA[0].date === '2024-01-09' && bA[0].date === '2024-01-09'
    && nA[N - 1].date === '2024-02-22' && bA[N - 1].date === '2024-02-22',
    JSON.stringify({ n0: (nA[0] || {}).date, b0: (bA[0] || {}).date,
      nz: (nA[N - 1] || {}).date, bz: (bA[N - 1] || {}).date }));

  /* ⑥ ohlcFiles 只数真读到 O/H/L 的那份(F-A),缺列 / 幌子 / 短序列都不算 */
  ok('loadDaily().ohlcFiles 只把 F-A 数进去(缺列、纯幌子、短序列都不算含 OHLC)',
    nres.ohlcFiles === 1, String(nres.ohlcFiles));

  /* ---- 最短行数门槛:两侧**故意**不同,这里把差异钉死,不是把它统一掉 -----------
   * 浏览器侧 `px.length < 13`  ← 对齐 src/js/valuation/volstats.js 的 `ph.length < 13`
   *   (它内部还要 `rets.length < 12`)。13 个点 = 12 个收益,是能算出一个样本方差的最少点数。
   *   浏览器侧还要吃**周线 / 月线**导出(volStats 按日期中位间隔判频率,252/52/12/1 四档都支持),
   *   以及**新上市**的短日线序列 —— 盘上 SPCX-US 就不到 40 根(见 [18];它历史还没满一年,
   *   根数**每个交易日 +1**,所以这里不写死具体几根)。按 40 收会把这些合法序列静默丢掉。
   * Node 侧 `px.length < 40`  ← 对齐冻结常量 PX_SIGMA_MIN_N = 40(src/js/pressure/params.js,
   *   SPEC 附录标注"不调"),sigmaD()(pressure/scale.js)与 priceDensity()(pressure/grid.js)都按它拒算;
   *   tools/ledger.mjs 与 tools/scratch/*.mjs 里同一个 40 也是这么来的。回测只经 sigmaD 消费日线,
   *   不足 40 根收益本来就出不了任何结论,早筛掉比算到一半返回 null 干净。
   *
   * 结论:两者服务的下游不同,是有意为之,**不是手误**。谁要"顺手统一",先让下面两条变红。 */
  ok('浏览器侧下限就是 13 根:12 根一个字都不收,13 根整条收下(对齐 volStats 的 12 个收益)',
    B.nulls.includes('XVLA-US Daily Charting.xlsx') && B.out['XVLA-US'] === undefined
    && (B.out['XVLB-US'] || []).length === 13,
    JSON.stringify({ nulls: B.nulls, lb: (B.out['XVLB-US'] || []).length }));
  ok('Node 侧下限就是 40 根:39 根整份跳过,40 根整条收下(对齐冻结常量 PX_SIGMA_MIN_N = 40)',
    nodeSide['XVLC-US'] === undefined && (nodeSide['XVLD-US'] || []).length === 40,
    JSON.stringify({ lc: nodeSide['XVLC-US'] === undefined, ld: (nodeSide['XVLD-US'] || []).length }));
  ok('13–39 根这一段两侧**故意**不一致:浏览器收(新上市/周线序列照画),回测不收(样本不够不出结论)',
    (B.out['XVLB-US'] || []).length === 13 && (B.out['XVLC-US'] || []).length === 39
    && nodeSide['XVLB-US'] === undefined && nodeSide['XVLC-US'] === undefined,
    JSON.stringify({ b13: (B.out['XVLB-US'] || []).length, b39: (B.out['XVLC-US'] || []).length,
      n13: nodeSide['XVLB-US'] === undefined, n39: nodeSide['XVLC-US'] === undefined }));
  /* 两个门槛各自的"出处"也钉住:数字漂了、或者对齐关系断了,这条先红。
   * 这是源码文本断言,配合上面三条行为断言用 —— 单独一条证明不了运行时真按它办事。 */
  {
    const rd = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const vol = rd('src/js/valuation/volstats.js'), par = rd('src/js/pressure/params.js');
    const ing = rd('src/js/ingest/charting.js'), bt = rd('tools/backtest.mjs');

    /* ---- 为什么这里必须先把注释剥掉 -------------------------------------
     * 这条断言原先直接对**全文**匹配 /\bpx\.length\s*<\s*13\b/ 和 …<\s*40\b/。
     * 那两个数字后来被提成了具名常量 INGEST_MIN_BARS / BACKTEST_MIN_BARS,
     * 但两个文件的头注释里都留着 "以前这里写的是字面量 `px.length < 13`" 的原文
     * —— 于是全文匹配**永远**命中注释。把 const 删掉、调用点改回硬编码字面量,
     * 这条断言照样绿。它钉的是"某处出现过这串字符",不是"代码这么写"。空转。
     *
     * 剥注释用的是下面这个逐行小状态机,不是 JS parser。已知盲点:字符串 / 正则
     * 字面量里出现的 `//` 或 `/*` 会被误当成注释开头。上面这四个文件里没有这种
     * 写法(已核过),而且两个方向的失效都会被下一条自检断言抓住:
     *   剥少了 → 注释里的路标还在 → 自检红;
     *   剥多了 → 代码里的路标没了 → 正文断言红。 */
    const stripComments = src => {
      const out = []; let inBlk = false;
      for (const raw of src.split('\n')) {
        let line = '', i = 0;
        while (i < raw.length) {
          if (inBlk) {
            const e = raw.indexOf('*/', i);
            if (e < 0) { i = raw.length; } else { inBlk = false; i = e + 2; }
            continue;
          }
          const b = raw.indexOf('/*', i), l = raw.indexOf('//', i);
          if (b >= 0 && (l < 0 || b < l)) { line += raw.slice(i, b); inBlk = true; i = b + 2; continue; }
          if (l >= 0) { line += raw.slice(i, l); i = raw.length; continue; }
          line += raw.slice(i); i = raw.length;
        }
        out.push(line);
      }
      return out.join('\n');
    };
    const ingC = stripComments(ing), btC = stripComments(bt);
    const volC = stripComments(vol), parC = stripComments(par);

    /* 先证明剥注释这一步真的干了活 —— 否则下面那三条"代码里不存在裸字面量"
     * 会因为"剥了个寂寞 / 剥成空字符串"而变成又一条空转断言。
     * 路标选的就是那两句留着字面量原文的注释本身。 */
    ok('剥注释这一步本身是有效的:注释里的字面量原文被剥掉了,代码里的守卫行还在',
      /以前这里写的是字面量/.test(ing) && !/以前这里写的是字面量/.test(ingC)
      && /以前这里写的是字面量/.test(bt) && !/以前这里写的是字面量/.test(btC)
      && /\bpx\.length\s*<\s*13\b/.test(ing) && /\bpx\.length\s*<\s*40\b/.test(bt)
      && /return\s+null\s*;/.test(ingC) && /function\s+loadDaily/.test(btC)
      && volC.includes('ph.length') && parC.includes('PX_SIGMA_MIN_N'),
      JSON.stringify({ ingRawHasNote: /以前这里写的是字面量/.test(ing),
        ingStrippedHasNote: /以前这里写的是字面量/.test(ingC),
        btStrippedHasNote: /以前这里写的是字面量/.test(btC),
        ingCodeAlive: /return\s+null\s*;/.test(ingC), btCodeAlive: /function\s+loadDaily/.test(btC) }));

    /* 两个下限的出处 + 它们**以具名常量的形式**存在且被调用点使用。
     * 三件事缺一不可,任何一件退回硬编码字面量都得红:
     *   ① const 定义还在,数字没漂;
     *   ② 守卫行读的是常量名,不是字面量;
     *   ③ 剥完注释的代码里**再也找不到**裸的 px.length < 13 / < 40。
     * ③ 是关键的那条 —— 没有它,"把 const 留着当摆设、守卫行改回硬编码"照样能绿。 */
    const A = {
      vol13: /\bph\.length\s*<\s*13\b/.test(volC), rets12: /\brets\.length\s*<\s*12\b/.test(volC),
      min40: /\bconst\s+PX_SIGMA_MIN_N\s*=\s*40\b/.test(parC),
      ingDef: /\bconst\s+INGEST_MIN_BARS\s*=\s*13\s*;/.test(ingC),
      btDef: /\bconst\s+BACKTEST_MIN_BARS\s*=\s*40\s*;/.test(btC),
      ingUse: /\bpx\.length\s*<\s*INGEST_MIN_BARS\b/.test(ingC),
      btUse: /\bpx\.length\s*<\s*BACKTEST_MIN_BARS\b/.test(btC),
      ingNoLit: !/\bpx\.length\s*<\s*13\b/.test(ingC),
      btNoLit: !/\bpx\.length\s*<\s*40\b/.test(btC),
    };
    ok('两个下限仍是具名常量、且守卫行真的在用它:13 = INGEST_MIN_BARS(← volStats 的 ph.length < 13)、'
      + '40 = BACKTEST_MIN_BARS(← 冻结常量 PX_SIGMA_MIN_N = 40),代码里一个裸字面量守卫都不剩',
      Object.values(A).every(Boolean), JSON.stringify(A));
  }

  fs.rmSync(XVDIR, { recursive: true, force: true });
});

/* ---------- [17] 蜡烛面板的交互:十字线 / tooltip / 窗口档 --------------------
 * [15] 只验了"画出来的东西对不对",交互那一段(pointermove / pointerleave / #klWinTabs)
 * 一条断言都没有。这里补上,并且刻意避开两种恒真写法:
 *   · 不断言"tooltip 非空",而是断言 tooltip 里的 O/H/L/C **就是那一根的四个数**;
 *   · 不断言"根数 >= 某个下界",而是把 60 / 120 / 252 三个数各自钉死。
 * 指针用 playwright 真鼠标(page.mouse.move),不是合成事件 —— 命中的是那块透明 hit rect
 * 本身,连"鼠标压根落不到图上"这种回归也一起挡住。
 * 每根的横坐标不去抄 renderCandles 里的 L/R/step 常量,而是从画出来的实体上量:
 * cx(i) = rect.x + rect.width/2。抄常量的话,常量改了测试跟着改,等于没测。 */
await section('[17] 蜡烛面板交互:十字线 / tooltip 数值 / 窗口档切换', async () =>
{
  const NBAR = 252;
  /* close = 200+i 的阴线:开 = 收+3、高 = 收+7、低 = 收−5。三位数 → fmtN 保留一位小数、无千分位 */
  await page.evaluate(n => {
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    state.overrides.clear(); state.market.clear(); state.roster = null; state.showOffRoster = false;
    const co = { ticker: 'KLX-US', name: 'KL Interact', currency: 'USD', price: 200 + n - 1,
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null };
    state.companies.set(co.ticker, co); state.selected = co.ticker; state.horizon = 'fy1';
    state.priceHist.set(co.ticker, Array.from({ length: n }, (_, i) => {
      const c = 200 + i;
      return { date: new Date(Date.UTC(2026, 0, 5) + i * 86400000).toISOString().slice(0, 10),
        price: c, o: c + 3, h: c + 7, l: c - 5 };
    }));
    state.klWin = 'all';
    renderAll();
  }, NBAR);

  /* 图在长页面的下半截,先滚进视口 —— 落在视口外的坐标 page.mouse.move 根本送不到元素上,
   * 那样测出来的"没反应"是坐标的锅,不是代码的锅。 */
  const intoView = () => page.evaluate(() => { $('klBox').scrollIntoView({ block: 'center' }); });

  /* 把第 i 根实体的中心换算成页面坐标。viewBox 宽度从 svg 上读,不写死 1100。 */
  const barPoint = async i => (await intoView(), page.evaluate(idx => {
    const svg = $('klChart').querySelector('svg');
    const bodies = svg.querySelectorAll('rect.klbody');
    const b = bodies[idx];
    /* 蜡烛整个没画出来时,给个视口外的坐标接着往下跑 —— 后面的断言会因为
     * tooltip 里没有那一根的数而**干净地 FAIL**,而不是在这里抛 TypeError
     * 把剩下的断言连同 pass/fail 总数一起带走。 */
    if (!b) return { x: 0, y: 0, cx: null, nBodies: bodies.length };
    const vbW = +svg.getAttribute('viewBox').split(/\s+/)[2];
    const cx = +b.getAttribute('x') + (+b.getAttribute('width')) / 2;
    const bb = $('klBox').getBoundingClientRect();
    return { x: bb.left + cx / vbW * bb.width, y: bb.top + bb.height / 2, cx, nBodies: bodies.length };
  }, i));
  const readTip = () => page.evaluate(() => {
    const svg = $('klChart').querySelector('svg');
    /* 十字线是那条唯一带 visibility 属性的竖线 */
    const cr = [...svg.querySelectorAll('line')].find(l => l.hasAttribute('visibility'));
    return {
      tipText: $('klTip').textContent, tipShown: $('klTip').style.display,
      crossVis: cr ? cr.getAttribute('visibility') : null,
      crossX: cr ? +cr.getAttribute('x1') : null,
      crossSame: cr ? cr.getAttribute('x1') === cr.getAttribute('x2') : null,
    };
  });

  const p100 = await barPoint(100);
  await page.mouse.move(p100.x, p100.y);
  const t100 = await readTip();
  const p7 = await barPoint(7);
  await page.mouse.move(p7.x, p7.y);
  const t7 = await readTip();

  /* 第 100 根:收 300、开 303、高 307、低 295;第 7 根:收 207、开 210、高 214、低 202。
   * 两根都对得上,才排除"tooltip 永远显示最后一根 / 永远显示同一根"。 */
  ok('pointermove 到第 100 根:tooltip 的 O/H/L/C 就是这一根的四个数(收 300.0 / 开 303.0 / 高 307.0 / 低 295.0)',
    /收 300\.0/.test(t100.tipText) && /开 303\.0/.test(t100.tipText)
    && /高 307\.0/.test(t100.tipText) && /低 295\.0/.test(t100.tipText)
    && t100.tipShown === 'block', JSON.stringify(t100));
  ok('tooltip 里还写着这一根的日期,且是第 100 根那天(2026-04-15),不是别的根',
    /2026-04-15/.test(t100.tipText), JSON.stringify(t100.tipText));
  ok('移到第 7 根,tooltip 整组数跟着换(收 207.0 / 开 210.0 / 高 214.0 / 低 202.0)—— 排除"永远显示同一根"',
    /收 207\.0/.test(t7.tipText) && /开 210\.0/.test(t7.tipText)
    && /高 214\.0/.test(t7.tipText) && /低 202\.0/.test(t7.tipText)
    && !/300\.0|303\.0/.test(t7.tipText), JSON.stringify(t7.tipText));
  ok('十字线跟着显示,且正好落在那根实体的中心(x1 = x2 = cx(i),两根各自对上)',
    t100.crossVis === 'visible' && t100.crossSame === true && Math.abs(t100.crossX - p100.cx) < 0.51
    && t7.crossVis === 'visible' && Math.abs(t7.crossX - p7.cx) < 0.51,
    JSON.stringify({ c100: t100.crossX, e100: p100.cx, c7: t7.crossX, e7: p7.cx }));

  /* pointerleave:鼠标挪到图外(页面左上角),十字线与 tooltip 都要收掉 */
  await page.mouse.move(2, 2);
  const away = await readTip();
  ok('pointerleave 之后十字线隐藏、tooltip 收起(不是留在原地不动)',
    away.crossVis === 'hidden' && away.tipShown === 'none',
    JSON.stringify(away));

  /* 窗口档:上一轮只在探针里看过 120 → 252,这里把三档各自钉死 */
  const barsNow = () => page.evaluate(() => {
    const svg = $('klChart').querySelector('svg');
    return {
      bodies: svg ? svg.querySelectorAll('rect.klbody').length : 0,
      wicks: svg ? svg.querySelectorAll('line.klwick').length : 0,
      on: [...$('klWinTabs').querySelectorAll('button')].filter(b => b.classList.contains('on')).map(b => b.dataset.klw),
      win: state.klWin,
    };
  });
  const all252 = await barsNow();
  await page.click('#klWinTabs button[data-klw="w60"]');
  const w60 = await barsNow();
  await page.click('#klWinTabs button[data-klw="w120"]');
  const w120 = await barsNow();
  await page.click('#klWinTabs button[data-klw="all"]');
  const back = await barsNow();

  ok('窗口档真的改变了画出来的根数:全部 252 → 近 60 档 60 根 → 近 120 档 120 根 → 全部又回到 252',
    all252.bodies === 252 && w60.bodies === 60 && w120.bodies === 120 && back.bodies === 252,
    JSON.stringify({ all: all252.bodies, w60: w60.bodies, w120: w120.bodies, back: back.bodies }));
  ok('影线根数与实体根数逐档一致(不许出现"实体切了、影线没切"的半截重绘)',
    w60.wicks === 60 && w120.wicks === 120 && back.wicks === 252,
    JSON.stringify({ w60: w60.wicks, w120: w120.wicks, back: back.wicks }));
  ok('高亮档位跟着走,且任何时候**恰好**一个档亮着',
    w60.on.join() === 'w60' && w120.on.join() === 'w120' && back.on.join() === 'all',
    JSON.stringify({ w60: w60.on, w120: w120.on, back: back.on }));

  /* 重绘之后十字线仍然接得上事件 —— onclick 重绘会换掉整棵 svg,
   * hit rect 是新建的,监听没挂上的话这里就读不到 tooltip 了。 */
  await page.click('#klWinTabs button[data-klw="w60"]');
  const p59 = await barPoint(59);                       /* 近 60 档的最后一根 = 原序列第 251 根 */
  await page.mouse.move(p59.x, p59.y);
  const t59 = await readTip();
  ok('切档重绘之后十字线/tooltip 仍然接得上(近 60 档末根 = 原序列第 251 根:收 451.0 / 开 454.0)',
    p59.nBodies === 60 && /收 451\.0/.test(t59.tipText) && /开 454\.0/.test(t59.tipText)
    && t59.crossVis === 'visible', JSON.stringify({ n: p59.nBodies, tip: t59.tipText }));

  await page.mouse.move(2, 2);
  await page.evaluate(() => {
    state.klWin = 'w120';
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    state.selected = null; renderAll();
  });
});

/* ---------- [18] 真实数据:**每一只**标的都要画得出来 --------------------------
 * 上一轮只在 NVDA-US 上肉眼验过降级折线。一只票过了不代表十一只都过:
 * SPCX-US 是新上市、历史还没满一年,SPY-US 同时以公司文件和 _MARKET-BENCH 两种身份出现在同一个
 * 文件夹里、QQQ-US 是 ETF。这里把 Assets/charting 整个文件夹喂进页面,逐只切过去画一遍。
 *
 * ---- 为什么这一节的数**不许**写死(踩过的坑,别改回去)----------------------
 * 上一版把根数钉死成"十只 252 根、SPCX-US 36 根",在我这边全绿,到用户机器上直接红:
 * 他的 SPCX-US 已经是 37 根了。原因不是代码坏了,是**数据本来就会变**——
 * 别的票是滚动 252 根窗口,看起来像常数;SPCX-US 历史不满 252 根,所以它**每个交易日 +1**。
 * 写死一个会随导出时间变的数,测出来的是"数据没换过",不是"代码没坏",而且保证明天再红一次。
 * 同理,公司清单写死也意味着用户往 Assets 里加一只票就变红 —— 加票是正常操作,不是回归。
 *
 * 现在换成三条**与快照无关**的判据,单条都不比原来的字面量弱:
 *   1. 画出来的点数 === 页面自己读到的根数(DOM 对得上模型,少画一根就红);
 *   2. 页面读到的根数 === tools/backtest.mjs 里 loadDaily() 独立读同一个文件夹得到的根数
 *      —— 拿**另一套实现**当尺子,不是自己量自己(这比"等于 252"强:252 只说明数没变);
 *   3. loadDaily() 有 40 根下限,被它跳过的票必须落在 [13, 40) 区间里
 *      —— 证明它被跳过正是因为太短,而不是被谁悄悄弄丢了。
 * 会随时间变的东西一律从**文件夹本身**推;只有"角色→代码"这种约定映射才继续写死。
 *
 * ---- 为什么这一段要按数据的三种状态分流(踩过的坑,别改回去)----------------
 * 之前这里直接 readdirSync,新克隆上跑出来是段落护栏兜住的一句生的
 *   ENOENT: no such file or directory, scandir '.../Assets/charting'
 * —— 又红又不告诉人该干嘛,而"没有授权数据"恰恰是新机器的**正常**状态。
 * 现在按 chartingStatus() 的三态分流,三条判据都不许改松也不许改严:
 *   'no-dir' 目录压根不存在 → 从没装过 → 大声跳过(单独计数,不影响退出码);
 *   'empty'  目录在、却读不出任何导出 → 装过又被清掉了 → **FAIL**,这是回归;
 *   'ok'     照跑,下面一条断言都没删、一条都没放松。
 * 注意 'empty' 绝不许跟着走跳过:那正是"数据被弄丢"会长的样子,
 * 一旦也豁免掉,这套跳过机制就变成了掩盖真问题的口子。 */
await section('[18] 真实数据遍历:Assets/charting 里每一只标的都画得出折线', async () =>
{
  const CH = chartingStatus(ROOT);
  if (CH.state === 'no-dir') { skipNoDirOnly('[18] 真实数据遍历(Assets/charting)', CH); return; }
  if (CH.state === 'empty') {
    ok('Assets/charting 目录在,却一个导出文件都读不出来 —— 这不是"没装过",是被弄丢了'
      + '(装过又清空 / 同步删掉 / 目录读不动都算回归;真的从没装过是整个目录不存在,那条才走跳过)',
      false, JSON.stringify({ dir: CH.dir, err: CH.err || '目录可读,但里面没有任何 .xlsx/.xls' }));
    return;
  }

  const CDIR = CH.dir;
  const { files, coFiles, mktFiles } = CH;      // 目录读取只过 chartingStatus() 这一道闸
  ok('Assets/charting 里读到了导出文件,公司文件与市场级序列都有(读空了就 FAIL,不是跳过)',
    files.length > 0 && coFiles.length > 0 && mktFiles.length > 0,
    JSON.stringify({ n: files.length, co: coFiles.length, mkt: mktFiles.length }));
  /* Node 侧独立再读一遍**同一个文件夹**:下面所有"应该是几根"都以它为准,不写字面量。
   * 它是 tools/backtest.mjs 的实现,与浏览器那套读取层各写各的([16] 已用夹具逐字段对过账)。 */
  const ND = loadDaily();

  const payload = files.map(fn => ({ fn, b64: fs.readFileSync(path.join(CDIR, fn)).toString('base64') }));
  const R = await page.evaluate(fs2 => {
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    state.overrides.clear(); state.market.clear(); state.roster = null; state.showOffRoster = false;
    for (const f of fs2) {
      const wb = XLSX.read(f.b64, { type: 'base64' });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
      ingestChartingSheet(wb.SheetNames[0], aoa, f.fn);
    }
    const cos = [...state.companies.keys()].sort();
    state.klWin = 'all';
    const per = {}, errs = [];
    for (const tk of cos) {
      try {
        state.selected = tk; state.horizon = 'fy1';
        renderAll();
        const svg = $('klChart').querySelector('svg');
        const p = svg && svg.querySelector('path.klline');
        per[tk] = {
          hidden: $('klSec').hidden,
          len: (state.priceHist.get(tk) || []).length,
          pts: p ? (p.getAttribute('d').match(/[ML]/g) || []).length : 0,
          lines: svg ? svg.querySelectorAll('path.klline').length : 0,
          bodies: svg ? svg.querySelectorAll('rect.klbody').length : 0,
          /* 降级折线上一点涨跌色都不许有(K.8) */
          delta: svg ? /--delta-(up|down)/.test(svg.outerHTML) : true,
          noInd: /12 格/.test($('klNote').textContent || '') && /全部未过验收闸门/.test($('klNote').textContent || ''),
        };
      } catch (e) { errs.push(tk + ': ' + e.message); }
    }
    const mkt = {};
    for (const [k, v] of state.market) mkt[k] = { sym: v.sym, n: v.px.length };
    state.klWin = 'w120';
    state.companies.clear(); state.history.clear(); state.priceHist.clear(); state.market.clear();
    state.selected = null; renderAll();
    return { cos, per, mkt, errs };
  }, payload);

  ok('遍历过程中没有一只票抛异常(抛了就把票号和消息报出来,不静默吞掉)',
    R.errs.length === 0, JSON.stringify(R.errs));

  /* 公司清单从**文件名**推(与 loadDaily() 去掉 " Daily Charting.xlsx" 的规则逐字相同),
   * 不写死那 11 个代码:用户往 Assets 里加一只票是正常操作,不该让测试变红;
   * 但少一只、或多出一只文件里没有的,照样红。
   * 市场级序列 _MARKET-* 不建公司 —— SOXX / HYG / IEF 只以市场序列的身份存在,
   * 一旦漏进公司表,总览表上就会凭空多出三行"公司"。 */
  const EXP = coFiles.map(f => f.replace(/\s+Daily Charting\.xlsx?$/i, '').toUpperCase()).sort();
  ok('公司清单正好等于 Assets 里的公司文件(一只不多一只不少;加票不算回归,漏票必须红)',
    R.cos.join(',') === EXP.join(','), JSON.stringify({ got: R.cos, exp: EXP }));
  ok('市场级序列不建公司:SOXX / HYG / IEF 一个都没混进公司表,清单里也没有任何 _MARKET 字样',
    !R.cos.some(t => /_MARKET/i.test(t))
    && !R.cos.includes('SOXX-US') && !R.cos.includes('HYG-US') && !R.cos.includes('IEF-US'),
    JSON.stringify(R.cos.filter(t => /_MARKET|SOXX|HYG|IEF/i.test(t))));
  /* 角色→代码这张映射表继续写死:它是**约定**(哪只 ETF 当基准/板块/信用/利率),
   * 不是会随导出时间漂的数。根数则改成与 Node 侧逐条对齐,不写 252。 */
  const canon = o => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])));
  const mktExp = {};
  for (const [k, v] of ND.mkt) mktExp[k] = { sym: v.sym, n: v.px.length };
  ok('导出里四条市场级序列各就各位(BENCH=SPY-US / SECTOR=SOXX-US / CREDIT=HYG-US / RATES=IEF-US)'
    + '—— 这条查的是 Assets 里的导出配置齐不齐,浏览器认不认得出来由下一条管',
    canon(Object.fromEntries(Object.entries(mktExp).map(([k, v]) => [k, v.sym])))
    === canon({ BENCH: 'SPY-US', CREDIT: 'HYG-US', RATES: 'IEF-US', SECTOR: 'SOXX-US' }),
    canon(mktExp));
  ok('四条市场级序列的代码与根数,浏览器侧与 Node 侧 loadDaily() 逐条相同(根数以另一套实现为准,不写死 252)',
    canon(R.mkt) === canon(mktExp), JSON.stringify({ browser: canon(R.mkt), node: canon(mktExp) }));
  /* SPY-US 既是公司文件又是 _MARKET-BENCH:两条路各走各的,公司那条照样在 */
  ok('SPY-US 同时以公司文件和 _MARKET-BENCH 出现,两条路互不吞掉(公司表里有,市场序列里也有)',
    R.cos.includes('SPY-US') && R.mkt.BENCH && R.mkt.BENCH.sym === 'SPY-US' && !!R.per['SPY-US'],
    JSON.stringify({ co: R.cos.includes('SPY-US'), mkt: R.mkt.BENCH }));

  /* ---- 逐只:一条降级折线,点数 = 根数,根数 = Node 侧读到的根数 ----
   * 13 / 40 这两个数是**代码常量**不是数据([16] 已把它们钉在 INGEST_MIN_BARS / BACKTEST_MIN_BARS
   * 的定义行上,那边红了这边才有可能跟着错),所以这里可以直接写。 */
  const INGEST_MIN = 13, BT_MIN = 40;
  const bad = [], viaNode = [], viaShort = [];
  for (const t of EXP) {
    const p = R.per[t];
    if (!p) { bad.push([t, '这只票整个没画出来']); continue; }
    if (p.hidden !== false || p.lines !== 1 || p.bodies !== 0) { bad.push([t, p]); continue; }
    if (p.pts !== p.len) { bad.push([t, { why: '点数 ≠ 根数', pts: p.pts, len: p.len }]); continue; }
    const nd = ND.cos.get(t);
    if (nd) {
      viaNode.push(t);
      if (p.len !== nd.length) bad.push([t, { why: '浏览器与 Node 读到的根数不一致', browser: p.len, node: nd.length }]);
    } else {
      viaShort.push(t);
      if (!(p.len >= INGEST_MIN && p.len < BT_MIN)) {
        bad.push([t, { why: 'Node 跳过了它,但它并不短(那就是被弄丢了,不是被下限筛掉的)', len: p.len }]);
      }
    }
  }
  ok('每一只票都画出**恰好一条**降级折线,点数 = 页面读到的根数,且根数与 Node 侧 loadDaily() 一致'
    + '(loadDaily 因 40 根下限跳过的,根数必须落在 [13,40))',
    bad.length === 0, JSON.stringify(bad));
  /* 防空跑:上面那条循环体如果一只票都没进去、或者全走了"短序列"那条宽松分支,
   * 它也会显示 PASS。这里把两条分支各自真的走过几只票摊开来,数为 0 就红。 */
  ok('上一条不是空跑:至少有一只票走了"与 Node 逐条对根数"这条严判据,Node 侧也确实读出了东西',
    EXP.length > 0 && ND.cos.size > 0 && viaNode.length > 0,
    JSON.stringify({ 与Node对齐: viaNode, 短序列走区间判据: viaShort, node读到: [...ND.cos.keys()].sort() }));
  /* 下面两条一律走 (R.per[t] || {}):某只票整个没读进来时要**干净地 FAIL**,
   * 而不是抛 TypeError 把后面的断言一起带走(那样 pass/fail 总数就不可信了)。 */
  ok('真实数据上一根蜡烛都不该有(盘上没有 O/H/L 列),也一点涨跌色都不许有',
    EXP.every(t => (R.per[t] || {}).bodies === 0 && (R.per[t] || {}).delta === false),
    JSON.stringify(EXP.filter(t => (R.per[t] || {}).bodies !== 0 || (R.per[t] || {}).delta !== false)));
  ok('每一只票的面板正文都带着那句"12 格全部未过验收闸门"(不是只有构造夹具那条路才写)',
    EXP.every(t => (R.per[t] || {}).noInd === true),
    JSON.stringify(EXP.filter(t => !(R.per[t] || {}).noInd)));
});

/* ---------- [19] 窄视口:380px 下面板不许横向溢出 ----------------------------
 * 之前所有探针都固定在宽视口上跑,`klNoInd` 那段说明文字很长(它是 K.8 的对外承诺,
 * 不许为了排版删掉),窄屏上一旦把容器撑出横向滚动条,用户就只能看到半句话。
 * 断言落在 scrollWidth vs clientWidth 上,并且要求正文**仍然可见**(offsetHeight > 0)——
 * 光测不溢出,拿 `display:none` 也能满足。 */
await section('[19] 窄视口(380px):面板不横向溢出、图仍画得出、说明文字仍在', async () =>
{
  await page.setViewportSize({ width: 380, height: 900 });
  const V = await page.evaluate(() => {
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    state.overrides.clear(); state.market.clear(); state.roster = null; state.showOffRoster = false;
    const co = { ticker: 'NARROW-US', name: 'Narrow Co', currency: 'USD', price: 251,
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: null }, extra: null };
    state.companies.set(co.ticker, co); state.selected = co.ticker; state.horizon = 'fy1';
    const D = i => new Date(Date.UTC(2026, 0, 5) + i * 86400000).toISOString().slice(0, 10);
    /* 先量降级折线那条路(真实数据走的就是它),再量蜡烛那条路 */
    const probe = () => {
      const sec = $('klSec'), note = $('klNote'), leg = $('klLegend'), box = $('klBox');
      const svg = $('klChart').querySelector('svg');
      const over = n => n.scrollWidth - n.clientWidth;
      const vw = document.documentElement.clientWidth;
      const secRight = sec.getBoundingClientRect().right;
      /* 面板**子树里**伸得最远的那个元素。只看 klSec 自己的 scrollWidth 会漏掉
       * `overflow:visible` 时溢出到外面、把整页撑宽的子节点(tabs 那一行、nowrap 的 tooltip 都可能)。 */
      let worst = { sel: '', right: -1e9 };
      for (const n of sec.querySelectorAll('*')) {
        const bb = n.getBoundingClientRect();
        if (bb.width > 0 && bb.right > worst.right) {
          worst = { sel: n.tagName + (n.id ? '#' + n.id : '') , right: bb.right };
        }
      }
      return {
        secOver: over(sec), boxOver: over(box), noteOver: over(note), legOver: over(leg),
        /* 子树最右边缘相对视口右沿 / 相对面板右沿的超出量 */
        subVw: worst.right - vw, subSec: worst.right - secRight, worstSel: worst.sel,
        svgW: svg ? svg.getBoundingClientRect().width : 0,
        clientW: sec.clientWidth,
        noteH: note.offsetHeight, legH: leg.offsetHeight,
        noteTxt: note.textContent || '',
        /* 正文右边缘不许伸到容器外面 —— 文字溢出未必把 scrollWidth 撑大(overflow 可见时才算) */
        noteRight: note.getBoundingClientRect().right - sec.getBoundingClientRect().right,
      };
    };
    state.priceHist.set(co.ticker, Array.from({ length: 252 }, (_, i) => ({ date: D(i), price: 200 + i })));
    state.klWin = 'all'; renderAll();
    const line = probe();
    state.priceHist.set(co.ticker, Array.from({ length: 252 }, (_, i) => {
      const c = 200 + i; return { date: D(i), price: c, o: c + 3, h: c + 7, l: c - 5 };
    }));
    renderAll();
    const cand = probe();
    const bodies = $('klChart').querySelector('svg').querySelectorAll('rect.klbody').length;
    state.klWin = 'w120';
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    state.selected = null; renderAll();
    return { line, cand, bodies };
  });

  const TOL = 1;   /* 亚像素取整的余量;写 1px 而不是几十,不然这条断言就白写了 */
  ok('380px 下 #klSec 不横向溢出(折线模式与蜡烛模式都不溢出)',
    V.line.secOver <= TOL && V.cand.secOver <= TOL,
    JSON.stringify({ line: V.line.secOver, cand: V.cand.secOver }));
  ok('380px 下图框 / 说明段 / 图例各自也都不横向溢出',
    V.line.boxOver <= TOL && V.line.noteOver <= TOL && V.line.legOver <= TOL
    && V.cand.boxOver <= TOL && V.cand.noteOver <= TOL && V.cand.legOver <= TOL,
    JSON.stringify({ line: [V.line.boxOver, V.line.noteOver, V.line.legOver],
      cand: [V.cand.boxOver, V.cand.noteOver, V.cand.legOver] }));
  /* 注意这里量的是**面板子树**,不是整个文档:380px 下 #app 里另外还有几处横向溢出,
   * 它们与价格走势面板无关,来源已逐个量清楚(实测值,别再照抄旧说法):
   *   · details.help 里那两张静态帮助表格   109.2px  → 已修,见 [20];
   *   · #ovTableWrap > table.ov(总览表)    254.1px(本节这份单公司夹具下)/ 413px(演示数据)
   *   · #mxWrap > table.mx(情景矩阵)        92.1px
   * 后两张是 JS 渲染的动态表格,不在本次范围内,**仍然溢出** —— 见交付说明。
   * (旧注释把那 254.1px 记在帮助表格头上,是记错了:帮助表格是 109.2px,
   *  254.1px 一直是 table.ov。数字来源现在写死在这儿,免得再传一次错。)
   * 这条断言钉的是"klSec 自己一个像素都没往视口外伸",它才是本节该管的事;
   * 只量 klSec.scrollWidth 会漏掉 overflow:visible 时伸到外面去的子节点。 */
  ok('380px 下 #klSec 子树里最靠右的元素也没伸出视口、更没伸出面板自身右沿',
    V.line.subVw <= TOL && V.cand.subVw <= TOL && V.line.subSec <= TOL && V.cand.subSec <= TOL,
    JSON.stringify({ lineVw: V.line.subVw, candVw: V.cand.subVw,
      lineSec: V.line.subSec, candSec: V.cand.subSec, worst: V.cand.worstSel }));
  ok('380px 下 SVG 仍然画得出来,且宽度跟着容器缩(不是被挤成 0,也没有顶着 1100px 硬撑)',
    V.line.svgW > 0 && V.line.svgW <= V.line.clientW + TOL
    && V.cand.svgW > 0 && V.cand.svgW <= V.cand.clientW + TOL && V.cand.svgW < 1100,
    JSON.stringify({ lineW: V.line.svgW, candW: V.cand.svgW, clientW: V.line.clientW }));
  ok('380px 下蜡烛照样是 252 根 —— 窄屏只改布局,不改画出来的东西',
    V.bodies === 252, String(V.bodies));
  ok('380px 下 K.8 那段说明文字仍然完整可见(高度 > 0、"12 格全部未过验收闸门" 还在、右边缘没伸出容器)',
    V.line.noteH > 0 && V.cand.noteH > 0 && V.line.legH > 0
    && /12 格/.test(V.line.noteTxt) && /全部未过验收闸门/.test(V.line.noteTxt)
    && /12 格/.test(V.cand.noteTxt) && /全部未过验收闸门/.test(V.cand.noteTxt)
    && V.line.noteRight <= TOL && V.cand.noteRight <= TOL,
    JSON.stringify({ h: [V.line.noteH, V.cand.noteH], right: [V.line.noteRight, V.cand.noteRight] }));

  await page.setViewportSize({ width: 1280, height: 720 });
});

/* ---------- [20] 静态帮助表格在 380px 下不许把 #app 撑出视口 ------------------
 * 这块 DOM 是 src/index.html 里写死的 <details class="help">,两张三列表格
 * ("列 / 含义 / FactSet 参考字段")。它们没有 width,走 shrink-to-fit,而
 * shrink-to-fit = max(min-content, available);第三列里 `FE_ESTIMATE("EPS",
 * "LOW|MEAN|HIGH",…,+1)` 是一个不含空格的 token,默认不拆,把那一列的 min-content
 * 顶到 ~299px,整张表 min-content = 444.2px。380px 下可用宽度只有
 * 380 − 48(.wrap padding) − 42(.card padding+border) = 290px,于是表格右沿
 * 伸出视口 109.2px,details 一展开整页就横向滚 —— **未载入任何数据时就已经这样**。
 *
 * 修法:src/styles/base.css 里 @media (max-width: 560px) 把表格改成堆叠卡片。
 * 本节钉三件事,少一件这个修复就可以被悄悄退回去:
 *   ① 380px 下 #app 子树里最靠右的元素不许伸出视口(把 media block 删掉 → 红);
 *   ② 不许靠"藏起来"过关:每一行仍然可见,code token 一个都没少;
 *   ③ 1280px 下仍是原样的三列表格(把 media query 的宽度限制去掉 → 红)。 */
await section('[20] 静态帮助表格:380px 下不撑宽 #app,1280px 下不退化', async () =>
{
  /* 让页面回到"空页面"状态:动态表格(table.ov / table.mx)不在场,
   * 这样 #app 子树里最靠右的元素就只可能是这张静态帮助表格 —— 断言指向唯一。 */
  const measure = () => page.evaluate(() => {
    state.companies.clear(); state.history.clear(); state.priceHist.clear();
    state.overrides.clear(); state.market.clear(); state.roster = null; state.showOffRoster = false;
    state.selected = null; renderAll();
    const dt = document.querySelector('details.help');
    dt.open = true;                                        // 收起来的表格量不出宽度
    const app = document.getElementById('app');
    const vw = document.documentElement.clientWidth;
    let worst = { sel: '', over: -1e9 };
    for (const n of app.querySelectorAll('*')) {
      const bb = n.getBoundingClientRect();
      if (bb.width > 0 && bb.right - vw > worst.over) {
        worst = { over: bb.right - vw, sel: n.tagName + (n.id ? '#' + n.id : '')
          + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/)[0] : '') };
      }
    }
    const tbl = [...document.querySelectorAll('details.help table')];
    const t0 = tbl[0], rows = t0 ? [...t0.rows] : [];
    const body = rows.slice(1);
    const cellTops = body.length ? [...body[0].cells].map(c => Math.round(c.getBoundingClientRect().top)) : [];
    const txt = t0 ? t0.textContent.replace(/\s+/g, ' ') : '';
    return {
      over: +worst.over.toFixed(1), worstSel: worst.sel,
      docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      nTables: tbl.length, nRows: rows.length,
      allRowsVisible: body.length > 0 && body.every(r => r.offsetHeight > 0),
      tblOver: t0 ? t0.scrollWidth - t0.clientWidth : -1,
      /* 三列同排 = 还是一张真正的表格;各占一行 = 已经堆叠 */
      oneLine: cellTops.length > 1 && new Set(cellTops).size === 1,
      headVisible: rows.length ? rows[0].offsetHeight > 0 : false,
      txt,
    };
  });

  await page.setViewportSize({ width: 380, height: 1200 });
  const N = await measure();
  await page.setViewportSize({ width: 1280, height: 900 });
  const W = await measure();
  await page.evaluate(() => { document.querySelector('details.help').open = false; });

  const TOL = 1;
  ok('380px 下 #app 子树里最靠右的元素没有伸出视口(静态帮助表格不再把整页撑横)',
    N.over <= TOL && N.docOver <= TOL,
    JSON.stringify({ over: N.over, worst: N.worstSel, docOver: N.docOver }));
  ok('380px 下两张帮助表格都还在、每一行都可见,且表格自身没有内部横向裁切(不是靠隐藏内容过关)',
    N.nTables === 2 && N.nRows === 6 && N.allRowsVisible && N.tblOver <= TOL,
    JSON.stringify({ nTables: N.nTables, nRows: N.nRows, vis: N.allRowsVisible, tblOver: N.tblOver }));
  ok('380px 下字段名一个都没被折断或删掉(eps_fy1_low / _mean / _high、FG_PRICE、price_date 原样都在)',
    /eps_fy1_low \/ _mean \/ _high/.test(N.txt) && /eps_fy2_low \/ _mean \/ _high/.test(N.txt)
    && N.txt.includes('FG_PRICE') && N.txt.includes('price_date') && N.txt.includes('ticker'),
    N.txt.slice(0, 160));
  ok('380px 下确实换成了堆叠布局(三格各占一行),而不是靠横向滚动条把 444px 藏起来',
    !N.oneLine && !N.headVisible, JSON.stringify({ oneLine: N.oneLine, head: N.headVisible }));
  ok('1280px 下没有退化:仍是三列同排的表格、表头在、整页也不溢出',
    W.oneLine && W.headVisible && W.over <= 0 && W.docOver <= TOL && W.nRows === 6,
    JSON.stringify({ oneLine: W.oneLine, head: W.headVisible, over: W.over, docOver: W.docOver }));
});

/* ---------- [21] 三态分流本身:不碰真实数据,任何机器上都跑得动 ---------------
 * [18] 现在会在"没有 Assets/charting"时跳过,而跳过是**不影响退出码**的路 ——
 * 那这条路自己就必须被测:判据要是写错(比如把 'empty' 也当成 'no-dir'),
 * 回归会被悄悄咽掉,而且恰恰咽在最没人盯着的那台新机器上。
 * 这里用 mkdtempSync 造三棵假树,只喂文件名、不喂任何 xlsx 内容,断言
 * chartingStatus() 的 state 和 _MARKET- 前缀分类 —— 与真实导出彻底无关。
 * 顺带补上"新克隆上什么都测不了"的空档:哪怕 [18] 整段跳过,这一段照跑照红。
 * 临时目录跑完删干净,并且**断言它真的被删掉了**(测试不许在 /tmp 里留垃圾)。 */
await section('[21] chartingStatus() 三态分流与跳过入口(用临时假树,不依赖授权数据)', async () =>
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prg-charting-'));
  const mk = (name, sub) => { const r = path.join(TMP, name); fs.mkdirSync(path.join(r, ...sub), { recursive: true }); return r; };
  try {
    /* ① 连 Assets 都没有 = 新克隆的样子 */
    const rNone = mk('none', []);
    const sNone = chartingStatus(rNone);
    /* ② 有 Assets、但没有 charting 子目录 —— 同样算"从没装过",不许因为
     *    父目录碰巧在就判成别的状态(用户可能只有 Assets/news 之类) */
    const rNoSub = mk('nosub', ['Assets', 'news']);
    const sNoSub = chartingStatus(rNoSub);
    ok('没有 Assets/ → state=\'no-dir\',三个文件数组都是空的,dir 指向 <root>/Assets/charting',
      sNone.state === 'no-dir' && sNone.files.length === 0 && sNone.coFiles.length === 0
      && sNone.mktFiles.length === 0 && sNone.dir === path.join(rNone, 'Assets', 'charting'),
      JSON.stringify(sNone));
    ok('有 Assets/ 但没有 charting/ → 仍然是 \'no-dir\'(判据看的是 charting 目录本身,不是父目录)',
      sNoSub.state === 'no-dir', JSON.stringify(sNoSub));

    /* ③ 目录在、空的 → 'empty'。这是"装过又被清掉"的样子,必须与 no-dir 分开 */
    const rEmpty = mk('empty', ['Assets', 'charting']);
    const sEmpty = chartingStatus(rEmpty);
    /* ④ 目录里有东西、但没有一份导出(.gitkeep / 说明文件不算数据)→ 还是 'empty' */
    const rJunk = mk('junk', ['Assets', 'charting']);
    fs.writeFileSync(path.join(rJunk, 'Assets/charting/.gitkeep'), '');
    fs.writeFileSync(path.join(rJunk, 'Assets/charting/readme.txt'), '放导出的地方');
    const sJunk = chartingStatus(rJunk);
    ok('目录在但一个文件都没有 → state=\'empty\'(而不是 no-dir:这是被弄丢,不是没装过)',
      sEmpty.state === 'empty' && sEmpty.files.length === 0, JSON.stringify(sEmpty));
    ok('目录里只有 .gitkeep / readme.txt 这类非导出文件 → 仍是 \'empty\'(闸门只认 .xlsx/.xls)',
      sJunk.state === 'empty' && sJunk.files.length === 0, JSON.stringify(sJunk));

    /* ⑤ 塞假文件名(只有名字,内容是空的 —— 三态判据不许去读文件内容) */
    const rOk = mk('ok', ['Assets', 'charting']);
    const NAMES = ['AAA-US Daily Charting.xlsx', 'BBB-US Daily Charting.xls',
      '_MARKET-BENCH SPY-US Daily Charting.xlsx',
      '_market-credit HYG-US Daily Charting.xlsx',   // 小写:前缀判定必须大小写不敏感
      'notes.txt', 'Options.csv'];                   // 噪声:不是导出,不许混进 files
    for (const n of NAMES) fs.writeFileSync(path.join(rOk, 'Assets/charting', n), '');
    const sOk = chartingStatus(rOk);
    ok('塞了假导出文件名 → state=\'ok\',files 只收 .xlsx/.xls(notes.txt / Options.csv 被挡在外面)且已排序',
      sOk.state === 'ok' && sOk.files.length === 4
      && sOk.files.join('|') === [...sOk.files].sort().join('|')
      && !sOk.files.some(f => /\.(txt|csv)$/i.test(f)),
      JSON.stringify(sOk.files));
    ok('_MARKET- 前缀分类正确:两份市场级序列(含小写 _market-)进 mktFiles,两份公司文件进 coFiles',
      sOk.coFiles.join('|') === 'AAA-US Daily Charting.xlsx|BBB-US Daily Charting.xls'
      && sOk.mktFiles.length === 2
      && sOk.mktFiles.every(f => /^_market-/i.test(f))
      && sOk.coFiles.every(f => !/^_market-/i.test(f))
      && sOk.coFiles.length + sOk.mktFiles.length === sOk.files.length,
      JSON.stringify({ co: sOk.coFiles, mkt: sOk.mktFiles }));

    /* ⑥ 跳过入口只对 'no-dir' 开放:拿别的状态调它必须抛,而且不许污染 skipped 计数。
     *    这条钉的是"跳过被误用来掩盖真问题"这个口子 —— 它一旦松了,[18] 的 empty
     *    分支再严也没用,因为谁都能绕过去。 */
    const before = skipped.length;
    const threw = st => { try { skipNoDirOnly('不该出现的跳过', st); return false; } catch { return true; } };
    ok('跳过入口只认 \'no-dir\':传 empty / ok / undefined 一律抛异常(抛在段体里 = 一条 FAIL,误用只会更红)',
      threw({ state: 'empty', dir: 'x' }) && threw({ state: 'ok', dir: 'x' }) && threw(undefined),
      '有状态被放行了');
    ok('那三次误用一次都没进跳过计数(跳过数不许被 no-dir 之外的东西撑大)',
      skipped.length === before, JSON.stringify({ before, after: skipped.length, skipped }));

    /* ⑦ 退出码那条开关。默认下"跳过不退 1"是给**人**用的(新机器第一次跑不该迎面一片红),
     *    可机器不看横幅:一台只读退出码、或者只拿 /\d+ passed, 0 failed/ 抓日志的 CI,
     *    会把"没数据的半套"当全绿收下。--require-data 就是堵这个的。
     *    这里直接钉判定函数本身,而不是"跑一遍看看退出码几" —— 后者在有数据的机器上
     *    根本走不到跳过那条分支,等于没测。 */
    const EC = [
      ['没 FAIL 没跳过,默认', exitCodeFor(0, 0, false), 0],
      ['没 FAIL 有跳过,默认 → 放行(用户拍的板)', exitCodeFor(0, 1, false), 0],
      ['没 FAIL 有跳过,开了 --require-data → 判失败', exitCodeFor(0, 1, true), 1],
      ['有 FAIL 没跳过 → 永远 1', exitCodeFor(2, 0, false), 1],
      ['有 FAIL 又有跳过 → 还是 1,开关不许把真 FAIL 洗白', exitCodeFor(2, 3, false), 1],
      ['开关只管跳过:没跳过时打开它也不许平白变红', exitCodeFor(0, 0, true), 0],
    ];
    ok('退出码判定六种组合全对(真 FAIL 永远 1;--require-data 只在"没 FAIL 但有跳过"时才改结论)',
      EC.every(([, got, exp]) => got === exp),
      JSON.stringify(EC.filter(([, got, exp]) => got !== exp)));
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
    ok('临时假树已删干净(测试不许在 ' + os.tmpdir() + ' 里留垃圾)', !fs.existsSync(TMP), TMP);
  }
});

/* ---------- [22] setup.mjs 的准备决策:纯函数,不 spawn、不下载 ----------------
 * 为什么这一段非有不可:tools/setup.mjs 是**新机器上第一个跑起来的东西**,而它最关键的
 * 几条判断恰恰是这台 Linux 机器永远走不到的 —— npm 在 Windows 上叫 npm.cmd、spawn 一个
 * .cmd 必须开 shell(CVE-2024-27980 之后不开会抛 EINVAL)。判错了,用户拿到的是
 * "spawnSync npm ENOENT" 这种指着错方向的报错,而我们这边一路全绿。
 * 所以口径必须由**纯函数**钉死,在任何平台上都能验。
 *
 * 规矩(和 [21] 同款):
 *   1. 只 import setup.mjs 里的纯函数来断言,**不许**在这里复制一份逻辑对着比 ——
 *      复制品和本体一起改错时两边照样相等,那测的是复制品不是产品;
 *   2. 一个子进程都不起、一个字节都不下载 —— 这段必须在没网、没依赖的机器上也能跑;
 *   3. setup.mjs 有 import.meta.url === argv[1] 的入口守卫,import 它不会触发 main()。
 * 与 `node tools/setup.mjs --selftest` 重复是**故意的**:selftest 是开发者手动跑的,
 * npm test 才是闸门。只活在 selftest 里的规矩,等于没有人守着。 */
await section('[22] setup.mjs 的准备决策与 Windows 口径(纯函数,不 spawn、不下载)', async () =>
{
  const S = await import('../tools/setup.mjs');

  /* --- (a) Windows 专属口径:这台机器永远验不到,只能靠纯函数钉 --- */
  ok('npmBin:win32 → npm.cmd,linux/darwin → npm(判错 win32 那侧就是 spawnSync npm ENOENT,' +
     '一句让用户去重装 Node 的假线索,而机器上明明装着)',
    S.npmBin('win32') === 'npm.cmd' && S.npmBin('linux') === 'npm' && S.npmBin('darwin') === 'npm',
    JSON.stringify({ win32: S.npmBin('win32'), linux: S.npmBin('linux'), darwin: S.npmBin('darwin') }));
  ok('needsShell:win32 上的 .cmd/.bat 必须开 shell(Node 修 CVE-2024-27980 之后,' +
     '不开 shell 直接 spawn 批处理会抛 EINVAL),大小写不敏感',
    S.needsShell('npm.cmd', 'win32') === true && S.needsShell('run-factset.bat', 'win32') === true
    && S.needsShell('SETUP.BAT', 'win32') === true,
    JSON.stringify(['npm.cmd', 'run-factset.bat', 'SETUP.BAT'].map(c => S.needsShell(c, 'win32'))));
  ok('needsShell:win32 上的 node.exe 不开 shell,POSIX 一律不开(哪怕名字里带 .cmd)—— ' +
     '多开的 shell 会把参数重新过一遍分词,是白送的注入面',
    S.needsShell('C:\\Program Files\\nodejs\\node.exe', 'win32') === false
    && S.needsShell('npm.cmd', 'linux') === false && S.needsShell('npm', 'darwin') === false,
    JSON.stringify({ nodeExe: S.needsShell('C:\\x\\node.exe', 'win32'), posixCmd: S.needsShell('npm.cmd', 'linux') }));

  /* --- (b) 浏览器决策矩阵:五种结论 + 三条优先级,整张表一次过 ---
   * 合并成 boolean 的诱惑在于"反正都是不装",但这五种不装要说的话完全不同:
   * 已经有了 / 你自己关了 / 你答了不要 / 这里没人能回答 / 装。糊成一个,用户只能猜。 */
  const B = o => S.decideBrowser(o).action;
  const MATRIX = [
    ['已经有 chromium → ready,不重复下 150MB',            { found: true },                                    'ready'],
    ['已经有了时 --yes 也不许重下',                          { found: true, yes: true },                         'ready'],
    ['已经有了时 --no-browser 也只报 ready(明明有,不许说成"你自己关的")',
                                                            { found: true, noBrowser: true },                   'ready'],
    ['--no-browser → off',                                  { found: false, noBrowser: true },                  'off'],
    ['--no-browser 压过 --yes:明确说不要就不许装',           { found: false, noBrowser: true, yes: true },       'off'],
    ['--yes → 直接装,不问',                                 { found: false, yes: true },                        'install'],
    ['没 TTY 且没 --yes → noask,绝不背着人下 150MB',        { found: false, interactive: false },               'noask'],
    ['没 TTY 但给了 --yes → 还是装(CI 明确要就给)',         { found: false, interactive: false, yes: true },    'install'],
    ['有 TTY 又没答 → ask(而不是替人做主)',                 { found: false, interactive: true },                'ask'],
    ['答了要 → install',                                     { found: false, answer: true },                     'install'],
    ['答了不要 → declined(和 off / noask 分开记,措辞不一样)', { found: false, answer: false },                  'declined'],
  ];
  const bad = MATRIX.filter(([, inp, exp]) => B(inp) !== exp).map(([n, inp]) => n + '→' + B(inp));
  ok('decideBrowser 决策矩阵十一种输入全对(含三条优先级:found > noBrowser > yes > 非交互)',
    bad.length === 0, bad.join(' ; '));
  ok('decideBrowser:五种结论各带一句非空 why,且五句话互不相同 —— ' +
     '五种"不装"共用一句文案,用户就只能看到"跳过浏览器"然后猜为什么',
    (() => {
      const whys = [{ found: true }, { found: false, noBrowser: true }, { found: false, yes: true },
        { found: false, interactive: false }, { found: false, answer: false }]
        .map(o => S.decideBrowser(o).why);
      return whys.every(w => typeof w === 'string' && w.length > 0) && new Set(whys).size === 5;
    })());
  /* 交互那条的答案是 yesish() 给的,所以两个函数要接得上:Windows 上双击之后直接敲回车
   * 是最常见的操作,提示写的是 [Y/n],大写那个就是默认值 —— 空回车必须落到 install。 */
  ok('yesish + decideBrowser 接得上:空回车 / y / 是 → install,n / no / 否 / 不要 / 不行 → declined',
    ['', '  ', 'y', 'YES', '是', '好'].every(a => B({ found: false, answer: S.yesish(a) }) === 'install')
    && ['n', 'no', '否', '不要', '不行', 'asdf'].every(a => B({ found: false, answer: S.yesish(a) }) === 'declined'),
    JSON.stringify(['', 'y', '是', 'n', '否', '不要'].map(a => a + '=>' + B({ found: false, answer: S.yesish(a) }))));

  /* --- (c) 退出码:skip 不许影响它 ---
   * 浏览器没装成、--skip-test 都会记成 skip,那都是用户自己选的(或可选组件的小意外)。
   * 把用户的选择表现成失败,他下次就不敢选,只好每次都等那 150MB。 */
  const St = (...st) => st.map((s, i) => ({ id: 'x' + i, status: s }));
  const EC = [
    ['全 ok → 0', S.exitCodeFor(St('ok', 'ok', 'ok')), 0],
    ['有 skip 没 fail → 0(跳过是用户自己选的,不许表现成失败)', S.exitCodeFor(St('ok', 'skip', 'skip')), 0],
    ['全是 skip → 还是 0', S.exitCodeFor(St('skip', 'skip')), 0],
    ['有 fail → 1', S.exitCodeFor(St('ok', 'skip', 'fail')), 1],
    ['fail 排在最后也要抓到 → 1', S.exitCodeFor(St('ok', 'ok', 'fail')), 1],
    ['空数组 → 0(一步都没跑不算失败)', S.exitCodeFor([]), 0],
  ];
  ok('exitCodeFor:只有 fail 退 1,skip 一概不参与(六种组合全对)',
    EC.every(([, got, exp]) => got === exp),
    JSON.stringify(EC.filter(([, got, exp]) => got !== exp)));

  /* --- (d) 结构性:安装器不许依赖 node_modules ---
   * 硬规矩 1。setup.mjs 的正职就是在 npm install **之前**跑起来,它要是自己 import 了
   * 一个第三方包,在最需要它的那一刻恰好起不来 —— 而且报出来的是
   * ERR_MODULE_NOT_FOUND,和它本来要替用户翻译的那句错一模一样。
   * 这条在 --selftest 里也有一份,重复是故意的:那份是开发者手动跑的,这份才在闸门上。 */
  const setupSrc = fs.readFileSync(path.join(ROOT, 'tools', 'setup.mjs'), 'utf8');
  const setupImports = [...setupSrc.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  ok('tools/setup.mjs 顶层 import 全是 node: 内置模块(安装器不许自己依赖 node_modules)',
    setupImports.length > 0 && setupImports.every(m => m.startsWith('node:')),
    setupImports.join(' , '));

  /* --- (e) setup.bat 的字节口径 ---
   * 这条是**唯一**能在 Linux 上守住那个 .bat 的闸门,理由是两个 cmd.exe 的老毛病:
   *   1. cmd.exe 按**当时的控制台代码页**读 .bat(中文 Windows 默认 936/GBK)。
   *      文件里只要有一个非 ASCII 字节,在别的代码页下就是乱码 —— 轻则提示看不懂,
   *      重则乱码字节把命令行本身撕坏。所以中文提示得靠 node 那边输出,.bat 里一个都不许有。
   *   2. cmd.exe 是**一行一行**读 .bat 的,多行 IF / FOR 块靠 CRLF 断行;只有 LF 时
   *      整块会被当成一行喂进解析器,报一句 "( 此时不应有 xxx" 这种完全指错方向的错。
   * 所以这两条不是风格洁癖,是"双击之后到底跑不跑得起来"。 */
  const batPath = path.join(ROOT, 'setup.bat');
  ok('根目录 setup.bat 在(README 和 [22] 都指着它,文件没了就是死链)', fs.existsSync(batPath), batPath);
  const bat = fs.existsSync(batPath) ? fs.readFileSync(batPath) : Buffer.alloc(0);
  const nonAscii = [];
  for (let i = 0; i < bat.length && nonAscii.length < 5; i++) if (bat[i] > 0x7f) nonAscii.push({ at: i, byte: bat[i] });
  ok('setup.bat 全文件没有一个非 ASCII 字节(cmd.exe 按当时的控制台代码页读 .bat,' +
     '中文 Windows 默认 936 —— 非 ASCII 在别的代码页下就是乱码,中文提示一律交给 node 输出)',
    bat.length > 0 && nonAscii.length === 0, JSON.stringify(nonAscii));
  const loneLF = [];
  for (let i = 0; i < bat.length && loneLF.length < 5; i++) if (bat[i] === 0x0a && bat[i - 1] !== 0x0d) loneLF.push(i);
  ok('setup.bat 全文 CRLF 换行,一个裸 LF 都没有(cmd.exe 逐行读 .bat,LF-only 会把多行 IF 块' +
     '当成一行解析,报一句 "( 此时不应有 xxx" 之类完全指错方向的错)',
    bat.length > 0 && loneLF.length === 0 && bat.includes(0x0a), JSON.stringify(loneLF));

  /* --- (f) setup.bat 里四条"行为不是语法"的钉子 ---
   * bat-lint 查得了字节和跳转,查不了语义;这四条全是**只在新机器上才发作**的坑,
   * 本机跑一百遍都绿。写在这里是因为它们看着都像"多余的一行",最容易被后来人顺手删掉。 */
  const batTxt = bat.toString('latin1');
  const iPath = batTxt.indexOf('set "PATH=%%~dpD;%PATH%"');
  const iHand = batTxt.indexOf('"%NODE_EXE%" "tools\\setup.mjs"');
  ok('setup.bat 在交棒给 setup.mjs 之前把 node 所在目录塞进了 PATH(刚装完 Node 的窗口里 PATH 还是旧的,' +
     '而 setup.mjs 第 1/5 步 spawn 的 npm.cmd 是靠 PATH 找的 —— 少这一行,新机器第一次跑必然 ENOENT,' +
     '这个脚本存在的唯一场景直接失效)',
    iPath > 0 && iHand > 0 && iPath < iHand, `PATH 注入@${iPath} / 交棒@${iHand}`);

  ok('setup.bat 接住了 winget 的退出码并且有 :wingetfailed 这条岔路(UAC 被拒也是非零退出;' +
     '不看退出码就会把"没权限装"说成"PATH 还没刷新,重开窗口再来" —— 用户照做,再被拒,无限循环)',
    /winget install[^\r\n]*\r\nset "WRC=%ERRORLEVEL%"/.test(batTxt)
      && batTxt.includes('if not "%WRC%"=="0" goto wingetfailed')
      && /^:wingetfailed$/m.test(batTxt),
    'WRC 捕获 + 判断 + 标签,三样缺一不可');

  ok('setup.bat 的装 Node 分支只认显式的 y/yes,别的一律走 :declined(stdin 在 EOF 时 set /p 根本不赋值,' +
     '默认"装"就等于背着人下一个安装包,和 setup.mjs 硬规则 2 直接打架)',
    batTxt.includes('if /i "%ANS%"=="y"   goto doinstall')
      && batTxt.includes('if /i "%ANS%"=="yes" goto doinstall')
      && /goto doinstall\r\ngoto declined\r\n/.test(batTxt),
    '两条 y 判断之后必须紧跟兜底的 goto declined');

  ok('setup.bat 在 cd /d 之后做了肯定式验证(UNC 路径下 cmd 把那句拒绝打到 stdout、' +
     'errorlevel 还可能是 0 —— 只看 errorlevel 会带着错的 cwd 一路走到"仓库不完整"这种指错方向的结论)',
    batTxt.includes('if not exist "%CD%\\setup.bat" goto badcwd'),
    '要求 cd 之后本文件确实在当前目录里看得见');
});

await section('[23] 输入护栏与方向模拟可复现性', async () => {
  const got = await page.evaluate(async () => {
    const co = { ticker: 'GUARD-US', name: 'Guard', currency: 'USD', price: 100, priceSrc: 'file', priceDate: '2026-01-01',
      eps: { fy1: { low: 4, mean: 5, high: 6 }, fy2: { low: 5, mean: 6, high: 7 } }, extra: {} };
    state.companies.set(co.ticker, co); state.selected = co.ticker;
    const px = document.getElementById('pxInput');
    px.value = ''; px.dispatchEvent(new Event('input', { bubbles: true }));
    const afterBlank = { price: co.price, src: co.priceSrc, date: co.priceDate,
      visible: !document.getElementById('pxError').hidden, invalid: px.getAttribute('aria-invalid') };
    px.dispatchEvent(new Event('blur'));
    const afterBlur = { value: px.value, visible: !document.getElementById('pxError').hidden,
      text: document.getElementById('pxError').textContent, invalid: px.getAttribute('aria-invalid') };
    px.value = '0'; px.dispatchEvent(new Event('input', { bubbles: true }));
    const afterZero = { price: co.price, src: co.priceSrc, invalid: px.getAttribute('aria-invalid') };

    const setPe = (id, value) => { const e = document.getElementById(id); e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); };
    setPe('peP25', '30'); setPe('peP50', '20'); setPe('peP75', '10');
    const peBad = { calc: peStats(co.ticker), visible: !document.getElementById('peManualError').hidden,
      invalid: document.getElementById('peP50').getAttribute('aria-invalid') };
    setPe('peP25', '10'); setPe('peP50', '20'); setPe('peP75', '30');
    const peGood = { calc: peStats(co.ticker), hidden: document.getElementById('peManualError').hidden };

    state.priceHist.set(co.ticker, Array.from({ length: 40 }, (_, i) => ({ date: '2026-01-' + String(i + 1).padStart(2, '0'), price: 90 + i * .5 })));
    renderDirection(co, calcRange(co, 'fy1')); const dirA = document.getElementById('dirOut').textContent;
    renderDirection(co, calcRange(co, 'fy1')); const dirB = document.getElementById('dirOut').textContent;

    let calls = 0; const realDirection = renderDirection;
    renderDirection = (...args) => { calls++; return realDirection(...args); };
    scheduleDirection(co, calcRange(co, 'fy1')); scheduleDirection(co, calcRange(co, 'fy1')); scheduleDirection(co, calcRange(co, 'fy1'));
    await new Promise(resolve => setTimeout(resolve, 180));
    renderDirection = realDirection;

    return { afterBlank, afterBlur, afterZero, peBad, peGood, dirA, dirB, calls,
      labels: ['pxInput', 'epsLow', 'epsMean', 'epsHigh', 'peP25', 'peP50', 'peP75'].every(id => document.getElementById(id).labels.length === 1),
      described: ['peP25', 'peP50', 'peP75'].every(id => document.getElementById(id).getAttribute('aria-describedby') === 'peManualError') };
  });
  ok('清空或输入 0 不覆盖现价及其来源', got.afterBlank.price === 100 && got.afterBlank.src === 'file'
    && got.afterBlank.date === '2026-01-01' && got.afterBlank.visible && got.afterBlank.invalid === 'true'
    && got.afterZero.price === 100 && got.afterZero.src === 'file'
    && got.afterZero.invalid === 'true', JSON.stringify(got));
  ok('无效现价失焦后恢复原值，并留下可见的恢复说明', got.afterBlur.value === '100'
    && got.afterBlur.visible && got.afterBlur.text.includes('100') && got.afterBlur.invalid === 'false', JSON.stringify(got.afterBlur));
  ok('手工 PE 通过真实 input 事件校验：无序时拒绝计算并显示反馈，有序时恢复',
    got.peBad.calc === null && got.peBad.visible && got.peBad.invalid === 'true'
      && got.peGood.calc && got.peGood.hidden, JSON.stringify(got));
  ok('方向面板真实连续渲染结果完全稳定', got.dirA && got.dirA === got.dirB, JSON.stringify(got));
  ok('连续三次调度只执行一次方向计算', got.calls === 1, JSON.stringify(got));
  ok('现价/EPS/PE 标签都关联到控件，PE 错误与三个输入关联', got.labels && got.described, JSON.stringify(got));

  await page.setViewportSize({ width: 280, height: 700 });
  const tip = await page.evaluate(() => {
    const co = state.companies.get('GUARD-US');
    renderOvChart([{ co, r: { coreLow: 80, coreHigh: 120, mid: 100, downPct: -20, upPct: 20, midPct: 0 } }]);
    const hit = document.querySelector('#ovChart svg rect[fill="transparent"]');
    hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 0, clientY: 100 }));
    const e = document.getElementById('ovTip'); return { left: parseFloat(e.style.left), shown: e.style.display };
  });
  ok('窄屏真实 pointermove 后 tooltip 不越过左边界', tip.shown === 'block' && tip.left >= 0, JSON.stringify(tip));
  await page.setViewportSize({ width: 1280, height: 900 });
});

await browser.close();
/* ---------- 结尾摘要:跳过必须说实话 ----------
 * 规则(不许改回去):
 *   1. 跳过数为 0 时,这行输出与历来**逐字相同** —— 正常路径不许添噪音,
 *      也不许让 CI 里那些按 "N passed, M failed" 抓正则的地方失配;
 *   2. 有跳过时,除了把跳过数加进摘要,还要**单独喊一句**:这一次不是完整验收、
 *      跳的是哪一段、为什么跳。跳过既然不影响退出码,那就只能靠喊得够响来防滥用;
 *   3. 退出码默认只由 fail 决定,跳过不参与(除非显式打开 --require-data,给 CI 用)
 *      —— 目录不存在退 0(新克隆的正常状态),
 *      目录空退 1(那是 [18] 记的一条真 FAIL)。 */
if (!skipped.length) {
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
} else {
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed, ${skipped.length} skipped`);
  console.log(BAR);
  console.log('  ⚠  这一次**不是完整验收**:' + skipped.length + ' 段整段没跑 —— '
    + skipped.join('、'));
  console.log('  ⚠  原因:本机没有 Assets/charting(FactSet 授权数据,.gitignore 挡掉,新克隆一定没有)。');
  console.log('  ⚠  上面的绿只代表"代码逻辑没坏",**不代表真实导出跑得通**;');
  console.log('     拿这次结果当"全绿"汇报是不成立的。补上数据后重跑即可(跳过段会自己跑起来)。');
  if (REQUIRE_DATA) {
    console.log('  ⚠  --require-data 已打开:这次按**失败**处理(退出码 1)。');
  } else {
    console.log('     给 CI 用:npm run test:full(= --require-data),那边有跳过就直接判失败。');
  }
  console.log(BAR + '\n');
}
process.exit(exitCodeFor(fail, skipped.length, REQUIRE_DATA));
