/* steps/research-feed.mjs — 给 US Equity Research OS 的每日 FactSet 数据包
 *
 * 用途(2026-11-18 用户确认先做这一步):Research OS 在云端跑,只能用公开来源;
 * 它反复记为缺口的几类读数(SOX 官方收盘、SPX 日内高低、USDJPY、STOXX 600、11 个行业 ETF 5 日相对 SPY、
 * 一致预期口径冲突)在 FactSet 里都有。fetcher 每轮结束时用同一条 FQL 接口取一次,写成一份 JSON,
 * 放在 Assets/research-feed/ 下,随云盘同步后由 Research OS 的 EVENING/MORNING 读取。
 *
 * 只做收盘后读数,不是盘中实时;每个数字都带 FactSet 给出的日期,读的一方按日期判断新旧。
 * 符号均为 2026-11-18 在登录态下实测能返回数值的写法(SOX、SPX、VIX、TNX、USDJPY、SXXP-STX ...)。
 * 取不到的符号进 missing,不造数、不补 0;SPX 都取不到时整份拒写(多半是登录态掉了)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { assetPath } from '../lib/config.mjs';
import { atomicText } from '../lib/atomic-csv.mjs';
import { phase } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { TICKERS } from '../lib/tickers.mjs';

export const FEED_VERSION = 1;
export const FEED_LATEST = 'research-feed latest.json';
export const feedFile = date => `research-feed ${date}.json`;
export const SERIES_DAYS = 25;   // 往回取 26 个交易日:够算 1/5/20 日变化

/* [FactSet 符号, 名称, 分组, 换算]  换算:收益率类指数 TNX/TYX/IRX 报的是 收益率×10 */
export const FEED_MARKETS = [
  ['SPX', 'S&P 500', 'index'], ['NDX', 'Nasdaq 100', 'index'], ['RUT', 'Russell 2000', 'index'],
  ['SOX', 'PHLX Semiconductor (SOX)', 'index'], ['SXXP-STX', 'STOXX Europe 600', 'index'],
  ['VIX', 'CBOE VIX', 'vol'],
  ['IRX', 'UST 13W yield %', 'rates', 0.1], ['TNX', 'UST 10Y yield %', 'rates', 0.1], ['TYX', 'UST 30Y yield %', 'rates', 0.1],
  ['USDJPY', 'USD/JPY', 'fx'],
  ['SPY-US', 'SPY', 'etf'], ['QQQ-US', 'QQQ', 'etf'], ['RSP-US', 'RSP (equal weight)', 'etf'], ['SMH-US', 'SMH', 'etf'],
  ...['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC'].map(s => [`${s}-US`, s, 'sector']),
];
/* 日期锚用 NOW 而不是 0(2026-11-19 实测):0 = FactSet 日终库里最近一个已入库交易日,要到次日才更新到当天;
 * NOW = 当天(收盘后即当日收盘,盘中则是盘中价),所以盘中/收盘由 sessionAt() 另行标注 */
export const MARKET_EXPRS = [`P_PRICE(NOW,-${SERIES_DAYS}D)`, `P_DATE(NOW,-${SERIES_DAYS}D)`, 'P_PRICE_OPEN(NOW)', 'P_PRICE_HIGH(NOW)', 'P_PRICE_LOW(NOW)'];
/* 公司读数的表达式定义在 collect/datasets/fql-series.mjs § CONSENSUS_EXPRS,这里取它的前 11 项(重构 R1) */
import { CONSENSUS_EXPRS } from '../../collect/datasets/fql-series.mjs';
export const COMPANY_EXPRS = Object.fromEntries(['price', 'date', 'eps_nq', 'eps_nq_30d', 'eps_nq_n', 'sales_nq', 'sales_nq_30d',
  'eps_fy1', 'eps_fy1_30d', 'target_mean', 'target_n'].map(k => [k, CONSENSUS_EXPRS[k]]));

