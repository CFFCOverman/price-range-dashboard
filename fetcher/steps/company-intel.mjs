/* steps/company-intel.mjs — 旧 fetcher 的取数与落盘;INTEL_REPORTS 与解析已搬到 collect/parsers/company-intel.mjs(重构 R1)。 */

import fs from 'node:fs';
import path from 'node:path';
import { assetPath } from '../lib/config.mjs';
import { atomicText } from '../lib/atomic-csv.mjs';
import { phase, stampUTC } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { getJson } from '../../collect/parsers/report-api.mjs';
export * from '../../collect/parsers/company-intel.mjs';

async function defaultRequest(p) {
  const { apiGet, ensureFactsetOrigin } = await import('./options.mjs');
  if (!(await ensureFactsetOrigin())) throw new Error('页面不在 my.apps.factset.com 上,同源接口发不出去(多半是登录态掉了)');
  return apiGet(p);
}
/** 跑一份报告:取接口 → 摊平 → 原子写文件。失败抛出,旧文件不动 */
export async function fetchIntel(report, ticker, { request = defaultRequest } = {}) {
  phase('取接口');
  const get = (url, what) => getJson(request, url, what);
  const out = await report.build(ticker, get);
  phase('写文件');
  const f = assetPath(report.file(ticker));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  atomicText(f, out.csv);
  log(`  ✔ ${path.basename(f)} (${out.count} 行${out.note ? ',' + out.note : ''}) ${stampUTC()}`);
  return true;
}
