/* steps/earnings.mjs 的解析与落盘 —— 响应形状照抄 2026-11-18 NVDA-USA 实测 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'earnings-'));
process.env.FS_OUT = root;
const E = await import('../fetcher/steps/earnings.mjs');
const { assetPath, assetSubdir } = await import('../fetcher/lib/config.mjs');
const { splitCsvLine } = await import('../fetcher/steps/news.mjs');
const { metaGuidance, metaSurprise, expectedArtifacts } = await import('../fetcher/lib/registry.mjs');

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

assert.equal(assetSubdir('NVDA-US Guidance History.csv'), 'earnings');
assert.equal(assetSubdir('NVDA-US Surprise History.csv'), 'earnings');
assert.equal(assetSubdir('NVDA-US FY1 Estimate History.xlsx'), 'estimates', '老文件归类不受影响');
assert.equal(metaGuidance('X-US').file, 'X-US Guidance History.csv');
assert.equal(metaSurprise('X-US').file, 'X-US Surprise History.csv');

try {
  const urls = [];
  const request = async p => { urls.push(p); return { status: 200, text: JSON.stringify(p.includes('guidance') ? guidanceJson : surpriseJson(p.includes('kitem=SALES') ? 'SALES' : 'EPS')) }; };
  assert.equal(await E.fetchGuidance('NVDA-US', { request }), true);
  assert.equal(await E.fetchSurprise('NVDA-US', { request }), true);
  const gl = fs.readFileSync(assetPath('NVDA-US Guidance History.csv'), 'utf8').trim().split('\n').map(splitCsvLine);
  assert.deepEqual(gl[0], E.GUIDANCE_COLS);
  assert.equal(gl.length, 3);
  const sl = fs.readFileSync(assetPath('NVDA-US Surprise History.csv'), 'utf8').trim().split('\n').map(splitCsvLine);
  assert.equal(sl.length, 5, 'EPS + SALES 各两行');
  assert.ok(sl.some(r => r[1] === 'SALES' && r[6] === '115844'));
  assert.equal(urls.length, 3);

  /* 失败不覆盖旧文件:登录页、HTTP 错误、解析不出已公布季度 */
  const before = fs.readFileSync(assetPath('NVDA-US Surprise History.csv'), 'utf8');
  for (const bad of [async () => ({ status: 403, text: '' }), async () => ({ status: 200, text: '<html>login' }), async () => ({ status: 200, text: JSON.stringify({ rows: [hdr(10)] }) })]) {
    await assert.rejects(E.fetchSurprise('NVDA-US', { request: bad }));
  }
  assert.equal(fs.readFileSync(assetPath('NVDA-US Surprise History.csv'), 'utf8'), before);

  /* 没有指引的公司:合法,写一份只有表头的文件 */
  assert.equal(await E.fetchGuidance('META-US', { request: async () => ({ status: 200, text: JSON.stringify({ rows: [hdr(10)] }) }) }), true);
  assert.equal(fs.readFileSync(assetPath('META-US Guidance History.csv'), 'utf8').trim(), E.GUIDANCE_COLS.join(','));
  console.log('test-earnings-history: OK');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