export { fqlTable, usDate } from '../../collect/parsers/fql.mjs';   // 定义搬到 collect/parsers/fql.mjs(重构 R1)
import { fqlTable, usDate } from '../../collect/parsers/fql.mjs';
const pct = (a, b) => (isFinite(a) && isFinite(b) && b !== 0 ? +((a / b - 1) * 100).toFixed(3) : null);
const round = (v, d = 4) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : null);

export function buildMarkets(table, markets = FEED_MARKETS) {
  const rows = [], missing = [];
  for (const [sym, name, group, scale = 1] of markets) {
    const px = (table.get(`${sym}|${MARKET_EXPRS[0]}`) || []).map(v => (typeof v === 'number' ? v * scale : null));
    const dates = (table.get(`${sym}|${MARKET_EXPRS[1]}`) || []).map(usDate);
    if (!(typeof px[0] === 'number') || !dates[0]) { missing.push(sym); continue; }
    const one = e => { const v = (table.get(`${sym}|${e}`) || [])[0]; return typeof v === 'number' ? v * scale : null; };
    rows.push({ symbol: sym, name, group, date: dates[0], close: round(px[0]),
      open: round(one(MARKET_EXPRS[2])), high: round(one(MARKET_EXPRS[3])), low: round(one(MARKET_EXPRS[4])),
      unchanged_1d: px[1] === px[0],   // 与前一日完全相同:多半是该序列当天还没更新(如 TNX 收盘后有时沿用前值)
      chg_1d_pct: pct(px[0], px[1]), chg_5d_pct: pct(px[0], px[5]), chg_20d_pct: pct(px[0], px[20]),
      /* 收益率类:变化用 bp 更直观 */
      ...(group === 'rates' ? { chg_1d_bp: isFinite(px[1]) ? round((px[0] - px[1]) * 100, 1) : null, chg_5d_bp: isFinite(px[5]) ? round((px[0] - px[5]) * 100, 1) : null } : {}),
      series: dates.map((d, i) => [d, round(px[i])]).filter(([d, v]) => d && v !== null) });
  }
  /* 行业 ETF 相对 SPY 的 5 日差(百分点),排好序,Research OS 的板块轮动扫描直接用 */
  const spy = rows.find(r => r.symbol === 'SPY-US');
  const sectors = rows.filter(r => r.group === 'sector' && spy && isFinite(r.chg_5d_pct) && isFinite(spy.chg_5d_pct))
    .map(r => ({ symbol: r.name, rel_5d_pp: round(r.chg_5d_pct - spy.chg_5d_pct, 2), chg_5d_pct: r.chg_5d_pct }))
    .sort((a, b) => b.rel_5d_pp - a.rel_5d_pp);
  return { rows, missing, sector_rotation_5d: sectors };
}

export function buildCompanies(table, tickers) {
  const rows = [], missing = [];
  for (const t of tickers) {
    const g = k => { const v = (table.get(`${t}|${COMPANY_EXPRS[k]}`) || [])[0]; return v ?? null; };
    const price = g('price');
    if (typeof price !== 'number') { missing.push(t); continue; }
    rows.push({ ticker: t, date: usDate(g('date')), price: round(price),
      eps_next_q_mean: round(g('eps_nq')), eps_next_q_mean_30d_ago: round(g('eps_nq_30d')), eps_next_q_rev_30d_pct: pct(g('eps_nq'), g('eps_nq_30d')),
      eps_next_q_num_est: g('eps_nq_n'),
      sales_next_q_mean: round(g('sales_nq'), 1), sales_next_q_rev_30d_pct: pct(g('sales_nq'), g('sales_nq_30d')),
      eps_fy1_mean: round(g('eps_fy1')), eps_fy1_rev_30d_pct: pct(g('eps_fy1'), g('eps_fy1_30d')),
      target_mean: round(g('target_mean'), 2), target_num_est: g('target_n'),
      target_upside_pct: pct(g('target_mean'), price) });
  }
  return { rows, missing };
}

