/** collect 的配置入口:参数与标的清单各只有一个来源(config/params.json、config/universe.csv);路径见 ./paths.mjs。 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { parseCsv } from './store.mjs';
export { ROOT, OUT_DIR, RAW_DIR, STATE_DIR } from './paths.mjs';

export const PARAMS_FILE = path.join(CONFIG_DIR, 'params.json');
export const UNIVERSE_FILE = path.join(CONFIG_DIR, 'universe.csv');

export function loadParams(file = PARAMS_FILE) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** universe.csv → [{symbol, kind, name, group, scale, breadth}];scale 空 = 1;# 开头的行是注释 */
export function loadUniverse(file = UNIVERSE_FILE) {
  return parseCsv(fs.readFileSync(file, 'utf8')).rows
    .filter(r => r.symbol && !r.symbol.startsWith('#'))
    .map(r => ({ ...r, symbol: r.symbol.trim().toUpperCase(), scale: Number(r.scale) || 1 }));
}
