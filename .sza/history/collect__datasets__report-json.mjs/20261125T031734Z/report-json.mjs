/** 页面同源 JSON 组件:estimates(Estimate History)、targets(Targets & Ratings)、ownership(Ownership Statistics,含空头)。 */
import { estimateApiUrl, mergeEstimateApi } from '../../fetcher/steps/estimates.mjs';
import { rowsTable, cellText } from '../../fetcher/lib/report-api.mjs';
import { replaceCsv, upsertCsv } from '../lib/store.mjs';

const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** "19 Nov '26" → 2026-11-19 */
export function fsDate(s) {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) '(\d{2})$/.exec(String(s || '').trim());
  return m && MON[m[2]] ? `20${m[3]}-${String(MON[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}
const slug = h => String(h).toLowerCase().replace(/\(x\)|\(%\)|\*/g, m => (m === '(%)' ? ' pct' : '')).trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
/** 二维表(首行表头)→ 对象行;表头转 snake_case,日期列转 ISO */
export function tableObjects(t, dateCols = ['date']) {
  if (!t.length) return { header: [], rows: [] };
  const header = t[0].map(slug);
  const rows = t.slice(1).map(r => Object.fromEntries(header.map((h, i) => {
    let v = r[i] ?? ''; if (v === '-') v = '';
    return [h, dateCols.includes(h) || /_date$/.test(h) ? (fsDate(v) || v) : v];
  })));
  return { header, rows };
}

/* ---------- estimates:源头自带 5 年月度历史,整表替换 ---------- */
export const seriesLabel = json => (/"serieslabel":\["([^"]+)"/.exec(JSON.stringify(json && json.misc || '')) || [])[1] || '';
export const estimates = {
  key: 'estimates',
  async run({ symbol, p, file, api }) {
    const notes = [];
    let total = 0;
    for (const [fy, period] of Object.entries(p.periods)) {
      const tbl = await api.getJ(estimateApiUrl(symbol, period, 'TABLE'), `Estimate History ${fy}`);
      const dly = await api.getJ(estimateApiUrl(symbol, period, 'TABLE_DELAY'), `Estimate History ${fy} P/E`);
      const { header, rows } = tableObjects(mergeEstimateApi(tbl, dly));
      if (rows.length < 2) throw new Error(`${fy} 只解析出 ${rows.length} 行`);
      const label = seriesLabel(tbl);
      rows.forEach(r => { r.fiscal_period = label; });
      total += replaceCsv(file('estimates', `${symbol} ${fy}`), [...header, 'fiscal_period'], rows);
      notes.push(`${fy}=${label}`);
    }
    return { rows: total, note: notes.join(' ') };
  },
};

/* ---------- targets:HISTORY 月度一致评级/目标价(合并攒),DETAIL 券商明细(当日快照替换) ---------- */
const TNR_COLS = 'bkr_name%2Can_name%2Crtg_date%2Crtg%2Crtg_price%2Ctgt_date%2Ctgt%2Ctgt_price%2Ctgt_imp_ret';
export const reportTicker = t => (/-US$/i.test(t) ? t + 'A' : t);
export const tnrUrl = (t, type, range) => `/estimate-reports/targets-and-ratings/api/component/ksTnrExcel/json?rptType=${type}`
  + `&statuser=MEAN&estDate=factset_defined&sdate=NOW&edate=${range}&bkrf=&win=0&curn=LOCAL&fixedrate=NO&rtgText=TEXT&statType=PCT`
  + `&orderOfBars=BUY_TOP_BAR&numberOfBars=3&columns=${TNR_COLS}&ukcurrency=GBX&ticker=${reportTicker(t)}`;
export const targets = {
  key: 'targets',
  async run({ symbol, p, file, api, today }) {
    const h = tableObjects(rowsTable(await api.getJ(tnrUrl(symbol, 'HISTORY', p.history_range), 'Targets History')));
    if (!h.rows.length) throw new Error('目标价历史为空');
    const { total } = upsertCsv(file('targets', `${symbol} history`), h.header, h.rows, r => r.date);
    const d = tableObjects(rowsTable(await api.getJ(tnrUrl(symbol, 'DETAIL', p.history_range), 'Targets Detail')));
    d.rows.forEach(r => { r.asof = today; });
    replaceCsv(file('targets', `${symbol} brokers`), [...d.header, 'asof'], d.rows);
    return { rows: total, note: `${d.rows.length - 1} 家券商,均值 ${h.rows[0].mean_tgt_price}` };
  },
};

/* ---------- ownership:机构/内部人/流通盘/空头(一张卡片),每天一行 ----------
 * 2026-11-19 对照旧 short-interest.csv:infographic.short_int = 空头回补天数,pct_shares_os = 空头占流通盘 %。
 * 没有空头数据时(RKLB)两项都是 "--",记空,不当失败。 */
export const ownershipUrl = t => '/services/HtmlReportDataOs3?mode=HTML_REPORT_FETCH&routeGroup=os3Route&service_id=raw_fql&navigator=1'
  + '&currency=USD&units_adj=1&entity_flag=SEC&fi_flag=EQ&raw_fql_attributes=title&SU_LANG_OVERRIDE=EN'
  + `&ticker=${t}&request_language=EN-US&validation_mode=IGNORE_ID_VALIDATION&check_ofdb=false&LOG_PERFORMANCE=false&formula=`
  + encodeURIComponent('FOS_OWNERSHIP_STATS(navigator="2",currency="USD",units_adj=1,entity_flag="SEC",fi_flag="EQ");');
export const OWNERSHIP_COLS = ['date', 'data_asof', 'inst_pct', 'insider_pct', 'top10_pct', 'unknown_pct', 'float_pct',
  'inst_pct_of_float', 'short_pct_float', 'short_days', 'shares_os', 'filers_13f'];
export function ownershipRow(json, today) {
  const d = json && json.result && json.result.RAW_FQL_DATA;
  if (!d || !d.info) throw new Error('Ownership Statistics 结构不认识(没有 info)');
  const sec = k => (Array.isArray(d[k]) ? d[k][1] || {} : {});
  const v = (o, k) => { const x = cellText((o[k] || [])[0]); return x === '--' ? '' : x; };
  const chart = sec('chart'), info = sec('info'), info1 = sec('info1'), t2 = sec('table2'), foot = sec('footer');
  const asof = /as of:\s*(.+)$/i.exec(String((foot.date || [])[0] || ''));
  return { date: today, data_asof: asof ? fsDate(asof[1].trim()) : '', inst_pct: v(chart, 'inst'), insider_pct: v(chart, 'insider'),
    top10_pct: v(chart, 'top'), unknown_pct: v(chart, 'unknown'), float_pct: v(info, 'float_pct'), inst_pct_of_float: v(info, 'inst_pct'),
    short_pct_float: v(info, 'pct_shares_os'), short_days: v(info, 'short_int'), shares_os: v(info1, 'shares_os'), filers_13f: v(t2, 'filers_rcnt') };
}
export const ownership = {
  key: 'ownership',
  async run({ symbol, file, api, today }) {
    const row = ownershipRow(await api.getJ(ownershipUrl(symbol), 'Ownership Statistics'), today);
    const { total } = upsertCsv(file('ownership', symbol), OWNERSHIP_COLS, [row], r => r.date);
    return { rows: total, note: row.short_days ? `空头 ${row.short_pct_float}% / ${row.short_days} 天` : '无空头数据' };
  },
};
