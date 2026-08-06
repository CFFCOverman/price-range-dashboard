/* lib/config.mjs — 路径、环境变量、全局开关
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 *
 * 路径全部从"这个文件在哪"往外推。拆模块之后本文件从 fetcher/ 掉到了 fetcher/lib/,
 * 所以这里**不再导出 SCRIPT_DIR** —— 那个名字不说明自己是哪一层,谁用谁错一层。
 * 要用就用下面三个说得清楚的:LIB_DIR < FETCHER_DIR < ROOT_DIR。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ================= 配置 =================
export const TICKERS_DEFAULT = ['NVDA-US', 'GOOGL-US'];  // 首次默认;之后以 tickers.txt 为准

/* ---- 三层目录锚点 ---- */
export const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));   // <repo>/fetcher/lib
export const FETCHER_DIR = path.resolve(LIB_DIR, '..');                // <repo>/fetcher
export const ROOT_DIR = path.resolve(FETCHER_DIR, '..');               // <repo>

/* 数据落在仓库根的 Assets/ —— 整个项目文件夹可整体搬迁/克隆,零改动可用;FS_OUT 环境变量可覆盖 */
export const OUT_DIR = process.env.FS_OUT || path.join(ROOT_DIR, 'Assets');
export const LOG_DIR = path.join(OUT_DIR, '_logs');   // 台账与跑批日志:脚本产出的东西都在 Assets 下面,一条 .gitignore 全包住

/* 配置文件跟着 fetcher/ 走(它们是"你要改的东西",不是数据) */
export const TICKERS_FILE = path.join(FETCHER_DIR, 'tickers.txt');   // 一行一个代码,# 开头为注释,记事本随时可改
export const TICKERS_JSON_OLD = path.join(FETCHER_DIR, 'tickers.json');
export const MARKETS_FILE = path.join(FETCHER_DIR, 'markets.txt');   // 市场级序列(只拉日线):SYMBOL 角色

export const APP_HTML = ['price-range-dashboard.html', 'index.html']
  .map(f => path.join(ROOT_DIR, f)).find(f => { try { return fs.existsSync(f); } catch { return false; } })
  || path.join(ROOT_DIR, 'price-range-dashboard.html');

/* ---- Assets 下按数据类型分子目录 ----
 * 分目录只为"人看得清",不改变导入语义:仪表盘的文件夹扫描本来就往下钻 3 层,
 * 且是按**文件名**认数据种类的,所以文件放在哪一层都一样能被认出来。
 * 归类规则只认文件名,因此写入、读回、体检、迁移共用同一个函数,不可能各走各的。 */
export const ASSET_RULES = [
  ['estimates', /Estimate History\.xlsx$/i],           // <代码> FY1/FY2/FY3 Estimate History.xlsx
  ['charting', /Charting\.xlsx$/i],                    // <代码> Daily Charting.xlsx / _MARKET-* 同款
  ['targets', /Targets Ratings\.xlsx$/i],              // <代码> Targets Ratings.xlsx
  ['news', /News\.csv$/i],                             // <代码> News.csv
  ['options', /Options\.csv$/i],                       // <代码> Options.csv
  ['summary', /^(companies|short-interest|roster)\.csv$/i],   // 汇总与逐轮累积(roster = 给仪表盘看的拉取清单)
];
export const ASSET_DIRS = [...ASSET_RULES.map(r => r[0]), 'misc'];
/** 文件名 → 子目录名。认不出的(比如你手动丢进来的 Snapshot/Price Summary)统一进 misc/,照样能被仪表盘读到 */
export function assetSubdir(file) {
  const name = path.basename(String(file || ''));
  for (const [dir, re] of ASSET_RULES) if (re.test(name)) return dir;
  return 'misc';
}
/** 文件名 → 完整落盘路径。**所有**读写都走这里,别再自己 path.join(OUT_DIR, ...) */
export function assetPath(file) { return path.join(OUT_DIR, assetSubdir(path.basename(String(file || ''))), path.basename(String(file || ''))); }
/** 建目录(幂等)。分目录必须先存在,否则第一次写入会 ENOENT */
export function ensureAssetDirs() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const d of ASSET_DIRS) fs.mkdirSync(path.join(OUT_DIR, d), { recursive: true });
  } catch {}
}

/* 成交量:仪表盘的压力位在有量时用真实筹码分布,无量时退回停留时间口径。
 * 设 FS_NO_VOLUME=1 可关掉尝试(比如你的图表布局被脚本点乱过,想先手动摆好)。 */
export const WANT_VOLUME = process.env.FS_NO_VOLUME !== '1';
export const volState = new Map();   // 文件名 -> 该轮导出里是否真的含成交量列

/* 时间跨度与 K 线:和成交量是**同一类**东西 —— 它们都不是下载按钮的属性,
 * 而是你 FactSet 账号里那张保存好的图表布局的属性。所以开关也放在一起,写法照抄上面那两行。
 * 一年 252 根日线是眼下所有验收数字的天花板:h=63 的回测只剩约 10 个独立聚类样本,
 * 再精巧的统计也变不出第 11 个;拉到 5 年这件事的价值全在这里,不在图好不好看。
 * 设 FS_NO_5Y=1 / FS_NO_OHLC=1 可分别关掉尝试(比如你已经手动摆好布局,不想让脚本再去点它)。 */
export const WANT_5Y = process.env.FS_NO_5Y !== '1';
export const WANT_OHLC = process.env.FS_NO_OHLC !== '1';
export const WANT_YEARS = 5;         // 期望跨度(年);判定时留半年余量,见 steps/charting.mjs 的 spanOK
/* 这里**没有** spanState / ohlcState:volState 建出来之后其实没有任何人读它,
 * 体检(lib/health.mjs)是直接去磁盘上重算的 —— 因为"上一轮内存里记的"和"文件现在是什么样"
 * 本来就该以后者为准。再照着建两个只写不读的 Map 只是把一处冗余抄成三处。 */
export const PROFILE = path.join(os.homedir(), '.factset-bot-profile');   // 独立浏览器 profile(保存登录态)
export const BASE = 'https://my.apps.factset.com';
export const LOGIN_ONLY = process.argv.includes('--login');
export const HEADLESS = false;                            // FactSet 登录/SSO 建议始终有头运行
// ========================================
