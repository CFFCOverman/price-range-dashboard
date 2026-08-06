/* steps/estimates.mjs — 第 1 步:Estimate History FY1/FY2
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import * as XLSX from 'xlsx';
import path from 'node:path';
import { clickTextInFrames, findTextInFrames, page } from '../lib/browser.mjs';
import { BASE, assetPath } from '../lib/config.mjs';
import { log } from '../lib/log.mjs';

/** 进入某 ticker 的 Estimate History 页,返回 {navFrame, tableFrame} */
export async function openEstimateHistory(ticker) {
  await page.goto(`${BASE}/workstation/navigator/company-security/estimate-history/${ticker}`, { waitUntil: 'domcontentloaded' });
  const nav = page.frameLocator('iframe[src*="company-security"]');
  const tbl = nav.frameLocator('iframe[src*="estimate-reports"]');
  await tbl.locator('tr').nth(5).waitFor({ timeout: 45000 });   // 等表格渲染
  await page.waitForTimeout(1500);
  return { nav, tbl };
}

/** 从内层 iframe 抓表格 → 二维数组 */
export function fyTag(label) {
  const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const m = label.match(/([A-Z][a-z]{2}) '(\d{2})E/);
  if (!m) return null;
  const end = new Date(2000 + +m[2], MONTHS[m[1]], 0);
  const months = (end - Date.now()) / 86400000 / 30.44;
  return months < 12 ? 'FY1' : months < 24 ? 'FY2' : 'FY3';
}
export function shiftLabel(label, years) {
  const m = label.match(/([A-Z][a-z]{2}) '(\d{2})E/);
  return `${m[1]} '${String(+m[2] + years).padStart(2, '0')}E`;
}
/** 页面上那一格财年标签("Jul '26E")。读不到就等一会儿再读。
 *
 *  为什么值得重试:表格本体和这一格是分开渲染的,表格出来了不代表标签也出来了。
 *  而这个 null 的代价大得不成比例 —— 下游"切到另一个财年"整段是 `if (p0 && …)`,
 *  标签一空,FY2 不是失败而是**根本没被尝试**:日志里连一行都没有,汇总表却打 ✖。
 *  2026-07-30 的 TSM-US 丢的就是这么一份 FY2。 */
export async function currentPeriod(tries = 3) {
  for (let i = 0; ; i++) {
    const v = await findTextInFrames("[A-Z][a-z]{2} '\\d{2}E");
    if (v || i >= tries - 1) return v;
    await page.waitForTimeout(1200);
  }
}
export async function switchPeriod(label) {
  const cur = await currentPeriod();
  if (!cur) return false;
  if (!(await clickTextInFrames(cur, false))) return false;   // 打开财年下拉
  await page.waitForTimeout(1200);
  if (!(await clickTextInFrames(label, true))) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  await page.waitForTimeout(4500);
  return (await currentPeriod()) === label;
}

/** 表格数组 → 仪表盘可识别的 Estimate History xlsx(B2 写入数据源出处,app 解析不受影响) */
export function saveEstimateXlsx(ticker, fyTag, rows, srcInfo) {
  const HEAD = ['Date','Mean','Sharp Cons','Num of Est','Num Up','Num Down','Low','High','Std Dev','Chg (%)','Chg Amt','P/E (x)','PEG (x)'];
  const data = rows.filter(r => /^\d{1,2} [A-Z][a-z]{2} '\d{2}$/.test(r[0] || ''))
    .map(r => r.length === 12 ? [...r.slice(0, 2), '-', ...r.slice(2)] : r);   // 无 Sharp Cons 列时补齐
  if (!data.length) { log(`  ⚠ ${ticker} ${fyTag}: 未抓到数据行`); return false; }
  const src = srcInfo || `FactSet Company/Security > Estimates > Estimate History (${ticker})`;
  const ws = XLSX.utils.aoa_to_sheet([[ticker], ['Estimate History', src], HEAD, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ticker.slice(0, 31));
  const f = assetPath(`${ticker} ${fyTag} Estimate History.xlsx`);
  XLSX.writeFile(wb, f);
  const span = data.length > 1 ? `${data[data.length - 1][0]} ~ ${data[0][0]}` : data[0][0];
  log(`  ✔ ${path.basename(f)} (${data.length} 行, ${span})`);
  return true;
}

/** 页面头部抓当前价格 */
