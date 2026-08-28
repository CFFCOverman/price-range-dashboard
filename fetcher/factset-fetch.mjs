/**
 * factset-fetch.mjs — 自动抓取 Price Range Dashboard 所需的 FactSet 数据(入口)
 *
 * 抓什么(每个 ticker):
 *   1. Estimate History FY1 + FY2(逐月一致预期:Mean/Low/High/上调下调家数/P⁄E)→ xlsx
 *   2. 当前价格(从页面头部)→ 汇总进 companies.csv
 *   3. Targets & Ratings(History 视图月度表:目标价均值/评级分布)→ xlsx
 *   4. Ownership 空头持仓(回补天数/占流通盘%)→ short-interest.csv(逐日累积)
 *   5. StreetAccount 新闻标题(近一年)→ "{ticker} News.csv"(逐轮累积去重)
 *   6. 期权链未平仓量 OI(尽力而为;账号无期权权限就跳过)→ "{ticker} Options.csv"(逐轮累积)
 *   7. Charting 日线数据导出(尽力而为;失败会提示手动)→ xlsx
 *      顺带尽力开启成交量序列 → 仪表盘压力位用真实筹码分布(拿不到就退回停留时间口径,不阻断)
 * 输出全部写入仓库根的 Assets/ —— 按数据类型分子目录(estimates / charting / targets /
 * news / options / summary),日志与台账在 Assets/_logs/。仪表盘的文件夹扫描会往下钻 3 层
 * 且按文件名认数据,所以分不分子目录都能"连接文件夹/重新扫描"直接食用。
 *
 * 代码在哪(FactSet 改版时按这张表找,不用通读全文):
 *   lib/    config 路径与开关 · log 进度条 · ledger 台账 · browser 启动与跨 iframe 原语
 *           tickers/markets 清单 · menu 控制台 · registry 产出登记 · health 体检
 *           companies 新鲜度与 csv · round 单轮编排 · selftest 纯函数自检
 *   steps/  一个抓取步骤一个文件:estimates / price / targets / short-interest /
 *           news / options / charting,外加 ticker.mjs(单公司 8 步编排)
 *   页面被重新设计时,坏掉的一定是 steps/ 里的某一个文件 —— 台账 sources.txt 的
 *   "失败环节"列会直接点名是哪一步,照名字打开对应文件即可。
 *
 * 出问题时:菜单输 chk 做数据体检,或直接看 Assets/_logs/sources.txt 台账 ——
 * 每个产出文件一行,FAIL 行的"失败环节"会指出断在导航/等待页面/切换 Report Type/定位表格/解析行/写文件 哪一步。
 *
 * 首次使用:
 *   npm init -y && npm i playwright xlsx
 *   node factset-fetch.mjs --login     ← 打开浏览器,手动登录 FactSet 一次(登录态存在本地 profile 里)
 * 日常使用:
 *   node factset-fetch.mjs             ← 全自动跑完 TICKERS 列表
 *   node factset-fetch.mjs --selftest  ← 只跑纯函数自检,不开浏览器
 *
 * 注意:请遵守你的 FactSet 许可条款;本脚本仅自动化你有权手动执行的导出,低频个人使用。
 */
/* 这一行必须排在 config 之前:config 的 OUT_DIR 是模块顶层 const,一旦求值就定死了,
 * 而 ESM 的 import 全部先于模块体执行——把"自检改写输出目录"做成一个更早的 import 是唯一时机。
 * 详见 lib/selftest-env.mjs 顶部的说明。 */
import './lib/selftest-env.mjs';
import { FETCHER_DIR, LOGIN_ONLY, OUT_DIR } from './lib/config.mjs';

/* --selftest 优先短路:此路径不碰浏览器,也不能创建 readline(否则无终端环境会挂住),
 * 所以下面的主流程全部用动态 import —— 静态 import 会在自检之前就把菜单模块执行掉。 */
if (process.argv.includes('--selftest')) {
  const { runSelftest } = await import('./lib/selftest.mjs');
  await runSelftest();   /* async(里面有 await 的断言);自行 process.exit(0/1) */
}

/* 先把旧版本留下的文件搬到位,再让任何模块去读它们(tickers.txt 尤其不能读空) */
const { migrateLegacyLayout } = await import('./lib/migrate.mjs');
const migrateNote = migrateLegacyLayout();

const browser = await import('./lib/browser.mjs');   /* ctx 是会被重新赋值的活绑定,必须整体持有 */
const { log } = await import('./lib/log.mjs');
const { RL, manageMenu } = await import('./lib/menu.mjs');
const { runRound } = await import('./lib/round.mjs');
const { maybeMonthlyBacktest } = await import('./lib/backtest.mjs');
const { runFetcherLoop } = await import('./lib/menu-actions.mjs');

if (LOGIN_ONLY) await browser.ensureBrowser();   /* --login 模式无需菜单,直接开窗 */

/* ============ 一级菜单循环：启动与每轮结束回到同一处 ============ */
console.log('============ FactSet 数据拉取 · Price Range Dashboard ============');
console.log('  输出目录: ' + OUT_DIR + '  (按类型分子目录,日志与台账在 _logs/)');
console.log('  配置目录: ' + FETCHER_DIR + '  (tickers.txt / markets.txt / .options-url)');
if (migrateNote) console.log(migrateNote);
console.log('  流程: 一级菜单输入 run → Chrome 默认后台拉取 → 回到同一菜单');
console.log('==================================================================');

/* 对齐检查放在菜单之前:Assets/ 里有数据、清单里却没登记的标的,每一轮都在被静默跳过,
 * 而仪表盘扫的是文件夹不是清单——所以它照样显示,只是数据停在几周前。补进清单,并当场告诉你补了谁。 */
const { reconcileReport } = await import('./lib/reconcile.mjs');
reconcileReport({ apply: true });

/* 对齐完再写 roster.csv —— 顺序不能反:对齐那一步会把"有数据没登记"的代码补进清单,
 * 先写就会写出一份少了它们的清单,仪表盘据此把刚补进来的公司藏起来一整轮。
 * 同时清理落榜满一年的数据(挪进 _to_delete/,不删)。见 lib/roster.mjs 顶部。 */
const { rosterReport } = await import('./lib/roster.mjs');
rosterReport({ apply: true });
let btDone = false;
try {
  await runFetcherLoop({
    interactive: !!RL, menu: manageMenu, runRound,
    afterRound: async () => {
      if (!btDone) { btDone = true; maybeMonthlyBacktest(new Date().toISOString().slice(0, 10)); }
    },
  });
  log('已退出。');
} finally {
  /* 某个抓取步骤抛错时也必须释放 persistent profile；否则遗留 Chrome 会让下一轮以 exit code 21 立即失败。 */
  if (RL) RL.close();
  if (browser.ctx) await browser.ctx.close().catch(() => {});
}
