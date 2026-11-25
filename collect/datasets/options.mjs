/**
 * options:期权链(OI / 全天成交量 / 收盘价 / Delta / Gamma / 买卖价),全部走同源接口。
 * 接口与字段的实测记录见 collect/parsers/fql.mjs 顶部;快照合并与滚存规则见 collect/parsers/opt-store.mjs。
 * 取数函数 optionChain 的网络请求由调用方注入(fqlRaw / get),便于测试。
 */
import {
  FQL_BATCH, OC_PATH, OPT_API_MAX_CONTRACTS,
  assembleOptionRows, chunk, optApiVerdict, parseFqlValues, parseOptionChainTable, pickChainContracts,
} from '../parsers/fql.mjs';
import { OPT_EXTRA_FIELDS } from '../parsers/opt-store.mjs';
import { readCsvFile } from '../lib/store.mjs';

/* GAMMA:2026-11-24 实测可取;隐含波动率没有直接字段(由 process 层从价格反推) */
export const OPT_METRICS = ['P_OPT_VOLUME', 'P_OPT_CLOSE_PRICE', 'P_OPT_DELTA', 'P_OPT_BID_PRICE', 'P_OPT_ASK_PRICE', 'P_OPT_GAMMA'];

/** 一整条链 → { rows, expiries, spot, stats, miss, legs, batches, coverage };失败直接抛(话写成下一步该干什么) */
export async function optionChain(ticker, { fqlRaw, get, today, log = () => {}, phase = () => {} }) {
  phase('取现价');
  const px = await fqlRaw([ticker], ['P_PRICE']);
  if (px.status !== 200) throw new Error(`FQL 取现价回了 HTTP ${px.status}(登录态或权限的问题,不是解析的问题)`);
  const pm = parseFqlValues(px.json, 'P_PRICE');
  const spot = pm.get(ticker) ?? [...pm.values()][0];
  if (!isFinite(spot) || spot <= 0) throw new Error(`FQL 没给出 ${ticker} 的现价,没有现价就框不出行权价窗口`);

  phase('取期权链目录');
  const oc = await get(`${OC_PATH}?symbol=${encodeURIComponent(ticker)}`);
  if (oc.status !== 200) throw new Error(`期权链目录回了 HTTP ${oc.status}(${OC_PATH})`);
  /* 代码不对或没有期权时接口给 200 + 空 body,不是 404;parseOptionChainTable 把它显式变成 error */
  const table = parseOptionChainTable(oc.text);
  if (table.error) throw new Error(table.error);

  phase('筛合约');
  const { kept, stats } = pickChainContracts(table.rows, { today, spot, ticker });
  if (!kept.length) {
    throw new Error(`目录有 ${stats.total} 行,但没有一个合约落在窗口里(现价 ${spot},已到期 ${stats.expired} / 太远 ${stats.farDate}`
      + ` / 离钱太远 ${stats.farStrike} / 调整过 ${stats.adjusted} / 标的对不上 ${stats.wrongUnderlier})`);
  }
  if (kept.length * 2 > OPT_API_MAX_CONTRACTS) {
    log(`  · ${ticker} 窗口里有 ${kept.length * 2} 条腿,超过 ${OPT_API_MAX_CONTRACTS} 的上限,只取靠前的那些`);
    kept.length = Math.floor(OPT_API_MAX_CONTRACTS / 2);
  }

  phase('取未平仓量与各项读数');
  const syms = kept.flatMap(k => [k.call, k.put]);
  const oi = new Map();
  const metricMaps = Object.fromEntries(OPT_METRICS.map(x => [x, new Map()]));
  const batches = chunk(syms, FQL_BATCH);
  for (let i = 0; i < batches.length; i++) {
    const r = await fqlRaw(batches[i], ['P_OPT_OPEN_INTEREST', ...OPT_METRICS]);
    if (r.status !== 200) throw new Error(`FQL 第 ${i + 1}/${batches.length} 批回了 HTTP ${r.status}`);
    if (!r.json) throw new Error(`FQL 第 ${i + 1}/${batches.length} 批返回的不是 JSON:${r.text}`);
    for (const [k, v] of parseFqlValues(r.json, 'P_OPT_OPEN_INTEREST')) oi.set(k, v);
    for (const e of OPT_METRICS) for (const [k, v] of parseFqlValues(r.json, e)) metricMaps[e].set(k, v);
  }

  phase('拼装');
  const built = assembleOptionRows(kept, oi, metricMaps);
  const bad = optApiVerdict(built);
  if (bad) throw new Error(bad);
  const coverage = Object.fromEntries(OPT_METRICS.map(e => [e, built.legs ? metricMaps[e].size / built.legs : 0]));
  return { ...built, spot, stats, batches: batches.length, coverage };
}

export const OPTION_FIELDS = ['asof', 'fetched_at', 'expiry', 'strike', 'call_oi', 'put_oi', ...OPT_EXTRA_FIELDS.filter(x => x !== 'fetched_at')];

/* ---------- R4(2026-11-24):按天分文件 + 次日早上补读收盘 OI ----------
 * 一天一个文件 raw/options/<代码>/<asof>.csv:单文件 2 万行上限下 NVDA 一天 1360 条腿,一年存不下。
 * OI 由清算所次日盘前公布:当晚拉到的 call_oi/put_oi 多半还是前一交易日的;次日 06:30 的 options-oi 轮
 * 把真正的当日收盘 OI 写进同一文件的 call_oi_eod / put_oi_eod(成交量那时已清零,不动)。 */
