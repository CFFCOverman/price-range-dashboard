/* lib/log.mjs — 进度条与带时间戳的日志
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, ensureAssetDirs } from './config.mjs';

/* ============ 进度条(TTY 动态刷新;无终端时打印里程碑) ============ */
export const isTTY = !!process.stdout.isTTY;
export let barState = null;
export function drawBar() {
  if (!barState || !isTTY) return;
  const { done, total, label } = barState;
  const W = 26, f = Math.min(W, Math.round(done / total * W));
  const pct = String(Math.round(done / total * 100)).padStart(3);
  process.stdout.write('\r[' + '█'.repeat(f) + '░'.repeat(W - f) + '] ' + pct + '% (' + done + '/' + total + ') ' + String(label).slice(0, 50) + '    ');
}
export function barClear() { if (isTTY && barState) process.stdout.write('\r' + ' '.repeat(110) + '\r'); }
export function bar(done, total, label) {
  barState = { done, total, label };
  if (isTTY) drawBar();
  else console.log(`[进度 ${Math.round(done / total * 100)}%] (${done}/${total}) ${label}`);
}
export function barEnd() { if (isTTY && barState) { drawBar(); process.stdout.write('\n'); } barState = null; }
/* ============ 跑批日志:控制台看到的东西同时落一份到 Assets/_logs/fetch-<日期>.log ============
 * 出问题时你不用再回终端里翻滚动条(而且终端缓冲区总是刚好把关键那几行吃掉)。
 * 按天一个文件,append;写日志失败绝不能拖垮抓取,所以整段吞异常。 */
export const LOG_FILE = path.join(LOG_DIR, `fetch-${new Date().toISOString().slice(0, 10)}.log`);
let logReady = false;
export function fileLog(line) {
  try {
    if (!logReady) { ensureAssetDirs(); logReady = true; }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}
export const log = (...a) => {
  const ts = new Date().toISOString().slice(11, 19);
  barClear();
  console.log(ts, ...a);
  fileLog(ts + ' ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  drawBar();
};
/** 只进日志文件、不打扰终端(用于分隔线、环境信息这类噪音) */
export const logQuiet = line => fileLog(line);
ensureAssetDirs();
