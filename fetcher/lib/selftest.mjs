/* lib/selftest.mjs — --selftest:纯函数自检,不开浏览器
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import * as XLSX from 'xlsx';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KINDS, classifyAssetFile, reconcileTickers, scanAssets } from './reconcile.mjs';
import { IGNORE_LINE } from './tickers.mjs';
import { RETAIN_DAYS, ROSTER_FILE, ROSTER_HEADER, pickOrphans, rosterCsv } from './roster.mjs';
import { SELFTEST_SANDBOX } from './selftest-env.mjs';
import { FETCHER_DIR, LIB_DIR, LOG_DIR, OUT_DIR, ROOT_DIR, assetPath, assetSubdir, envFlag } from './config.mjs';
import { LED_COLS, SOURCES_FILE, clean } from './ledger.mjs';
import { LOG_FILE } from './log.mjs';
import { CHART_DIAG_FILE, dumpChartDiag, formatChartDiag, scrubSecrets } from './chart-diag.mjs';
import {
  CHART_PROBES, OHLC_LABELS, OHLC_MENUS, OHLC_SERIES_MENUS, RANGE_LABELS, RANGE_MENUS, VOL_MENUS,
  spanNote, spanOK, xlsxDateSpan, xlsxHasOHLC, xlsxHasVolume,
} from '../steps/charting.mjs';
import { estimateRowsVerdict, fyTag, rowsWithOneRetry, saveEstimateXlsx, shiftLabel } from '../steps/estimates.mjs';
import { csvCell, parseNewsDate, parseNewsRows, splitCsvLine } from '../steps/news.mjs';
import { ingestOptExports, optExportFresh, optSymOf, parseOptExpiry, parseOptNum, parseOptSheetName, parseOptionRows, parseOptionsExport } from '../steps/options.mjs';
import { OPT_URL_FILE, expandOptUrl, expandOptUrlVariants, optionsUrlCandidates, templatizeOptUrl } from './options-url.mjs';
import { assembleOptionRows, bareSym, chunk, daysBetween, ocDate, optApiVerdict, parseFqlValues, parseOptionChainTable, pickChainContracts } from './fql.mjs';
import { mergeOptionSnapshots } from './opt-store.mjs';
import { BT_SCRIPT, backtestDue, btExitNote, pickLastRunDate } from './backtest.mjs';
import { parseShortInt, shortIntDiagnosis, shortIntSanity, siBlockTooWide } from '../steps/short-interest.mjs';
import { FRESH_HOURS, freshHoursFor, hasPriceToday, priceMap } from './companies.mjs';
import { metaCharting, metaCompanies, metaEst, metaNews, metaOptions, metaShortInt, metaTargets } from './registry.mjs';
import { factsetSessionValid, headlessMode, initialHeadless, loginFallback } from './browser-policy.mjs';
import { menuCommand, menuScreen, openDashboardAction, openPathSpec, runFetcherLoop } from './menu-actions.mjs';

/* --selftest:不开浏览器,验证核心逻辑(财年判定/标签位移/xlsx 写读回)
 * async 是为了 dumpChartDiag 那一组:它本身是 async(要 await 页面采集),
 * 而"它在各种失败姿势下都不抛"这件事只有真 await 一次才测得到 —— 不 await 的话
 * 抛出来的是一个 rejected promise,自检会绿着跑过去,而线上那一步已经挂了。 */
