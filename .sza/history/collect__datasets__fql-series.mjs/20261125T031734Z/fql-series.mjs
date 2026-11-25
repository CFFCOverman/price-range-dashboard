/** prices(日线 OHLCV 里 FQL 给得出的部分)与 consensus(一致预期每日快照)。都是 FQL。 */
import { usDate, COMPANY_EXPRS } from '../../fetcher/steps/research-feed.mjs';
import { readCsvFile, upsertCsv } from '../lib/store.mjs';
import { fetchValuationHistory } from '../../fetcher/steps/valuation.mjs';
import { apiFql } from '../../fetcher/steps/options.mjs';

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const r4 = v => (v === null ? null : +v.toFixed(4));

/* 2026-11-19 实测:P_PRICE / P_PRICE_OPEN / P_VOLUME / P_DATE 都能按区间返回日序列(新→旧);
 * P_PRICE_HIGH / P_PRICE_LOW 无论哪种区间写法都只回一个值,所以日内高低只取当天一格,不回填历史。 */
export const priceExprs = range => ({
  date: `P_DATE(NOW,${range},D)`, close: `P_PRICE(NOW,${range},D)`,
  open: `P_PRICE_OPEN(NOW,${range},D)`, volume_k: `P_VOLUME(NOW,${range},D)`,
  high: 'P_PRICE_HIGH(NOW)', low: 'P_PRICE_LOW(NOW)',
});
/** FQL 表 → 行(旧→新)。各序列长度不一时只信与日期等长的那条;scale 用于收益率类(TNX 等报价 ×10) */
export function priceRows(table, sym, exprs, scale = 1) {
  const s = k => table.get(`${sym}|${exprs[k]}`) || [];
  const dates = s('date').map(usDate), n = dates.length;
  const col = k => (s(k).length === n ? s(k) : []);
  const close = col('close'), open = col('open'), vol = col('volume_k');
  const rows = [];
  for (let i = 0; i < n; i++) {
    const c = num(close[i]);
    if (!dates[i] || c === null) continue;
    const o = num(open[i]);
    rows.push({ date: dates[i], open: o === null ? null : r4(o * scale), high: null, low: null, close: r4(c * scale), volume_k: num(vol[i]) || null });   // 指数类成交量回 0,记空
  }
  if (rows.length) {   // 当天一格的高低
    const hi = num(s('high')[0]), lo = num(s('low')[0]);
    rows[0].high = hi === null ? null : r4(hi * scale);
    rows[0].low = lo === null ? null : r4(lo * scale);
  }
  return rows.reverse();
}
export const PRICE_COLS = ['date', 'open', 'high', 'low', 'close', 'volume_k'];

export const prices = {
  key: 'prices',
  async run({ symbol, entry, p, file, api }) {
    const f = file('prices', symbol);
    /* 已有足够历史就只补最近一段,避免每天重拉 5 年 */
    const have = readCsvFile(f).rows.length;
    const range = have >= 200 ? '-30D' : `-${p.years}AY`;
    const ex = priceExprs(range);
    const rows = priceRows(await api.fql([symbol], Object.values(ex)), symbol, ex, entry.scale);
    if (!rows.length) throw new Error(`FQL 没给出 ${symbol} 的价格序列`);
    const { total, added } = upsertCsv(f, PRICE_COLS, rows, r => r.date);
    return { rows: total, note: `+${added},最新 ${rows.at(-1).date} ${rows.at(-1).close}` };
  },
};

