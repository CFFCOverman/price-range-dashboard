/* ============ 估值史走同源接口(2026-11-19 起为主路径)============
 * 为什么换:页面上的财年下拉会被 FactSet 记住,跨公司切换时会漂移(11/19 实测 RKLB/META/ORCL/NFLX 打开时停在
 * Dec '28E,整页拒写);按日历推 FY 也会把"已结束未公布"的财年判错(AVGO Oct '26E 与 Oct '27E 都被判成 FY1,
 * FY1 文件被 FY2 数据覆盖)。接口用 period=1/2 直接指定 FY1/FY2,与页面同源,不依赖页面状态。
 *   TABLE        → Date | Mean | [Sharp Cons] | Num of Est | Up | Down | Low | High | Std Dev | Chg (%) | Chg Amt | (占位) | (占位)
 *   TABLE_DELAY  → P/E (x) | PEG (x)   与上面逐行对齐
 */
export function estimateApiUrl(ticker, period, option) {
  const t = /-US$/i.test(ticker) ? ticker + 'A' : ticker;
  return `/estimate-reports/estimate-history/api/component/ksEhSingleTable/json?kitem=EPS&statuser=MEAN&sdate=NOW&edate=-5AY`
    + `&frq=MTD&bkrf=&win=0&units=AUTO&rbase=ANNUAL&curn=LOCAL&fixedrate=NO&period=${period}&roll=0&returnOption=${option}&ukcurrency=GBX&ticker=${t}`;
}
const apiRows = j => (j && Array.isArray(j.rows) ? j.rows : []).map(r => (r.fragments || []).flatMap(f => f.cells || []).map(c => {
  const v = c.value ?? c.data;
  return typeof v === 'number' ? (isFinite(v) ? v : '-') : (/^@na/i.test(String(v ?? '')) ? '-' : String(v ?? '').trim());
}));
/** 两次响应 → 与页面刮表同形的二维数组(表头 + 数据行),交给 estimateRowsVerdict / saveEstimateXlsx */
export function mergeEstimateApi(table, delay) {
  const a = apiRows(table), b = apiRows(delay);
  if (!a.length) return [];
  /* TABLE 末尾两列是 P/E、PEG 的占位(表头写 Loading...),去掉后接上 TABLE_DELAY 的同一行 */
  const keep = a[0].map((h, j) => !/^Loading/i.test(String(h)));
  return a.map((r, i) => [...r.filter((_, j) => keep[j]), ...(b[i] || ['-', '-'])]);
}
export async function fetchEstimateApi(ticker, period, request) {
  const get = async opt => {
    const r = await request(estimateApiUrl(ticker, period, opt));
    if (!r || r.status !== 200) throw new Error(`Estimate History 接口回了 HTTP ${r && r.status}`);
    try { return JSON.parse(r.text); } catch { throw new Error('Estimate History 接口回的不是 JSON(多半是登录态掉了)'); }
  };
  return mergeEstimateApi(await get('TABLE'), await get('TABLE_DELAY'));
}

