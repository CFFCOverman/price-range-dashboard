/* collect/parsers 的纯函数自检(从旧 test-company-intel / test-earnings-history / test-estimates-api 迁来;响应形状照抄 2026-11-18/19 实测) */
import assert from 'node:assert/strict';
const A = await import('../collect/parsers/report-api.mjs');
const I = await import('../collect/parsers/company-intel.mjs');
const E = await import('../collect/parsers/earnings.mjs');
const X = await import('../collect/parsers/estimates.mjs');

{ /* 报表接口与公司情报 */
const cell = v => ({ value: v, data: v });
const rowsObj = rows => ({ title: 't', rows: rows.map((r, i) => ({ ...(i === 0 ? { header: true } : {}), fragments: [{ cells: r.map(cell) }] })) });
const tableData = rows => ({ result: { TABLE_DATA: { meta: {}, tbldata: rows.map(r => ({ rowdata: [{ fragment: r.map(d => ({ data: d })) }] })) } }, status: 'SUCCESS' });

assert.equal(A.excelDate(46344), '2026-11-18');
assert.equal(A.cellText('@NaNd'), '');
assert.deepEqual(A.rowsTable({ tableData: rowsObj([['Buys', '%OS'], ['SG', 0.26]]) }), [['Buys', '%OS'], ['SG', 0.26]]);
assert.deepEqual(A.rowsTable({ ksX: rowsObj([['h'], ['v']]) }), [['h'], ['v']], '供应链接口把表包在组件名下面');
assert.deepEqual(A.htmlTable(tableData([['', 'Latest (bps)'], ['5 Year', 309.12]])), [['', 'Latest (bps)'], ['5 Year', 309.12]]);
assert.ok(A.htmlReportUrl({ ticker: 'ORCL-US', report: 'DCS Overview', service: 'raw_fql', dbs: 'credit', formula: 'HTML_DCS_CDS_CHART_DATA();' })
  .includes('fixed_income_dbs=205'), '信用报告必须带固收库参数,否则 TICKER_NOT_FOUND');

const raw = { cds_dates: [46343, 46344], cds_yr1_data: [113.4, 114.4, { DB_SOURCES: [] }], cds_yr5_data: [305.1, 309.1, { DB_SOURCES: [] }], price_data: [116, 114.3, { DB_SOURCES: [] }] };
assert.deepEqual(I.cdsHistoryRows(raw), [['2026-11-17', 113.4, 305.1, 116], ['2026-11-18', 114.4, 309.1, 114.3]]);
assert.deepEqual(I.cdsHistoryRows({ cds_dates: [46344], cds_yr1_data: ['@NA'], cds_yr5_data: ['@NA'] }), [], '没有 CDS 报价的公司不造行');
const geo = { chart1: [[' ', 'econ_code', 'country_code', 'pct', 'rev'], ['United States', 'CC_US', 'US', '69.287018', '0'], { all_countries: [['United States', 'CC_US', 'US', '69.287018', '0'], ['Mainland China', 'CC_CN', 'CN', '8.891637', '0']] }] };
assert.equal(I.geoRevRows(geo).length, 2, '优先用 all_countries 全量');

}
{ /* 业绩指引与超预期 */
const cell = (v, date) => ({ value: v, data: v, ...(date ? { date } : {}) });
const hdr = n => ({ header: true, fragments: [{ cells: Array.from({ length: n }, (_, i) => cell('H' + i)) }] });
const row = cells => ({ fragments: [{ cells }] });
const guidanceJson = { rows: [hdr(10),
  row([cell("18 Nov '26", '20261118'), cell("FQE Jan '27E", '20270100'), cell('Sales'), cell(126100), cell(133900), cell(125679), cell(3.43794), cell('@NaNd'), cell('@NaNd'), cell(-2.87855)]),
  row([cell("27 Aug '26", '20260827'), cell("FQE Oct '26", '20261000'), cell('Gross Income Margin (%)'), cell(73), cell(73), cell(72.1), cell(1.2), cell(73.4), cell(0.5), cell(8.73796)]),
  row([cell('junk')]),
] };
const SH = ['Period', 'Event Date', 'After Event', 'Mean', 'Surp (%)', 'Sharp Surp (%)', 'Num of Est', 'Low', 'High', 'Price Imp (%)'];
const shdr = names => ({ header: true, fragments: [{ cells: names.map(n => cell(n)) }] });
const surpriseJson = item => ({ rows: [shdr(SH),
  row([cell("Jan '27E", '20270131'), cell('@NA'), cell('@NaNd'), cell(2.88046), cell('@NaNd'), cell('@NaNd'), cell(38), cell(2.78844), cell(3.11), cell('@NaNd')]),
  row([cell("Oct '26", '20261031'), cell("18 Nov '26", '20261118'), cell(item === 'EPS' ? 2.68 : 115844), cell(2.49001), cell(7.62997), cell('@NaNd'), cell(40), cell(2.26), cell(2.6958), cell(-2.05197)]),
] });

assert.equal(E.reportTicker('NVDA-US'), 'NVDA-USA');
assert.equal(E.reportTicker('NVDA-USA'), 'NVDA-USA');
assert.ok(E.surpriseUrl('NVDA-US', 'SALES').includes('kitem=SALES') && E.surpriseUrl('NVDA-US').includes('rbase=QTR'));
assert.ok(E.guidanceUrl('NVDA-US').includes('ticker=NVDA-USA') && E.guidanceUrl('NVDA-US').includes('edate=-5AY'));

const g = E.parseGuidance(guidanceJson, 'NVDA-US', 'T');
assert.equal(g.length, 2, '表头和残行都被剔掉');
assert.deepEqual([g[0].guid_date, g[0].period_end, g[0].item, g[0].guid_mid, g[0].actual], ['2026-11-18', '2027-01', 'Sales', 130000, '']);
assert.equal(g[1].actual, 73.4);

const s = E.parseSurprise(surpriseJson('EPS'), 'NVDA-US', 'EPS', 'T');
assert.equal(s.length, 2);
assert.deepEqual([s[0].reported, s[0].actual, s[0].event_date, s[0].num_est], [0, '', '', 38], '未公布的下一季保留为当前一致预期');
assert.deepEqual([s[1].reported, s[1].event_date, s[1].surprise_pct, s[1].sharp_surprise_pct], [1, '2026-11-18', 7.62997, '']);
/* 没有 Sharp 列的公司:9 列,按表头取(2026-11-19 ORCL SALES 实测形状) */
const nine = { rows: [shdr(SH.filter(n => n !== 'Sharp Surp (%)')),
  row([cell("Nov '26E", '20261130'), cell('@NA'), cell('@NaNd'), cell(21325.5), cell('@NaNd'), cell(29), cell(21173.4), cell(21550), cell('@NaNd')]),
  row([cell("Aug '26", '20260831'), cell("11 Sep '26", '20260911'), cell(19345), cell(19135), cell(1.09762), cell(32), cell(18636.5), cell(19373), cell(-1.73924)])] };
const s9 = E.parseSurprise(nine, 'ORCL-US', 'SALES', 'T');
assert.deepEqual([s9.length, s9[1].actual, s9[1].num_est, s9[1].est_high, s9[1].price_impact_pct, s9[1].sharp_surprise_pct], [2, 19345, 32, 19373, -1.73924, '']);

}
{ /* Estimate History 接口 */
const cell = v => ({ value: v });
const row = (cs, h) => ({ ...(h ? { header: true } : {}), fragments: [{ cells: cs.map(cell) }] });
const HEAD = ['Date', 'Mean', 'Sharp Cons', 'Num of Est', 'Num Up', 'Num Down', 'Low', 'High', 'Std Dev', 'Chg (%)', 'Chg Amt', 'Loading...', 'Loading...'];
const delay = { rows: [row(['P/E (x)', 'PEG (x)'], 1), row([29.67, 0.51]), row([27.9, 0.48])] };
const withSharp = { rows: [row(HEAD, 1), row(["19 Nov '26", 11.68, '@NaNd', 46, 3, 0, 11.5, 12.38, 0.14, -0.01, -0.002, '@NaNd', '@NaNd']),
  row(["30 Oct '26", 11.68, 11.7, 45, 11, 5, 11.5, 12.38, 0.14, 0.08, 0.009, '@NaNd', '@NaNd'])] };
const r = X.mergeEstimateApi(withSharp, delay);
assert.deepEqual(r[0], ['Date', 'Mean', 'Sharp Cons', 'Num of Est', 'Num Up', 'Num Down', 'Low', 'High', 'Std Dev', 'Chg (%)', 'Chg Amt', 'P/E (x)', 'PEG (x)']);
assert.deepEqual([r[1][2], r[1][11], r[2][11]], ['-', 29.67, 27.9], '占位列去掉、P/E 逐行对齐');
const noSharp = { rows: [row(HEAD.filter(h => h !== 'Sharp Cons'), 1), row(["19 Nov '26", 19.3, 46, 2, 2, 17.4, 22.4, 0.97, 0.02, 0.005, '@NaNd', '@NaNd'])] };
assert.ok(X.estimateApiUrl('AVGO-US', 2, 'TABLE').includes('period=2') && X.estimateApiUrl('AVGO-US', 1, 'TABLE').includes('ticker=AVGO-USA'));
}
console.log('parsers 自检全部通过');