/* 一致预期快照:在 research-feed 的公司读数之上补 FY2 与收入 —— 每天一行,修订轨迹靠我们攒 */
export const CONSENSUS_EXPRS = {
  ...COMPANY_EXPRS,
  eps_fy2: 'FE_ESTIMATE(EPS,MEAN,ANN_ROLL,+2,NOW)', eps_fy2_30d: 'FE_ESTIMATE(EPS,MEAN,ANN_ROLL,+2,-30D)',
  eps_fy1_n: 'FE_ESTIMATE(EPS,NEST,ANN_ROLL,+1,NOW)',
  sales_fy1: 'FE_ESTIMATE(SALES,MEAN,ANN_ROLL,+1,NOW)', sales_fy2: 'FE_ESTIMATE(SALES,MEAN,ANN_ROLL,+2,NOW)',
  target_30d: 'FE_ESTIMATE(PRICE_TGT,MEAN,ANN_ROLL,+1,-30D)',
};
export function consensusRow(table, sym, asof, exprs = CONSENSUS_EXPRS) {
  const row = { date: asof };
  for (const [k, e] of Object.entries(exprs)) {
    const v = (table.get(`${sym}|${e}`) || [])[0];
    row[k] = k === 'date' ? usDate(v) : num(v);
  }
  row.price_date = row.date === asof ? undefined : row.date;   // P_DATE 与采集日不同时留痕
  row.date = asof;
  return row;
}
export const consensus = {
  key: 'consensus',
  async run({ symbol, file, api, today }) {
    const row = consensusRow(await api.fql([symbol], Object.values(CONSENSUS_EXPRS)), symbol, today);
    if (row.eps_fy1 === null && row.price === null) throw new Error('FQL 没给出价格与 FY1 EPS');
    const cols = ['date', ...Object.keys(CONSENSUS_EXPRS).filter(k => k !== 'date'), 'price_date'];
    const { total } = upsertCsv(file('consensus', symbol), cols, [row], r => r.date);
    return { rows: total, note: `FY1 ${row.eps_fy1} / 目标价 ${row.target_mean}` };
  },
};

/* 月末 NTM 市盈率历史(10 年):规则与校验在 fetcher/steps/valuation.mjs;每天只重算当月与上月两个点 */
export const valuation = {
  key: 'valuation',
  async run({ symbol, p, file, today }) {
    const f = file('valuation', symbol);
    try {
      await fetchValuationHistory(symbol, { asOf: today, years: p.years, request: apiFql, file: f });
    } catch (e) {
      /* 2026-11-19 首跑:RKLB(亏损)、SPCX(上市不久)的 NTM P/E 有效点不够 —— 这是"不适用",不是故障 */
      if (/有效 NTM P\/E 点/.test(e.message)) return { rows: 0, note: `不适用:${e.message}` };
      throw e;
    }
    return { rows: readCsvFile(f).rows.length };
  },
};

/* 修订广度(OS L2「卖方行业修订广度」):每个成员一行,广度在 process 层算。
 * 2026-11-24 实测:NTMA 无财年切换跳变,用它比 30 天变化;UP/DOWN 只对 ANN_ROLL 有值(FactSet 默认统计窗口)。 */
export const BREADTH_EXPRS = {
  eps_ntm: 'FE_ESTIMATE(EPS,MEAN,NTMA,,NOW)', eps_ntm_30d: 'FE_ESTIMATE(EPS,MEAN,NTMA,,-30D)',
  eps_fy1: 'FE_ESTIMATE(EPS,MEAN,ANN_ROLL,+1,NOW)', nest_fy1: 'FE_ESTIMATE(EPS,NEST,ANN_ROLL,+1,NOW)',
  up_fy1: 'FE_ESTIMATE(EPS,UP,ANN_ROLL,+1,NOW)', down_fy1: 'FE_ESTIMATE(EPS,DOWN,ANN_ROLL,+1,NOW)',
  up_fy2: 'FE_ESTIMATE(EPS,UP,ANN_ROLL,+2,NOW)', down_fy2: 'FE_ESTIMATE(EPS,DOWN,ANN_ROLL,+2,NOW)',
};
export function breadthRows(table, members, asof, exprs = BREADTH_EXPRS) {
  return members.map(sym => {
    const row = { date: asof, symbol: sym };
    for (const [k, e] of Object.entries(exprs)) row[k] = num((table.get(`${sym}|${e}`) || [])[0]);
    return row;
  }).filter(r => r.eps_ntm !== null || r.eps_fy1 !== null);
}
export const breadth = {
  key: 'breadth',
  async run({ symbol: group, entry, file, api, today }) {
    const rows = breadthRows(await api.fql(entry.members, Object.values(BREADTH_EXPRS)), entry.members, today);
    if (rows.length < entry.members.length * 0.8) throw new Error(`只取到 ${rows.length}/${entry.members.length} 个成员的一致预期`);
    const { total } = upsertCsv(file('breadth', group), ['date', 'symbol', ...Object.keys(BREADTH_EXPRS)], rows, r => `${r.date}|${r.symbol}`);
    const up = rows.filter(r => r.eps_ntm > r.eps_ntm_30d).length;
    return { rows: total, note: `${rows.length} 家,NTM EPS 30 天上调 ${up} / 下调 ${rows.length - up}` };
  },
};
