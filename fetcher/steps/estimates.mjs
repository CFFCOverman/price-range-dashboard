/* steps/estimates.mjs — 第 1 步:Estimate History FY1/FY2
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { clickTextInFrames, findTextInFrames, page } from '../lib/browser.mjs';
import { BASE, LOG_DIR, assetPath } from '../lib/config.mjs';
import { log } from '../lib/log.mjs';

export function tickerIdentityMatches(text, ticker) {
  const wanted = String(ticker || '').trim().toUpperCase();
  if (!wanted) return false;
  const tokens = [...new Set([wanted, wanted.split('-')[0]].filter(Boolean))];
  return tokens.some(token => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(String(text || ''));
  });
}
async function estimatePageIdentity(tbl, ticker) {
  try {
    const txt = await tbl.locator('body').innerText({ timeout: 12000 });
    return tickerIdentityMatches(txt, ticker);
  } catch { return false; }
}
/** 进入某 ticker 的 Estimate History 页,返回 {navFrame, tableFrame} */
export async function openEstimateHistory(ticker) {
  const url = `${BASE}/workstation/navigator/company-security/estimate-history/${ticker}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const nav = page.frameLocator('iframe[src*="company-security"]');
    const tbl = nav.frameLocator('iframe[src*="estimate-reports"]');
    await tbl.locator('tr').nth(5).waitFor({ timeout: 45000 });   // 等表格渲染
    if (await estimatePageIdentity(tbl, ticker)) return { nav, tbl };
    if (attempt === 1) {
      log(`  ⚠ 页面表格已出现,但证券身份不是 ${ticker}；重新导航一次,不读取上一家公司残留内容`);
      await page.waitForTimeout(1200);
    }
  }
  throw new Error(`页面证券身份连续两次不是 ${ticker},拒绝写入估值和现价`);
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
  const end = Date.now() + 10000;
  do {
    if ((await currentPeriod(1)) === label) return true;
    await page.waitForTimeout(400);
  } while (Date.now() < end);
  return false;
}

export const EST_HEAD = ['Date','Mean','Sharp Cons','Num of Est','Num Up','Num Down','Low','High','Std Dev','Chg (%)','Chg Amt','P/E (x)','PEG (x)'];
export function estimateDataRows(rows) {
  return rows.filter(r => /^\d{1,2} [A-Z][a-z]{2} '\d{2}$/.test(r[0] || ''))
    .map(r => r.length === 12 ? [...r.slice(0, 2), '-', ...r.slice(2)] : r);   // 无 Sharp Cons 列时补齐
}
export function estimateRowsVerdict(fy, rows) {
  const data = estimateDataRows(rows);
  if (!data.length) return { ok: false, reason: '未抓到数据行', data, pe: 0 };
  const pe = data.filter(r => isFinite(parseFloat(r[11])) && parseFloat(r[11]) > 0).length;
  const latestMean = parseFloat(data[0][1]);
  /* FY2 的 P/E 不能替代 FY1；这里只守 FY1。盈利为正、样本够做分位却连 12 个
   * 正 P/E 都没有，正是 2026-08-28 NVDA/AMD/AVGO 整列变成 '-' 的故障形状。 */
  if (fy === 'FY1' && isFinite(latestMean) && latestMean > 0 && data.length >= 12 && pe < 12) {
    return { ok: false, reason: `FY1 P/E 只有 ${pe}/${data.length} 个有效点(至少需要 12 个)`, data, pe };
  }
  return { ok: true, reason: '', data, pe };
}
export async function rowsWithOneRetry(loadRows, validate, onRetry = () => {}) {
  const first = await loadRows(1), v1 = validate(first);
  if (v1.ok) return { rows: first, verdict: v1, attempts: 1 };
  await onRetry(v1);
  const second = await loadRows(2), v2 = validate(second);
  return { rows: second, verdict: v2, attempts: 2 };
}
function writeEstimateBook(file, ticker, data, src) {
  const ws = XLSX.utils.aoa_to_sheet([[ticker], ['Estimate History', src], EST_HEAD, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ticker.slice(0, 31));
  XLSX.writeFile(wb, file);
}
function existingEstimateIsGood(file, fy) {
  try {
    const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    return estimateRowsVerdict(fy, rows).ok;
  } catch { return false; }
}
/** 表格数组 → 仪表盘可识别的 Estimate History xlsx(B2 写入数据源出处,app 解析不受影响) */
export function saveEstimateXlsx(ticker, fyTag, rows, srcInfo, { quarantine = false } = {}) {
  const verdict = estimateRowsVerdict(fyTag, rows), data = verdict.data;
  if (!verdict.ok) {
    log(`  ⚠ ${ticker} ${fyTag}: ${verdict.reason}`);
    if (quarantine && data.length) {
      const dir = path.join(LOG_DIR, 'rejected-estimates');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rejected = path.join(dir, `${stamp} ${ticker} ${fyTag} Estimate History.xlsx`);
      writeEstimateBook(rejected, ticker, data, srcInfo || `Rejected FactSet Estimate History (${ticker})`);
      log(`  ⚠ 第二次仍异常,已隔离 ${path.basename(rejected)}；标准文件保持不变`);
    }
    return false;
  }
  const src = srcInfo || `FactSet Company/Security > Estimates > Estimate History (${ticker})`;
  const f = assetPath(`${ticker} ${fyTag} Estimate History.xlsx`);
  /* 成功文件覆盖前留一份 last-good。目录在 _logs 下，仪表盘不会误扫成第二份公司数据。 */
  if (fs.existsSync(f) && existingEstimateIsGood(f, fyTag)) {
    const dir = path.join(LOG_DIR, 'last-good-estimates');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(f, path.join(dir, path.basename(f)));
  }
  writeEstimateBook(f, ticker, data, src);
  const span = data.length > 1 ? `${data[data.length - 1][0]} ~ ${data[0][0]}` : data[0][0];
  log(`  ✔ ${path.basename(f)} (${data.length} 行, ${span})`);
  return true;
}

/** 页面头部抓当前价格 */
