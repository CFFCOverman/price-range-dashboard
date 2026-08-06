/* lib/reconcile.mjs — 清单与数据的对齐检查:Assets/ 里有谁,tickers.txt 里写了谁
 *
 * 起因很具体:Assets/ 里躺着 6 家公司的数据,tickers.txt 只登记了 2 家。
 * 于是每次跑批只更新那 2 家,另外 4 家的文件停在几周前——但仪表盘照读不误,
 * 因为它扫的是文件夹,不是清单。**屏幕上有 6 家,其中 4 家是过期的,而且没有任何地方会告诉你。**
 * 这比"数据缺失"难发现得多:缺了你会去查,旧了你只会照着做判断。
 *
 * 判断依据是**文件名**,和仪表盘 `ingest/` 的识别规则、`registry.mjs` 的产出命名是同一套。
 * 不去解析文件内容,也不去读 companies.csv——多一条独立口径,就多一种两边说法不一致的可能。
 *
 * 补齐是**单向**的:Assets 有、清单没有 → 补进清单。反过来清单有、Assets 没有,
 * 只报告不删除:那可能是你刚加进去还没拉,也可能是拉失败了,两种都不该由脚本替你决定。
 */

import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from './config.mjs';
import { SELFTEST_ARTIFACTS } from './selftest-env.mjs';
import { IGNORED, TICKERS, VALID, saveTickers, setTickers } from './tickers.mjs';

/* 把 registry.mjs 的产出命名反过来读。顺序无所谓——文件名之间没有交集。 */
export const KIND_RULES = [
  ['estimates', /^(.+?) FY\d+ Estimate History\.xlsx$/i],
  ['charting', /^(.+?) Daily Charting\.xlsx$/i],
  ['targets', /^(.+?) Targets Ratings\.xlsx$/i],
  ['news', /^(.+?) News\.csv$/i],
  ['options', /^(.+?) Options\.csv$/i],
];
export const KINDS = KIND_RULES.map(r => r[0]);
export const KIND_CN = { estimates: '估值', charting: '走势', targets: '目标价', news: '新闻', options: '期权' };
/** 市场级序列长得像走势文件,但它不是公司,必须先认出来摘掉 */
export const MARKET_RULE = /^_MARKET-([A-Z]+) (.+?) Daily Charting\.xlsx$/i;

/**
 * 一个文件名 → 它属于谁、算哪一类。认不出返回 null(汇总 csv、手动导出、自检遗留都在此列)。
 */
export function classifyAssetFile(name) {
  const base = path.basename(String(name || ''));
  if (SELFTEST_ARTIFACTS.includes(base)) return null;
  const mk = MARKET_RULE.exec(base);
  if (mk) return { market: true, ticker: mk[2].trim().toUpperCase(), role: mk[1].toUpperCase(), kind: 'charting' };
  for (const [kind, re] of KIND_RULES) {
    const g = re.exec(base);
    if (!g) continue;
    const t = g[1].trim().toUpperCase();
    return VALID.test(t) ? { market: false, ticker: t, kind } : null;   // 形如代码才算,其余当手动导出放过
  }
  return null;
}

/**
 * 扫一遍 Assets/,返回谁有哪几类数据。
 * 递归三层(和仪表盘的 collectDirFiles 一致),跳过 `_` 开头的目录——`_logs` 是日志不是数据。
 */
export function scanAssets(root = OUT_DIR) {
  const data = new Map();      // ticker → Set(kind)
  const markets = new Map();   // 市场序列代码 → 角色
  const litter = [];           // 自检遗留在真实 Assets 里的文件(绝对路径)
  let files = 0;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('_')) walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      files++;
      if (SELFTEST_ARTIFACTS.includes(e.name)) { litter.push(p); continue; }
      const c = classifyAssetFile(e.name);
      if (!c) continue;
      if (c.market) { if (!markets.has(c.ticker)) markets.set(c.ticker, c.role); continue; }
      if (!data.has(c.ticker)) data.set(c.ticker, new Set());
      data.get(c.ticker).add(c.kind);
    }
  };
  walk(root, 0);
  return { data, markets, litter, files };
}

