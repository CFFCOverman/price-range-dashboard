/** 路径与站点常量的唯一出处(重构 R3)。旧 fetcher/lib/config.mjs 从这里取 OUT_DIR / PROFILE / BASE。
 *
 * 数据目录优先级:FS_OUT 环境变量 > config/assets-path.txt > fetcher/assets-path.txt(迁移期兼容)> <repo>/Assets
 * assets-path.txt 只写一行绝对路径(# 开头为注释);每台电脑不同,不进 git。写了却找不到目录(云盘没挂载)
 * 直接报错,绝不悄悄退回仓库内的 Assets/ —— 否则数据分叉成两份。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const ASSETS_PATH_FILES = [path.join(CONFIG_DIR, 'assets-path.txt'), path.join(ROOT, 'fetcher', 'assets-path.txt')];

export function resolveOutDir(env = process.env, files = ASSETS_PATH_FILES) {
  if (env.FS_OUT) return env.FS_OUT;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const line = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
    if (!line) continue;
    const dir = path.resolve(line.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.existsSync(dir)) throw new Error(`${path.relative(ROOT, f)} 指向的数据目录不存在: ${dir}\n  请确认 Google Drive 已登录、云盘已挂载,或改正该文件。`);
    return dir;
  }
  return path.join(ROOT, 'Assets');
}
export const OUT_DIR = resolveOutDir();
export const RAW_DIR = path.join(OUT_DIR, 'raw');
export const STATE_DIR = path.join(OUT_DIR, '_state');

export const BASE = 'https://my.apps.factset.com';
export const PROFILE = path.join(os.homedir(), '.factset-bot-profile');   // 独立浏览器 profile,保存登录态;不要删
