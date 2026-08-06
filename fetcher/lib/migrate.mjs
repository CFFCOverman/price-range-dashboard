/* lib/migrate.mjs — 一次性搬家:把旧位置的文件挪到新位置
 *
 * 为什么需要它:v16 把单文件脚本拆成 lib/ + steps/ 之后,原来的 SCRIPT_DIR 从 fetcher/
 * 变成了 fetcher/lib/,于是那一轮的产出全部下沉了一层(fetcher/Assets、fetcher/lib/sources.txt、
 * fetcher/lib/tickers.txt ...)。这些是真数据,不能扔,所以开跑前先把它们接回来。
 * v16.2 又把 Assets 改成按类型分子目录,平铺的老文件也在这里一并归位。
 *
 * 全程幂等:搬完再跑什么也不会发生。同名冲突保留**较新**的那份,
 * 输的那份**不删除**,而是挪进仓库根目录的 `_to_delete/`(已在 .gitignore 里)——
 * 这是别人辛苦拉下来的授权数据,由脚本替他做"永久删除"的决定不合适;
 * 顺带这条路径不依赖删除权限,在只读挂载/受限文件系统上也能跑完。
 */

import fs from 'node:fs';
import path from 'node:path';
import { FETCHER_DIR, LIB_DIR, LOG_DIR, OUT_DIR, ROOT_DIR, assetPath, ensureAssetDirs } from './config.mjs';
import { SELFTEST_ARTIFACTS } from './selftest-env.mjs';

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return -1; } };

/** 把一个多余的文件挪进 _to_delete/(重名就加序号),绝不真删。
 *  导出是给 roster.mjs 的落榜清理用的 —— "挪不删"这条规矩只该有一个实现,
 *  另写一份迟早会有一份忘了加序号,然后同名文件互相盖掉。 */
export function retire(p) {
  try {
    const bin = path.join(ROOT_DIR, '_to_delete');
    fs.mkdirSync(bin, { recursive: true });
    const ext = path.extname(p), stem = path.basename(p, ext);
    let dest = path.join(bin, stem + ext);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(bin, `${stem} (${i})${ext}`);
    fs.renameSync(p, dest);
    return true;
  } catch { return false; }
}

/** 只在目标不存在时用的裸搬运:先 rename,跨盘符再退回复制 */
function rawMove(from, to) {
  try { fs.renameSync(from, to); return true; } catch {}
  try { fs.copyFileSync(from, to); retire(from); return true; } catch { return false; }
}

/* 搬一个文件。三种情况,分开写——上一版把它们糅在一个 try 里,
 * 结果"目标更新"分支里的删除一旦失败就掉进 catch 的复制兜底,
 * 拿旧文件盖掉了新文件。同一段代码既判断谁该赢又负责兜底,是这类错的根源。 */
function moveFile(from, to) {
  if (from === to || !isFile(from)) return false;
  try { fs.mkdirSync(path.dirname(to), { recursive: true }); } catch { return false; }
  if (!isFile(to)) return rawMove(from, to);            // 目标不存在:直接搬
  if (mtime(from) <= mtime(to)) { retire(from); return false; }  // 目标更新:源是多余的那份
  return retire(to) && rawMove(from, to);               // 源更新:先把旧的请出去,再搬进来
}

/** 目录空了就删掉,免得留一堆空壳误导人 */
function rmdirIfEmpty(dir) {
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
}

/** 把一个目录里平铺的数据文件按类型归进子目录 */
function foldFlatFiles(dir) {
  let n = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (moveFile(path.join(dir, e.name), assetPath(e.name))) n++;
  }
  return n;
}

/**
 * 执行迁移。返回一段可打印的说明(没搬东西就返回空串,正常情况下你永远看不到它)。
 */
export function migrateLegacyLayout() {
  ensureAssetDirs();
  const notes = [];

  /* 1) v16 误建的 fetcher/Assets —— 那一轮真正抓到的数据在里面 */
  const strayAssets = path.join(FETCHER_DIR, 'Assets');
  if (strayAssets !== OUT_DIR && fs.existsSync(strayAssets)) {
    const n = foldFlatFiles(strayAssets);
    for (const sub of (() => { try { return fs.readdirSync(strayAssets, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return []; } })()) {
      foldFlatFiles(path.join(strayAssets, sub.name));
      rmdirIfEmpty(path.join(strayAssets, sub.name));
    }
    rmdirIfEmpty(strayAssets);
    if (n) notes.push(`fetcher/Assets/ 里的 ${n} 个文件已归位到 Assets/`);
  }

  /* 2) 配置文件被带进了 lib/ */
  for (const name of ['tickers.txt', 'tickers.json', 'markets.txt', '.options-url']) {
    if (moveFile(path.join(LIB_DIR, name), path.join(FETCHER_DIR, name))) notes.push(`fetcher/lib/${name} → fetcher/${name}`);
  }

  /* 3) 台账改放 Assets/_logs/ */
  for (const from of [path.join(LIB_DIR, 'sources.txt'), path.join(FETCHER_DIR, 'sources.txt')]) {
    if (moveFile(from, path.join(LOG_DIR, 'sources.txt'))) notes.push(`${path.basename(path.dirname(from))}/sources.txt → Assets/_logs/sources.txt`);
  }

  /* 4) Assets 根下平铺的老文件按类型归位 */
  const n = foldFlatFiles(OUT_DIR);
  if (n) notes.push(`Assets/ 下 ${n} 个文件已按类型归入子目录`);

  /* 5) 自检当年写进真实 Assets/ 的测试文件。
   * 它们是 --selftest 通过 assetPath() 落下的(TEST-US 的两个 xlsx + 三个 _selftest 量能样本),
   * 现在自检已改写到临时目录,但历史遗留还在盘上。留着不只是脏:
   * "清单与数据对齐"会如实报告 TEST-US 是"你拉过却没登记的标的",然后把它补进清单,
   * 于是往后每一轮都要为一家不存在的公司白跑 8 步。每一步都对,合起来是错的。 */
  let junk = 0;
  for (const name of SELFTEST_ARTIFACTS) {
    const p = assetPath(name);
    if (isFile(p) && retire(p)) junk++;
  }
  if (junk) notes.push(`自检遗留的 ${junk} 个测试文件已移出 Assets/`);

  if (!notes.length) return '';
  const bin = path.join(ROOT_DIR, '_to_delete');
  let retired = 0;
  try { retired = fs.readdirSync(bin).length; } catch {}
  if (retired) notes.push(`重复的旧文件 ${retired} 个已挪进 _to_delete/(没删,确认后自行清空)`);
  return '  · 目录迁移:' + notes.join(';');
}
