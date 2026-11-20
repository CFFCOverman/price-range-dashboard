/* 估值史接口路径与空头"无数据"判定 —— 形状照抄 2026-11-19 AVGO/META 与 RKLB 实测 */
import assert from 'node:assert/strict';
process.env.FS_OUT = process.env.FS_OUT || '/tmp/est-api-test';
const E = await import('../fetcher/steps/estimates.mjs');
const S = await import('../fetcher/steps/short-interest.mjs');
const cell = v => ({ value: v });
const row = (cs, h) => ({ ...(h ? { header: true } : {}), fragments: [{ cells: cs.map(cell) }] });
const HEAD = ['Date', 'Mean', 'Sharp Cons', 'Num of Est', 'Num Up', 'Num Down', 'Low', 'High', 'Std Dev', 'Chg (%)', 'Chg Amt', 'Loading...', 'Loading...'];
const delay = { rows: [row(['P/E (x)', 'PEG (x)'], 1), row([29.67, 0.51]), row([27.9, 0.48])] };
const withSharp = { rows: [row(HEAD, 1), row(["19 Nov '26", 11.68, '@NaNd', 46, 3, 0, 11.5, 12.38, 0.14, -0.01, -0.002, '@NaNd', '@NaNd']),
  row(["30 Oct '26", 11.68, 11.7, 45, 11, 5, 11.5, 12.38, 0.14, 0.08, 0.009, '@NaNd', '@NaNd'])] };
const r = E.mergeEstimateApi(withSharp, delay);
assert.deepEqual(r[0], ['Date', 'Mean', 'Sharp Cons', 'Num of Est', 'Num Up', 'Num Down', 'Low', 'High', 'Std Dev', 'Chg (%)', 'Chg Amt', 'P/E (x)', 'PEG (x)']);
assert.deepEqual([r[1][2], r[1][11], r[2][11]], ['-', 29.67, 27.9], '占位列去掉、P/E 逐行对齐');
const noSharp = { rows: [row(HEAD.filter(h => h !== 'Sharp Cons'), 1), row(["19 Nov '26", 19.3, 46, 2, 2, 17.4, 22.4, 0.97, 0.02, 0.005, '@NaNd', '@NaNd'])] };
assert.equal(E.estimateDataRows(E.mergeEstimateApi(noSharp, delay))[0].length, 13, '无 Sharp 列时补齐到 13 列');
assert.ok(E.estimateApiUrl('AVGO-US', 2, 'TABLE').includes('period=2') && E.estimateApiUrl('AVGO-US', 1, 'TABLE').includes('ticker=AVGO-USA'));
assert.ok(S.NO_SHORTINT_DATA.test('SHORT INTEREST -- DAYS / --% FLOAT FLOAT 98.5%'));
assert.ok(!S.NO_SHORTINT_DATA.test('SHORT INTEREST 2.8 DAYS / 9.7% FLOAT'));
console.log('test-estimates-api: OK');
