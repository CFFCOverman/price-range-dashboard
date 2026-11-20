/* steps/company-intel.mjs + lib/report-api.mjs —— 响应形状照抄 2026-11-19 NVDA/ORCL 实测 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-'));
process.env.FS_OUT = root;
const A = await import('../fetcher/lib/report-api.mjs');
const I = await import('../fetcher/steps/company-intel.mjs');
const { assetPath, assetSubdir } = await import('../fetcher/lib/config.mjs');
const { splitCsvLine } = await import('../fetcher/steps/news.mjs');
const { expectedArtifacts } = await import('../fetcher/lib/registry.mjs');

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

const fixtures = url => {
  if (url.includes('HTML_DCS_SPREADS_NEW')) return tableData([['', 'Latest (bps)', '1D'], ['5 Year', 309.12, 1.9]]);
  if (url.includes('HTML_DCS_CREDIT_RATINGS_NEW')) return tableData([[' ', 'Date', 'Rating'], ['S&P', '09-Jul-26', 'BBB-']]);
  if (url.includes('HTML_DCS_CDS_CHART_DATA')) return { result: { RAW_FQL_DATA: raw }, status: 'SUCCESS' };
  if (url.includes('/ownership-reports/')) return { tableData: rowsObj([['Buys', '%OS'], ['SG', 0.26]]) };
  if (url.includes('IMC_FIN_SEGMENTS')) return tableData([['', "JAN '26"], ['Total', 215938]]);
  if (url.includes('COMA_GEOREV')) return { result: { RAW_FQL_DATA: geo }, status: 'SUCCESS' };
  if (url.includes('/supply-chain/')) return { ksScRelOverviewOverviewTableAllRows: rowsObj([['Rel Type', 'Company'], ['Supplier', 'Oracle']]) };
  throw new Error('未知地址 ' + url);
};
try {
  let calls = 0;
  const request = async url => { calls++; return { status: 200, text: JSON.stringify(fixtures(url)) }; };
  for (const r of I.INTEL_REPORTS) {
    assert.equal(await I.fetchIntel(r, 'ORCL-US', { request }), true, r.key);
    const f = assetPath(r.file('ORCL-US'));
    assert.equal(assetSubdir(f), 'company-intel', r.key + ' 归入 company-intel/');
    assert.ok(fs.readFileSync(f, 'utf8').trim().split('\n').length >= 2, r.key + ' 至少一行数据');
  }
  const cds = fs.readFileSync(assetPath('ORCL-US CDS History.csv'), 'utf8').trim().split('\n').map(splitCsvLine);
  assert.deepEqual(cds[2], ['2026-11-18', '114.4', '309.1', '114.3']);
  assert.ok(calls >= 9);

  /* 503 重试:前两次 503,第三次成功 */
  let n = 0;
  const flaky = async url => (++n < 3 ? { status: 503, text: '' } : { status: 200, text: JSON.stringify(fixtures(url)) });
  const sc = I.INTEL_REPORTS.find(r => r.key === 'supply-chain');
  assert.equal(await I.fetchIntel(sc, 'TSM-US', { request: async u => flaky(u) }), true);
  assert.equal(n, 3);

  /* 失败不覆盖:登录页 / NOT_SERVICED / 空表 */
  const before = fs.readFileSync(assetPath('ORCL-US Supply Chain.csv'), 'utf8');
  for (const bad of [async () => ({ status: 200, text: '<html>' }),
    async () => ({ status: 200, text: JSON.stringify({ result: 'TICKER_NOT_FOUND', status: 'NOT_SERVICED' }) }),
    async () => ({ status: 200, text: JSON.stringify({ x: rowsObj([['h']]) }) })]) {
    await assert.rejects(I.fetchIntel(sc, 'ORCL-US', { request: bad }));
  }
  assert.equal(fs.readFileSync(assetPath('ORCL-US Supply Chain.csv'), 'utf8'), before);

  /* 登记表由 INTEL_REPORTS 生成,不另写一份 */
  const metas = expectedArtifacts().filter(m => m.kind === 'company-intel');
  assert.ok(metas.length % I.INTEL_REPORTS.length === 0 && metas.length > 0);
  console.log('test-company-intel: OK');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
