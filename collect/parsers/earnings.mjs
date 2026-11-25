/* collect/parsers/earnings.mjs — 业绩事件史:Guidance History + Surprise History(季度)
 *
 * 为什么不刮屏(2026-11-18 在登录态下实测):
 *   Company/Security > Estimates 下的这两张报告,页面本身就是先向下面两个同源 JSON 接口要数据再渲染的。
 *   直接问接口,拿到的是同一份数据的源头,不受虚拟滚动/列宽/语言设置影响。
 *
 *   1) Guidance History
 *      GET /estimate-reports/guidance-history/api/component/ksGhTable/json?...&rbase=ALL&ticker=NVDA-USA
 *      一行 = 一次指引里的一个科目:发布日 / 期间 / 科目 / 指引上下限 / 发布时一致预期 / 指引相对预期% /
 *      实际值 / 实际相对指引% / 发布后股价反应%
 *   2) Surprise History(季度)
 *      GET /estimate-reports/surprise-history/api/component/ksShSingleTable/json?kitem=EPS|SALES&rbase=QTR&...
 *      一行 = 一个财季:事件日 / 实际 / 一致预期 / 超预期% / Sharp 超预期% / 家数 / 最低 / 最高 / 股价反应%
 *      第一行是尚未公布的下一季(Period 带 E、实际为空),照样保留:它就是当前一致预期。
 *
 * 两份 csv 每次整份覆盖 —— FactSet 自己保存全部历史,我们不需要逐轮累积。
 * 解析函数全是纯函数,tests/test-earnings-history.mjs 用实地抄回来的响应形状做断言。
 */


import { csvFlat as csvCell } from '../lib/store.mjs';

export const guidanceFile = t => `${t} Guidance History.csv`;
export const surpriseFile = t => `${t} Surprise History.csv`;
export const SURPRISE_ITEMS = ['EPS', 'SALES'];
export const SURPRISE_QUARTERS = 12;
export const GUIDANCE_YEARS = 5;

/** NVDA-US → NVDA-USA(这两张报告的接口只认带交易所全称的写法,页面自己发的就是这样) */
export function reportTicker(t) {
  const s = String(t || '').trim().toUpperCase();
  return /-US$/.test(s) ? s + 'A' : s;
}
export function guidanceUrl(t, years = GUIDANCE_YEARS) {
  const q = new URLSearchParams({ kitem: 'EPS', rptType: 'MULTI', statuser: 'MEAN', rbase: 'ALL', fixedrate: 'NO',
    columns: 'guid_date,period,kitem,guid_low,guid_high,cns,surp_pct_cns,actual,surp_pct_act,price_impact',
    curn: 'LOCAL', edate: `-${years}AY`, sdate: 'NOW', download: '0', ukcurrency: 'GBX', units: 'AUTO', ticker: reportTicker(t) });
  return `/estimate-reports/guidance-history/api/component/ksGhTable/json?${q}`;
}
export function surpriseUrl(t, item = 'EPS', quarters = SURPRISE_QUARTERS) {
  const q = new URLSearchParams({ kitem: item, rptType: 'SINGLE', statuser: 'MEAN', rbase: 'QTR', speriod: '1', period: '0',
    eperiod: String(-(quarters - 1)), periodCount: String(quarters), bkrf: '', act: '1', fixedrate: 'NO', tempFetchGuidance: '0',
    downloading: '0', curn: 'LOCAL', win: '0', impactBef: '1', impactAft: '0',
    columns: 'period,surp_date,after,before,surp_pct,est_count,est_low,est_high,price_impact,sharp_pct',
    return_table: 'SINGLE', ukcurrency: 'GBX', units: 'AUTO', ticker: reportTicker(t) });
  return `/estimate-reports/surprise-history/api/component/ksShSingleTable/json?${q}`;
}

