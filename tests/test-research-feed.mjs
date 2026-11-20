/* steps/research-feed.mjs —— 响应形状照抄 2026-11-18 实测(扁平数组,P_PRICE(0,-25D) 为 26 行降序,日期 MM/DD/YYYY) */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
process.env.FS_OUT = root;
const F = await import('../fetcher/steps/research-feed.mjs');
const { assetPath, assetSubdir } = await import('../fetcher/lib/config.mjs');

const days = Array.from({ length: 26 }, (_, i) => { const d = new Date(Date.UTC(2026, 10, 17 - i)); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; });
function marketJson({ drop = [] } = {}) {
  const out = [];
  for (const [sym] of F.FEED_MARKETS) {
    if (drop.includes(sym)) { for (const e of F.MARKET_EXPRS) out.push({ $symbol: sym, $expression: e, $error: 0, $value: [['@NA']] }); continue; }
    const base = sym === 'TNX' ? 51 : sym === 'SPY-US' ? 600 : sym === 'XLK-US' ? 160 : 100;
    /* 收盘降序:今天 base,5 天前 base/1.02(SPY)或 base/1.05(XLK)或 base/1.01(其他) */
    const k = sym === 'SPY-US' ? 1.02 : sym === 'XLK-US' ? 1.05 : 1.01;
    const px = days.map((_, i) => [i === 0 ? base : i === 1 ? base - 1 : i >= 5 ? +(base / k).toFixed(4) : base]);
    out.push({ $symbol: sym, $expression: F.MARKET_EXPRS[0], $error: 0, $value: px });
    out.push({ $symbol: sym, $expression: F.MARKET_EXPRS[1], $error: 0, $value: days.map(d => [d]) });
    out.push({ $symbol: sym, $expression: F.MARKET_EXPRS[2], $error: 0, $value: [[base - 0.5]] });
    out.push({ $symbol: sym, $expression: F.MARKET_EXPRS[3], $error: 0, $value: [[base + 2]] });
    out.push({ $symbol: sym, $expression: F.MARKET_EXPRS[4], $error: 0, $value: [[base - 2]] });
  }
  return out;
}
const companyJson = [
  ...Object.entries({ price: 155.46, date: '11/17/2026', eps_nq: 2.8765, eps_nq_30d: 2.7305, eps_nq_n: 42, sales_nq: 130802.72, sales_nq_30d: 124347.05,
    eps_fy1: 9.6646, eps_fy1_30d: 9.3545, target_mean: 255.03, target_n: 60 }).map(([k, v]) => ({ $symbol: 'NVDA-US', $expression: F.COMPANY_EXPRS[k], $error: 0, $value: [[v]] })),
  ...Object.values(F.COMPANY_EXPRS).map(e => ({ $symbol: 'MCLD-US', $expression: e, $error: 0, $value: [['@NA']] })),
];

assert.equal(F.usDate('11/7/2026'), '2026-11-07');
assert.equal(F.sessionAt(new Date('2026-11-19T16:00:00Z')), 'intraday', '11:00 ET 盘中');
assert.equal(F.sessionAt(new Date('2026-11-19T23:00:00Z')), 'close', '18:00 ET 收盘后');
assert.equal(F.sessionAt(new Date('2026-11-21T16:00:00Z')), 'close', '周六');
assert.ok(F.MARKET_EXPRS.every(e => !/\(0[,)]/.test(e)), '不再用 0 作日期锚');
const feed = F.buildFeed({ marketJson: marketJson(), companyJson, tickers: ['NVDA-US', 'MCLD-US'], retrievedAt: '2026-11-18T22:00:00Z' });
assert.equal(F.feedVerdict(feed), null);
assert.equal(feed.session, 'close');
assert.equal(feed.as_of, '2026-11-17');
const tnx = feed.markets.find(r => r.symbol === 'TNX');
assert.equal(tnx.close, 5.1, '收益率×10 换算回百分比');
assert.equal(tnx.chg_1d_bp, 10, '51→50 即 5.1%→5.0%,+10bp');
const spx = feed.markets.find(r => r.symbol === 'SPX');
assert.deepEqual([spx.high, spx.low, spx.series.length], [102, 98, 26]);
assert.equal(feed.sector_rotation_5d[0].symbol, 'XLK', 'XLK 5 日最强排第一');
assert.ok(Math.abs(feed.sector_rotation_5d[0].rel_5d_pp - 3) < 0.01, 'XLK +5% vs SPY +2% = +3pp');
const nv = feed.companies.find(r => r.ticker === 'NVDA-US');
assert.equal(nv.date, '2026-11-17');
assert.ok(Math.abs(nv.eps_next_q_rev_30d_pct - 5.347) < 0.01);
assert.ok(Math.abs(nv.target_upside_pct - 64.05) < 0.05);
assert.deepEqual(feed.missing.companies, ['MCLD-US'], '取不到的公司进 missing,不造数');

/* SOX 取不到:只进 missing,整份照写 */
const partial = F.buildFeed({ marketJson: marketJson({ drop: ['SOX'] }), companyJson, tickers: ['NVDA-US'], retrievedAt: '2026-11-18T22:00:00Z' });
assert.deepEqual(partial.missing.markets, ['SOX']);
assert.equal(F.feedVerdict(partial), null);
/* SPX 取不到:拒写 */
assert.match(F.feedVerdict(F.buildFeed({ marketJson: marketJson({ drop: ['SPX'] }), companyJson, tickers: [], retrievedAt: '2026-11-18T22:00:00Z' })), /SPX/);

assert.equal(assetSubdir('research-feed 2026-11-17.json'), 'research-feed');
assert.equal(assetSubdir('research-feed latest.json'), 'research-feed');
assert.equal(assetSubdir('NVDA-US Fair Value Inputs.json'), 'misc', '仪表盘自己的 json 不受影响');

try {
  const request = async (syms, exprs) => ({ status: 200, json: exprs === F.MARKET_EXPRS ? marketJson() : companyJson });
  assert.equal(await F.fetchResearchFeed({ request, tickers: ['NVDA-US'], now: new Date('2026-11-18T22:00:00Z') }), true);
  const dated = JSON.parse(fs.readFileSync(assetPath('research-feed 2026-11-17.json'), 'utf8'));
  const latest = fs.readFileSync(assetPath('research-feed latest.json'), 'utf8');
  assert.equal(dated.as_of, '2026-11-17');
  assert.equal(JSON.stringify(dated), JSON.stringify(JSON.parse(latest)));
  const before = latest;
  await assert.rejects(F.fetchResearchFeed({ request: async () => ({ status: 403 }), tickers: [] }));
  await assert.rejects(F.fetchResearchFeed({ request: async (s, e) => ({ status: 200, json: e === F.MARKET_EXPRS ? marketJson({ drop: ['SPX'] }) : [] }), tickers: [] }));
  assert.equal(fs.readFileSync(assetPath('research-feed latest.json'), 'utf8'), before, '失败时 latest 保持上一份');
  console.log('test-research-feed: OK');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