/**
 * 对齐。apply=true 时把"有数据但没登记"的代码写回 tickers.txt(并同步内存清单)。
 * 忽略名单(tickers.txt 里的 `# ignore:` 行)里的代码不补——你手动删掉的东西不该自己长回来。
 */
export function reconcileTickers({ apply = true, list = TICKERS, ignored = IGNORED, root = OUT_DIR } = {}) {
  const scan = scanAssets(root);
  const inList = new Set(list);
  const skipped = [], extra = [];
  for (const t of [...scan.data.keys()].sort()) {
    if (inList.has(t)) continue;
    (ignored.includes(t) ? skipped : extra).push(t);
  }
  const missing = list.filter(t => !scan.data.has(t));
  const partial = [];
  for (const t of list) {
    const have = scan.data.get(t);
    if (!have) continue;
    const lack = KINDS.filter(k => !have.has(k));
    if (lack.length) partial.push([t, lack]);
  }
  let added = [];
  let next = list;
  if (apply && extra.length) {
    added = extra;
    next = [...list, ...extra];
    saveTickers(next);
    setTickers(next);
  }
  return { ...scan, extra, added, skipped, missing, partial, list: next };
}

const kinds = set => KINDS.filter(k => set.has(k)).map(k => KIND_CN[k]).join('·');
const lacks = arr => arr.map(k => KIND_CN[k]).join('·');

/** 打印对齐结果。安静原则:全部对齐时只有一行,别人不会去读一份天天说"没事"的报告。 */
export function printReconcile(rep) {
  const total = rep.data.size;
  if (!rep.extra.length && !rep.missing.length && !rep.partial.length && !rep.litter.length) {
    console.log(`  · 清单与数据对齐:${total} 家,一致 ✔`);
    return;
  }
  console.log('\n---------- 清单与数据对齐(Assets/ 有谁 × tickers.txt 写了谁)----------');
  console.log(`  Assets/ 里有数据 ${total} 家 · 清单登记 ${rep.list.length} 家`
    + (rep.markets.size ? ` · 市场级序列 ${rep.markets.size} 个` : ''));
  if (rep.added.length) {
    console.log('\n  ✚ 已补进 tickers.txt(有数据却没登记 —— 之前每轮跑批都在跳过它们):');
    for (const t of rep.added) {
      const have = rep.data.get(t);
      const lack = KINDS.filter(k => !have.has(k));
      console.log(`     ${t.padEnd(10)} 已有 ${kinds(have)}` + (lack.length ? `   缺 ${lacks(lack)}(下一轮补上)` : ''));
    }
    console.log('     不想要哪个,在下面菜单输 -代码 删掉即可(删了就不会再补回来)。');
  }
  if (rep.extra.length && !rep.added.length) {
    console.log('\n  ✚ 有数据但没登记(本次未改动清单):' + rep.extra.join('  '));
  }
  if (rep.skipped.length) {
    console.log('\n  · 有数据但你已主动删除,不再补回:' + rep.skipped.join('  '));
  }
  if (rep.missing.length) {
    console.log('\n  ○ 在清单里但一个文件都没有(新加入,或从第一次就没拉成):');
    console.log('     ' + rep.missing.join('  '));
  }
  if (rep.partial.length) {
    console.log('\n  ⚠ 数据不全 —— 缺的这几类,仪表盘里对应的面板会直接空着:');
    for (const [t, lack] of rep.partial) console.log(`     ${t.padEnd(10)} 缺 ${lacks(lack)}`);
  }
  if (rep.litter.length) {
    console.log(`\n  · 自检遗留文件 ${rep.litter.length} 个(不计入上面的统计,启动时会自动挪进 _to_delete/)`);
  }
  console.log('----------------------------------------------------------------------');
}

/** 入口与菜单共用:对齐一次并打印,返回结果 */
export function reconcileReport(opts) {
  const rep = reconcileTickers(opts);
  printReconcile(rep);
  return rep;
}
