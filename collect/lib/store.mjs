/** raw/ 与 _state/ 的读写。纯函数(parseCsv/toCsv/mergeRows)可自检;落盘一律原子替换。 */
import fs from 'node:fs';
import path from 'node:path';

export function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
/** CSV 文本 → {header, rows:[{col:value}]};支持引号内换行 */
export function parseCsv(text) {
  const recs = []; let cur = '', q = false;
  for (const line of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    cur = cur ? cur + '\n' + line : line;
    q = (cur.match(/"/g) || []).length % 2 === 1;
    if (!q) { if (cur.trim()) recs.push(cur); cur = ''; }
  }
  const header = recs.length ? splitCsvLine(recs.shift()).map(s => s.trim()) : [];
  return { header, rows: recs.map(l => { const c = splitCsvLine(l); return Object.fromEntries(header.map((h, i) => [h, c[i] ?? ''])); }) };
}
export function csvCell(v) {
  if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** 压平型单元格:换行与连续空白并成一个空格(旧 fetcher 各报表 csv 的写法,news/earnings/company-intel 共用) */
export function csvFlat(v) {
  const t = String(v ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return /[",]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
export function toCsv(header, rows) {
  return header.join(',') + '\n' + rows.map(r => header.map(h => csvCell(r[h])).join(',')).join('\n') + (rows.length ? '\n' : '');
}
/** 按 key 合并:新行覆盖同 key 旧行,其余旧行保留;按 key 升序 */
export function mergeRows(oldRows, newRows, keyOf) {
  const m = new Map();
  for (const r of oldRows) m.set(keyOf(r), r);
  for (const r of newRows) m.set(keyOf(r), { ...(m.get(keyOf(r)) || {}), ...r });
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(e => e[1]);
}

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.pending-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
export function readCsvFile(file) {
  try { return parseCsv(fs.readFileSync(file, 'utf8')); } catch { return { header: [], rows: [] }; }
}

/** raw/<dataset>/<name>.csv —— name 通常是代码,如 NVDA-US 或 "NVDA-US FY1" */
export const rawFile = (rawDir, dataset, name) => path.join(rawDir, dataset, `${name}.csv`);

/** 整表替换(源头本身就带全量历史,如 Estimate History) */
export function replaceCsv(file, header, rows) { atomicWrite(file, toCsv(header, rows)); return rows.length; }
/** 追加/合并(源头只给当天或一段窗口,历史靠我们攒) */
export function upsertCsv(file, header, rows, keyOf) {
  const old = readCsvFile(file);
  const merged = mergeRows(old.rows, rows, keyOf);
  const cols = [...new Set([...header, ...old.header])];
  atomicWrite(file, toCsv(cols, merged));
  return { total: merged.length, added: merged.length - old.rows.length };
}

/** _state/collect.json:{ "<dataset>|<symbol>": {ok_at, err_at, err, rows} } */
export function loadState(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'collect.json'), 'utf8')); } catch { return {}; }
}
export function saveState(stateDir, state) { atomicWrite(path.join(stateDir, 'collect.json'), JSON.stringify(state, null, 1) + '\n'); }
