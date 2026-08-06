/* steps/news.mjs — 第 5 步:StreetAccount 新闻标题
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import { page } from '../lib/browser.mjs';
import { BASE, assetPath } from '../lib/config.mjs';
import { phase } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';

/* ============ StreetAccount 新闻标题(情绪面第四条腿)============
 * 页面是虚拟化的自定义 tf-grid:没有 <tr>,scrollTop 也不吃程序赋值。
 * 解法:抓取前把视口临时拉高到 2400px,让虚拟列表一次性渲染完;
 *       再用单元格 bounding-rect 的 top/left 把"格子"还原成"行"。 */
export const NEWS_MAX_ROWS = 500;
/* 下面几个纯函数用 function 声明(会提升),--selftest 在文件靠前处就能调用 */
export function pad2(n) { return String(n).padStart(2, '0'); }
export function newsMonth(abbr) {
  return { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }[abbr] || 0;
}
/** "00:06"(今天)/"27 Jul '26"/"27 Jul" → YYYY-MM-DD;ref 供自检注入固定"今天" */
export function parseNewsDate(s, ref) {
  const now = ref ? new Date(ref) : new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const v = String(s || '').trim();
  if (/^\d{1,2}:\d{2}$/.test(v)) return todayISO;              // 只有时间 = 当天
  let m = v.match(/^(\d{1,2})\s+([A-Z][a-z]{2})\s+'(\d{2})$/);
  if (m && newsMonth(m[2])) return `${2000 + +m[3]}-${pad2(newsMonth(m[2]))}-${pad2(+m[1])}`;
  m = v.match(/^(\d{1,2})\s+([A-Z][a-z]{2})$/);                // 没写年份 → 取不晚于今天的那一年
  if (m && newsMonth(m[2])) {
    const y = now.getUTCFullYear();
    const tail = `-${pad2(newsMonth(m[2]))}-${pad2(+m[1])}`;
    return `${y}${tail}` > todayISO ? `${y - 1}${tail}` : `${y}${tail}`;
  }
  return null;
}
export function csvCell(s) {
  const v = String(s ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
export function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
/** 用单元格几何位置把虚拟表格还原成行 */
export async function scrapeNewsRows() {
  let best = null;
  for (const f of page.frames()) {
    try {
      const rows = await f.evaluate(() => {
        const cells = [...document.querySelectorAll('[class*="tf-grid-cell-base"]')];
        if (cells.length < 9) return null;
        const m = new Map();
        for (const c of cells) {
          const r = c.getBoundingClientRect();
          if (r.height <= 0 || r.width <= 0) continue;
          const k = Math.round(r.top / 2) * 2;
          if (!m.has(k)) m.set(k, []);
          m.get(k).push([r.left, (c.innerText || '').replace(/\s+/g, ' ').trim()]);
        }
        return [...m.entries()].sort((a, b) => a[0] - b[0])
          .map(([, v]) => v.sort((a, b) => a[0] - b[0]).map(x => x[1]));
      });
      if (rows && rows.length > 2 && (!best || rows.length > best.length)) best = rows;
    } catch {}
  }
  return best;
}
/** 抓到的行 → {date, ids, headline}[] */
export function parseNewsRows(rows, ref) {
  const out = [];
  for (const r of rows || []) {
    if (!r || r.length < 2) continue;
    const date = parseNewsDate(r[0], ref);
    if (!date) continue;                                    // 表头/分组行自然被滤掉
    const headline = String(r[r.length - 1] || '')
      .replace(/\s*\(\$[\d.,]+,\s*-?[\d.,]+\)\s*$/, '')     // 去掉尾部行情括号
      .trim();
    if (headline.length < 8) continue;
    out.push({ date, ids: r.length >= 3 ? String(r[1] || '').trim() : '', headline });
  }
  return out;
}
/** 累积去重写入 "{ticker} News.csv" */
export function saveNewsCsv(ticker, recs) {
  const f = assetPath(`${ticker} News.csv`);
  const seen = new Map();
  try {
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue;
        const c = splitCsvLine(line);
        if (c.length >= 3 && c[0]) seen.set(c[0] + '|' + c[2], { date: c[0], ids: c[1], headline: c[2] });
      }
    }
  } catch {}
  const before = seen.size;
  for (const r of recs) seen.set(r.date + '|' + r.headline, r);
  const all = [...seen.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, NEWS_MAX_ROWS);
  fs.writeFileSync(f, 'date,ids,headline\n' + all.map(r => [r.date, r.ids, r.headline].map(csvCell).join(',')).join('\n') + '\n');
  return { total: all.length, added: Math.max(0, seen.size - before) };
}
export async function fetchNews(ticker) {
  const url = `${BASE}/workstation/navigator/company-security/streetaccount/${ticker}`;
  phase('导航');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  phase('等待页面');
  await page.waitForTimeout(9000);
  /* 虚拟列表不吃 scrollTop:把视口拉高,让它一次性渲染完整页 */
  const vp = page.viewportSize() || { width: 1600, height: 900 };
  await page.setViewportSize({ width: vp.width, height: 2400 }).catch(() => {});
  await page.waitForTimeout(4000);
  phase('定位表格');
  let rows = await scrapeNewsRows();
  if (!rows) { await page.waitForTimeout(6000); rows = await scrapeNewsRows(); }
  phase('解析行');
  const bag = new Map();
  const add = rs => { for (const r of parseNewsRows(rs)) bag.set(r.date + '|' + r.headline, r); };
  if (rows) add(rows);
  /* 滚轮兜底:再往下滚两屏合并(滚不动也无害) */
  for (let i = 0; i < 3 && bag.size; i++) {
    try {
      await page.mouse.move(vp.width / 2, 1200);
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1500);
      const more = await scrapeNewsRows();
      if (more) add(more);
    } catch { break; }
  }
  await page.setViewportSize(vp).catch(() => {});
  if (!bag.size) throw new Error('未解析出新闻行(StreetAccount 表格结构或日期格式改版)');
  phase('写文件');
  const { total, added } = saveNewsCsv(ticker, [...bag.values()]);
  log(`  ✔ ${ticker} News.csv (本轮 ${bag.size} 条,新增 ${added},累计 ${total})`);
  return true;
}
