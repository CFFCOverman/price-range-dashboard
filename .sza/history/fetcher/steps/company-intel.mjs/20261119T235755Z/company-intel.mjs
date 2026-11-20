/* steps/company-intel.mjs —— 公司情报:信用/CDS、机构增减持、分部门营收、地区收入、供应链
 *
 * 本文件只定义一件事:INTEL_REPORTS —— 每份报告问哪个接口、存成什么文件、多久重拉一次。
 * 接口地址怎么拼、返回怎么摊平,见 lib/report-api.mjs;登记表(台账/体检)由 lib/registry.mjs § metaIntel 从这里生成。
 * 2026-11-19 用户要求"先把该抓的抓下来,存到 G 盘";接口均在登录态下逐个实测过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { assetPath } from '../lib/config.mjs';
import { atomicText } from '../lib/atomic-csv.mjs';
import { phase, stampUTC } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { csvCell } from './news.mjs';
import { excelDate, getJson, htmlReportUrl, htmlTable, ownershipUrl, rawFql, rowsTable, supplyChainUrl } from '../lib/report-api.mjs';

/** 多段表 → csv:每行首列是段名;每段第一行是该段表头 */
export function sectionsCsv(sections) {
  const lines = ['section,cells...'];
  for (const { section, table } of sections) for (const row of table) lines.push([section, ...row].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}
export function plainCsv(header, rows) {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
const nonEmpty = t => t.length > 1 && t.slice(1).some(r => r.some(c => c !== ''));

/** CDS 历史(raw_fql)→ [date, cds_1y, cds_5y, price]。数组末尾多一个 DB_SOURCES 对象,以日期数组长度为准 */
export function cdsHistoryRows(raw) {
  if (!raw || !Array.isArray(raw.cds_dates)) return [];
  const num = v => (typeof v === 'number' && isFinite(v) ? v : '');
  return raw.cds_dates.map((d, i) => [excelDate(d), num(raw.cds_yr1_data?.[i]), num(raw.cds_yr5_data?.[i]), num(raw.price_data?.[i])])
    .filter(r => r[0] && (r[1] !== '' || r[2] !== ''));
}
/** 地区收入(raw_fql CHART)→ [country, econ_code, country_code, pct];优先用 all_countries 全量 */
export function geoRevRows(raw) {
  const c = raw && raw.chart1;
  if (!Array.isArray(c)) return [];
  const all = c.find(x => x && !Array.isArray(x) && Array.isArray(x.all_countries));
  const rows = all ? all.all_countries : c.filter(x => Array.isArray(x)).slice(1);
  return rows.filter(r => Array.isArray(r) && r[0] && r[0] !== ' ').map(r => [r[0], r[1], r[2], Number(r[3])]).filter(r => isFinite(r[3]));
}

/* key 只用于台账与日志;file 决定落盘名(子目录由 lib/config.mjs § ASSET_RULES 按文件名归类) */
export const INTEL_REPORTS = [
  { key: 'credit', file: t => `${t} Credit.csv`, freshHours: 20, slug: 'dcs-overview',
    tab: 'Company/Security > Credit Analysis > DCS Overview', desc: 'CDS 曲线(最新 bps 与 1D/1W/1M/3M/6M 变化)+ 穆迪/标普评级',
    async build(t, get) {
      const spreads = htmlTable(await get(htmlReportUrl({ ticker: t, report: 'DCS Overview', service: 'generic_component', dbs: 'credit', formula: 'HTML_DCS_SPREADS_NEW();' }), 'CDS 曲线'));
      const ratings = htmlTable(await get(htmlReportUrl({ ticker: t, report: 'DCS Overview', service: 'generic_component', dbs: 'credit', formula: 'HTML_DCS_CREDIT_RATINGS_NEW();' }), '信用评级'));
      return { csv: sectionsCsv([{ section: 'CDS Spreads', table: spreads }, { section: 'Credit Ratings', table: ratings }]),
        count: spreads.length + ratings.length, note: nonEmpty(spreads) ? '' : '无 CDS 报价', allowEmpty: true };
    } },
  { key: 'cds-history', file: t => `${t} CDS History.csv`, freshHours: 20, slug: 'dcs-overview',
    tab: 'Company/Security > Credit Analysis > DCS Overview(CDS 历史图)', desc: '近 6 个月逐日 1Y/5Y CDS(bps)与股价',
    async build(t, get) {
      const rows = cdsHistoryRows(rawFql(await get(htmlReportUrl({ ticker: t, report: 'DCS Overview', service: 'raw_fql', dbs: 'credit', formula: 'HTML_DCS_CDS_CHART_DATA();' }), 'CDS 历史')));
      return { csv: plainCsv(['date', 'cds_1y_bps', 'cds_5y_bps', 'price'], rows), count: rows.length,
        note: rows.length ? `${rows[0][0]} ~ ${rows.at(-1)[0]}` : '无 CDS 报价', allowEmpty: true };
    } },
  { key: 'ownership', file: t => `${t} Ownership Activity.csv`, freshHours: 144, slug: 'summary-analytics',
    tab: 'Company/Security > Ownership > Ownership Activity / Company Summary', desc: '6 个月前十增减持、按投资者类型/风格的净变化(季度)、前 15 机构与前 5 内部人',
    async build(t, get) {
      const sections = [];
      for (const [section, comp] of [['Top Buys/Sells 6M', 'ksTopBuysSells'], ['Activity by Investor Type 6M', 'ksActivityByInvestorType'],
        ['Net Position Change by Style (quarterly)', 'ksNetPosChgPrice'], ['Top Institutions / Insiders', 'ksTopInstInsiders']]) {
        sections.push({ section, table: rowsTable(await get(ownershipUrl(comp, t), section)) });
      }
      if (!sections.some(s => nonEmpty(s.table))) throw new Error('四张持股表都是空的');
      return { csv: sectionsCsv(sections), count: sections.reduce((a, s) => a + s.table.length, 0) };
    } },
  { key: 'segments', file: t => `${t} Segments.csv`, freshHours: 144, slug: 'segments',
    tab: 'Company/Security > Financials > Segment History', desc: '近 10 个财年分业务、分地区营收(公司披露口径)',
    async build(t, get) {
      const one = seg => htmlReportUrl({ ticker: t, report: 'Segments', service: 'generic_component', dbs: 'fundamentals',
        formula: `IMC_FIN_SEGMENTS_ITEM_BANDIT(item="SALES",curn="LOCAL",sdate=0,edate="-9",segment="${seg}",reverse=1,periodicity="ANN",downloading=0,all_segments=0);` });
      const bus = htmlTable(await get(one('BUS'), '分业务营收')), geo = htmlTable(await get(one('GEO'), '分地区营收'));
      if (!nonEmpty(bus) && !nonEmpty(geo)) throw new Error('分业务、分地区营收都是空的');
      return { csv: sectionsCsv([{ section: 'Sales by Business', table: bus }, { section: 'Sales by Geography', table: geo }]), count: bus.length + geo.length };
    } },
  { key: 'georev', file: t => `${t} Geographic Revenue.csv`, freshHours: 144, slug: 'geographic-revenue',
    tab: 'Company/Security > Overviews > Geographic Revenue (GeoRev)', desc: 'FactSet GeoRev 各国收入占比(含估算)',
    async build(t, get) {
      const rows = geoRevRows(rawFql(await get(htmlReportUrl({ ticker: t, report: 'Geographic Revenue', service: 'raw_fql',
        formula: 'COMA_GEOREV(com_name="CHART",mode="CHART",category="COUNTRY");' }), 'GeoRev')));
      if (!rows.length) throw new Error('GeoRev 没有任何国家行');
      return { csv: plainCsv(['country', 'econ_code', 'country_code', 'pct_of_revenue'], rows), count: rows.length,
        note: rows.slice(0, 3).map(r => `${r[2]} ${r[3].toFixed(1)}%`).join(' / ') };
    } },
  { key: 'supply-chain', file: t => `${t} Supply Chain.csv`, freshHours: 144, slug: 'supply-chain',
    tab: 'Company/Security > Overviews > Supply Chain (Revere)', desc: '全部供应商/客户/合作方:关系类型、排名、行业、市值、3 个月价格相关性',
    async build(t, get) {
      const table = rowsTable(await get(supplyChainUrl('ksScRelOverviewOverviewTableAllRows', t), '供应链'));   /* 503 重试见 lib/report-api.mjs § getJson */
      if (!nonEmpty(table)) throw new Error('供应链关系表是空的');
      return { csv: sectionsCsv([{ section: 'All Relationships', table }]), count: table.length - 1 };
    } },
];

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
