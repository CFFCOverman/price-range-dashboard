/* lib/tickers.mjs — 拉取清单 tickers.txt 的读写与内存状态
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import { TICKERS_DEFAULT, TICKERS_FILE, TICKERS_JSON_OLD } from './config.mjs';

/* ============ 拉取清单:tickers.txt(一行一个,# 注释),控制台可批量增删或直接弹记事本编辑 ============ */
export const VALID = /^[A-Z.]{1,6}-[A-Z]{2}$/;
export function loadTickers() {
  try {
    if (fs.existsSync(TICKERS_FILE)) {
      const list = fs.readFileSync(TICKERS_FILE, 'utf8').split(/\r?\n/)
        .map(s => s.replace(/#.*$/, '').trim().toUpperCase())
        .filter(s => s && VALID.test(s));
      if (list.length) return [...new Set(list)];
    }
    if (fs.existsSync(TICKERS_JSON_OLD)) {   // 兼容旧版 json,自动迁移
      const list = JSON.parse(fs.readFileSync(TICKERS_JSON_OLD, 'utf8')).tickers;
      saveTickers(list);
      return list;
    }
  } catch {}
  return [...TICKERS_DEFAULT];
}
/* ============ 忽略名单:你主动删掉的代码 ============
 * 存在 tickers.txt 自己的注释行里(`# ignore: XXX-US`),不另开文件——清单和它的例外应该同生共死。
 *
 * 为什么非要有:启动时的"清单与数据对齐"会把 Assets/ 里有数据、清单里却没有的代码补进清单。
 * 而删清单并不删数据。所以没有这份名单的话,你今天删掉 SPCX-US,明天启动它就原地复活了——
 * 一个东西被删掉之后自己长回来,是最快让人不再信任这个工具的行为,比它少干点活严重得多。
 */
export const IGNORE_LINE = /^#\s*ignore:\s*([A-Z.]{1,6}-[A-Z]{2})\s*$/i;
export function loadIgnored() {
  try {
    return [...new Set(fs.readFileSync(TICKERS_FILE, 'utf8').split(/\r?\n/)
      .map(s => (IGNORE_LINE.exec(s.trim()) || [])[1])
      .filter(Boolean).map(s => s.toUpperCase()))];
  } catch { return []; }
}
export let IGNORED = loadIgnored();
/** 同 setTickers:ESM 的 import 绑定不可跨模块赋值,菜单通过它回写 */
export function setIgnored(list) { IGNORED = [...new Set(list.map(s => String(s).toUpperCase()))]; }

export function saveTickers(list, ignored = IGNORED) {
  fs.writeFileSync(TICKERS_FILE,
    '# Price Range Dashboard 拉取清单 — 一行一个代码(如 NVDA-US),# 开头为注释\n' +
    '# 可直接用记事本编辑保存;也可在运行时的控制台里增删。\n' +
    (ignored.length
      ? '#\n# 下面是你主动删掉的标的:它们在 Assets/ 里还有历史数据,但启动时的"清单与数据对齐"\n'
        + '# 不会再把它们补回来。想恢复:删掉对应的 ignore 行,或在控制台里直接输入该代码。\n'
        + ignored.map(t => '# ignore: ' + t).join('\n') + '\n#\n'
      : '') +
    list.join('\n') + '\n');
}
export function printList(list) {
  console.log('\n当前拉取清单(' + list.length + ' 家):');
  list.forEach((t, i) => console.log('   ' + String(i + 1).padStart(2) + '. ' + t));
}
export let TICKERS = loadTickers();
if (!fs.existsSync(TICKERS_FILE)) saveTickers(TICKERS);
/** 菜单改动清单后回写内存状态(ESM 的 import 绑定不可跨模块赋值) */
export function setTickers(list) { TICKERS = list; }
