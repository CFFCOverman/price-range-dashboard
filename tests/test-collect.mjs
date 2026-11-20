/** collect/ 纯函数自检(不联网)。夹具形状取自 2026-11-19 对真实接口的抓包。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.FS_OUT ||= fs.mkdtempSync(path.join(os.tmpdir(), 'collect-'));
const { parseCsv, toCsv, mergeRows, upsertCsv, readCsvFile } = await import('../collect/lib/store.mjs');
const { isDue, planRun } = await import('../collect/lib/plan.mjs');
const { loadParams, loadUniverse } = await import('../collect/lib/config.mjs');
const { priceRows, priceExprs, consensusRow, CONSENSUS_EXPRS } = await import('../collect/datasets/fql-series.mjs');
const { fsDate, tableObjects, seriesLabel, ownershipRow, tnrUrl } = await import('../collect/datasets/report-json.mjs');
const { newsTime, htmlText, newsRow, newsStart } = await import('../collect/datasets/news.mjs');
const { DATASETS } = await import('../collect/datasets/index.mjs');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✔ ' + name); };

t('CSV 往返(引号、逗号、换行)', () => {
  const rows = [{ a: 'x,y', b: 'he said "hi"\nok' }, { a: '1', b: '' }];
  assert.deepEqual(parseCsv(toCsv(['a', 'b'], rows)).rows, rows);
});
t('mergeRows:同 key 新覆盖旧,升序', () => {
  const m = mergeRows([{ d: '2', v: 1 }, { d: '1', v: 1 }], [{ d: '2', v: 2 }, { d: '3', v: 3 }], r => r.d);
  assert.deepEqual(m.map(r => r.d + r.v), ['11', '22', '33']);
});
t('upsertCsv 攒历史且列取并集', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upsert-')), 'a.csv');
  upsertCsv(f, ['date', 'v'], [{ date: '2026-01-01', v: 1 }], r => r.date);
  const r = upsertCsv(f, ['date', 'v', 'w'], [{ date: '2026-01-02', v: 2, w: 9 }], r => r.date);
  assert.equal(r.total, 2); assert.equal(r.added, 1);
  assert.deepEqual(readCsvFile(f).header, ['date', 'v', 'w']);
});

const params = loadParams(), universe = loadUniverse();
t('params ↔ 实现一一对应,scope 只引用已定义数据集', () => {
  assert.deepEqual(Object.keys(params.datasets).sort(), Object.keys(DATASETS).sort());
  for (const [k, list] of Object.entries(params.scope)) for (const d of list) assert.ok(params.datasets[d], `${k}:${d}`);
  for (const d of Object.values(params.datasets)) assert.ok(params.cadence_hours[d.cadence], d.cadence);
});
t('universe:代码唯一、kind 都在 scope 里', () => {
  const syms = universe.map(u => u.symbol);
  assert.equal(new Set(syms).size, syms.length);
  for (const u of universe) assert.ok(params.scope[u.kind], u.symbol);
  assert.ok(!syms.includes('MCLD-US'));
  assert.equal(universe.find(u => u.symbol === 'TNX').scale, 0.1);
});
t('isDue 按节奏', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  assert.equal(isDue(params, 'prices', '2026-11-19T05:00:00Z', now), false);   // 19h < 20h
  assert.equal(isDue(params, 'prices', '2026-11-19T03:00:00Z', now), true);
  assert.equal(isDue(params, 'holders', '2026-11-17T00:00:00Z', now), false);  // 周频
  assert.equal(isDue(params, 'holders', '2026-11-17T00:00:00Z', now, true), true);
});
t('planRun:ETF 只拉 prices/options,市场只拉 prices', () => {
  const jobs = planRun(params, universe, {});
  assert.deepEqual([...new Set(jobs.filter(j => j.symbol === 'SPY-US').map(j => j.dataset))], ['prices', 'options']);
  assert.deepEqual([...new Set(jobs.filter(j => j.symbol === 'TNX').map(j => j.dataset))], ['prices']);
  assert.equal(jobs.filter(j => j.symbol === 'NVDA-US').length, params.scope.company.length);
});

t('priceRows:新→旧翻成旧→新,缩放,当天高低,0 成交量记空', () => {
  const ex = priceExprs('-30D'), tb = new Map([
    [`TNX|${ex.date}`, ['11/19/2026', '11/18/2026']], [`TNX|${ex.close}`, [50.66, 50.1]],
    [`TNX|${ex.open}`, [null, null]], [`TNX|${ex.volume_k}`, [0, 0]], [`TNX|${ex.high}`, [51]], [`TNX|${ex.low}`, [null]]]);
  const r = priceRows(tb, 'TNX', ex, 0.1);
  assert.deepEqual(r.map(x => x.date), ['2026-11-18', '2026-11-19']);
  assert.equal(r[1].close, 5.066); assert.equal(r[1].high, 5.1); assert.equal(r[1].low, null); assert.equal(r[1].volume_k, null);
  assert.equal(r[0].high, null);
});
t('consensusRow 记采集日', () => {
  const tb = new Map([[`NVDA-US|${CONSENSUS_EXPRS.eps_fy1}`, [7.1]], [`NVDA-US|${CONSENSUS_EXPRS.date}`, ['11/18/2026']]]);
  const r = consensusRow(tb, 'NVDA-US', '2026-11-19');
  assert.equal(r.date, '2026-11-19'); assert.equal(r.price_date, '2026-11-18'); assert.equal(r.eps_fy1, 7.1); assert.equal(r.eps_fy2, null);
});
t('fsDate / tableObjects', () => {
  assert.equal(fsDate("19 Nov '26"), '2026-11-19'); assert.equal(fsDate('x'), '');
  const o = tableObjects([['Date', 'Mean Tgt Price', 'Tgt Price Implied Return (%)', 'P/E (x)'], ["30 Oct '26", '333.27', '-', '25']]);
  assert.deepEqual(o.header, ['date', 'mean_tgt_price', 'tgt_price_implied_return_pct', 'p_e']);
  assert.deepEqual(o.rows[0], { date: '2026-10-30', mean_tgt_price: '333.27', tgt_price_implied_return_pct: '', p_e: '25' });
});
t('seriesLabel 取财年标签', () => assert.equal(seriesLabel({ misc: ['Misc', { chart: ['1', { serieslabel: ["Oct '26E"] }] }] }), "Oct '26E"));
t('tnrUrl 用 -USA 代码', () => assert.match(tnrUrl('NVDA-US', 'HISTORY', '-2AY'), /ticker=NVDA-USA$/));
const fos = (si, pct) => ({ result: { RAW_FQL_DATA: {
  chart: ['chart', { insider: [3.78, { DB_SOURCES: [] }], inst: [72.63], top: [28.81], unknown: [23.59] }],
  footer: ['footer', { date: ["Data as of: 18 Nov '26"] }],
  info: ['infographic', { float_pct: [96.22], inst_pct: [75.49], pct_shares_os: [pct], short_int: [si] }],
  info1: ['info1', { shares_os: ['24100000000'] }], table2: ['table2', { filers_rcnt: [6444] }] } } });
t('ownershipRow:空头天数/占比映射,"--" 记空', () => {
  const r = ownershipRow(fos(2.7974708, 1.21), '2026-11-19');
  assert.equal(r.short_days, 2.7974708); assert.equal(r.short_pct_float, 1.21); assert.equal(r.data_asof, '2026-11-18'); assert.equal(r.insider_pct, 3.78);
  const k = ownershipRow(fos('--', '--'), '2026-11-19');
  assert.equal(k.short_days, ''); assert.equal(k.short_pct_float, '');
});
t('news 时间与正文', () => {
  assert.equal(newsTime('20261119T175344'), '2026-11-19T17:53:44');
  assert.equal(htmlText('<ul><li>A &amp; B</li><li>C</li></ul>'), '• A & B\n• C');
  assert.equal(newsRow({ id: 'sa_1', story_datetime: '20261119T085601', headline: 'h' }).body, '');
});
t('newsStart:没回补完就拉全窗口,补完才增量', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  assert.equal(newsStart([], now, 365).toISOString().slice(0, 10), '2025-11-19');
  assert.equal(newsStart(['2026-11-16T12:00:00', '2026-11-19T09:00:00'], now, 365).toISOString().slice(0, 10), '2025-11-19');
  assert.equal(newsStart(['2025-11-25T00:00:00', '2026-11-19T09:00:00'], now, 365).toISOString().slice(0, 10), '2026-11-16');
});
console.log(`collect 自检 ${n} 项全部通过`);
