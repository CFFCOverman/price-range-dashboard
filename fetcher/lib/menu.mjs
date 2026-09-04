/* lib/menu.mjs — 控制台菜单(增删清单 / edit / mkt / chk / sources)
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { exec, execFile, spawn } from 'node:child_process';
import { releaseBrowser } from './browser.mjs';
import { lastBacktestDate, runBacktest } from './backtest.mjs';
import { APP_HTML, LOGIN_ONLY, MARKETS_FILE, OPTIONS_APP_HTML, OPTIONS_FLOW_TRAY, OPTIONS_FLOW_TRAY_LAUNCHER, TICKERS_FILE } from './config.mjs';
import { healthReport } from './health.mjs';
import { SOURCES_FILE, writeSources } from './ledger.mjs';
import { MARKETS, loadMarkets, saveMarkets, setMarkets } from './markets.mjs';
import { reconcileReport } from './reconcile.mjs';
import { IGNORED, TICKERS, VALID, loadIgnored, loadTickers, saveTickers, setIgnored, setTickers } from './tickers.mjs';
import { menuCommand, menuScreen, openDashboardAction, openPathSpec } from './menu-actions.mjs';

function launchSpec(spec) {
  if (!spec) return false;
  if (spec.file) execFile(spec.file, spec.args || []);
  else exec(spec.command);
  return true;
}

export const RL = (!LOGIN_ONLY && process.stdin.isTTY)
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;   /* 无终端(如定时任务):跳过所有交互 */
let pendingInput = null;
export function pauseMenuInput() { if (RL && !RL.closed) RL.pause(); }
export function resumeMenuInput() { if (RL && !RL.closed) RL.resume(); }
function carryInput(input) {
  if (input && !input.eof && String(input.value || '').trim()) pendingInput = input;
}
/* 空行与 EOF 必须是两种结果：空行留在菜单，终端关闭则安全退出。
 * 旧的 Promise.race 每问一次都会遗留一个 close listener，菜单多操作几次还会触发
 * MaxListenersExceededWarning；直接接住 question 的关闭异常即可同时解决两件事。 */
export async function askLine(q) {
  if (pendingInput) { const input = pendingInput; pendingInput = null; return input; }
  if (!RL || RL.closed) return { eof: true, value: '' };
  try { return { eof: false, value: await RL.question(q) }; }
  catch { return { eof: true, value: '' }; }
}
/** 启动和每轮结束都是这一个一级菜单；只有明确 run / exit 才离开。 */
export async function manageMenu() {
  if (!RL) return 'run';
  while (true) {
    console.log(menuScreen(TICKERS, MARKETS));
    const input = await askLine('请选择操作 > ');
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
      const r = openDashboardAction({ platform: process.platform, appHtml: APP_HTML, exists: fs.existsSync, launch: launchSpec });
      console.log(r.why);
      continue;
    }
    if (cmd === 'options-dashboard') {
      const r = openDashboardAction({ platform: process.platform, appHtml: OPTIONS_APP_HTML, exists: fs.existsSync, launch: launchSpec });
      console.log(r.ok ? `已打开 Options Positioning Dashboard: ${OPTIONS_APP_HTML}` : r.why);
      continue;
    }
    if (cmd === 'options-flow-tray') {
      if (!fs.existsSync(OPTIONS_FLOW_TRAY) || !fs.existsSync(OPTIONS_FLOW_TRAY_LAUNCHER)) console.log(`找不到托盘监测器或启动器: ${OPTIONS_FLOW_TRAY}`);
      else {
        /* stdio 必须是 ignore：默认 pipe 会把托盘寿命绑在主菜单进程上。
         * 同时先释放本进程的 persistent profile，否则独立监测器拿不到 FactSet 登录态。 */
        await releaseBrowser();
        const child = spawn('wscript.exe', [OPTIONS_FLOW_TRAY_LAUNCHER],
          { windowsHide: true, detached: true, stdio: 'ignore' });
        child.unref();
        console.log('正在独立启动期权方向监测；几秒后右下角系统托盘会出现图标。关闭本菜单不会停止。');
      }
      continue;
    }
    if (cmd === 'edit') {
      saveTickers(TICKERS);
      launchSpec(openPathSpec(process.platform, TICKERS_FILE, true));
      carryInput(await askLine('已打开记事本(tickers.txt)—— 保存后按回车刷新；也可直接输入下一条命令 '));
      setTickers(loadTickers());
      setIgnored(loadIgnored());   /* 忽略名单就写在同一个文件的注释行里,一起刷新 */
      continue;
    }
    if (cmd === 'markets') {
      saveMarkets(MARKETS);
      launchSpec(openPathSpec(process.platform, MARKETS_FILE, true));
      carryInput(await askLine('已打开记事本(markets.txt)—— 保存后按回车刷新；也可直接输入下一条命令 '));
      setMarkets(loadMarkets());
      console.log('市场级序列: ' + (MARKETS.length ? MARKETS.map(([s, r]) => s + '(' + r + ')').join('  ') : '(空,不拉取)'));
      continue;
    }
    if (cmd === 'health') { healthReport(); continue; }
    if (cmd === 'backtest') {
      /* 手动跑也照样记账。想"看一眼不留痕"的念头要压住:
       * 只在结果好看时才记的账,过几个月就是一份专门骗自己的历史。 */
      const last = lastBacktestDate();
      console.log(last ? `上一轮回测:${last}(这轮的数字会追加进同一份台账)` : '还没跑过回测,这是第一轮。');
      const r = runBacktest({ log: true });
      if (!r.ok) console.log(`\x1b[33m回测没跑成:${r.skipped || 'exit ' + r.code}\x1b[0m`);
      continue;
    }
    if (cmd === 'sync') {
      const rep = reconcileReport({ apply: true });
      if (rep.added.length) console.log('已补回清单:', rep.added.join(', '));
      continue;
    }
    if (cmd === 'sources') {
      if (!fs.existsSync(SOURCES_FILE)) writeSources();
      launchSpec(openPathSpec(process.platform, SOURCES_FILE, true));
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
    console.log('清单已保存。');
  }
}
