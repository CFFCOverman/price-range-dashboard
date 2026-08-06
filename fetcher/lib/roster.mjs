/* lib/roster.mjs —— 把"拉取清单"这件事告诉仪表盘,以及一年之后怎么处置落榜的数据
 *
 * 起因:仪表盘扫的是文件夹,不是清单。你从 tickers.txt 里删掉一个代码,数据还在 Assets/ 里躺着,
 * 于是它照样出现在表格里 —— 只是从此再也不更新。屏幕上那一行看不出任何异常,
 * 你却会照着一份停在三个月前的价格做判断。这比"数据不见了"危险得多。
 *
 * 两件事,一件事一个口径,别混:
 *
 *   1) 显示归显示。每次启动往 Assets/summary/roster.csv 写一份当前清单,仪表盘读它来决定画谁。
 *      不在清单里的**不删、不动、照常载入**,只是默认不画出来,表格下面留一行可以点开看。
 *      —— 这一步完全可逆:清单里加回来,下一轮启动它就回到表格里了。
 *
 *   2) 清理归清理。落榜之后**满一年**才动它,而且是挪进 _to_delete/,不是删除。
 *      一年这个数字不是随手定的:它和期权链滚存用的是同一个界(见 opt-store.mjs),
 *      两处口径要是不一样,以后没人说得清"我的历史到底留多久"。
 *      最后那一下删除由人按,脚本不替你销毁攒了一年的授权数据。
 *
 * 为什么落榜判定用文件 mtime 而不是另记一个"删除日期":因为清单一删,那个代码就不再被抓,
 * 它所有文件的 mtime 就此冻结在最后一次抓取那天。mtime 本身就是"它凉了多久",不用再存一份。
 * 少一份状态,就少一次两边对不上的机会。
 */

import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR, assetPath } from './config.mjs';
import { MARKETS } from './markets.mjs';
import { retire } from './migrate.mjs';
import { classifyAssetFile } from './reconcile.mjs';
import { TICKERS } from './tickers.mjs';

export const ROSTER_FILE = 'roster.csv';
export const ROSTER_HEADER = 'ticker,role,active';
/** 落榜多久才清理。和期权链滚存同一个界,改这里等于改整套保留期口径 */
export const RETAIN_DAYS = 365;
const DAY = 86400000;

/* 结尾这行给打开文件的人看。CSV 没有注释语法,所以它会被解析成一行数据 ——
 * 仪表盘那侧靠"ticker 以 # 开头就跳过"把它滤掉(src/js/ingest/roster.js)。
 * 两边是一对约定:这里改了措辞不要紧,改了开头那个 # 就会凭空多出一家叫「这份文件…」的公司。 */
export const ROSTER_NOTE = '# 这份文件由 fetcher 自动生成 —— 要增删标的请改 fetcher/tickers.txt 而不是这里';

/**
 * 清单 → CSV 文本。纯函数,不碰盘。
 * 公司写 role=company;市场级序列带上自己的角色(BENCH/SECTOR/CREDIT/RATES),
 * 它们不是公司、不会出现在表格里,写进来只为让这份文件自己说得清"这一轮到底要拉什么"。
 */
export function rosterCsv(tickers = TICKERS, markets = MARKETS) {
  const lines = [ROSTER_HEADER];
  const seen = new Set();
  for (const t of [...tickers].map(s => String(s).trim().toUpperCase()).filter(Boolean).sort()) {
    if (seen.has(t)) continue;
    seen.add(t);
    lines.push(`${t},company,1`);
  }
  for (const [sym, role] of markets || []) {
    const s = String(sym || '').trim().toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    lines.push(`${s},${String(role || '').trim().toLowerCase()},1`);
  }
  lines.push(ROSTER_NOTE);
  return lines.join('\n') + '\n';
}

/** 写一份 roster.csv 到 Assets/summary/。返回落盘路径;写不进去返回 null(不阻断抓取)。 */
export function writeRoster(tickers = TICKERS, markets = MARKETS) {
  try {
    const f = assetPath(ROSTER_FILE);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rosterCsv(tickers, markets), 'utf8');
    return f;
  } catch { return null; }
}

/**
 * 扫一遍 Assets/,列出每个数据文件属于谁、上次写是什么时候。
 * 递归三层、跳过 `_` 开头的目录 —— 和 reconcile.scanAssets、仪表盘的 collectDirFiles 同一套走法。
 * 认不出归属的文件(汇总 csv、手动导出、自检遗留)一律不列 —— 清理只动"明确属于某个代码"的东西。
 */
