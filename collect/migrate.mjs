#!/usr/bin/env node
/**
 * 一次性迁移:把旧 Assets 布局里**只有我们自己攒下、源头补不回来**的历史并进 raw/。可重复运行(只合并,不删旧文件)。
 *   options/<T> Options.csv              → raw/options/<T>.csv     (OI 快照,源头只给当天)
 *   valuation/<T> NTM Valuation History  → raw/valuation/<T>.csv   (作缓存,省得 collect 首跑重拉 10 年)
 *   summary/short-interest.csv           → raw/ownership/<T>.csv   (空头天数/占比的日记录)
 *   news/<T> News.csv                    → raw/news/<T>.csv        (旧版只有日期+标题,id 记为 legacy:…)
 * 不迁:charting(收盘+成交量,FQL 5 年日线已覆盖)、estimates/targets xlsx(接口自带历史)、earnings/company-intel(下次重拉)。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OUT_DIR, RAW_DIR, STATE_DIR } from './lib/config.mjs';
import { readCsvFile, upsertCsv, rawFile, atomicWrite } from './lib/store.mjs';
import { NEWS_COLS } from './datasets/news.mjs';
import { OWNERSHIP_COLS } from './datasets/report-json.mjs';

const MARK = path.join(STATE_DIR, 'migrated.json');
if (fs.existsSync(MARK) && !process.argv.includes('--again')) { console.log('已迁移过(' + MARK + '),跳过;要重来加 --again'); process.exit(0); }
const old = (...p) => path.join(OUT_DIR, ...p);
const list = (dir, re) => { try { return fs.readdirSync(old(dir)).map(f => re.exec(f)).filter(Boolean); } catch { return []; } };
const file = (ds, name) => rawFile(RAW_DIR, ds, name);
const done = [];

for (const m of list('options', /^(.+-[A-Z]{2}) Options\.csv$/)) {
  const src = readCsvFile(old('options', m[0]));
  const r = upsertCsv(file('options', m[1]), src.header, src.rows, x => `${x.asof}|${x.expiry}|${x.strike}`);
  done.push(`options ${m[1]} ${r.total}`);
}
for (const m of list('valuation', /^(.+-[A-Z]{2}) NTM Valuation History\.csv$/)) {
  const src = readCsvFile(old('valuation', m[0]));
  const r = upsertCsv(file('valuation', m[1]), src.header, src.rows, x => x.date);
  done.push(`valuation ${m[1]} ${r.total}`);
}
{
  const by = {};
  for (const x of readCsvFile(old('summary', 'short-interest.csv')).rows) (by[x.ticker] ||= []).push({ date: x.date, short_days: x.days_to_cover, short_pct_float: x.pct_of_float });
  for (const [t, rows] of Object.entries(by)) done.push(`ownership ${t} ${upsertCsv(file('ownership', t), OWNERSHIP_COLS, rows, x => x.date).total}`);
}
for (const m of list('news', /^(.+-[A-Z]{2}) News\.csv$/)) {
  const rows = readCsvFile(old('news', m[0])).rows.filter(x => x.date && x.headline).map(x => ({
    id: 'legacy:' + crypto.createHash('sha1').update(x.date + '|' + x.headline).digest('hex').slice(0, 12),
    datetime: x.date, headline: x.headline, subjects: '', primary_symbols: (x.ids || '').replace(/\s+/g, ''), body: '' }));
  done.push(`news ${m[1]} ${upsertCsv(file('news', m[1]), NEWS_COLS, rows, x => x.id).total}`);
}
atomicWrite(MARK, JSON.stringify({ at: new Date().toISOString(), done }, null, 1) + '\n');
console.log(`迁移到 ${RAW_DIR}:\n  ` + done.join('\n  '));
