/* steps/targets.mjs — 第 3 步:Targets & Ratings 月度历史
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import * as XLSX from 'xlsx';
import path from 'node:path';
import { clickTextInFrames, page } from '../lib/browser.mjs';
import { BASE, assetPath } from '../lib/config.mjs';
import { phase, stampUTC } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';

export async function scrapeTargetsRows() {
  for (const f of page.frames()) {
    try {
      const rows = await f.evaluate(() => {
        if (!document.body || !/Mean Tgt Price/.test(document.body.innerText)) return null;
        return [...document.querySelectorAll('tr')]
          .map(r => [...r.querySelectorAll('th,td')].map(c => c.innerText.trim()))
          .filter(r => r.length > 5 && r.some(c => c));
      });
      if (rows && rows.length > 3) return rows;
    } catch {}
  }
  return null;
}
async function waitForTargetsRows(timeout = 8000) {
  const end = Date.now() + timeout;
  do {
    const rows = await scrapeTargetsRows();
    if (rows) return rows;
    await page.waitForTimeout(400);
  } while (Date.now() < end);
  return null;
}
/** 目标价/评级月度历史 → "{ticker} Targets Ratings.xlsx"(情绪面信号来源) */
export async function fetchTargets(ticker) {
  const url = `${BASE}/workstation/navigator/company-security/targets-and-ratings/${ticker}`;
  phase('导航');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  phase('等待页面');
  phase('定位表格');
  let rows = await waitForTargetsRows(8000);
  if (!rows) {   /* 默认 Detail 视图没有月度表 → 切 Report Type 下拉到 History(选择会被 FactSet 记住) */
    phase('切换 Report Type');
    await clickTextInFrames('Detail', false);
    await page.waitForTimeout(1200);
    await clickTextInFrames('History', false);
    phase('定位表格');
    rows = await waitForTargetsRows(6000);
  }
  if (!rows || rows.length < 3) throw new Error('未找到 History 月度表(可在页面左上角 Report Type 手动切到 History 后重跑)');
  phase('写文件');
  const src = `FactSet: Targets & Ratings (History) | ${url} | ${stampUTC()}`;
  const ws = XLSX.utils.aoa_to_sheet([[ticker], ['Targets Ratings', src], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ticker.slice(0, 31));
  const f = assetPath(`${ticker} Targets Ratings.xlsx`);
  XLSX.writeFile(wb, f);
  log(`  ✔ ${path.basename(f)} (${rows.length - 1} 个月度点)`);
  return true;
}

/** 空头持仓(当前值,逐日累积成时间序列)→ Assets/short-interest.csv */
