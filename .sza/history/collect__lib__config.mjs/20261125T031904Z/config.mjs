/** collect 的配置入口:参数与标的清单各只有一个来源(config/params.json、config/universe.csv),这里只负责读。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_DIR } from '../../fetcher/lib/config.mjs';
import { parseCsv } from './store.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PARAMS_FILE = path.join(ROOT, 'config', 'params.json');
export const UNIVERSE_FILE = path.join(ROOT, 'config', 'universe.csv');
export const RAW_DIR = path.join(OUT_DIR, 'raw');
export const STATE_DIR = path.join(OUT_DIR, '_state');
export { OUT_DIR };

export function loadParams(file = PARAMS_FILE) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** universe.csv → [{symbol, kind, name, group, scale}];scale 空 = 1 */
export function loadUniverse(file = UNIVERSE_FILE) {
  return parseCsv(fs.readFileSync(file, 'utf8')).rows
    .filter(r => r.symbol && !r.symbol.startsWith('#'))
    .map(r => ({ ...r, symbol: r.symbol.trim().toUpperCase(), scale: Number(r.scale) || 1 }));
}
