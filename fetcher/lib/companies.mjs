/* lib/companies.mjs — companies.csv 增量维护与文件新鲜度判定
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import { assetPath } from './config.mjs';

// ================= 主流程 =================
export const today = new Date().toISOString().slice(0, 10);
export const FRESH_HOURS = 20;   /* 文件在此小时数内视为最新,跳过重复拉取 */
export function isFresh(file) {
  try { return (Date.now() - fs.statSync(assetPath(file)).mtimeMs) < FRESH_HOURS * 3600e3; } catch { return false; }
}
/* companies.csv 增量维护:先载入已有行,拉到新价格才覆盖对应公司 */
export const CSV_HEADER = 'ticker,name,currency,price,price_date,eps_fy1_low,eps_fy1_mean,eps_fy1_high,eps_fy2_low,eps_fy2_mean,eps_fy2_high';
export const COMPANIES_CSV = assetPath('companies.csv');
export const priceMap = new Map();
try {
  if (fs.existsSync(COMPANIES_CSV)) {
    for (const line of fs.readFileSync(COMPANIES_CSV, 'utf8').split(/\r?\n/).slice(1)) {
      const tk = (line.split(',')[0] || '').trim().toUpperCase();
      if (tk) priceMap.set(tk, line);
    }
  }
} catch {}