import fs from 'node:fs';
import path from 'node:path';
import { replaceCsv } from '../lib/store.mjs';

export const DAY_FIELDS = [...OPTION_FIELDS, 'call_oi_eod', 'put_oi_eod', 'oi_eod_at'];
const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
export const dayDir = (file, symbol) => path.dirname(file('options', `${symbol}/x`));
export const dayFile = (file, symbol, asof) => file('options', `${symbol}/${asof}`);
/** 目录里的快照日(升序) */
export function snapshotDays(dir) {
  try { return fs.readdirSync(dir).map(f => f.replace(/\.csv$/, '')).filter(d => ymdRe.test(d)).sort(); } catch { return []; }
}
/** 旧的单文件 → 按 asof 拆成按天文件(已存在的那天不覆盖);旧文件改名留作备份。返回拆出的天数 */
export function splitLegacy(file, symbol) {
  const legacy = file('options', symbol);
  if (!fs.existsSync(legacy)) return 0;
  const by = {};
  for (const r of readCsvFile(legacy).rows) if (ymdRe.test(r.asof || '')) (by[r.asof] ||= []).push(r);
  let n = 0;
  for (const [d, rows] of Object.entries(by)) {
    const f = dayFile(file, symbol, d);
    if (fs.existsSync(f)) continue;
    replaceCsv(f, DAY_FIELDS, rows); n++;
  }
  fs.renameSync(legacy, legacy.replace(/\.csv$/, '.legacy-split.csv'));
  return n;
}
/** 只留最近 keepDays 天 */
export function pruneDays(dir, today, keepDays) {
  const cut = new Date(Date.parse(today) - keepDays * 864e5).toISOString().slice(0, 10);
  let n = 0;
  for (const d of snapshotDays(dir)) if (d < cut) { fs.unlinkSync(path.join(dir, `${d}.csv`)); n++; }
  return n;
}
/** 快照行 + 链目录里挑出的合约 + OI 表 → 写入 *_oi_eod;返回 {rows, matched} */
export function applyEodOi(rows, kept, oi, at) {
  const sym = new Map(kept.map(k => [`${k.expiry}|${Number(k.strike)}`, k]));
  let matched = 0;
  const out = rows.map(r => {
    const k = sym.get(`${r.expiry}|${Number(r.strike)}`);
    if (!k) return r;
    const c = oi.get(k.call), p = oi.get(k.put);
    if (c == null && p == null) return r;
    matched++;
    return { ...r, call_oi_eod: c == null ? '' : Math.round(c), put_oi_eod: p == null ? '' : Math.round(p), oi_eod_at: at };
  });
  return { rows: out, matched };
}

export const options = {
  key: 'options',
  async run({ symbol, p, file, api, today }) {
    const split = splitLegacy(file, symbol);
    const res = await optionChain(symbol, { fqlRaw: api.fqlRaw, get: api.get, today });
    const fetched_at = new Date().toISOString();
    const rows = res.rows.map(r => ({ ...r, asof: today, fetched_at }));
    replaceCsv(dayFile(file, symbol, today), DAY_FIELDS, rows);
    const pruned = pruneDays(dayDir(file, symbol), today, p.keep_days);
    const days = snapshotDays(dayDir(file, symbol)).length;
    return { rows: rows.length, note: `${res.legs} 条腿,${res.expiries.length} 个到期日;共 ${days} 天${split ? `(旧文件拆出 ${split} 天)` : ''}${pruned ? `,过期删 ${pruned} 天` : ''}` };
  },
};

/** 次日早上补读收盘 OI(params.datasets['options-oi'].manual:只在 --only=options-oi 时跑,给 06:30 计划任务用) */
export const optionsOi = {
  key: 'options-oi',
  async run({ symbol, file, api, today }) {
    const days = snapshotDays(dayDir(file, symbol)).filter(d => d < today);
    if (!days.length) return { rows: 0, note: '没有更早的快照可补' };
    const asof = days.at(-1), f = dayFile(file, symbol, asof);
    const rows = readCsvFile(f).rows;
    const oc = await api.get(`${OC_PATH}?symbol=${encodeURIComponent(symbol)}`);
    if (oc.status !== 200) throw new Error(`期权链目录回了 HTTP ${oc.status}`);
    const table = parseOptionChainTable(oc.text);
    if (table.error) throw new Error(table.error);
    /* 以快照日为"今天"、窗口放到最大:只为把快照里的 (到期日, 行权价) 对回合约代码 */
    const { kept } = pickChainContracts(table.rows, { today: asof, spot: NaN, ticker: symbol, maxDte: 3650, window: 1e9 });
    const want = new Set(rows.map(r => `${r.expiry}|${Number(r.strike)}`));
    const legs = kept.filter(k => want.has(`${k.expiry}|${Number(k.strike)}`)).flatMap(k => [k.call, k.put]);
    const oi = new Map();
    for (const b of chunk(legs, FQL_BATCH)) {
      const r = await api.fqlRaw(b, ['P_OPT_OPEN_INTEREST']);
      if (r.status !== 200 || !r.json) throw new Error(`FQL 回了 HTTP ${r.status}`);
      for (const [k, v] of parseFqlValues(r.json, 'P_OPT_OPEN_INTEREST')) oi.set(k, v);
    }
    const out = applyEodOi(rows, kept, oi, new Date().toISOString());
    replaceCsv(f, DAY_FIELDS, out.rows);
    return { rows: out.matched, note: `补 ${asof} 收盘 OI:${out.matched}/${rows.length} 行` };
  },
};
