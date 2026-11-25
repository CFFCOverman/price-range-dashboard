/**
 * options:期权链(OI / 全天成交量 / 收盘价 / Delta / Gamma / 买卖价),全部走同源接口(重构 R1:取数核心从旧 fetcher 搬来,唯一定义)。
 * 接口与字段的实测记录见 collect/parsers/fql.mjs 顶部;快照合并与滚存规则见 collect/parsers/opt-store.mjs。
 * 取数函数 optionChain 的网络请求由调用方注入(fqlRaw / get),所以旧 fetcher 退役前也复用同一份。
 */
import {
  FQL_BATCH, OC_PATH, OPT_API_MAX_CONTRACTS,
  assembleOptionRows, chunk, optApiVerdict, parseFqlValues, parseOptionChainTable, pickChainContracts,
} from '../parsers/fql.mjs';
import { mergeOptionSnapshots, OPT_EXTRA_FIELDS } from '../parsers/opt-store.mjs';
import { readCsvFile, atomicWrite, csvFlat } from '../lib/store.mjs';

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
/** 按 asof 合并进快照文件(一天一层);返回 { total, added, snapshots, agedOut } */
export function saveOptionSnapshots(file, recs, asof, today) {
  const old = readCsvFile(file).rows.filter(r => r.asof && r.expiry);
  const fetched_at = new Date().toISOString();
  const enriched = (recs || []).map(r => ({ ...r, fetched_at: r.fetched_at || fetched_at }));
  const m = mergeOptionSnapshots(old, enriched, asof || today, today);
  atomicWrite(file, OPTION_FIELDS.join(',') + '\n' + m.rows.map(r => OPTION_FIELDS.map(k => csvFlat(r[k] ?? '')).join(',')).join('\n') + '\n');
  return { total: m.rows.length, added: m.added, snapshots: m.snapshots, agedOut: m.agedOut + m.capped };
}

export const options = {
  key: 'options',
  async run({ symbol, file, api, today }) {
    const res = await optionChain(symbol, { fqlRaw: api.fqlRaw, get: api.get, today });
    const { total, snapshots } = saveOptionSnapshots(file('options', symbol), res.rows, today, today);
    return { rows: total, note: `${res.legs} 条腿,${res.expiries.length} 个到期日,${snapshots} 层快照` };
  },
};