/** 运行时刻(美东)→ 'intraday' | 'close':工作日 09:30–16:15 ET 之间取到的是盘中价,不能当收盘用 */
export function sessionAt(date = new Date()) {
  if (!(date instanceof Date) || isNaN(date)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(x => [x.type, x.value]));
  const mins = Number(p.hour) * 60 + Number(p.minute);
  return !['Sat', 'Sun'].includes(p.weekday) && mins >= 570 && mins < 975 ? 'intraday' : 'close';
}
export function buildFeed({ marketJson, companyJson, tickers, retrievedAt }) {
  const m = buildMarkets(fqlTable(marketJson)), c = buildCompanies(fqlTable(companyJson), tickers);
  const spx = m.rows.find(r => r.symbol === 'SPX');
  return {
    feed_version: FEED_VERSION,
    source: 'FactSet(用户订阅,经本地 Price Range Dashboard fetcher 抓取;FQL 接口,收盘后读数)',
    as_of: spx ? spx.date : null, retrieved_at: retrievedAt, session: sessionAt(new Date(retrievedAt)),
    notes: ['收益率类(IRX/TNX/TYX)已换算为百分比;chg_*_bp 为基点变化', '价格锚为 NOW:session=close 时是当日收盘,session=intraday 时是盘中价;unchanged_1d=true 表示该序列当天可能未更新',
      'eps_next_q 指下一未公布季度;rev_30d_pct 为一致预期 30 天变化'],
    markets: m.rows, sector_rotation_5d: m.sector_rotation_5d, companies: c.rows,
    missing: { markets: m.missing, companies: c.missing },
  };
}
export function feedVerdict(feed) {
  if (!feed.as_of) return 'SPX 收盘读不到 —— 多半是登录态掉了或 FQL 接口变了,本次不写';
  if (feed.markets.length < FEED_MARKETS.length / 2) return `市场读数只拿到 ${feed.markets.length}/${FEED_MARKETS.length},不完整,本次不写`;
  return null;
}

async function defaultRequest(symbols, exprs) {
  const { apiFql, ensureFactsetOrigin } = await import('./options.mjs');
  if (!(await ensureFactsetOrigin())) throw new Error('页面不在 my.apps.factset.com 上,同源接口发不出去(多半是登录态掉了)');
  return apiFql(symbols, exprs);
}

export async function fetchResearchFeed({ request = defaultRequest, tickers = TICKERS, now = new Date() } = {}) {
  phase('取接口');
  const mr = await request(FEED_MARKETS.map(r => r[0]), MARKET_EXPRS);
  if (mr.status !== 200) throw new Error(`市场读数 FQL 回了 HTTP ${mr.status}`);
  const cr = tickers.length ? await request(tickers, Object.values(COMPANY_EXPRS)) : { status: 200, json: [] };
  if (cr.status !== 200) throw new Error(`公司读数 FQL 回了 HTTP ${cr.status}`);
  phase('解析行');
  const feed = buildFeed({ marketJson: mr.json, companyJson: cr.json, tickers, retrievedAt: now.toISOString() });
  const bad = feedVerdict(feed);
  if (bad) throw new Error(bad);
  phase('写文件');
  const text = JSON.stringify(feed, null, 1) + '\n';
  const f = assetPath(feedFile(feed.as_of)), latest = assetPath(FEED_LATEST);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  atomicText(f, text);
  atomicText(latest, text);
  const sox = feed.markets.find(r => r.symbol === 'SOX'), spx = feed.markets.find(r => r.symbol === 'SPX');
  log(`  ✔ ${path.basename(f)}(截至 ${feed.as_of}:SPX ${spx.close} 低 ${spx.low}` + (sox ? `,SOX ${sox.close}` : '') +
    `;市场 ${feed.markets.length} 项、公司 ${feed.companies.length} 家` +
    (feed.missing.markets.length + feed.missing.companies.length ? `;缺 ${[...feed.missing.markets, ...feed.missing.companies].join(' ')}` : '') + ')');
  return true;
}
