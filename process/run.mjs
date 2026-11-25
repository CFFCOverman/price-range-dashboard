#!/usr/bin/env node
/**
 * process 入口:raw/ → derived/(价位、估值)→ handoff/(给 Research OS 的数据包)。
 *   node process/run.mjs [--symbols=NVDA-US,AMD-US]
 * 方法见 process/README.md;参数在 config/params.json § levels / valuation / handoff。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadParams, loadUniverse, RAW_DIR, DERIVED_DIR, HANDOFF_DIR } from '../collect/lib/config.mjs';
import { readCsvFile, rawFile, atomicWrite } from '../collect/lib/store.mjs';
import { marketDate } from '../collect/lib/clock.mjs';
import { buildLevels } from './levels.mjs';
import { buildValuation } from './valuation.mjs';
import { buildHandoff, symbolSummary, newsFeed, revisionReading, brokerChanges, shortReading, breadthSummary } from './handoff.mjs';

const params = loadParams(), universe = loadUniverse();
let asof = marketDate();   // 先用纽约日期;下面改成价格数据里最新的交易日(午夜后跑也不会标成第二天)
const only = (process.argv.find(a => a.startsWith('--symbols=')) || '').split('=')[1]?.split(',');
const read = (ds, name) => readCsvFile(rawFile(RAW_DIR, ds, name)).rows;
const writeJson = (f, o) => atomicWrite(f, JSON.stringify(o, null, 1) + '\n');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const summaries = {}, feedInputs = {}, priceDates = [];
for (const e of universe.filter(u => ['company', 'etf'].includes(u.kind) && (!only || only.includes(u.symbol)))) {
  const prices = read('prices', e.symbol);
  const spot = Number(prices.at(-1)?.close);
  if (!(spot > 0)) { console.log(`  ✘ ${e.symbol} 没有价格`); continue; }
  if (prices.at(-1)?.date) priceDates.push(prices.at(-1).date);
  const dir = path.join(RAW_DIR, 'options', e.symbol);
  let days = []; try { days = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort(); } catch {}
  const optAsof = days.at(-1)?.slice(0, 10);
  const valuation = read('valuation', e.symbol), brokers = read('targets', `${e.symbol} brokers`);
  const lv = buildLevels({ symbol: e.symbol, asof, spot, optAsof, prices, valuation, brokers,
    optRows: optAsof ? readCsvFile(path.join(dir, days.at(-1))).rows : [],
    prevOptRows: days.length > 1 ? readCsvFile(path.join(dir, days.at(-2))).rows : [] }, params.levels);
  writeJson(path.join(DERIVED_DIR, 'levels', `${e.symbol}.json`), lv);
  let va = null;
  if (e.kind === 'company') {
    va = buildValuation({ symbol: e.symbol, asof, spot, cons: read('consensus', e.symbol).at(-1),
      fy1Label: read('estimates', `${e.symbol} FY1`)[0]?.fiscal_period, valRows: valuation, prices, brokers }, params.valuation);
    writeJson(path.join(DERIVED_DIR, 'valuation', `${e.symbol}.json`), va);
  }
  summaries[e.symbol] = symbolSummary(lv, va);
  feedInputs[e.symbol] = { kind: e.kind, brokers };
  const v = va?.applicable ? `估值 ${va.range.bear}/${va.range.base}/${va.range.bull}` : va ? `估值不适用:${va.reason}` : '';
  console.log(`  ✔ ${e.symbol} 现价 ${spot} · ${lv.levels.length} 个价位 · ${lv.zones.filter(z => z.confluence).length} 个共振区 · ${v}`);
}
if (priceDates.length) asof = priceDates.sort().at(-1);
if (!only) {
  const latestFile = path.join(HANDOFF_DIR, 'latest.json');
  const prev = readJson(latestFile);
  // 基准 = asof 早于本包的最近一份(同日重算时用 previous.json;asof 不早于本包的一律不当基准)
  const prevFile = path.join(HANDOFF_DIR, 'previous.json');
  const older = [prev, readJson(prevFile)].filter(x => x?.asof && x.asof < asof).sort((x, y) => y.asof.localeCompare(x.asof));
  const base = older[0] || null;
  const H = params.handoff;
  const since = base?.asof || new Date(Date.parse(asof + 'T12:00:00Z') - H.news_first_days * 864e5).toISOString().slice(0, 10);
  const feeds = {};
  for (const [sym, fi] of Object.entries(feedInputs)) {
    const f = { news: newsFeed(read('news', sym), { since, prevIds: (base?.feeds?.[sym]?.news || []).map(n => n.id), max: H.news_max_per_symbol, chars: H.news_summary_chars }) };
    if (fi.kind === 'company') {
      f.revisions = revisionReading(read('consensus', sym).at(-1));
      f.broker_changes = brokerChanges(fi.brokers, since);
      f.short = shortReading(read('ownership', sym));
    }
    feeds[sym] = f;
  }
  const breadth = {};
  for (const g of [...new Set(universe.map(u => u.breadth).filter(Boolean))]) { const b = breadthSummary(read('breadth', g)); if (b) breadth[g] = b; }
  const h = buildHandoff({ asof, symbols: summaries, prev: base, minPct: H.min_change_pct, feeds, breadth, P: H, schema: H.schema });
  if (prev?.id === h.id) console.log(`交接数据包内容未变(编号 ${h.id}),不重写`);
  else {
    if (prev?.asof && prev.asof < asof) writeJson(prevFile, prev);
    writeJson(path.join(HANDOFF_DIR, `${asof}.json`), h); writeJson(latestFile, h);
    console.log(`交接数据包 ${h.id}(${h.schema}):${Object.keys(summaries).length} 只,${h.changes.length} 条变化,新闻 ${Object.values(feeds).reduce((s, f) => s + f.news.length, 0)} 条 → handoff/latest.json`);
  }
}
