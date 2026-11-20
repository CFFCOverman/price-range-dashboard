/* lib/report-api.mjs —— FactSet 网页报告背后的同源数据接口:地址怎么拼、返回怎么摊平
 *
 * 2026-11-19 在登录态下实测的三种报告接口(页面自己就是先问它们再渲染的):
 *   A) 「rows」形:/ownership-reports/api/component/<组件>/json、/supply-chain/api/aggr/json
 *      返回 { rows:[{header?, fragments:[{cells:[{value,data,date}]}]}] },有的包在 tableData 或组件名下面
 *      (estimate-reports 的指引/超预期也是这一形,见 steps/earnings.mjs)
 *   B) HtmlReportData generic_component:返回 result.TABLE_DATA.tbldata[].rowdata[].fragment[].data
 *   C) HtmlReportData raw_fql:返回 result.RAW_FQL_DATA,字段因报告而异(如 CDS 历史的 cds_dates/cds_yr5_data)
 * 这里只定义"怎么问、怎么摊平";问哪几张报告、存成什么文件,见 steps/company-intel.mjs § INTEL_REPORTS。
 */

/** HtmlReportData 需要的数据库参数,按报告族照抄页面自己发的那份(少了会回 TICKER_NOT_FOUND / NOT_SERVICED) */
export const HTML_REPORT_DBS = {
  credit: 'validation_mode=DB_ORDER_VERBOSE_ERRORS&needs_user_db_order=1&fund_dbs=129%2C80%2C11%2C94&html_supported_fund_dbs=129%2C80%2C11%2C94&fixed_income_dbs=205&html_supported_fixed_income_dbs=205&db_types=FUND%2CFIXED_INCOME&db_deps=FUND%2CFIXED_INCOME%2COR',
  fundamentals: 'validation_mode=DB_ORDER&check_ofdb=false&needs_user_db_order=1&fund_dbs=129&html_supported_fund_dbs=129&db_types=FUND&db_deps=FUND',
  plain: 'validation_mode=IGNORE_ID_VALIDATION&check_ofdb=false',
};
export function htmlReportUrl({ ticker, report, service, formula, dbs = 'plain', extra = '' }) {
  return `/services/HtmlReportData?mode=HTML_REPORT_FETCH&report_name=${encodeURIComponent(report).replace(/%20/g, '+')}`
    + `&request_language=EN-US&${HTML_REPORT_DBS[dbs]}&LOG_PERFORMANCE=false&service_id=${service}`
    + `&ticker=${encodeURIComponent(ticker)}${extra}&formula=${encodeURIComponent(formula)}`;
}
export function ownershipUrl(component, ticker, range = '6M') {
  return `/ownership-reports/api/component/${component}/json?navigator=1&act_type=ACTPASS&currency=USD&units_adj=1&investor_type=FS`
    + `&posch_range=${range}&entity_flag=SEC&fi_flag=EQ&raw_fql_attributes=title%2Cfooter&routeGroup=os3Route&SU_LANG_OVERRIDE=EN&ticker=${encodeURIComponent(ticker)}`;
}
export function supplyChainUrl(component, ticker) {
  return `/supply-chain/api/aggr/json?${component}%5BcomponentName%5D=${component}&${component}%5Boptions%5D=id%3D${encodeURIComponent(ticker)}`;
}

/** FactSet 的缺值写法 @NA / @NaNd 一律变空串;数字原样 */
export function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'number') return isFinite(v) ? v : '';
  if (typeof v === 'object') return '';
  const s = String(v).trim();
  return /^@na/i.test(s) ? '' : s;   // @NA / @NaNd
}
/** A 形 → 二维表(首行表头)。接受 {rows}、{tableData:{rows}}、{<组件名>:{rows}} 三种外壳 */
export function rowsTable(obj) {
  const t = obj && (Array.isArray(obj.rows) ? obj : obj.tableData && Array.isArray(obj.tableData.rows) ? obj.tableData
    : Object.values(obj || {}).find(v => v && Array.isArray(v.rows)));
  if (!t) return [];
  return t.rows.map(r => (r.fragments || []).flatMap(f => f.cells || []).map(c => cellText(c.value ?? c.data)));
}
/** B 形 → 二维表 */
export function htmlTable(json) {
  const t = json && json.result && json.result.TABLE_DATA;
  if (!t || !Array.isArray(t.tbldata)) return [];
  return t.tbldata.map(r => (r.rowdata || []).flatMap(x => x.fragment || []).map(c => cellText(c.data)));
}
/** C 形 → RAW_FQL_DATA 对象(没有就 null) */
export function rawFql(json) { return (json && json.result && json.result.RAW_FQL_DATA) || null; }
/** Excel 序列日(1899-12-30 起)→ YYYY-MM-DD。2026-11-19 实测 46344 = 2026-11-18 */
export function excelDate(n) {
  if (!Number.isFinite(n)) return '';
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}
/** 发请求并要求是 JSON:非 200、登录页、NOT_SERVICED 都当失败(抛出的话写成下一步该看什么) */
export const RETRY_STATUS = [502, 503, 504];
export async function getJson(request, url, what, { tries = 3, waitMs = 2000 } = {}) {
  /* 2026-11-19 实测:供应链等接口在连续请求下偶发 503,稍等再问就好;只对网关类错误重试 */
  let r;
  for (let i = 0; i < tries; i++) {
    r = await request(url);
    if (!r || !RETRY_STATUS.includes(r.status) || i === tries - 1) break;
    await new Promise(res => setTimeout(res, waitMs * (i + 1)));
  }
  if (!r || r.status !== 200) throw new Error(`${what} 接口回了 HTTP ${r && r.status}(登录态或权限的问题)`);
  let j;
  try { j = JSON.parse(r.text); } catch { throw new Error(`${what} 接口回的不是 JSON(多半是被重定向到登录页)`); }
  if (j && j.status === 'NOT_SERVICED') throw new Error(`${what} 接口拒绝服务:${typeof j.result === 'string' ? j.result : 'NOT_SERVICED'}(参数或权限)`);
  return j;
}
