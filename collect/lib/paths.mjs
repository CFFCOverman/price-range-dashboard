/** 路径与站点常量的唯一出处。
 *
 * 数据目录优先级:FS_OUT 环境变量 > config/assets-path.txt > 自动识别的 Google Drive 位置 > <repo>/Assets
 * assets-path.txt 每行一个候选绝对路径(# 开头为注释),取第一个存在的;每台电脑不同,不进 git。
 * 写了却一个都找不到(云盘没挂载)直接报错,绝不悄悄退回仓库内的 Assets/ —— 否则数据分叉成两份。
 * 没有 assets-path.txt 时按操作系统找 Google Drive 桌面版的标准位置(DRIVE_CANDIDATES),都找不到才用仓库内 Assets/。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const ASSETS_PATH_FILES = [path.join(CONFIG_DIR, 'assets-path.txt')];
export const DRIVE_SUBDIR = ['PriceRangeDashboard', 'Assets'];   // 云盘「我的云端硬盘」下的数据目录

/** Google Drive 桌面版的标准挂载位置:Windows 为盘符 G:;macOS 在 ~/Library/CloudStorage/GoogleDrive-<账号>/ 下 */
export function driveCandidates(platform = process.platform, home = os.homedir()) {
  const mine = ['My Drive', '我的云端硬盘'];
  if (platform === 'win32') return mine.map(m => path.win32.join('G:\\', m, ...DRIVE_SUBDIR));
  if (platform === 'darwin') {
    const cs = path.join(home, 'Library', 'CloudStorage');
    let accts = []; try { accts = fs.readdirSync(cs).filter(d => d.startsWith('GoogleDrive-')).sort(); } catch {}
    return accts.flatMap(a => mine.map(m => path.join(cs, a, m, ...DRIVE_SUBDIR)));
  }
  return [];
}
export function resolveOutDir(env = process.env, files = ASSETS_PATH_FILES, auto = driveCandidates()) {
  if (env.FS_OUT) return env.FS_OUT;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    if (!lines.length) continue;
    const dirs = lines.map(l => path.resolve(l.replace(/^~(?=$|[\\/])/, os.homedir())));
    const hit = dirs.find(d => fs.existsSync(d));
    if (!hit) throw new Error(`${path.relative(ROOT, f)} 里的数据目录都不存在:\n  ${dirs.join('\n  ')}\n  请确认 Google Drive 已登录、云盘已挂载,或改正该文件。`);
    return hit;
  }
  const found = auto.find(d => fs.existsSync(d));
  return found || path.join(ROOT, 'Assets');
}
export const OUT_DIR = resolveOutDir();
export const RAW_DIR = path.join(OUT_DIR, 'raw');
export const LIVE_CONFIG_DIR = path.join(OUT_DIR, 'config');   // 标的清单的现行版本放 G 盘,换机器跟着走;仓库里只有种子
export const DERIVED_DIR = path.join(OUT_DIR, 'derived');
export const HANDOFF_DIR = path.join(OUT_DIR, 'handoff');
export const STATE_DIR = path.join(OUT_DIR, '_state');

export const BASE = 'https://my.apps.factset.com';
export const PROFILE = path.join(os.homedir(), '.factset-bot-profile');   // 独立浏览器 profile,保存登录态;不要删
