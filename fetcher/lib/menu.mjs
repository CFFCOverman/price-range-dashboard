/* lib/menu.mjs — 控制台菜单(增删清单 / edit / mkt / chk / sources)
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { exec } from 'node:child_process';
import { lastBacktestDate, runBacktest } from './backtest.mjs';
import { APP_HTML, LOGIN_ONLY, MARKETS_FILE, TICKERS_FILE } from './config.mjs';
import { healthReport } from './health.mjs';
import { SOURCES_FILE, writeSources } from './ledger.mjs';
import { MARKETS, loadMarkets, saveMarkets, setMarkets } from './markets.mjs';
import { reconcileReport } from './reconcile.mjs';
import { IGNORED, TICKERS, VALID, loadIgnored, loadTickers, printList, saveTickers, setIgnored, setTickers } from './tickers.mjs';
import { menuCommand, openDashboardAction } from './menu-actions.mjs';

export const RL = (!LOGIN_ONLY && process.stdin.isTTY)
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;   /* 无终端(如定时任务):跳过所有交互 */
/* 空行与 EOF 必须是两种结果：空行留在菜单，终端关闭则安全退出。
 * 旧的 Promise.race 每问一次都会遗留一个 close listener，菜单多操作几次还会触发
 * MaxListenersExceededWarning；直接接住 question 的关闭异常即可同时解决两件事。 */
export async function askLine(q) {
  if (!RL || RL.closed) return { eof: true, value: '' };
  try { return { eof: false, value: await RL.question(q) }; }
  catch { return { eof: true, value: '' }; }
}
/** 启动和每轮结束都是这一个一级菜单；只有明确 run / exit 才离开。 */
export async function manageMenu() {
  if (!RL) return 'run';
  printList(TICKERS);
  if (MARKETS.length) console.log('市场级序列(' + MARKETS.length + ' 个,只拉日线): ' + MARKETS.map(([s, r]) => s + '(' + r + ')').join('  '));
  console.log('操作:输代码添加(可多个)| -代码 删除 | edit | mkt | sync | chk | bt | sources');
  console.log('      open / dashboard 打开仪表盘 | run 开始拉取 | exit 退出  (空回车留在菜单)');
  while (true) {
    const input = await askLine('> ');
    const ans = input.value.trim();
    const cmd = menuCommand(ans, input.eof);
    if (cmd === 'empty') { console.log('请输入 run 开始拉取，或 exit 退出。'); continue; }
    if (cmd === 'exit') return 'exit';
    if (cmd === 'run') {
      saveTickers(TICKERS);
      if (!TICKERS.length) { console.log('清单为空，请先添加代码。'); continue; }
      return 'run';
    }
    if (cmd === 'dashboard') {
      const r = openDashboardAction({ platform: process.platform, appHtml: APP_HTML, exists: fs.existsSync, launch: command => exec(command) });
      console.log(r.why);
      if (r.ok) await askLine('确认看到仪表盘后按回车返回同一菜单 ');
      continue;
    }
    if (/^edit$/i.test(ans)) {
      saveTickers(TICKERS);
      const before = TICKERS.join(',');
      exec(`start notepad "${TICKERS_FILE}"`);
      await askLine('已打开记事本(tickers.txt)—— 编辑保存后回到这里按回车刷新清单 ');
      setTickers(loadTickers());
      setIgnored(loadIgnored());   /* 忽略名单就写在同一个文件的注释行里,一起刷新 */
      printList(TICKERS);
      continue;
    }
    if (/^(mkt|markets?)$/i.test(ans)) {
      saveMarkets(MARKETS);
      const before = JSON.stringify(MARKETS);
      exec(`start notepad "${MARKETS_FILE}"`);
      await askLine('已打开记事本(markets.txt)—— 编辑保存后回到这里按回车刷新 ');
      setMarkets(loadMarkets());
      console.log('市场级序列: ' + (MARKETS.length ? MARKETS.map(([s, r]) => s + '(' + r + ')').join('  ') : '(空,不拉取)'));
      continue;
    }
    if (/^(chk|check|health|体检)$/i.test(ans)) { healthReport(); continue; }
    if (/^(bt|backtest|回测)$/i.test(ans)) {
      /* 手动跑也照样记账。想"看一眼不留痕"的念头要压住:
       * 只在结果好看时才记的账,过几个月就是一份专门骗自己的历史。 */
      const last = lastBacktestDate();
      console.log(last ? `上一轮回测:${last}(这轮的数字会追加进同一份台账)` : '还没跑过回测,这是第一轮。');
      const r = runBacktest({ log: true });
      if (!r.ok) console.log(`\x1b[33m回测没跑成:${r.skipped || 'exit ' + r.code}\x1b[0m`);
      continue;
    }
    if (/^(sync|align|对齐)$/i.test(ans)) {
      const rep = reconcileReport({ apply: true });
      if (rep.added.length) printList(TICKERS);
      continue;
    }
    if (/^(sources|src)$/i.test(ans)) {
      if (!fs.existsSync(SOURCES_FILE)) writeSources();
      exec(`start notepad "${SOURCES_FILE}"`);
      console.log('已打开源出台账(sources.txt,只读性质——每次拉取自动更新,手改会被覆盖)');
      continue;
    }
    for (let tok of ans.split(/[,,;\s]+/).filter(Boolean)) {
      tok = tok.toUpperCase();
      if (tok.startsWith('-')) {
        const t = tok.slice(1);
        if (TICKERS.includes(t)) {
          setTickers(TICKERS.filter(x => x !== t));
          setIgnored([...IGNORED, t]);   /* 记下来,否则下次启动对齐检查会照着盘上的旧数据把它补回来 */
          console.log('  已删除', t, '(历史数据保留在 Assets/ 里,不会自动补回清单)');
        } else console.log('  ⚠ 清单里没有', t);
      } else if (!VALID.test(tok)) {
        console.log('  ⚠ 跳过无法识别的代码:', tok, '(格式应如 AMZN-US / ASML-US)');
      } else if (!TICKERS.includes(tok)) {
        TICKERS.push(tok);
        setIgnored(IGNORED.filter(x => x !== tok));   /* 手动加回来 = 撤销之前的删除 */
        console.log('  已添加', tok);
      } else console.log('  已在清单中:', tok);
    }
    saveTickers(TICKERS);
    printList(TICKERS);
    console.log('可继续增删；完成后输入 run 拉取，或 exit 退出。');
  }
}
