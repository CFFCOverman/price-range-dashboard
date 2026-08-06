/* lib/ledger.mjs — 源出台账 v2:登记产出、记录失败子阶段
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.mjs';
import { log } from './log.mjs';

/* ============ 源出台账 v2:Assets/_logs/sources.txt —— 不只是"从哪来",更是"哪一环断了" ============
 * 每个产出文件一行,九列固定:
 *   状态 | 步骤 | 文件 | FactSet 页签路径 | 内容说明 | 最近成功(UTC) | 最近失败(UTC) | 失败环节 | URL
 * 失败环节记录的是子阶段(导航/等待页面/切换 Report Type/定位表格/解析行/写文件),
 * 于是 FactSet 改版时,看一眼台账就知道是"页面没打开"还是"表格选择器失效"。 */
export const SOURCES_FILE = path.join(LOG_DIR, 'sources.txt');
export const LED_COLS = 9;
export const ledger = new Map();          // file -> {status, step, file, tab, desc, okAt, failAt, failPhase, url}
export const clean = s => String(s ?? '').replace(/[|\r\n]+/g, ' / ').replace(/\s+/g, ' ').trim() || '-';
export const stampUTC = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
(function loadLedger() {
  try {
    if (!fs.existsSync(SOURCES_FILE)) return;
    for (const line of fs.readFileSync(SOURCES_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue;
      const c = line.split('|').map(s => s.trim());
      if (c.length < LED_COLS) continue;   // v1 旧格式 → 丢弃,本轮自动重建
      ledger.set(c[2], { status: c[0], step: c[1], file: c[2], tab: c[3], desc: c[4], okAt: c[5], failAt: c[6], failPhase: c[7], url: c[8] });
    }
  } catch {}
})();
/** 只登记元信息(用于"跳过未过期"或"尚未拉取"的条目),不改动状态与时间戳 */
export function noteArtifact(meta) {
  const prev = ledger.get(meta.file) || { status: '未拉取', okAt: '-', failAt: '-', failPhase: '-' };
  ledger.set(meta.file, { ...prev, ...meta });
  return ledger.get(meta.file);
}
/* 当前子阶段:每个抓取函数在推进时调用 phase(),失败时台账记下停在哪一环 */
export const PHASES = ['导航', '等待页面', '切换 Report Type', '定位表格', '解析行', '写文件'];
export let curPhase = '-';
export const phase = p => { curPhase = p; };
/** 包住一次抓取:成功/失败都写台账,失败落在哪个子阶段一目了然 */
export async function step(meta, fn) {
  noteArtifact(meta);
  phase('导航');
  let ok = false, err = null;
  try { ok = await fn(); } catch (e) { err = e; }
  const rec = ledger.get(meta.file);
  if (ok) { rec.status = 'OK'; rec.okAt = stampUTC(); rec.failPhase = '-'; }
  else {
    rec.status = 'FAIL'; rec.failAt = stampUTC();
    rec.failPhase = clean(curPhase + (err ? ' :: ' + String(err.message).split('\n')[0].slice(0, 80) : ''));
    log(`  ⚠ ${meta.step} 失败 —— 断在【${rec.failPhase}】(详见 sources.txt,菜单输 chk 看体检)`);
  }
  ledger.set(meta.file, rec);
  return ok;
}
export function writeSources() {
  const head = '# 数据源出台账 v2 — 由 factset-fetch 自动维护(每轮覆盖,勿手改格式)\n'
    + '# 用途:某天数据不对时,先看"状态";FAIL 行的"失败环节"直接告诉你 FactSet 哪一环变了。\n'
    + '# 子阶段: ' + PHASES.join(' → ') + '\n'
    + '# 列: 状态 | 步骤 | 文件 | FactSet 页签路径 | 内容说明 | 最近成功(UTC) | 最近失败(UTC) | 失败环节 | URL\n';
  const body = [...ledger.values()]
    .sort((a, b) => (a.file || '').localeCompare(b.file || ''))
    .map(r => [r.status || '未拉取', r.step, r.file, r.tab, r.desc, r.okAt || '-', r.failAt || '-', r.failPhase || '-', r.url]
      .map(clean).join(' | '))
    .join('\n');
  fs.writeFileSync(SOURCES_FILE, head + body + '\n');
}
