/**
 * valuation:月末 NTM 市盈率历史(10 年),逐月 FQL 取 P/E、价格、NTM EPS。
 * 2026-09-30 实测:NTMA 是 FactSet 基于年度预期的 NTM;字面 NTM 被 FQL 拒绝;ANN_ROLL,+1 是 FY1 不是 NTM。
 * 历史月份的 P/E 不变,只重算当月与上月(上月价格/EPS 用当前的拆股口径);亏损或上市不久的(有效点不足)记"不适用"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { valuationDates, scalarFql, valuationVerdict, VALUATION_YEARS } from '../parsers/valuation-history.mjs';
import { readCsvFile, atomicWrite, csvFlat } from '../lib/store.mjs';

export function valuationExpressions(date) {
  const d = date.replaceAll('-', '');
  return { price: `P_PRICE(${d})`, eps: `FE_ESTIMATE(EPS,MEAN,NTMA,,${d})`, pe: `FE_VALUATION(PE,MEAN,NTMA,,${d})` };
}
export const VALUATION_COLS = ['ticker', 'date', 'pe_ntm', 'price', 'eps_ntm', 'valuation_basis', 'source', 'retrieved_at'];
/** 读回已有文件作缓存;口径不对或不完整就当没有 */
export function cachedValuation(file, ticker) {
  const n = v => (v == null || v === '' ? null : Number(v));
  const rows = readCsvFile(file).rows.map(r => ({ ...r, price: n(r.price), eps_ntm: n(r.eps_ntm), pe_ntm: n(r.pe_ntm) }));
  if (!rows.length || rows.some(r => r.ticker !== ticker || r.valuation_basis !== 'ntm' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date))) return [];
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(rows.map(r => r.date)).size !== rows.length || !valuationVerdict(rows).ok) return [];
  return rows;
}
/** request(symbols, exprs) → {status, json};返回 verdict,失败抛 */
export async function valuationHistory(ticker, { asOf, years = VALUATION_YEARS, request, file, forceHistory = false, log = () => {}, phase = () => {} }) {
  const schedule = valuationDates(asOf, years);
  const cached = new Map((forceHistory ? [] : cachedValuation(file, ticker)).map(r => [r.date, r]));
  const comparisonDate = schedule.at(-2);
  const dates = schedule.filter(d => d === asOf || d === comparisonDate || !cached.has(d));
  const records = new Map(schedule.filter(d => cached.has(d)).map(d => [d, cached.get(d)]));
  const retrievedAt = new Date().toISOString();
  phase('取滚动 NTM 历史');
  for (let off = 0; off < dates.length; off += 24) {
    const batch = dates.slice(off, off + 24), exprs = batch.flatMap(d => Object.values(valuationExpressions(d)));
    const res = await request([ticker], exprs);
    if (res.status !== 200) throw new Error(`NTM 历史接口 HTTP ${res.status}`);
    for (const date of batch) {
      const e = valuationExpressions(date);
      const price = scalarFql(res.json, ticker, e.price), eps = scalarFql(res.json, ticker, e.eps), pe = scalarFql(res.json, ticker, e.pe);
      records.set(date, { ticker, date, pe_ntm: eps > 0 && pe > 0 ? pe : null, price, eps_ntm: eps,
        valuation_basis: 'ntm', source: 'FactSet FQL: ' + e.pe + '; ' + e.price + '; ' + e.eps, retrieved_at: retrievedAt });
    }
    log(`  · ${ticker} NTM 更新 ${Math.min(off + 24, dates.length)}/${dates.length} 个日期已返回`);
  }
  phase('校验历史覆盖');
  const rows = schedule.map(d => records.get(d));
  const verdict = valuationVerdict(rows);
  if (!verdict.ok) throw new Error(verdict.reason);
  phase('写文件');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, VALUATION_COLS.join(',') + '\n' + rows.map(r => VALUATION_COLS.map(k => csvFlat(r[k] ?? '')).join(',')).join('\n') + '\n');
  log(`  ✔ ${path.basename(file)}:${verdict.positive} 个有效点,${verdict.from} ~ ${verdict.to}(请求近${years}年)`);
  return verdict;
}

export const valuation = {
  key: 'valuation',
  async run({ symbol, p, file, api, today }) {
    const f = file('valuation', symbol);
    try {
      const v = await valuationHistory(symbol, { asOf: today, years: p.years, request: api.fqlRaw, file: f });
      return { rows: readCsvFile(f).rows.length, note: `${v.positive} 个有效点` };
    } catch (e) {
      /* 2026-11-19 首跑:RKLB(亏损)、SPCX(上市不久)NTM P/E 有效点不够 —— 这是"不适用",不是故障 */
      if (/有效 NTM P\/E 点/.test(e.message)) return { rows: 0, note: `不适用:${e.message}` };
      throw e;
    }
  },
};