export async function runSelftest() {
  let fail = 0;
  const eq = (got, want, name) => {
    if (got === want) console.log('  PASS', name, '=', got);
    else { console.log('  FAIL', name, 'got', got, 'want', want); fail++; }
  };
  eq(menuCommand(''), 'empty', '菜单空回车只留在菜单');
  eq(menuCommand('', true), 'exit', '菜单 EOF/终端关闭安全退出,不当成空回车');
  eq(menuCommand('run'), 'run', '菜单 run 明确开始拉取');
  eq(menuCommand('拉取'), 'run', '菜单中文拉取别名');
  eq(menuCommand('exit'), 'exit', '菜单 exit 明确退出');
  eq(menuCommand('dashboard'), 'dashboard', '菜单 dashboard 打开仪表盘');
  eq(menuCommand('仪表盘'), 'dashboard', '菜单中文仪表盘别名');
  eq(menuCommand('1'), 'run', '菜单数字 1 = 开始拉取');
  eq(menuCommand('2'), 'dashboard', '菜单数字 2 = 打开仪表盘');
  eq(menuCommand('3'), 'health', '菜单数字 3 = 数据体检');
  eq(menuCommand('4'), 'edit', '菜单数字 4 = 编辑公司清单');
  eq(menuCommand('5'), 'markets', '菜单数字 5 = 编辑市场清单');
  eq(menuCommand('6'), 'sync', '菜单数字 6 = 数据对齐');
  eq(menuCommand('7'), 'sources', '菜单数字 7 = 来源台账');
  eq(menuCommand('8'), 'backtest', '菜单数字 8 = 回测');
  eq(menuCommand('0'), 'exit', '菜单数字 0 = 退出');
  eq(menuCommand('NVDA-US'), 'other', '代码仍交给清单增删逻辑');
  const ms = menuScreen(['META-US', 'NVDA-US'], [['SPY-US', 'BENCH']]);
  eq(ms.includes('公司  2 家') && ms.includes('META-US') && ms.includes('[1] 开始拉取'), true,
    '菜单首页同时显示清单摘要和编号操作,不用记命令');
  const opened = [];
  const od = openDashboardAction({ platform: 'win32', appHtml: 'C:\\x\\dash.html', exists: () => true, launch: s => opened.push(s) });
  eq(od.ok && opened.length, 1, 'Dashboard 动作可注入,自检不真开窗');
  eq(opened[0].command, 'start "" "C:\\x\\dash.html"', 'Windows Dashboard 命令带完整引号');
  eq(JSON.stringify(openPathSpec('darwin', '/x/dash.html')), '{"file":"open","args":["/x/dash.html"]}',
    'macOS Dashboard 使用 open 且路径作为独立参数');
  eq(JSON.stringify(openPathSpec('darwin', '/x/tickers.txt', true)), '{"file":"open","args":["-e","/x/tickers.txt"]}',
    'macOS 文本配置使用 TextEdit 打开');
  eq(openDashboardAction({ platform: 'linux', appHtml: '/x/dash.html', exists: () => true, launch: () => {} }).ok, true,
    'Linux 使用 xdg-open,不再误报只能手动打开');
  eq(openDashboardAction({ platform: 'win32', appHtml: 'missing', exists: () => false, launch: () => {} }).ok, false,
    'Dashboard 文件缺失明确失败');
  const actions = ['run', 'run', 'exit']; let menuN = 0, roundN = 0, afterN = 0; const ioTrace = [];
  await runFetcherLoop({ interactive: true, menu: async () => actions[menuN++],
    runRound: async () => { ioTrace.push('round'); roundN++; }, afterRound: async () => { ioTrace.push('after'); afterN++; },
    pauseInput: () => ioTrace.push('pause'), resumeInput: () => ioTrace.push('resume') });
  eq(`${menuN}/${roundN}/${afterN}`, '3/2/2', '交互循环:启动进菜单,每轮后回同一菜单,exit 才停');
  eq(ioTrace.join(','), 'resume,pause,round,after,resume,resume,pause,round,after,resume,resume',
    '交互输入只在菜单启用:抓取期间暂停,每轮结束即恢复(提前输入的下一条命令不能被静默吞掉)');
  let cronMenu = 0, cronRound = 0, cronAfter = 0;
  await runFetcherLoop({ interactive: false, menu: async () => { cronMenu++; return 'exit'; },
    runRound: async () => { cronRound++; }, afterRound: async () => { cronAfter++; } });
  eq(`${cronMenu}/${cronRound}/${cronAfter}`, '0/1/1', '无 TTY:不进菜单,自动单轮后退出');
  eq(freshHoursFor('legacy.csv'), FRESH_HOURS, 'fresh legacy string keeps 20h');
  eq(freshHoursFor(metaCompanies()), 0, 'fresh price every round');
  eq(freshHoursFor(metaEst('T-US', 'FY1')), 96, 'fresh estimates 4d');
  eq(freshHoursFor(metaTargets('T-US')), 144, 'fresh targets 6d');
  eq(freshHoursFor(metaCharting('T-US')), 20, 'fresh charting daily');
  eq(freshHoursFor(metaCharting('SPY-US', '_MARKET-BENCH SPY-US Daily Charting.xlsx', 'market')), 20, 'fresh market daily');
  eq(freshHoursFor(metaNews('T-US')), 20, 'fresh news daily');
  eq(freshHoursFor(metaOptions('T-US')), 20, 'fresh options daily');
  eq(freshHoursFor(metaShortInt()), 20, 'fresh short daily');
  eq(freshHoursFor({ file: 'x', kind: 'targets' }, 7), 7, 'fresh explicit override wins');
  const oldPriceRow = priceMap.get('FRESH-TEST');
  priceMap.set('FRESH-TEST', 'FRESH-TEST,FRESH-TEST,USD,10,2026-08-25,,,,,,');
  eq(hasPriceToday('FRESH-TEST', '2026-08-25'), true, 'price same date fresh');
  eq(hasPriceToday('FRESH-TEST', '2026-08-26'), false, 'price next date stale');
  if (oldPriceRow === undefined) priceMap.delete('FRESH-TEST'); else priceMap.set('FRESH-TEST', oldPriceRow);
  eq(headlessMode(undefined), 'auto', 'browser 默认 auto');
  eq(headlessMode('0'), 'visible', 'FS_HEADLESS=0 强制可见');
  eq(headlessMode('1'), 'headless', 'FS_HEADLESS=1 强制后台');
  eq(headlessMode('1', true), 'visible', '--login 始终可见,压过 FS_HEADLESS=1');
  eq(initialHeadless('auto'), true, 'auto 首次后台启动');
  eq(initialHeadless('visible'), false, 'visible 首次有窗口');
  eq(loginFallback('auto'), 'relaunch-visible', 'auto 登录失效时重开可见窗口');
  eq(loginFallback('visible'), 'wait-visible', '强制可见在原窗口等登录');
  eq(loginFallback('headless'), 'error', '强制后台登录失效时报错');
  eq(factsetSessionValid('https://my.apps.factset.com/workstation/'), true, 'workstation URL 认作已登录');
  eq(factsetSessionValid('https://id.factset.com/auth/login'), false, 'SSO URL 认作未登录');
  let badHeadless = false; try { headlessMode('yes'); } catch { badHeadless = true; }
  eq(badHeadless, true, 'FS_HEADLESS 非法值明确拒绝');
  const browserSrc = fs.readFileSync(path.join(LIB_DIR, 'browser.mjs'), 'utf8');
  const iFallback = browserSrc.indexOf("fallback === 'relaunch-visible'");
  const iClose = browserSrc.indexOf('await closeBrowser()', iFallback);
  const iVisible = browserSrc.indexOf('await launchBrowser(false)', iFallback);
  eq(iFallback >= 0 && iClose > iFallback && iVisible > iClose, true,
    'auto 重开顺序:先 close persistent context,再 launch visible(不并发占 profile)');
  const forcedBlock = browserSrc.slice(browserSrc.indexOf("fallback === 'error'"), iFallback);
  eq(/await closeBrowser\(\)/.test(forcedBlock) && /FS_HEADLESS=1/.test(forcedBlock) && /fetch:login/.test(forcedBlock), true,
    '强制后台登录失效:关闭 context 并给出可执行指引');
  const loginBlock = browserSrc.slice(browserSrc.indexOf('if (LOGIN_ONLY)'), browserSrc.indexOf('log(\'⏳ 正在检查'));
  eq(/await page\.goto\(BASE\)/.test(loginBlock) && /waitForEvent\('close'/.test(loginBlock), true,
    '--login 行为:打开首页并等用户关窗');
  eq(fyTag("Jan '27E"), 'FY1', "fyTag Jan'27E");
  eq(fyTag("Jan '28E"), 'FY2', "fyTag Jan'28E");
  eq(fyTag("Dec '26E"), 'FY1', "fyTag Dec'26E");
  eq(fyTag("Dec '27E"), 'FY2', "fyTag Dec'27E");
  eq(shiftLabel("Jan '27E", 1), "Jan '28E", 'shiftLabel +1');
  eq(shiftLabel("Dec '27E", -1), "Dec '26E", 'shiftLabel -1');
  const fake13 = [["28 Jul '26", '9.00', '-', '47', '35', '1', '8.20', '9.85', '0.32', '0.3', '0.02', '21.9', '0.6']];
  const fake12 = [["28 Jul '26", '12.75', '45', '35', '1', '9.65', '16.45', '1.29', '0.9', '0.11', '15.4', '0.4']];
  eq(saveEstimateXlsx('TEST-US', 'FY1', [['junk'], ...fake13]), true, 'save 13-col');
  eq(saveEstimateXlsx('TEST-US', 'FY2', [['junk'], ...fake12]), true, 'save 12-col');
  const badPe = Array.from({ length: 24 }, (_, i) => [`${String(28 - (i % 20)).padStart(2, '0')} Jul '26`, '9.00', '-', '47', '35', '1', '8.20', '9.85', '0.32', '0.3', '0.02', '-', '-']);
  eq(estimateRowsVerdict('FY1', badPe).ok, false, 'FY1 盈利为正但 P/E 整列为空:判异常,不准覆盖 last-good');
  eq(estimateRowsVerdict('FY2', badPe).ok, true, 'FY2 不冒充 FY1 分位,但也不被 FY1 专用护栏误杀');
  const lossPe = badPe.map(r => [r[0], '-0.20', ...r.slice(2)]);
  eq(estimateRowsVerdict('FY1', lossPe).ok, true, '亏损公司没有 P/E 是合法形状,不无限重试');
  let retryN = 0;
  const retried = await rowsWithOneRetry(async () => (++retryN === 1 ? badPe : fake13),
    rows => estimateRowsVerdict('FY1', rows));
  eq(`${retryN}/${retried.attempts}/${retried.verdict.ok}`, '2/2/true', '首次 P/E 异常立即重拉一次,第二次正常才交付');
  retryN = 0;
  const twiceBad = await rowsWithOneRetry(async () => { retryN++; return badPe; }, rows => estimateRowsVerdict('FY1', rows));
  eq(`${retryN}/${twiceBad.attempts}/${twiceBad.verdict.ok}`, '2/2/false', '连续两次异常后停止重拉并进入保护路径');
  const beforeGuard = fs.readFileSync(assetPath('TEST-US FY1 Estimate History.xlsx'));
  eq(saveEstimateXlsx('TEST-US', 'FY1', badPe, 'bad retry', { quarantine: true }), false,
    '第二次仍异常返回失败,让台账明确标红');
  const afterGuard = fs.readFileSync(assetPath('TEST-US FY1 Estimate History.xlsx'));
  eq(Buffer.compare(beforeGuard, afterGuard), 0, '异常导出不覆盖标准文件');
  const rejectedDir = path.join(LOG_DIR, 'rejected-estimates');
  eq(fs.existsSync(rejectedDir) && fs.readdirSync(rejectedDir).some(f => /TEST-US FY1 Estimate History\.xlsx$/.test(f)), true,
    '连续两次异常样本进入 _logs/rejected-estimates 隔离目录');
  const wbBack = XLSX.read(fs.readFileSync(assetPath('TEST-US FY2 Estimate History.xlsx')), { type: 'buffer' });
  const back = XLSX.utils.sheet_to_json(wbBack.Sheets['TEST-US'], { header: 1 });
  eq(String(back[2][2]), 'Sharp Cons', 'header col3');
  eq(String(back[3][1]), '12.75', 'FY2 mean roundtrip');
  eq(String(back[3][6]), '9.65', 'FY2 low in col7 (Sharp Cons 补位正确)');
  const si = parseShortInt('Float (%)96.15Short Interest2.5 Days/1.39% of FloatCurrent Valuation');
  eq(si && si.days, 2.5, 'shortInt days');
  eq(si && si.pct, 1.39, 'shortInt pct');
  eq(parseShortInt('no match here'), null, 'shortInt null');
  /* 改版容错:两个数字各读各的,读到一个就不该把它一起扔掉 */
  const siSplit = parseShortInt('Short Interest\nDays to Cover\n3.4\nShort Interest % of Float\n2.10\n');
  eq(siSplit && siSplit.days, 3.4, 'shortInt 拆表格 days');
  eq(siSplit && siSplit.pct, 2.1, 'shortInt 拆表格 pct');
  const siPctOnly = parseShortInt('Short Interest 1.85% of Free Float');
  eq(siPctOnly && siPctOnly.pct, 1.85, 'shortInt 只有占比时仍返回');
  eq(siPctOnly && isFinite(siPctOnly.days), false, 'shortInt 缺天数记为 NaN 而非 0');
  eq(parseShortInt('Days to Cover 1,234.5')?.days ?? null, null, 'shortInt 量纲护栏挡掉离谱天数');
  eq(parseShortInt('Short Interest 640% of Float'), null, 'shortInt 量纲护栏挡掉离谱占比');
  /* 量级自洽:读到数字 ≠ 读对了格子。2026-07-29 那一轮全是"成功"的错数字 */
  eq(shortIntSanity(2.5, 1.39), null, 'shortInt 自洽 正常值放行');
  eq(/不可能/.test(shortIntSanity(1.6, 68.7) || ''), true, 'shortInt 自洽 挡下 AMD 68.7%(实为隔壁那格)');
  eq(/不可能/.test(shortIntSanity(2.5, 72.1) || ''), true, 'shortInt 自洽 挡下 NVDA 72.1%');
  eq(shortIntSanity(2.2, 6.1), null, 'shortInt 自洽 换手率比值在量级内就放行');
  eq(/没读到/.test(shortIntSanity(2.5, NaN) || ''), true, 'shortInt 自洽 缺占比直接判失败');
  eq(shortIntSanity(NaN, 3.2), null, 'shortInt 自洽 缺天数时只卡绝对上限');
  /* 失败诊断:必须把页面原文摘出来,否则下次改版还是只能"再开一次浏览器" */
  eq(/没有出现/.test(shortIntDiagnosis(null)), true, 'shortInt 诊断 无面板');
  eq(/1\.39% of Float/.test(shortIntDiagnosis('xxShort Interest 2.5 Days / 1.39% of Float yy')), true, 'shortInt 诊断 摘原文');
  /* ---- 2026-07-30:下面这几条用的是**实地抄回来的原文**,不是想象中的写法 ----
   * 页面真正写的是 “SHORT INTEREST 2.5 DAYS / 1.4% FLOAT” —— 大写、没有 of。
   * 上面那批断言全都带着 of,所以它们一直是绿的,而线上七只标的全读错了。
   * 断言写得像页面而不像正则,才能挡住下一次。 */
  const siNVDA = parseShortInt('SHORT INTEREST 2.5 DAYS / 1.4% FLOAT');
  eq(siNVDA && siNVDA.days, 2.5, 'shortInt 真实原文 NVDA days(无 of)');
  eq(siNVDA && siNVDA.pct, 1.4, 'shortInt 真实原文 NVDA pct(无 of)');
  const siAMD = parseShortInt('SHORT INTEREST 1.6 DAYS / 2.5% FLOAT');
  eq(siAMD && siAMD.days, 1.6, 'shortInt 真实原文 AMD days');
  eq(siAMD && siAMD.pct, 2.5, 'shortInt 真实原文 AMD pct');
  const siSPCX = parseShortInt('SHORT INTEREST 2.2 DAYS / 25.8% FLOAT');
  eq(siSPCX && siSPCX.days, 2.2, 'shortInt 真实原文 SPCX days');
  eq(siSPCX && siSPCX.pct, 25.8, 'shortInt 真实原文 SPCX pct');
  /* 25.8% 是真的高,但 25.8/2.2 ≈ 11.7 的换手率在量级内 —— 自洽护栏不许误伤它 */
  eq(shortIntSanity(2.2, 25.8), null, 'shortInt 自洽 真实高空头 SPCX 不误杀');
  /* 反向断言:三块统计并排时,旧代码在这里读回 72.1(机构持股)。它必须只读自己那一格。 */
  const SI_THREE = 'SHORT INTEREST 2.5 DAYS / 1.4% FLOAT FLOAT 96.2% INST. OWNERSHIP 72.1% OF FLOAT';
  const siWide = parseShortInt(SI_THREE);
  eq(siWide && siWide.pct, 1.4, 'shortInt 反向 三块并排时仍读自己那格(旧代码读回 72.1)');
  eq(siWide && siWide.days, 2.5, 'shortInt 反向 三块并排时天数也不串格');
  /* 连天数都没有时,快路径锚不住 —— 此时宁可失败,也不许松正则去够隔壁的 72.1 */
  eq(parseShortInt('SHORT INTEREST 1.4% FLOAT FLOAT 96.2% INST. OWNERSHIP 72.1% OF FLOAT'), null,
    'shortInt 反向 范围过宽且锚不住时拒绝猜');
  eq(parseShortInt(SI_THREE.replace('2.5 DAYS / ', ''), { wide: true }), null,
    'shortInt wide 整页文本只认严格写法');
  eq(siBlockTooWide('SHORT INTEREST 2.5 DAYS / 1.4% FLOAT'), false, 'shortInt 宽度判据 单格放行');
  eq(siBlockTooWide(SI_THREE), true, 'shortInt 宽度判据 三个百分号判为过宽');
  /* 新闻日期解析(注入固定"今天" 2026-07-29 以免测试随时间漂移) */
  const REF = '2026-07-29T12:00:00Z';
  eq(parseNewsDate('00:06', REF), '2026-07-29', 'newsDate 仅时间=当天');
  eq(parseNewsDate("27 Jul '26", REF), '2026-07-27', 'newsDate 带年份');
  eq(parseNewsDate("3 Jan '26", REF), '2026-01-03', 'newsDate 单位数日');
  eq(parseNewsDate('27 Jul', REF), '2026-07-27', 'newsDate 缺年份=今年');
  eq(parseNewsDate('15 Dec', REF), '2025-12-15', 'newsDate 缺年份且未来→去年');
  eq(parseNewsDate('Date/Time', REF), null, 'newsDate 表头行被滤掉');
  /* CSV 转义 + 回读(标题里几乎一定有逗号和引号) */
  eq(csvCell('a,b'), '"a,b"', 'csv 逗号加引号');
  eq(csvCell('say "hi"'), '"say ""hi"""', 'csv 引号转义');
  eq(csvCell('plain'), 'plain', 'csv 无需转义');
  const rt = splitCsvLine(['2026-07-29', 'NVDA-US,HUT-US', 'Buy, says "X"'].map(csvCell).join(','));
  eq(rt.length, 3, 'csv 回读列数');
  eq(rt[1], 'NVDA-US,HUT-US', 'csv 回读含逗号字段');
  eq(rt[2], 'Buy, says "X"', 'csv 回读含引号字段');
  /* 新闻行解析:表头被滤、行情括号被剥、ID 列保留 */
  const nrows = [['Date/Time', 'ID', 'Headline'],
    ["27 Jul '26", 'HUT-US,NVDA-US', 'NVIDIA behind up to $50B worth of leases ($196.51, 0.00)'],
    ['00:06', 'NVDA-US', 'Short headline here today']];
  const nrec = parseNewsRows(nrows, REF);
  eq(nrec.length, 2, 'newsRows 只留数据行');
  eq(nrec[0].headline.endsWith('leases'), true, 'newsRows 剥掉尾部行情括号');
  eq(nrec[0].date, '2026-07-27', 'newsRows 日期');
  /* 台账九列:含分隔符的字段被清洗,回读不错位 */
  const ledLine = ['OK', 'X · 步骤', 'X.csv', 'A > B', '说明|含竖线', '2026-07-29 00:00Z', '-', '-', 'https://x/y']
    .map(clean).join(' | ');
  eq(ledLine.split('|').length, LED_COLS, '台账列数固定为 9');
  eq(ledLine.split('|')[4].trim(), '说明 / 含竖线', '台账字段内竖线被清洗');
  /* 成交量判定:以文件内容为准。FactSet 导出的列名是 "NVDA-US - Volume",
   * 裸 "Volume" 也认;但 "Volume Weighted..." 之类的衍生列不该误判成真成交量。 */
  const mkVolXlsx = (hdr, name) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ["28 Jul '26", 100, 5000]]), 'S');
    const p = assetPath(name);
    XLSX.writeFile(wb, p);
    return p;
  };
  eq(xlsxHasVolume(mkVolXlsx(['Date', 'TEST-US - Price', 'TEST-US - Volume'], '_selftest vol.xlsx')), true, 'hasVolume FactSet 列名');
  eq(xlsxHasVolume(mkVolXlsx(['Date', 'Close', 'Volume'], '_selftest vol2.xlsx')), true, 'hasVolume 裸 Volume');
  eq(xlsxHasVolume(mkVolXlsx(['Date', 'Close', 'Volume Weighted Avg Price'], '_selftest novol.xlsx')), false, 'hasVolume 不误判衍生列');
  eq(xlsxHasVolume(assetPath('_selftest 不存在.xlsx')), false, 'hasVolume 文件缺失=false 不抛错');

  /* ---- 时间跨度与 OHLC:和成交量同一套路数 —— 布局改没改成,只有导出文件说了算 ----
   * 下面的表头和日期形态都是照着 Assets/charting/*.xlsx 里真实那份抄的:
   * 表头 ["Date","NVIDIA Corp - Close","Volume"],日期是 Excel 序列号(45874 = 2025-08-05),
   * 253 行 = 表头 + 252 个交易日,正好一年。编一份"差不多的"就只是在测我对自己正则的记忆力。 */
  const XL0 = Date.UTC(1899, 11, 30);
  const ser = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - XL0) / 86400000);
  const mkSheet = (hdr, rows, name) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...rows]), 'Worksheet');
    const p = assetPath(name);
    XLSX.writeFile(wb, p);
    return p;
  };
  eq(ser('2025-08-05'), 45874, '日期序列号换算和真导出对得上(45874 = 2025-08-05)');
  const CLOSE_HDR = ['Date', 'NVIDIA Corp - Close', 'Volume'];
  const oneYear = mkSheet(CLOSE_HDR, [
    [ser('2025-08-05'), 178.26, 156407600], [ser('2026-02-02'), 190.1, 1e8], [ser('2026-08-05'), 219.22, 158187404],
  ], '_selftest span1y.xlsx');
  const S1 = xlsxDateSpan(oneYear);
  eq(S1 && S1.rows, 3, '跨度 数据行数不含表头');
  eq(S1 && S1.first + '→' + S1.last, '2025-08-05→2026-08-05', '跨度 起止日期从序列号还原成人看得懂的日子');
  eq(S1 && Number(S1.years.toFixed(1)), 1.0, '跨度 眼下真实的那一份就是一年');
  eq(spanOK(S1), false, '跨度 一年不达标');
  eq(spanNote(S1), '跨度仍是 1 年', '跨度 一年时说人话:"仍是 1 年",不是干巴巴的 false');
  const fiveYear = mkSheet(CLOSE_HDR, [
    [ser('2021-08-05'), 50, 1e8], [ser('2026-08-05'), 219.22, 1e8],
  ], '_selftest span5y.xlsx');
  const S5 = xlsxDateSpan(fiveYear);
  eq(Number(S5.years.toFixed(1)), 5.0, '跨度 五年那份算出来就是 5.0');
  eq(spanOK(S5), true, '跨度 五年达标');
  /* 4.98 年:5Y 布局按自然日切出来常是这个数。卡死 5.0 会把一次成功判成失败 */
  eq(spanOK(xlsxDateSpan(mkSheet(CLOSE_HDR, [[ser('2021-09-01'), 50], [ser('2026-08-05'), 219]], '_selftest span498.xlsx'))),
    true, '跨度 差几天不到整五年也算成(判定留了半年余量)');
  eq(spanNote(xlsxDateSpan(mkSheet(CLOSE_HDR, [[ser('2023-08-05'), 50], [ser('2026-08-05'), 219]], '_selftest span3y.xlsx'))),
    '跨度只有 3.0 年', '跨度 三年既不是"一年"也不是达标,措辞要分得开');
  /* 这一条抄的是 Assets/charting/SPCX-US 的真实形状:36 行、2026-06-12 → 2026-08-04。
   * 它短是因为新上市,不是因为布局没切成 —— 报成"仍是 1 年"就是拿现成结论盖住另一个事实。 */
  eq(spanNote(xlsxDateSpan(mkSheet(CLOSE_HDR, [[ser('2026-06-12'), 10], [ser('2026-08-04'), 12]], '_selftest spanshort.xlsx'))),
    '跨度只有 0.1 年', '跨度 新上市那种两个月的历史照实说,不套用"仍是 1 年"');
  /* 日期写成文本(改版真会这么干)也得读得出来,否则会误报成"读不出" */
  eq(xlsxDateSpan(mkSheet(CLOSE_HDR, [['2021-08-05', 50], ['2026-08-05', 219]], '_selftest spantxt.xlsx')).years.toFixed(1),
    '5.0', '跨度 日期是 ISO 文本时照样算得出');
  eq(xlsxDateSpan(mkSheet(CLOSE_HDR, [['08/05/2021', 50], ['08/05/2026', 219]], '_selftest spanus.xlsx')).years.toFixed(1),
    '5.0', '跨度 日期是美式 MM/DD/YYYY 时照样算得出');
  /* 这两条是这一整块里最要紧的:"读不出"必须和"读出来是一年"分开。
   * 合成一个 boolean,就是又一次把"没有证据"和"证据表明坏了"塞进同一个分支。 */
  eq(xlsxDateSpan(mkSheet(['Symbol', 'Close'], [['NVDA', 1], ['NVDA', 2]], '_selftest spannone.xlsx')), null,
    '跨度 没有日期列时返回 null(而不是 0 年)—— 这是"没验证过",不是"跨度不够"');
  eq(spanNote(null), '跨度未知', '跨度 未知就说未知,不许伪装成"仍是 1 年"');
  eq(spanOK(null), false, '跨度 未知一律不算达标');
  eq(xlsxDateSpan(assetPath('_selftest 不存在.xlsx')), null, '跨度 文件缺失=null 不抛错');
  /* 量纲护栏:价格、成交量也是数字。不设界的话 178.26 会被当成 1900 年的某一天 */
  eq(xlsxDateSpan(mkSheet(['Date', 'Close'], [[178.26, 1], [219.22, 2]], '_selftest spanjunk.xlsx')), null,
    '跨度 第一列是价格而非日期时拒绝解释(否则会读出"跨度 126 年")');
  /* OHLC:开高低三列齐了才算 */
  eq(xlsxHasOHLC(oneYear), false, '有 OHLC 眼下真实那份只有收盘价 → false');
  eq(xlsxHasOHLC(mkSheet(['Date', 'NVIDIA Corp - Open', 'NVIDIA Corp - High', 'NVIDIA Corp - Low',
    'NVIDIA Corp - Close', 'Volume'], [[ser('2026-08-05'), 1, 2, 0.5, 1.5, 100]], '_selftest ohlc.xlsx')),
  true, '有 OHLC FactSet 列名("公司名 - Open"这种)');
  eq(xlsxHasOHLC(mkSheet(['Date', 'Open', 'High', 'Low', 'Close'], [[ser('2026-08-05'), 1, 2, 0.5, 1.5]], '_selftest ohlc2.xlsx')),
    true, '有 OHLC 裸列名');
  eq(xlsxHasOHLC(mkSheet(['Date', 'NVIDIA Corp - Open', 'NVIDIA Corp - High', 'NVIDIA Corp - Close'],
    [[ser('2026-08-05'), 1, 2, 1.5]], '_selftest ohlc3.xlsx')),
  false, '有 OHLC 缺 Low 就不算(画不出下影线、算不了真实波幅,那是另一种东西)');
  eq(xlsxHasOHLC(mkSheet(['Date', 'Open', '52 Week High', '52 Week Low', 'Close'],
    [[ser('2026-08-05'), 1, 2, 0.5, 1.5]], '_selftest ohlc4.xlsx')),
  false, '有 OHLC 不误判衍生列(52 Week High 不是当天最高价)');
  eq(xlsxHasOHLC(assetPath('_selftest 不存在.xlsx')), false, '有 OHLC 文件缺失=false 不抛错');

  /* ================ 图表布局诊断(lib/chart-diag.mjs)================
   * 这一整组存在的理由:trySetRange5Y / tryEnableOHLC 里的菜单文案和点击顺序**全是猜的**,
   * 一次都没在真界面上验过。既然验不了,那就必须保证"失败时交出的证据"是可靠的 ——
   * 证据不可靠的话,下一轮还是只能接着猜。
   * 下面测的**不是**那几个选择器对不对(那要真登录才知道),而是三件能在这里测死的事:
   *   ① 候选清单没有被抄成两份(抄两份就会说岔);
   *   ② 诊断在各种失败姿势下都交得出东西、且绝不抛;
   *   ③ 报告里一个能登录的串都不许有。③ 是红线 —— 这份日志是要发出去的。 */

  /* ① 候选清单:逐字钉死内容和顺序。写成 length >= 4 之类就是空断言 —— 这个仓库栽过三次 */
  eq(RANGE_LABELS.join('|'), '5y|5Y|5 Years|5 Year|5Yr|5yr', '诊断 时间跨度候选逐字不变');
  eq(RANGE_MENUS.join('|'), 'Date Range|Range|Period|Time Frame|Timeframe|Zoom', '诊断 时间跨度菜单入口逐字不变');
  eq(OHLC_LABELS.join('|'), 'Candlestick|Candle|OHLC|Bar', '诊断 K 线候选逐字不变(Bar 排最后是因为它太短容易撞)');
  eq(OHLC_MENUS.join('|'), 'Chart Type|Chart Style|Series Type|Style', '诊断 图表类型菜单入口逐字不变');
  eq(OHLC_SERIES_MENUS.join('|'), 'Series|Edit Series|Studies|Study', '诊断 Series 层菜单入口逐字不变');
  eq(VOL_MENUS.join('|'), 'Studies|Study|Indicators|Add Study', '诊断 成交量菜单入口逐字不变(这一组是唯一走通过的)');
  eq(CHART_PROBES.length, 6, '诊断 六组候选全部报给用户,不挑着报');
  eq(CHART_PROBES.map(p => p[1].length).join(','), '6,6,4,4,4,4', '诊断 每组的候选个数');
  eq(CHART_PROBES[0][1] === RANGE_LABELS && CHART_PROBES[2][1] === OHLC_LABELS, true,
    '诊断 报给用户的清单和真正点击时用的是**同一个数组**,不是抄写(抄写迟早说岔)');

  /* ③ 脱敏:先单条钉死每一类的写法,再在下面做一次整份报告的红线检查 */
  eq(scrubSecrets('https://my.apps.factset.com/workstation/charting/?sessionId=abc123&x=1'),
    'https://my.apps.factset.com/workstation/charting/?[已隐去]',
    '脱敏 地址的 query 整段丢掉(不做"哪个参数敏感"的逐个判断 —— 判断错一次就泄一次)');
  eq(scrubSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib3QifQ.Zm9vYmFyc2ln'), 'Bearer [已隐去]',
    '脱敏 JWT 三段一起抹掉');
  eq(scrubSecrets('Bearer AbCdEf0123456789xyz'), 'Bearer [已隐去]', '脱敏 不是 JWT 的 Bearer 令牌也抹掉');
  eq(scrubSecrets('JSESSIONID=9F8E7D6C5B4A'), 'JSESSIONID=[已隐去]', '脱敏 会话键值对只留键名');
  eq(scrubSecrets('x 9f8e7d6c5b4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c y'), 'x [已隐去] y',
    '脱敏 32 字符以上的不明串一律抹掉(兜没被认出来的漏网之鱼)');
  eq(scrubSecrets(null), '', '脱敏 null 不炸,交空串');
  /* 反向:脱敏不能把要看的东西也一起删了。抹得太狠 = 这份日志白发 */
  eq(scrubSecrets('Chart Type'), 'Chart Type', '脱敏 反向 界面文案原样保留');
  eq(scrubSecrets('5Y'), '5Y', '脱敏 反向 短文案原样保留');
  eq(scrubSecrets('https://my.apps.factset.com/workstation/navigator/company-security/ownership-summary/NVDA-US'),
    'https://my.apps.factset.com/workstation/navigator/company-security/ownership-summary/NVDA-US',
    '脱敏 反向 没有 query 的长路径不许被兜底规则误伤(路径正是"这是哪个页面"的唯一线索)');

  /* ② 畸形输入:诊断跑在"页面已经不是我以为的样子"那一刻,入参没有一个可信 */
  eq(typeof formatChartDiag(), 'string', '诊断 不传参也交得出报告');
  eq(typeof formatChartDiag(null), 'string', '诊断 传 null 不炸');
  eq(typeof formatChartDiag('这不是对象'), 'string', '诊断 传字符串不炸');
  eq(/一个 frame 都没扫到/.test(formatChartDiag({ frames: 'not-array' })), true,
    '诊断 frames 不是数组 → 如实说"没扫到",而不是当成扫到了零个可用信息');
  eq(/一个 frame 都没扫到/.test(formatChartDiag({ frames: [null, undefined, 0] })), true,
    '诊断 frames 里全是垃圾 → 同上,过滤完就是没扫到');
  eq(/带 title \/ aria-label 的元素 0 个/.test(formatChartDiag({ frames: [{ labels: null, texts: 'x' }] })), true,
    '诊断 frame 里字段类型不对时按 0 个报,不假装有内容');

  /* ③ 红线的正面检查:样本里每一个字段都塞了能登录的东西,报告里一个都不许剩 */
  const LEAKY = {
    ticker: 'NVDA-US?token=S3CRETTOKENVALUE',
    file: 'NVDA-US Daily Charting.xlsx',
    at: '2026-08-06T00:00:00Z',
    via: { '5Y': null, OHLC: 'menu:Chart Type' },
    verdict: { '5Y': '跨度仍是 1 年', OHLC: '只有收盘价' },
    probes: CHART_PROBES,
    frames: [{
      url: 'https://my.apps.factset.com/workstation/charting/?jsessionid=S3CRETTOKENVALUE&x=1',
      labels: ['BUTTON "Download"', 'DIV "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib3QifQ.Zm9vYmFyc2ln"',
        'SPAN "password: hunter2pass"'],
      texts: ['5Y', 'Chart Type', 'JSESSIONID=9f8e7d6c5b4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c'],
    }],
  };
  const LEAKS = ['S3CRETTOKENVALUE', 'eyJhbGciOiJIUzI1NiJ9', 'hunter2pass',
    '9f8e7d6c5b4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c'];
  const DIAG_OUT = formatChartDiag(LEAKY);
  /* 先证明样本里真的有四个 —— 没有这一条,上面那条"一个都没剩"就是空断言 */
  eq(LEAKS.filter(s => JSON.stringify(LEAKY).includes(s)).length, 4,
    '诊断 反向 样本里确实塞了 4 个凭据(否则下一条恒真)');
  eq(LEAKS.filter(s => DIAG_OUT.includes(s)).length, 0,
    '诊断 红线 报告里一个凭据/令牌/会话串都不许出现 —— 这份日志是要发给别人的');
  /* 抹干净了还得有用:命中/未命中这一段就是让我知道"哪几个词是我猜错的" */
  eq(/\[命中  \] K 线 · 图表类型菜单入口/.test(DIAG_OUT), true,
    '诊断 页面上确有 "Chart Type" → 报命中(说明这个词猜对了)');
  eq(/\[未命中\] K 线 · 图表类型选项/.test(DIAG_OUT), true,
    '诊断 Candlestick/OHLC/Bar 一个都没有 → 报未命中(这正是"我猜错了"的证据)');

  /* 日志文件的位置与命名:要和 fetch-YYYY-MM-DD.log 同目录同模子,否则用户找不到、也不知道该发哪个 */
  eq(path.dirname(CHART_DIAG_FILE), LOG_DIR, '诊断日志 和跑批日志同一个目录(Assets/_logs/)');
  eq(path.basename(CHART_DIAG_FILE), 'chart-diag-' + new Date().toISOString().slice(0, 10) + '.log',
    '诊断日志 文件名就是 chart-diag-YYYY-MM-DD.log');
  eq(path.basename(CHART_DIAG_FILE).replace(/^chart-diag-/, 'fetch-'), path.basename(LOG_FILE),
    '诊断日志 日期段和 fetch-YYYY-MM-DD.log 完全一致(同一天的两个文件要对得上)');

  /* 采集代码的红线:它**从不**去读浏览器的会话信息。这一条钉的是源码本身,
   * 因为"没有读"是没法从输出上证明的 —— 只能证明"代码里根本没有那几个 API"。 */
  const CD_SRC = fs.readFileSync(path.join(LIB_DIR, 'chart-diag.mjs'), 'utf8');
  eq(/document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB/.test(CD_SRC), false,
    '诊断 红线 采集代码里不出现任何读会话/本地存储的 API');
  /* 同理钉住"最后整体再脱一遍"这层兜底。它今天是冗余的(上面每个字段都单独脱过了),
   * 所以任何行为断言都杀不掉"删掉它"这个改动 —— 只能钉源码。而它防的恰恰是**将来**:
   * 谁往 formatChartDiag 里新加一个忘了 scrubSecrets 的字段,这层兜底是唯一还站着的东西。 */
  eq(/return\s+scrubSecrets\(out\.join\(/.test(CD_SRC), true,
    '诊断 红线 formatChartDiag 的最后一行必须是整体再脱敏一遍(逐字段脱敏之外的兜底)');

  /* ② 的另一半:dumpChartDiag 是 async,四种失败姿势各来一遍,一次都不许抛。
   * 这几发都写去 scratch 文件,免得把下面那条 append 计数弄脏。 */
  const DIAG_SCRATCH = path.join(SELFTEST_SANDBOX || os.tmpdir(), 'chart-diag-scratch.log');
  const D1 = await dumpChartDiag({ ticker: 'NVDA-US', probes: CHART_PROBES },
    { harvest: () => { throw new Error('采集当场炸了'); }, file: DIAG_SCRATCH, quiet: true });
  eq(/一个 frame 都没扫到/.test(D1), true, '诊断 采集函数抛异常 → 照样交出报告,不把整个抓取步骤拖挂');
  eq(/NVDA-US/.test(D1), true, '诊断 采集失败时报告里仍有标的名(否则这份证据没法归属到哪只票)');
  eq(typeof await dumpChartDiag({ ticker: 'A' }, { harvest: async () => '不是数组', file: DIAG_SCRATCH, quiet: true }),
    'string', '诊断 采集返回值类型不对也不炸');
  eq(/诊断结束/.test(await dumpChartDiag(null,
    { harvest: async () => [null, { labels: 1, texts: 2 }], file: DIAG_SCRATCH, quiet: true })), true,
  '诊断 info 传 null、frame 字段全是垃圾,仍然走完全程');
  /* 写盘失败:把落盘路径指到一个**目录**上,appendFileSync 必抛 EISDIR */
  eq(/诊断结束/.test(await dumpChartDiag({ ticker: 'B' },
    { harvest: async () => [], file: LOG_DIR, quiet: true })), true,
  '诊断 写盘失败(路径是目录)也不抛,报告照样交得出来');

  /* 真落盘一次:文件确实生成、"一个入口都没点着"这句话确实写进去了 */
  const diagCount = () => {
    try { return (fs.readFileSync(CHART_DIAG_FILE, 'utf8').match(/======== 诊断结束 ========/g) || []).length; }
    catch { return 0; }
  };
  const diagBefore = diagCount();
  await dumpChartDiag({
    ticker: 'NVDA-US', file: 'NVDA-US Daily Charting.xlsx',
    via: { '5Y': null }, verdict: { '5Y': '跨度仍是 1 年' }, probes: CHART_PROBES,
  }, { harvest: async () => [{ url: 'https://my.apps.factset.com/workstation/charting/?sid=X', labels: [], texts: ['5Y'] }], quiet: true });
  eq(fs.existsSync(CHART_DIAG_FILE), true, '诊断日志 真的落到了 Assets/_logs/chart-diag-*.log');
  eq(/一个入口都没点着/.test(fs.readFileSync(CHART_DIAG_FILE, 'utf8')), true,
    '诊断日志 "一个入口都没点着"必须落进文件 —— 它和"点着了但没生效"要采取的下一步完全不同');
  await dumpChartDiag({ ticker: 'ZZZ-US' }, { harvest: async () => [], quiet: true });
  eq(diagCount() - diagBefore, 2, '诊断日志 同一天第二次失败是 append 不是覆盖(两只票的证据要能并排看)');

  /* ---- 期权链解析 ---- */
  eq(parseOptExpiry('2026-08-21'), '2026-08-21', 'expiry ISO 原样');
  eq(parseOptExpiry("21 Aug '26"), '2026-08-21', 'expiry 日-月-年');
  eq(parseOptExpiry('Aug 21, 2026'), '2026-08-21', 'expiry 月-日-年');
  eq(parseOptExpiry('08/21/2026'), '2026-08-21', 'expiry 美式斜杠');
  eq(parseOptExpiry("Aug '26"), '2026-08-21', 'expiry 只到月 → 第三个周五');
  eq(parseOptExpiry('下周五'), null, 'expiry 认不出返回 null 而不是瞎猜');
  eq(parseOptNum('12,345'), 12345, 'OI 去千分位');
  eq(parseOptNum('1.2K'), 1200, 'OI 认 K 后缀');
  eq(Number.isNaN(parseOptNum('--')), true, 'OI 空占位 → NaN');
  /* 标准排布:calls | Strike | puts —— Strike 左边最近的 Open Int 才是看涨 */
  const chainRows = [
    ["Aug 21 '26"],
    ['Last', 'Volume', 'Open Int', 'Strike', 'Open Int', 'Volume', 'Last'],
    ['1.20', '300', '5,000', '100', '7,000', '200', '2.40'],
    ['0.80', '100', '9,000', '105', '1,000', '50', '3.10'],
    ["Sep 18 '26"],
    ['Last', 'Volume', 'Open Int', 'Strike', 'Open Int', 'Volume', 'Last'],
    ['1.00', '10', '2,000', '100', '2,500', '20', '2.00'],
  ];
  const P1 = parseOptionRows(chainRows);
  eq(P1.rows.length, 3, '期权链解析出 3 行');
  eq(P1.rows[0].expiry + '|' + P1.rows[0].strike, '2026-08-21|100', '分组行的到期日被逐行继承');
  eq(P1.rows[0].call_oi, 5000, 'Strike 左侧 OI = 看涨');
  eq(P1.rows[0].put_oi, 7000, 'Strike 右侧 OI = 看跌');
  eq(P1.rows[2].expiry, '2026-09-18', '第二个分组切换到期日');
  /* 单栏排布:每行一个 Type,同一 (到期日,行权价) 的两行要合并成一行 */
  const P2 = parseOptionRows([
    ['Expiration', 'Type', 'Strike', 'Open Int'],
    ["21 Aug '26", 'Call', '100', '5,000'],
    ["21 Aug '26", 'Put', '100', '7,000'],
  ]);
  eq(P2.rows.length, 1, '单栏排布的看涨/看跌合并为一行');
  eq(P2.rows[0].call_oi + '/' + P2.rows[0].put_oi, '5000/7000', '单栏排布按 Type 分流');
  eq(parseOptionRows([['Symbol', 'Last', 'Change'], ['NVDA', '1', '2']]).sawStrike, false,
    '没有 Strike 表头时如实报告(用于区分"改版"与"停在概览页")');
  /* ---- 导出解析:下面这张表头是**从真导出里原样抄的** 21 列,一个字都没改 ----
   * 抄原文而不是自己编一个"差不多的",是因为这一整步的前提就是"表头名不会变";
   * 编一个差不多的表头,测的就只是我对自己正则的记忆力。 */
  const OX_HEAD = ['', 'Call Month & Strike Code', 'Call Price - Last', 'Call Tick Direction',
    'Call Price Dollar Change', 'Call Price - Bid', 'Call Price - Ask', 'Call Cumulative Volume',
    'Call Open Interest', 'Expiration Date', 'Days to Exp', 'Strike Price', 'Root Symbol',
    'Put Month & Strike Code', 'Put Price - Last', 'Put Tick Direction', 'Put Price Dollar Change',
    'Put Price - Bid', 'Put Price - Ask', 'Put Cumulative Volume', 'Put Open Interest'];
  /* 分组行:只有 A 列写着字,其余 20 列全空 —— 真导出里就长这样 */
  const oxSection = m => [`Options Expiring: ${m}`, ...Array(20).fill('')];
  const oxRow = (callOI, exp, strike, root, putOI) => {
    const r = Array(21).fill('');
    r[8] = String(callOI); r[9] = exp; r[10] = '1'; r[11] = String(strike); r[12] = root; r[20] = String(putOI);
    return r;
  };
  const OX_NVDA = [OX_HEAD, oxSection('July 2026'),
    oxRow('834', '07/29/2026', '187.5', 'NVDA', '2,370'),
    oxRow('20,148', '07/29/2026', '190', 'NVDA', '667'),
    oxSection('August 2026'),
    oxRow('45,493', '09/18/2026', '200', 'NVDA', '39,635'),
    oxRow('11', '07/31/2026', '85', 'SPCX', '751')];        // 混进来的别人家一行,必须被踢掉
  const OX = parseOptionsExport(OX_NVDA, 'NVDA-USA_20260728', 'NVDA-US');
  eq(OX.error ?? null, null, '导出 表头按名字认出来了');
  eq(OX.rows.length, 3, '导出 分组行自动跳过,不当数据行');
  eq(OX.asof, '2026-07-28', '导出 快照日期取自 sheet 名,而不是"今天"');
  eq(OX.sym, 'NVDA', '导出 标的取自 sheet 名');
  eq(OX.rows[0].expiry + '|' + OX.rows[0].strike, '2026-07-29|187.5', '导出 到期日与行权价');
  eq(OX.rows[0].call_oi + '/' + OX.rows[0].put_oi, '834/2370', '导出 call/put 各归各列(千分位已去掉)');
  eq(OX.badRoot, 1, '导出 根符号不是本标的的行被逐行踢掉');
  eq(OX.expiries.join(','), '2026-07-29,2026-09-18', '导出 到期日精确到天,不是"某月第三个周五"');
  /* 身份核对:sheet 名就是这份文件的身份证。对不上整份拒收,不做"能读多少算多少" */
  eq(parseOptionsExport(OX_NVDA, 'NVDA-USA_20260728', 'AMD-US').rows ?? null, null,
    '导出 标的对不上时整份拒收(混链比没数据危险)');
  eq(parseOptionsExport(OX_NVDA, 'Sheet1', 'NVDA-US').rows ?? null, null,
    '导出 sheet 名认不出就不敢用这份文件');
  eq(parseOptionsExport([['Symbol', 'Last'], ['NVDA', '1']], 'NVDA-USA_20260728', 'NVDA-US').rows ?? null, null,
    '导出 缺 OI 表头时报错而不是交半份数据');
  eq(optSymOf('NVDA-US'), 'NVDA', '裸符号:导出写 NVDA-USA,清单写 NVDA-US,只比前面那截');
  eq(JSON.stringify(parseOptSheetName('SPCX-USA_20260729')),
    '{"sym":"SPCX","exch":"USA","asof":"2026-07-29"}', 'sheet 名解析');
  eq(parseOptSheetName('NVDA-USA_20261332'), null, 'sheet 名里月份 13 日 32 —— 不认');
  eq(optExportFresh('2026-07-28', '2026-07-30'), true, '导出新鲜度 两天前的算数');
  eq(optExportFresh('2026-01-01', '2026-07-30'), false, '导出新鲜度 半年前的 OI 说明不了今天');
  /* 多份合并:500 合约上限逼得必须按月分开下,所以"多份拼一份"是常态而不是意外 */
  const OXDIR = path.join(SELFTEST_SANDBOX || os.tmpdir(), 'optinbox');
  fs.mkdirSync(OXDIR, { recursive: true });
  const oxWrite = (file, sheet, aoa) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
    fs.writeFileSync(path.join(OXDIR, file), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };
  oxWrite('optionsMontage_SPCX-USA_20260729.xlsx', 'SPCX-USA_20260729', [OX_HEAD, oxSection('July 2026'),
    oxRow('715', '07/31/2026', '100', 'SPCX', '23,879')]);
  oxWrite('optionsMontage_SPCX-USA_20260729 (1).xlsx', 'SPCX-USA_20260729', [OX_HEAD, oxSection('August 2026'),
    oxRow('344', '08/07/2026', '100', 'SPCX', '14,049'),
    oxRow('1,670', '08/28/2026', '140', 'SPCX', '315')]);
  oxWrite('optionsMontage_NVDA-USA_20260728.xlsx', 'NVDA-USA_20260728', [OX_HEAD,
    oxRow('834', '07/29/2026', '187.5', 'NVDA', '2,370')]);
  oxWrite('optionsMontage_SPCX-USA_20251201.xlsx', 'SPCX-USA_20251201', [OX_HEAD,
    oxRow('99999', '12/19/2025', '50', 'SPCX', '99999')]);
  const ING = ingestOptExports('SPCX-US', [OXDIR], '2026-07-30');
  eq(ING.rows.length, 3, '导出合并 两个月份文件拼成一份(500 合约上限逼出来的常态)');
  eq(ING.expiries.join(','), '2026-07-31,2026-08-07,2026-08-28', '导出合并 到期日按月拼齐');
  eq(ING.asof, '2026-07-29', '导出合并 快照日期取最新的那一份');
  eq(ING.used.length, 2, '导出合并 同目录里别的标的、太旧的文件都不算');
  eq(ING.rows.some(r => r.strike === 187.5), false, '导出合并 NVDA 那份不会混进 SPCX(下载目录里什么都有)');
  eq(ING.rejected.some(s => /2025-12-01/.test(s)), true, '导出合并 太旧的那份被点名跳过,而不是静默丢掉');

  /* ---- 期权链走接口(主路)------------------------------------------------
   * 下面这几行**是 2026-07-30 从 /services/IDCServ/oc 原样抄回来的**,
   * 一个字符都没改(除了两行明确标注为"改出来的"):真数据里那根行尾多余的竖线、
   * FREQUENCY 是 M/W4/Y、EXCHANGES 那一长串字母,全在。
   * 断言写得像返回的字节,而不是像我想象中的返回,才挡得住下一次接口改字段。
   * OI 数字同样是实地的(NVDA 2026-08-21 那三档),不是编的。 */
  const OC_HEAD = 'YEAR|MONTH|DISP_DATE|ROOT|C_RT_SYM|P_RT_SYM|C_DISP_SYM|P_DISP_SYM|STRIKE|SIZE|'
    + 'UNDERLIER|ADJUSTED|UNDERLIER_IS_US|ANALYTICS_CALC_METHOD|DELIVERABLES|C_OCC_SYM|P_OCC_SYM|'
    + 'FREQUENCY|VENUE|SETTLEMENT_METHOD|EXERCISE_STYLE|SETTLEMENT_STYLE|OPTION_TYPE|EXCHANGES|EXP_DATE|';
  const OC_EX = 'A,B,C,S,H,I,J,E,M,P,Q,R,V,T,K,W,X,Z';
  /* 明天到期、行权价 50 —— 日期够近,但离钱太远,应该被行权价那一道筛掉 */
  const OC_JUL = `2026|07|JUL26|NVDA.US|NVDA#G3126D500000-USA|NVDA#S3126D500000-USA|NVDA.US#C4VZ7-USA|NVDA.US#P5VD3-USA|50|100|NVDA-USA|N|Y|1|NVDA,100|NVDA#260731C00050000-USA|NVDA#260731P00050000-USA|W4|||1|PM|EO|${OC_EX}|20260731|`;
  const OC_AUG = [
    `2026|08|AUG26|NVDA.US|NVDA#H2126C185000-USA|NVDA#T2126C185000-USA|NVDA.US#CY1XM-USA|NVDA.US#PGKFL-USA|185|100|NVDA-USA|N|Y|1|NVDA,100|NVDA#260821C00185000-USA|NVDA#260821P00185000-USA|M|||1|PM|EO|${OC_EX}|20260821|`,
    `2026|08|AUG26|NVDA.US|NVDA#H2126C190000-USA|NVDA#T2126C190000-USA|NVDA.US#CTNHM-USA|NVDA.US#P5W62-USA|190|100|NVDA-USA|N|Y|1|NVDA,100|NVDA#260821C00190000-USA|NVDA#260821P00190000-USA|M|||1|PM|EO|${OC_EX}|20260821|`,
    `2026|08|AUG26|NVDA.US|NVDA#H2126C195000-USA|NVDA#T2126C195000-USA|NVDA.US#CWS7S-USA|NVDA.US#PNTJL-USA|195|100|NVDA-USA|N|Y|1|NVDA,100|NVDA#260821C00195000-USA|NVDA#260821P00195000-USA|M|||1|PM|EO|${OC_EX}|20260821|`,
  ];
  /* 两年后到期 —— 目录里真有这些行(NVDA 一路排到 2028-12),应该被日期那一道筛掉 */
  const OC_DEC28 = `2028|12|DEC28|NVDA.US|NVDA#L1528C460000-USA|NVDA#X1528C460000-USA|NVDA.US#CRWGL-USA|NVDA.US#PNXRC-USA|460|100|NVDA-USA|N|Y|1|NVDA,100|NVDA#281215C00460000-USA|NVDA#281215P00460000-USA|Y|||1|PM|L|${OC_EX}|20281215|`;
  /* 这两行是**在真行上改出来的**:NVDA 眼下没有调整过的合约,别家有。
   * 一张不是 100 股的合约和别人不可比;别人的链混进来比没有数据危险得多。 */
  const OC_ADJ = OC_AUG[1].replace('|NVDA-USA|N|', '|NVDA-USA|Y|').replace('|NVDA.US|', '|NVDA1.US|');
  const OC_OTHER = OC_AUG[1].replace('|NVDA-USA|', '|AMD-USA|');
  const OC_TEXT = [OC_HEAD, OC_JUL, ...OC_AUG, OC_DEC28, OC_ADJ, OC_OTHER].join('\n') + '\n';

  const OC = parseOptionChainTable(OC_TEXT);
  eq(OC.header.length, 25, '期权链目录 表头 25 列(行尾那根多余的竖线不算一列)');
  eq(OC.header[OC.header.length - 1], 'EXP_DATE', '期权链目录 最后一列是 EXP_DATE');
  eq(OC.rows.length, 7, '期权链目录 七行数据都读进来了');
  eq(OC.rows[1].C_RT_SYM, 'NVDA#H2126C185000-USA', '期权链目录 看涨那条腿的符号原样取出');
  eq(OC.rows[1].P_RT_SYM, 'NVDA#T2126C185000-USA', '期权链目录 看跌那条腿的符号原样取出');
  /* 这一条是这一整块里最要紧的:代码不存在、或标的没有期权时,
   * 接口回的是 **HTTP 200 + 空 body**,不是 404。
   * 少了这一条,"请求成功"就会被当成"拿到了链",一路静悄悄走到写文件那一步。 */
  eq(parseOptionChainTable('').rows ?? null, null, '期权链目录 200 + 空 body 是失败,不是"成功但零行"');
  eq(/空的/.test(parseOptionChainTable('').error), true, '期权链目录 空响应的理由说人话');
  eq(parseOptionChainTable('A|B|\n1|2|\n').rows ?? null, null, '期权链目录 表头缺列直接拒收(接口改字段要吭声)');

  eq(ocDate('20260821'), '2026-08-21', '期权链目录 日期精确到天');
  eq(ocDate('2026-08'), null, '期权链目录 认不出的日期返回 null,不猜');
  eq(daysBetween('2026-07-30', '2026-08-21'), 22, '距到期天数按 UTC 零点算,不受本机时区影响');

  const PK = pickChainContracts(OC.rows, { today: '2026-07-30', spot: 190.01, ticker: 'NVDA-US' });
  eq(PK.kept.length, 3, '筛合约 只剩窗口里那三档');
  eq(PK.kept.map(k => k.strike).join(','), '185,190,195', '筛合约 按行权价排好序交出');
  eq(PK.stats.farStrike, 1, '筛合约 明天到期但行权价 50 —— 日期够近也不要,离钱太远的 OI 不构成墙');
  eq(PK.stats.farDate, 1, '筛合约 2028 年的链不要(目录真的一路排到那么远)');
  eq(PK.stats.adjusted, 1, '筛合约 调整过的合约不要(一张不是 100 股,和别人不可比)');
  eq(PK.stats.wrongUnderlier, 1, '筛合约 标的对不上的整行拒收(和导出那条路核对 sheet 名是同一个动作)');
  eq(PK.kept[0].dte, 22, '筛合约 距到期天数一并算好,不用下游再算一次');
  eq(pickChainContracts(OC.rows, { today: '2026-09-01', spot: 190.01, ticker: 'NVDA-US' }).stats.expired, 4,
    '筛合约 已过期的一个都不留(dte = 0 也算过期:它今晚就归零)');

  /* FQL 的返回是**扁平数组**,一个 (symbol, expression) 一项。这一份是实地抄回来的。 */
  const FQL_JSON = [
    { $error: 0, $expression: 'P_OPT_OPEN_INTEREST', $symbol: 'NVDA#H2126C185000-USA', $value: [[8662]], $wall_time_ms: 24.6 },
    { $error: 0, $expression: 'P_OPT_OPEN_INTEREST', $symbol: 'NVDA#T2126C185000-USA', $value: [[33852]] },
    { $error: 0, $expression: 'P_OPT_OPEN_INTEREST', $symbol: 'NVDA#H2126C190000-USA', $value: [[18334]] },
    { $error: 0, $expression: 'P_OPT_OPEN_INTEREST', $symbol: 'NVDA#T2126C190000-USA', $value: [[48130]] },
    { $error: 0, $expression: 'P_OPT_OPEN_INTEREST', $symbol: 'NVDA#H2126C195000-USA', $value: [[14390]] },
    { $error: 1, $error_description: "%FQL-E-ERROR, Unknown identifier 'P_OPT_NOPE'.\n\n", $expression: 'P_OPT_NOPE', $symbol: 'NVDA#T2126C195000-USA' },
    { $error: 0, $expression: 'P_PRICE', $symbol: 'NVDA-USA', $value: [[190.01]] },
  ];
  const FV = parseFqlValues(FQL_JSON, 'P_OPT_OPEN_INTEREST');
  eq(FV.size, 5, 'FQL 只收 $error 为 0 的那些(报错项没有 $value,当没拿到)');
  eq(FV.get('NVDA#T2126C190000-USA'), 48130, 'FQL 取值走 $value[0][0]');
  eq(FV.has('NVDA-USA'), false, 'FQL 按表达式过滤,取 OI 时不会把现价那一项混进来');
  eq(parseFqlValues(FQL_JSON, 'P_PRICE').get('NVDA-USA'), 190.01, 'FQL 同一份返回里现价单独取得出来');

  const AS = assembleOptionRows(PK.kept, FV);
  eq(AS.rows.length, 3, '拼装 三个行权价各一行');
  eq(AS.rows[0].call_oi + '/' + AS.rows[0].put_oi, '8662/33852', '拼装 两条腿分别落到 call_oi / put_oi');
  eq(AS.legs, 6, '拼装 六条腿都数进去了');
  eq(AS.miss, 1, '拼装 没取到 OI 的那条腿被数出来(195 的看跌),不是悄悄按 0 混过去');
  eq(AS.rows[2].put_oi, 0, '拼装 缺的那一腿按 0 计,但上面那个 miss 计数才是判断依据');
  eq(AS.expiries.join(','), '2026-08-21', '拼装 到期日一并交出');
  const ZERO = assembleOptionRows(PK.kept, new Map());
  eq(ZERO.rows.length, 0, '拼装 两条腿都是 0 的行不写进 csv(仪表盘本来也会跳过,留着只撑大文件)');
  eq(optApiVerdict(AS), null, '验收 缺 1/6 在容忍范围内,这一轮算数');
  eq(typeof optApiVerdict(ZERO), 'string', '验收 一条腿都没取到就拒收,不交半份链');
  eq(typeof optApiVerdict({ rows: AS.rows, legs: 6, miss: 3 }), 'string',
    '验收 缺一半就拒收 —— 缺一块的链算出来的 max pain 和 OI 墙是错的,宁可这一轮不写');
  eq(chunk([1, 2, 3, 4, 5], 2).map(a => a.length).join(','), '2,2,1', '切批 最后一批不补齐');
  eq(chunk([], 300).length, 0, '切批 空数组不产生空批次');
  eq(bareSym('NVDA-USA') + '/' + bareSym('NVDA-US') + '/' + bareSym('NVDA'), 'NVDA/NVDA/NVDA',
    '交易所后缀三种写法都归一(接口对这三种一视同仁,实测返回同一份)');

  /* ---- Options.csv 的滚存(v16.8:从"覆盖写"改成"按 asof 追加") ----
   * 样本照着 Assets/options/ 里真实文件的形状写:表头 asof,expiry,strike,call_oi,put_oi,
   * 一轮约 37 行、两个到期日。这几条断言盯的是那两条曾经"杀历史"的语句不会再长回来。 */
  const OLD_D1 = [
    { asof: '2026-07-29', expiry: '2026-07-31', strike: '325', call_oi: '1804', put_oi: '1389' },
    { asof: '2026-07-29', expiry: '2026-07-31', strike: '330', call_oi: '7832', put_oi: '1514' },
  ];
  const NEW_D2 = [
    { expiry: '2026-07-31', strike: 325, call_oi: 2100, put_oi: 1400 },
    { expiry: '2026-08-21', strike: 340, call_oi: 55, put_oi: 66 },
  ];
  const M1 = mergeOptionSnapshots(OLD_D1, NEW_D2, '2026-07-30', '2026-07-30');
  eq(M1.rows.length, 4, '滚存 跨天不覆盖:昨天两行 + 今天两行 = 四行(旧写法这里只剩三行)');
  eq(M1.snapshots, 2, '滚存 两天算两层快照');
  eq(M1.added, 2, '滚存 新增数只数今天真加进来的行');
  eq(M1.rows.map(r => r.asof).join(','), '2026-07-29,2026-07-29,2026-07-30,2026-07-30',
    '滚存 按 asof 升序:最新那层永远在文件末尾,追加出来的文件人读着也是这个顺序');
  eq(M1.rows.find(r => r.asof === '2026-07-29' && r.strike === '325').call_oi, '1804',
    '滚存 昨天那格的 OI 原样保留 —— 回测要的就是"当时看到的是多少",不是现在的值');
  const M2 = mergeOptionSnapshots(M1.rows, [
    { expiry: '2026-07-31', strike: 325, call_oi: 2222, put_oi: 1400 },
  ], '2026-07-30', '2026-07-30');
  eq(M2.rows.length, 4, '滚存 同一天重跑不再多加一行(键含 asof,同一层就地覆盖)');
  eq(M2.rows.find(r => r.asof === '2026-07-30' && r.strike === '325').call_oi, '2222',
    '滚存 同一天重跑取后写的那份(重跑通常是因为第一次抓漏了)');
  /* 曾经的第二条杀手:filter(r => r.expiry >= today)。到期的链正是回测要看的"这堵墙顶住没有" */
  const M3 = mergeOptionSnapshots(OLD_D1, [], '2026-09-15', '2026-09-15');
  eq(M3.rows.length, 2, '滚存 到期日已经过去的链**留着**(旧写法在这里会把它们整段删掉)');
  /* 保留期:一年。边界两侧各测一天,别只测中间 */
  const AGED = [
    { asof: '2025-07-30', expiry: '2025-08-15', strike: '100', call_oi: '1', put_oi: '2' },  // 365 天整
    { asof: '2025-07-29', expiry: '2025-08-15', strike: '100', call_oi: '1', put_oi: '2' },  // 366 天
  ];
  const M4 = mergeOptionSnapshots(AGED, [], '2026-07-30', '2026-07-30');
  eq(M4.rows.length, 1, '滚存 满 365 天的留着,超过 365 天的滚掉(边界是"大于"才扔)');
  eq(M4.agedOut, 1, '滚存 滚掉几行要报出来,不闷声删');
  eq(mergeOptionSnapshots(AGED, [], '2026-07-30', '2026-07-30', { retainDays: 30 }).rows.length, 0,
    '滚存 保留期可配:传 30 天进去,这两行都过期');
  /* 坏数据:日期不合法的行排不进时间轴,回测用不了、仪表盘按 asof 比大小也会被它带偏 */
  const M5 = mergeOptionSnapshots([
    { asof: '', expiry: '2026-08-21', strike: '100', call_oi: '1', put_oi: '2' },
    { asof: '2026-07-30', expiry: 'Aug 21', strike: '100', call_oi: '1', put_oi: '2' },
    { asof: '2026-07-30', expiry: '2026-08-21', strike: '', call_oi: '1', put_oi: '2' },
  ], [], '2026-07-30', '2026-07-30');
  eq(M5.rows.length, 0, '滚存 asof/到期日/行权价 缺一不可,残行不进表');
  eq(M5.dropped, 3, '滚存 扔掉的残行也要计数');
  eq(mergeOptionSnapshots(null, null, '2026-07-30', '2026-07-30').rows.length, 0,
    '滚存 空文件 / 没抓到任何行都不炸(第一次跑就是这个情形)');
  /* 上限:顶到了按"整份最老的快照"往外扔,不从尾巴切一刀 —— 半份链算出来的 max pain 是错的 */
  const many = [];
  for (const d of ['2026-07-28', '2026-07-29', '2026-07-30'])
    for (let s = 100; s < 104; s++) many.push({ asof: d, expiry: '2026-08-21', strike: String(s), call_oi: '1', put_oi: '2' });
  const M6 = mergeOptionSnapshots(many, [], '2026-07-30', '2026-07-30', { max: 9 });
  eq(M6.rows.length, 8, '滚存 超上限扔掉整整一天(12 行 → 8 行),不会剩下半份链');
  eq(M6.snapshots, 2, '滚存 扔的是最老的那一层');
  eq(M6.rows.some(r => r.asof === '2026-07-28'), false, '滚存 被扔的确实是最老那天');
  eq(mergeOptionSnapshots(many, [], '2026-07-30', '2026-07-30', { max: 2 }).snapshots, 1,
    '滚存 哪怕今天这一份就超了上限,当期这层也绝不砍 —— 缺了它面板当场就是错的');

  /* 每月回测的排期:只有两个决定 —— 上一轮是哪天、这个月跑过没有。
   * 两个都容易写反,而写反的代价是不对称的:漏跑只是少一份报告,
   * 天天跑则会把台账灌成日更,"哪一轮翻的"这件事当场就查不出来了。 */
  const BT_CSV = 'run_date,group,metric,horizon,n,effN,value,baseline,z,verdict\n'
    + '2026-06-30,A,cover1sigma,5,1016,203,66.1,68.27,-0.65,holds\n'
    + '2026-07-30,A,cover1sigma,5,1016,203,66.1,68.27,-0.65,holds\n'
    + '2026-07-02,B,bandHoldRate,5,33,22,64.3,89.29,-1.94,inconclusive\n';
  eq(pickLastRunDate(BT_CSV), '2026-07-30', '回测台账 取最大的 run_date,不是取最后一行(同日重跑会重排)');
  eq(pickLastRunDate('run_date,group\n'), null, '回测台账 只有表头 = 还没跑过');
  eq(pickLastRunDate('run_date,group\n乱码一行\n'), null, '回测台账 读不出日期就当没跑过,不猜');
  eq(backtestDue('2026-07-31', '2026-07-30'), false, '回测排期 同一个自然月内不重复跑');
  eq(backtestDue('2026-08-01', '2026-07-30'), true, '回测排期 跨到下个月就该跑(哪怕只隔两天)');
  eq(backtestDue('2026-08-01', null), true, '回测排期 从没跑过 = 该跑');
  eq(backtestDue('2027-07-01', '2026-07-30'), true, '回测排期 比的是年月整体,不是只比月份(否则隔一年会判成"跑过了")');

  /* v16.9 真机崩过一次:tools/backtest.mjs 写的是 `import * as XLSX from 'xlsx'`,
   * 而裸模块名是从**引用文件自己的目录**往上找 node_modules 的,跟 cwd 无关。
   * 那个文件在 tools/,包却被 run-factset.bat 装在 fetcher/node_modules —— 必崩。
   * 下面两条钉的是修法本身:静态裸导入不许回来,退出码 3 的约定两边要对得上。 */
  const btSrc = fs.existsSync(BT_SCRIPT) ? fs.readFileSync(BT_SCRIPT, 'utf8') : '';
  eq(/^\s*import[^\n]*\bfrom\s*['"]xlsx['"]/m.test(btSrc), false,
    "回测依赖 tools/backtest.mjs 不能静态 import 'xlsx'(tools/ 下找不到 fetcher/node_modules)");
  eq(/process\.exit\(3\)/.test(btSrc), true,
    '回测依赖 缺 xlsx 时约定 exit 3,调用方靠这个码分辨"跑挂了"和"根本没装"');
  eq(btExitNote(0), null, '回测退出码 0 = 没话说');
  eq(/npm i xlsx/.test(btExitNote(3) || ''), true, '回测退出码 3 要给出装依赖的那条命令,而不是干巴巴一句 exit 3');
  eq(btExitNote(1), 'exit 1', '回测退出码 其它非零不转述 —— 真错误子进程已经原样打出来了');

  /* 期权页地址:它是顶层页签,地址形态和 Company 子页签不同,占位符替换必须两种写法都吃 */
  eq(expandOptUrl('https://x/workstation/options/{ticker}', 'NVDA-US'),
    'https://x/workstation/options/NVDA-US', '{ticker} 占位符被替换');
  eq(expandOptUrl('https://x/workstation/options-montage/', 'NVDA-US'),
    'https://x/workstation/options-montage/', '目录式地址**原样使用**(顶层页签地址里没有代码那一段)');
  eq(expandOptUrlVariants('https://x/workstation/options-montage/', 'NVDA-US').join(' , '),
    'https://x/workstation/options-montage/ , https://x/workstation/options-montage/NVDA-US',
    '目录式地址给出两个候选:先原样,再补代码');
  eq(expandOptUrlVariants('https://x/workstation/options/{ticker}', 'NVDA-US').length, 1,
    '带占位符的模板只有一种解释,不多试');
  eq(expandOptUrl('https://x/workstation/options/NVDA-US', 'NVDA-US'),
    'https://x/workstation/options/NVDA-US', '已含代码的完整地址原样使用');
  eq(expandOptUrl('', 'NVDA-US'), '', '空模板不瞎造地址');
  eq(templatizeOptUrl('https://x/workstation/options/NVDA-US', 'NVDA-US'),
    'https://x/workstation/options/{ticker}', '成功地址转回模板以便换代码复用');
  eq(templatizeOptUrl('https://x/workstation/options-montage/', 'NVDA-US'),
    'https://x/workstation/options-montage/', '地址里没有代码时原样记住,不硬造占位符');
  eq(optionsUrlCandidates('NVDA-US').every(u => !/company-security/.test(u)), true,
    '候选地址里不再出现 company-security(期权不是 Company 的子页签)');
  eq(optionsUrlCandidates('NVDA-US')[0], 'https://my.apps.factset.com/workstation/options-montage/',
    '首选候选就是实测落地的 options-montage(不带代码)');

  /* ---- Assets 归类:写入、读回、体检、迁移必须共用同一套规则 ---- */
  eq(assetSubdir('NVDA-US FY1 Estimate History.xlsx'), 'estimates', '归类 估值历史');
  eq(assetSubdir('NVDA-US Daily Charting.xlsx'), 'charting', '归类 走势');
  eq(assetSubdir('_MARKET-BENCH SPY-US Daily Charting.xlsx'), 'charting', '归类 市场级序列同走势');
  eq(assetSubdir('NVDA-US Targets Ratings.xlsx'), 'targets', '归类 目标价');
  eq(assetSubdir('NVDA-US News.csv'), 'news', '归类 新闻');
  eq(assetSubdir('NVDA-US Options.csv'), 'options', '归类 期权');
  eq(assetSubdir('companies.csv'), 'summary', '归类 汇总');
  eq(assetSubdir('short-interest.csv'), 'summary', '归类 空头持仓');
  eq(assetSubdir('NVDA-US Snapshot.xlsx'), 'misc', '认不出的手动导出进 misc,不丢');
  eq(assetPath('NVDA-US News.csv') === path.join(OUT_DIR, 'news', 'NVDA-US News.csv'), true,
    'assetPath = OUT_DIR / 子目录 / 文件名');
  eq(assetPath(path.join('别的地方', 'NVDA-US News.csv')), assetPath('NVDA-US News.csv'),
    '传进来带路径也只认文件名,不会在 Assets 里套出一层怪目录');
  /* 路径锚点:拆模块最容易踩的就是这里 —— config 从 fetcher/ 掉到了 fetcher/lib/ */
  eq(path.basename(LIB_DIR), 'lib', 'LIB_DIR 指向 fetcher/lib');
  eq(envFlag({}, 'FS_OPEN_DASHBOARD'), false, '仪表盘默认不自动打开');
  eq(envFlag({ FS_OPEN_DASHBOARD: '1' }, 'FS_OPEN_DASHBOARD'), true, 'FS_OPEN_DASHBOARD=1 才允许自动打开');
  eq(envFlag({ FS_OPEN_DASHBOARD: 'true' }, 'FS_OPEN_DASHBOARD'), false, '仪表盘开关只认明确的 1,不把任意字符串当开启');
  eq(path.basename(FETCHER_DIR), 'fetcher', 'FETCHER_DIR 指向 fetcher/');
  eq(path.resolve(FETCHER_DIR, '..') === ROOT_DIR, true, 'ROOT_DIR 是 fetcher 的上一级(仓库根)');
  eq(process.env.FS_OUT ? true : OUT_DIR === path.join(ROOT_DIR, 'Assets'), true,
    'Assets 落在仓库根,不是 fetcher/Assets');
  eq(LOG_DIR === path.join(OUT_DIR, '_logs'), true, '日志与台账都在 Assets/_logs/');
  eq(SOURCES_FILE === path.join(LOG_DIR, 'sources.txt'), true, '台账在 Assets/_logs/sources.txt');
  eq(path.dirname(OPT_URL_FILE) === FETCHER_DIR, true, '.options-url 在 fetcher/ 而不是 fetcher/lib/');
  eq(SELFTEST_SANDBOX ? OUT_DIR === SELFTEST_SANDBOX : true, true,
    '自检写在临时目录里,不污染真实 Assets/(TEST-US 就是这么长出来的)');

  /* ---- 清单与数据对齐:文件名 → 谁的、哪一类 ---- */
  eq(JSON.stringify(classifyAssetFile('AMD-US FY1 Estimate History.xlsx')),
    '{"market":false,"ticker":"AMD-US","kind":"estimates"}', '认出 估值历史');
  eq(classifyAssetFile('AMD-US Daily Charting.xlsx').kind, 'charting', '认出 走势');
  eq(classifyAssetFile('AMD-US Targets Ratings.xlsx').kind, 'targets', '认出 目标价');
  eq(classifyAssetFile('AMD-US News.csv').kind, 'news', '认出 新闻');
  eq(classifyAssetFile('AMD-US Options.csv').kind, 'options', '认出 期权');
  eq(classifyAssetFile('_MARKET-BENCH SPY-US Daily Charting.xlsx').market, true,
    '市场级序列先摘掉,不能算成一家公司');
  eq(classifyAssetFile('_MARKET-BENCH SPY-US Daily Charting.xlsx').ticker, 'SPY-US', '市场序列取出代码');
  eq(classifyAssetFile('TEST-US FY1 Estimate History.xlsx'), null,
    '自检遗留文件不算数据(否则会把 TEST-US 补进清单,每轮白跑 8 步)');
  eq(classifyAssetFile('companies.csv'), null, '汇总 csv 不归属任何单一标的');
  eq(classifyAssetFile('我随手导的 News.csv'), null, '不像代码的前缀当手动导出放过,不硬认');
  eq(KINDS.length, 5, '一家公司算五类数据');

  /* 造一个假的 Assets 目录来扫,断言"扫描"和"对齐"两步分别成立 */
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'price-range-scan-'));
  const touch = (sub, name) => {
    fs.mkdirSync(path.join(fixture, sub), { recursive: true });
    fs.writeFileSync(path.join(fixture, sub, name), '');
  };
  touch('estimates', 'AMD-US FY1 Estimate History.xlsx');
  touch('estimates', 'AMD-US FY2 Estimate History.xlsx');
  touch('charting', 'AMD-US Daily Charting.xlsx');
  touch('targets', 'AMD-US Targets Ratings.xlsx');
  touch('news', 'AMD-US News.csv');
  touch('options', 'AMD-US Options.csv');
  touch('charting', 'MSFT-US Daily Charting.xlsx');
  touch('charting', '_MARKET-BENCH SPY-US Daily Charting.xlsx');
  touch('summary', 'companies.csv');
  touch('estimates', 'TEST-US FY1 Estimate History.xlsx');
  touch('_logs', 'GOOGL-US News.csv');          // 日志目录里的东西不算数据
  const sc = scanAssets(fixture);
  eq(sc.data.size, 2, '扫出两家公司(市场序列与汇总 csv 不算)');
  eq(sc.data.get('AMD-US').size, 5, 'AMD 五类齐全');
  eq(sc.markets.get('SPY-US'), 'BENCH', '市场序列单独记角色');
  eq(sc.data.has('TEST-US'), false, '自检遗留不进统计');
  eq(sc.litter.length, 1, '自检遗留单独列出来,好挪走');
  eq(sc.data.has('GOOGL-US'), false, '_logs/ 不递归(日志不是数据)');

  /* apply:false —— 自检绝不改真实的 tickers.txt。它在 fetcher/ 下,不受 FS_OUT 沙箱保护 */
  const R = reconcileTickers({ apply: false, list: ['MSFT-US', 'NVDA-US'], ignored: [], root: fixture });
  eq(R.extra.join(','), 'AMD-US', '有数据没登记 → 待补齐');
  eq(R.missing.join(','), 'NVDA-US', '登记了却一个文件都没有 → 只报告,不删');
  eq(R.partial.map(([t, k]) => t + ':' + k.length).join(','), 'MSFT-US:4', '登记了但数据不全 → 点名缺几类');
  eq(R.added.length, 0, 'apply:false 时一个字都不写');
  const R2 = reconcileTickers({ apply: false, list: ['MSFT-US'], ignored: ['AMD-US'], root: fixture });
  eq(R2.extra.length + '/' + R2.skipped.join(''), '0/AMD-US',
    '你删掉的标的不会被数据"复活"(删清单不删数据,没这条它下次启动就长回来了)');
  eq((IGNORE_LINE.exec('# ignore: AMD-US') || [])[1], 'AMD-US', '忽略名单就写在 tickers.txt 的注释行里');
  eq(IGNORE_LINE.test('# 普通注释'), false, '普通注释不会被误读成忽略项');

  /* ---- 拉取清单 roster.csv:仪表盘据此决定"画谁",落榜满一年才清理 ----
   * 这一组钉的全是**沉默的**失效模式:清单写错了、注释行被当成公司、
   * 一整个 Assets 被搬空 —— 没有一样会在终端上报错,只会让屏幕上的东西悄悄不对。 */
  eq(assetSubdir(ROSTER_FILE), 'summary', '归类 拉取清单(和 companies.csv 同一处)');
  const rc = rosterCsv(['NVDA-US', 'AMD-US', 'NVDA-US'], [['SPY-US', 'BENCH']]).split('\n');
  eq(rc[0], ROSTER_HEADER, 'roster 第一行必须是表头(parseCSV 只认第一行,没有注释语法)');
  eq(rc[1] + '|' + rc[2], 'AMD-US,company,1|NVDA-US,company,1', 'roster 公司排序去重后逐行写');
  eq(rc[3], 'SPY-US,bench,1', '市场序列带上自己的角色 —— 它不是公司,仪表盘据此不把它画进表格');
  eq(rc[4].charAt(0), '#', 'roster 末行说明必须以 # 开头(仪表盘靠这个字符把它滤掉,改了就凭空多一家公司)');
  const roundSrc = fs.readFileSync(path.join(LIB_DIR, 'round.mjs'), 'utf8');
  eq(/writeRoster\(TICKERS,\s*MARKETS\)/.test(roundSrc), true,
    '每轮拉取前按菜单里的当前清单刷新 roster(运行中新增 META-US 不能下载后仍被仪表盘隐藏)');

  const D = 86400000, NOW = Date.UTC(2026, 6, 30);
  const ent = (ticker, ageDays) => ({ ticker, file: `/x/${ticker}-${ageDays}.csv`, mtimeMs: NOW - ageDays * D });
  const names = gs => gs.map(g => g.ticker).join(',');
  eq(names(pickOrphans([ent('OLD-US', 400)], new Set(['NVDA-US']), NOW)), 'OLD-US',
    '不在清单里且满一年 → 该挪走');
  eq(names(pickOrphans([ent('OLD-US', 400)], new Set(['OLD-US']), NOW)), '',
    '在清单里的,再老也不动(那是你还在跟的票,只是这阵子没拉)');
  eq(names(pickOrphans([ent('OLD-US', 400)], new Set(), NOW)), '',
    '清单为空时一个都不动 —— 空清单多半是读失败,按字面办事会把整个 Assets 搬空');
  eq(names(pickOrphans([ent('OLD-US', 400), ent('OLD-US', 10)], new Set(['NVDA-US']), NOW)), '',
    '同一个代码只要还有一个文件是新的,整组留下(挪一半会留下一份自相矛盾的历史)');
  eq(names(pickOrphans([ent('A-US', 364), ent('B-US', 366)], new Set(['NVDA-US']), NOW)), 'B-US',
    '一年为界:364 天留,366 天走');
  eq(names(pickOrphans([ent('SPY-US', 400)], new Set(['NVDA-US', 'SPY-US']), NOW)), '',
    '市场级序列也要算进"还在用"的集合,否则 SPY 的日线一年后会被当成落榜公司挪走');
  eq(names(pickOrphans([{ ticker: 'X-US', file: '/x/y.csv', mtimeMs: -1 }], new Set(['NVDA-US']), NOW)), '',
    '读不到修改时间就别猜,留着');
  eq(RETAIN_DAYS, 365, '保留期和期权链滚存同一个界 —— 两处口径不一致就没人说得清历史留多久');

  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}

  console.log(fail === 0 ? 'SELFTEST OK' : `SELFTEST ${fail} FAILURES`);
  process.exit(fail === 0 ? 0 : 1);
}