/** 报告 JSON → 数据行(每行是 cell 数组);表头行(header:true)剔掉 */
export function reportCells(json) {
  if (!json || !Array.isArray(json.rows)) return [];
  return json.rows.filter(r => !r.header && Array.isArray(r.fragments))
    .map(r => r.fragments.flatMap(f => Array.isArray(f.cells) ? f.cells : []));
}
/** FactSet 的缺值写法是 @NA / @NaNd / '-';一律变成空,不造 0 */
export function num(c) {
  const v = c && (c.data ?? c.value);
  if (typeof v === 'number') return isFinite(v) ? v : '';
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return String(v ?? '').trim() && isFinite(n) ? n : '';
}
/** cell.date 是 YYYYMMDD(期间是 YYYYMM00 → 只给到月) */
export function cellDate(c) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(c && c.date || ''));
  if (!m) return '';
  return m[3] === '00' ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${m[3]}`;
}
const text = c => { const v = c && (c.value ?? c.data); return v == null || /^@NA/.test(String(v)) ? '' : String(v).trim(); };

export const GUIDANCE_COLS = ['ticker', 'guid_date', 'period', 'period_end', 'item', 'guid_low', 'guid_high', 'guid_mid',
  'consensus_at_guid', 'guid_vs_cons_pct', 'actual', 'actual_vs_guid_pct', 'price_impact_pct', 'retrieved_at'];
export function parseGuidance(json, ticker, retrievedAt = '') {
  const out = [];
  for (const c of reportCells(json)) {
    if (c.length < 10) continue;
    const date = cellDate(c[0]), item = text(c[2]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !item) continue;
    const lo = num(c[3]), hi = num(c[4]);
    out.push({ ticker, guid_date: date, period: text(c[1]), period_end: cellDate(c[1]), item,
      guid_low: lo, guid_high: hi, guid_mid: lo !== '' && hi !== '' ? (lo + hi) / 2 : (lo !== '' ? lo : hi),
      consensus_at_guid: num(c[5]), guid_vs_cons_pct: num(c[6]), actual: num(c[7]), actual_vs_guid_pct: num(c[8]),
      price_impact_pct: num(c[9]), retrieved_at: retrievedAt });
  }
  return out;
}

export const SURPRISE_COLS = ['ticker', 'item', 'period', 'period_end', 'reported', 'event_date', 'actual', 'mean',
  'surprise_pct', 'sharp_surprise_pct', 'num_est', 'est_low', 'est_high', 'price_impact_pct', 'retrieved_at'];
/* 列按表头名取,不按位置取:没有 Sharp 共识的公司(2026-11-19 实测 ASML/ORCL/RKLB/TSM)整列不出现,只有 9 列 */
export const SURPRISE_HEADERS = { period: 'Period', event: 'Event Date', actual: 'After Event', mean: 'Mean', surp: 'Surp (%)',
  sharp: 'Sharp Surp (%)', n: 'Num of Est', low: 'Low', high: 'High', impact: 'Price Imp (%)' };
export function headerIndex(json) {
  const h = (json && Array.isArray(json.rows) ? json.rows : []).find(r => r.header);
  const names = h ? h.fragments.flatMap(f => f.cells || []).map(c => String(c.value ?? c.data ?? '').trim()) : [];
  return Object.fromEntries(Object.entries(SURPRISE_HEADERS).map(([k, name]) => [k, names.indexOf(name)]));
}
export function parseSurprise(json, ticker, item, retrievedAt = '') {
  const ix = headerIndex(json), out = [];
  if (ix.period < 0 || ix.mean < 0) return out;
  const at = (c, k) => (ix[k] >= 0 ? c[ix[k]] : undefined);
  for (const c of reportCells(json)) {
    const period = text(at(c, 'period'));
    if (!/^[A-Z][a-z]{2} '\d{2}E?$/.test(period)) continue;
    out.push({ ticker, item, period, period_end: cellDate(at(c, 'period')), reported: period.endsWith('E') ? 0 : 1,
      event_date: cellDate(at(c, 'event')), actual: num(at(c, 'actual')), mean: num(at(c, 'mean')), surprise_pct: num(at(c, 'surp')),
      sharp_surprise_pct: num(at(c, 'sharp')), num_est: num(at(c, 'n')), est_low: num(at(c, 'low')), est_high: num(at(c, 'high')),
      price_impact_pct: num(at(c, 'impact')), retrieved_at: retrievedAt });
  }
  return out;
}
export function toCsv(cols, rows) {
  return cols.join(',') + '\n' + rows.map(r => cols.map(k => csvCell(r[k] ?? '')).join(',')).join('\n') + (rows.length ? '\n' : '');
}

