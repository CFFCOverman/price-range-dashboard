#!/usr/bin/env node
/**
 * collect 入口:按 config/params.json 的节奏,把 config/universe.csv 里到期的 (数据集 × 标的) 拉一遍,写进 <Assets>/raw/。
 * 用法见 collect/README.md § 怎么跑。
 *   node collect/run.mjs                    到期的都拉
 *   node collect/run.mjs --dry              只列出本轮会拉什么
 *   node collect/run.mjs --force --only=news,targets --symbols=NVDA-US
 */
import path from 'node:path';
import { loadParams, loadUniverse, ensureUniverse, RAW_DIR, STATE_DIR, OUT_DIR } from './lib/config.mjs';
import { loadState, saveState, rawFile, atomicWrite } from './lib/store.mjs';
import { planRun, stateKey } from './lib/plan.mjs';
import { DATASETS } from './datasets/index.mjs';
import { marketDate } from './lib/clock.mjs';
import * as api from './lib/api.mjs';

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const list = k => (arg(k) ? arg(k).split(',').map(s => s.trim()).filter(Boolean) : null);
const flag = k => process.argv.includes(`--${k}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

ensureUniverse();
const params = loadParams(), universe = loadUniverse(), state = loadState(STATE_DIR);
for (const ds of Object.keys(params.datasets)) if (!DATASETS[ds]) throw new Error(`params.json 有数据集 ${ds},collect/datasets 里没有实现`);
const now = new Date(), today = marketDate(now);
const jobs = planRun(params, universe, state, { now, force: flag('force'), only: list('only'), symbols: list('symbols')?.map(s => s.toUpperCase()) });

console.log(`collect ${today} · 输出 ${OUT_DIR} · 本轮 ${jobs.length} 项`);
if (flag('dry') || !jobs.length) {
  const by = {}; for (const j of jobs) (by[j.dataset] ||= []).push(j.symbol);
  for (const [d, s] of Object.entries(by)) console.log(`  ${d.padEnd(12)} ${s.length} · ${s.join(' ')}`);
  process.exit(0);
}

const { openSession, closeSession } = await import('./lib/session.mjs');
await openSession();
const file = (ds, name) => rawFile(RAW_DIR, ds, name);
const report = { started_at: now.toISOString(), today, ok: [], failed: [] };
let i = 0;
for (const job of jobs) {
  i++;
  const tag = `[${i}/${jobs.length}] ${job.dataset} ${job.symbol}`;
  const k = stateKey(job.dataset, job.symbol);
  try {
    const out = await DATASETS[job.dataset].run({ ...job, p: params.datasets[job.dataset], file, api, today, now });
    state[k] = { ok_at: new Date().toISOString(), rows: out.rows };
    report.ok.push({ dataset: job.dataset, symbol: job.symbol, rows: out.rows, note: out.note || '' });
    console.log(`  ✔ ${tag} · ${out.rows} 行${out.note ? ' · ' + out.note : ''}`);
  } catch (e) {
    state[k] = { ...(state[k] || {}), err_at: new Date().toISOString(), err: String(e.message || e) };
    report.failed.push({ dataset: job.dataset, symbol: job.symbol, error: String(e.message || e) });
    console.log(`  ✘ ${tag} · ${e.message || e}`);
  }
  saveState(STATE_DIR, state);   // 每项都落盘:中途断掉,下次从未完成的接着拉
  await sleep(params.run.pause_ms_between_requests);
}
report.finished_at = new Date().toISOString();
atomicWrite(path.join(STATE_DIR, 'last-run.json'), JSON.stringify(report, null, 1) + '\n');
console.log(`完成:成功 ${report.ok.length},失败 ${report.failed.length}(明细 _state/last-run.json)`);
await closeSession();
process.exit(report.failed.length ? 1 : 0);
