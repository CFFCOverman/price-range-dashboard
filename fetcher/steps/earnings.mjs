/* steps/earnings.mjs — 旧 fetcher 的取数与落盘;解析与接口地址已搬到 collect/parsers/earnings.mjs(重构 R1)。 */

import fs from 'node:fs';
import path from 'node:path';
import { assetPath } from '../lib/config.mjs';
import { atomicText } from '../lib/atomic-csv.mjs';
import { phase, stampUTC } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
export * from '../../collect/parsers/earnings.mjs';
import { guidanceFile, surpriseFile, SURPRISE_ITEMS, guidanceUrl, surpriseUrl, parseGuidance, parseSurprise, GUIDANCE_COLS, SURPRISE_COLS, toCsv } from '../../collect/parsers/earnings.mjs';

/** 这家公司的接口回了内容,但内容是不是这家公司的?—— 和别处一样,串号比缺数据危险 */
function assertJson(res, what) {
  if (!res || res.status !== 200) throw new Error(`${what} 接口回了 HTTP ${res && res.status}(登录态或权限的问题)`);
  try { return JSON.parse(res.text); } catch { throw new Error(`${what} 接口回的不是 JSON(多半是被重定向到登录页)`); }
}

/** request(pathQuery) → {status, text};默认走页面上下文的同源 GET(steps/options.mjs 的 apiGet) */
async function defaultRequest(p) {
  const { apiGet, ensureFactsetOrigin } = await import('./options.mjs');
  if (!(await ensureFactsetOrigin())) throw new Error('页面不在 my.apps.factset.com 上,同源接口发不出去(多半是登录态掉了)');
  return apiGet(p);
}

export async function fetchGuidance(ticker, { request = defaultRequest } = {}) {
  phase('取接口');
  const json = assertJson(await request(guidanceUrl(ticker)), 'Guidance History');
  phase('解析行');
  const rows = parseGuidance(json, ticker, stampUTC());
  /* 有的公司根本不给指引(比如 GOOGL/META 只给开支指引,有的什么都不给):空表是合法结果,照写一份表头,
   * 让"这家没有指引"和"没去拉"在文件层面分得开。 */
  phase('写文件');
  const f = assetPath(guidanceFile(ticker));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  atomicText(f, toCsv(GUIDANCE_COLS, rows));
  log(`  ✔ ${path.basename(f)} (${rows.length} 条指引${rows.length ? `, 最近 ${rows[0].guid_date}` : ',该公司无指引记录'})`);
  return true;
}

export async function fetchSurprise(ticker, { request = defaultRequest } = {}) {
  const at = stampUTC(), all = [];
  for (const item of SURPRISE_ITEMS) {
    phase('取接口');
    const json = assertJson(await request(surpriseUrl(ticker, item)), `Surprise History ${item}`);
    phase('解析行');
    const rows = parseSurprise(json, ticker, item, at);
    if (!rows.some(r => r.reported)) throw new Error(`${item} 一个已公布季度都没有解析出来(接口字段可能改了)`);
    all.push(...rows);
  }
  phase('写文件');
  const f = assetPath(surpriseFile(ticker));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  atomicText(f, toCsv(SURPRISE_COLS, all));
  const last = all.find(r => r.item === 'EPS' && r.reported);
  log(`  ✔ ${path.basename(f)} (${all.length} 行${last ? `, 最近 ${last.period} EPS 超预期 ${Number(last.surprise_pct).toFixed(1)}%` : ''})`);
  return true;
}
