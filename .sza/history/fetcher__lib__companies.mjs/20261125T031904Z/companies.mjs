/* lib/companies.mjs — companies.csv 增量维护与文件新鲜度判定
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import { ledger } from './ledger.mjs';
import { assetPath } from './config.mjs';

// ================= 主流程 =================
/** FactSet 美股快照按纽约交易日归档；UTC 午夜后纽约仍是前一日，不能提前造出“明天”的 OI。 */
export function marketDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = k => parts.find(x => x.type === k)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/* 活绑定:fetcher 进程会开着过夜(菜单循环),每轮开始由 lib/round.mjs 调 refreshToday(),
 * 否则过了午夜价格、期权快照、空头持仓仍会盖着启动那天的日期 */
export let today = marketDate();
export function refreshToday(now = new Date()) { today = marketDate(now); return today; }
export const FRESH_HOURS = 20;   /* 文件在此小时数内视为最新,跳过重复拉取 */
export const FRESH_HOURS_BY_KIND = Object.freeze({
  /* targets 原 144h:财报季目标价/评级一天内就会大面积调整,一周一拉会漏(2026-11-19 改 20h) */
  price: 0, estimates: 0, valuation: 0, targets: FRESH_HOURS,
  charting: FRESH_HOURS, market: FRESH_HOURS, news: FRESH_HOURS, options: FRESH_HOURS, short: FRESH_HOURS,
});
/** 旧调用 `isFresh('x')` 仍保持 20h；registry meta 可携带 kind/freshHours 选择周期。 */
export function freshHoursFor(fileOrMeta, override) {
  if (isFinite(override) && override >= 0) return Number(override);
  if (fileOrMeta && typeof fileOrMeta === 'object') {
    if (isFinite(fileOrMeta.freshHours) && fileOrMeta.freshHours >= 0) return Number(fileOrMeta.freshHours);
    if (fileOrMeta.kind in FRESH_HOURS_BY_KIND) return FRESH_HOURS_BY_KIND[fileOrMeta.kind];
  }
  return FRESH_HOURS;
}
export function isFresh(fileOrMeta, override) {
  const file = typeof fileOrMeta === 'string' ? fileOrMeta : fileOrMeta && fileOrMeta.file;
  const hours = freshHoursFor(fileOrMeta, override);
  if (!file || hours <= 0 || ledger.get(file)?.status === 'FAIL') return false;
  try { return (Date.now() - fs.statSync(assetPath(file)).mtimeMs) < hours * 3600e3; } catch { return false; }
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
export function hasPriceToday(ticker, ref = today) {
  const row = priceMap.get(String(ticker || '').toUpperCase());
  return !!row && String(row).split(',')[4] === ref;
}