export function listAssetFiles(root = OUT_DIR) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('_')) walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const c = classifyAssetFile(e.name);
      if (!c) continue;
      let mtimeMs = -1;
      try { mtimeMs = fs.statSync(p).mtimeMs; } catch {}
      out.push({ ticker: c.ticker, market: !!c.market, kind: c.kind, file: p, mtimeMs });
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 谁该被清理。纯函数(便于自检钉住边界),按**代码**成组判定,不按单个文件。
 *
 * 成组是关键:只要这个代码还有**任何一个**文件比一年新,整组都留下。
 * 按文件逐个挪的话,一年半的日线被挪走、半年前的估值还留着,剩下的是一份自相矛盾的历史 ——
 * 仪表盘照读不误,画出来的东西却谁也解释不了。要走一起走。
 *
 * @param entries  listAssetFiles() 的产物
 * @param activeSet 现在还在清单里的代码(公司 + 市场序列)
 * @returns [{ticker, files, newestMs, ageDays}] 按代码排序
 */
export function pickOrphans(entries, activeSet, todayMs, days = RETAIN_DAYS) {
  const keep = new Set([...(activeSet || [])].map(s => String(s).trim().toUpperCase()));
  /* 清单空了就一个都不动。空清单多半是文件被清掉/读失败,而不是"这些我全都不要了" ——
   * 这种时候按字面办事,会把整个 Assets 一次性搬空。 */
  if (!keep.size) return [];
  const cut = todayMs - days * DAY;
  const by = new Map();
  for (const e of entries || []) {
    const tk = String(e?.ticker || '').trim().toUpperCase();
    if (!tk || keep.has(tk)) continue;
    if (!by.has(tk)) by.set(tk, []);
    by.get(tk).push(e);
  }
  const out = [];
  for (const [ticker, files] of by) {
    const newestMs = files.reduce((a, f) => Math.max(a, Number(f.mtimeMs) || 0), 0);
    if (!(newestMs > 0)) continue;          // 读不到时间就别猜,留着
    if (newestMs > cut) continue;           // 还有新文件 → 整组留下
    out.push({ ticker, files, newestMs, ageDays: Math.floor((todayMs - newestMs) / DAY) });
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/**
 * 执行清理:落榜满一年的,整组挪进 _to_delete/,并当场说清楚挪了谁、挪了几个文件。
 * apply:false 只看不动(菜单/自检用)。返回 {groups, moved, failed}。
 */
export function sweepOrphans({ apply = true, todayMs = Date.now(), root = OUT_DIR,
  tickers = TICKERS, markets = MARKETS, days = RETAIN_DAYS } = {}) {
  const active = new Set([
    ...[...tickers].map(s => String(s).toUpperCase()),
    ...[...(markets || [])].map(([s]) => String(s).toUpperCase()),
  ]);
  const groups = pickOrphans(listAssetFiles(root), active, todayMs, days);
  let moved = 0, failed = 0;
  if (apply) {
    for (const g of groups) for (const f of g.files) (retire(f.file) ? moved++ : failed++);
  }
  return { groups, moved, failed, days };
}

/** 打印清理结果。安静原则:没东西可挪就一个字都不说。 */
export function printSweep(rep) {
  if (!rep || !rep.groups.length) return;
  console.log(`\n---------- 落榜满 ${rep.days} 天的数据已挪进 _to_delete/ ----------`);
  console.log('  这些代码不在 tickers.txt 里,而且最后一次更新已经过去一年多:');
  for (const g of rep.groups) {
    console.log(`     ${g.ticker.padEnd(10)} ${String(g.files.length).padStart(3)} 个文件 · 最后更新 ${new Date(g.newestMs).toISOString().slice(0, 10)}(${g.ageDays} 天前)`);
  }
  console.log(`  共 ${rep.moved} 个文件已挪走` + (rep.failed ? `,${rep.failed} 个挪不动(被占用?下次启动再试)` : '') + '。');
  console.log('  \x1b[1m挪走不等于删除\x1b[0m —— 东西都在仓库根的 _to_delete/ 里,要不要真删由你决定。');
  console.log('  想留下某个代码:把它加回 tickers.txt(并删掉对应的 # ignore: 行),再把文件从 _to_delete/ 拖回 Assets/。');
  console.log('---------------------------------------------------------------');
}

/** 入口共用:写清单 + 清理一次并打印 */
export function rosterReport(opts) {
  writeRoster();
  const rep = sweepOrphans(opts);
  printSweep(rep);
  return rep;
}
