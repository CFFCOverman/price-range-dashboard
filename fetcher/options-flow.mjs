/**
 * 盘中期权方向代理采集器。
 * 默认抓一次 NVDA：node fetcher/options-flow.mjs
 * 指定标的：node fetcher/options-flow.mjs NVDA-US SPY-US QQQ-US
 * 连续监测：node fetcher/options-flow.mjs --watch --interval=300 NVDA-US SPY-US
 * 注意：这是“成交方向代理”，不是交易所逐笔客户/Dealer 分类。
 */
import fs from 'node:fs';
import { ensureAssetDirs, assetPath } from './lib/config.mjs';
import * as browser from './lib/browser.mjs';
import { csvCell, splitCsvLine } from './steps/news.mjs';
import { fetchOptionsViaApi } from './steps/options.mjs';
import { FLOW_FIELDS, flowRows, retainFlowRows } from './lib/option-flow-store.mjs';
import { SIGNAL_FIELDS, buildOptionSignal, resolveOneHourReturns } from './lib/option-flow-signal.mjs';
import { loadTickers } from './lib/tickers.mjs';
import { optionPollPlan } from './lib/options-market-clock.mjs';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const fromEnv = String(process.env.FS_FLOW_TICKERS || '').split(/[\s,;]+/).filter(Boolean);
const requested = args.filter(x => !x.startsWith('--'));
const tickers = (args.includes('--all') ? loadTickers() : requested.length ? requested : fromEnv.length ? fromEnv : ['NVDA-US'])
  .map(x => x.toUpperCase());

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = splitCsvLine(lines.shift() || '');
  return lines.map(line => Object.fromEntries(head.map((h, i) => [h, splitCsvLine(line)[i] ?? ''])));
}
function save(ticker, snapshot) {
  ensureAssetDirs();
  const file = assetPath(`${ticker} Options Flow.csv`);
  const old = retainFlowRows(readCsv(file));
  const fresh = flowRows(ticker, snapshot);
  const priorTime = [...new Set(old.filter(r=>r.asof===fresh[0]?.asof).map(r=>r.timestamp))].sort().at(-1);
  const prior = priorTime ? old.filter(r=>r.timestamp===priorTime) : [];
  const signal = buildOptionSignal(ticker, prior, fresh);
  const rows = [...old, ...fresh];
  fs.writeFileSync(file, FLOW_FIELDS.join(',') + '\n' + rows.map(r => FLOW_FIELDS.map(k => csvCell(r[k])).join(',')).join('\n') + '\n');
  let signalFile='';
  if(signal){
    signalFile=assetPath(`${ticker} Options Signals.csv`);
    const byTime=new Map(readCsv(signalFile).map(r=>[r.timestamp,r]));byTime.set(signal.timestamp,signal);
    const signals=resolveOneHourReturns([...byTime.values()]).slice(-100000);
    fs.writeFileSync(signalFile,SIGNAL_FIELDS.join(',')+'\n'+signals.map(r=>SIGNAL_FIELDS.map(k=>csvCell(r[k])).join(',')).join('\n')+'\n');
  }
  return { file, signalFile, signal, rows: fresh.length, snapshots: new Set(rows.map(r => r.timestamp)).size };
}
async function round() {
  let totalVolume = 0, succeeded = 0;
  for (const ticker of tickers) {
    try {
      const snap = await fetchOptionsViaApi(ticker);
      const s = save(ticker, snap);
      totalVolume += snap.rows.reduce((n, r) => n + (+r.call_volume || 0) + (+r.put_volume || 0), 0);
      succeeded++;
      console.log(`✔ ${ticker}: ${s.rows} 个行权价，盘中快照共 ${s.snapshots} 份 → ${s.file}`);
      if(s.signal)console.log(`  · Delta Flow ${s.signal.net_delta_shares} 股 / imbalance ${(+s.signal.delta_imbalance).toFixed(2)} / ${s.signal.quality} / ${s.signal.direction}`);
    } catch (e) { console.error(`✖ ${ticker}: ${e.message}`); }
  }
  return { totalVolume, succeeded };
}

let previousTotal = null, idleRounds = 0;
try {
  do {
    /* Closed sessions do not even open Chrome. Releasing the persistent profile overnight also
     * lets the normal daily fetcher use FactSet without fighting this monitor for the profile. */
    let plan = optionPollPlan(new Date(), idleRounds);
    if (watch && !plan.session.open) {
      await browser.releaseBrowser();
      console.log(`休市等待（${plan.reason}）；下次检查 ${plan.next.toLocaleString('zh-CN', { timeZone:'America/New_York' })} ET。`);
      await new Promise(ok => setTimeout(ok, plan.delayMs));
      continue;
    }
    await browser.ensureBrowser();
    const result = await round();
    if (!watch) break;
    if (result.succeeded === tickers.length && previousTotal !== null && result.totalVolume <= previousTotal) idleRounds++;
    else idleRounds = 0;
    if (result.succeeded === tickers.length) previousTotal = result.totalVolume;
    plan = optionPollPlan(new Date(), idleRounds);
    if (!plan.session.open) await browser.releaseBrowser();
    console.log(`下一次检查 ${plan.next.toLocaleString('zh-CN', { timeZone:'America/New_York' })} ET（${plan.reason}）；按 Ctrl+C 停止。`);
    await new Promise(ok => setTimeout(ok, plan.delayMs));
  } while (watch);
} finally { if (browser.ctx) await browser.ctx.close().catch(() => {}); }
