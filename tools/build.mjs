#!/usr/bin/env node
/* ============================================================================
 * build.mjs — 把 src/ 下的模块拼回零依赖单文件 HTML
 *
 * 为什么是"拆开开发、拼回交付":
 *   仪表盘的两个硬约束决定了交付物必须是单文件——
 *   (1) 直接双击打开(file:// 协议下 ES module import 会被 CORS 拦掉);
 *   (2) GitHub Pages 静态托管,不引入任何构建产物依赖。
 *   同时脚本必须是**单个非 IIFE 的 <script>**:test-app.mjs 用 page.evaluate
 *   直接调用顶层的 calcRange / pressureLevels 等函数,一旦包进 IIFE 或改成
 *   module 作用域,断言就全部够不着了。
 *   所以这里只做"按 manifest 顺序拼接",不做任何打包/转译/改写。
 *
 * 用法:
 *   node tools/build.mjs           构建并写出 manifest.outputs
 *   node tools/build.mjs --check   只校验产物是否与 src/ 同步(CI / 测试用)
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'src', 'manifest.json');
const STYLE_MARK = '/*@build:styles*/';
const SCRIPT_MARK = '/*@build:scripts*/';

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 只吃掉文件末尾那一个换行符(而不是所有空行):模块之间原本用空行分隔,
 * 保留它才能让产物与拆分前的单文件**逐字节相同**——这是这次重构唯一可信的验收证据。 */
const join = files => files.map(f => read(f).replace(/\n$/, '')).join('\n');

export function build() {
  const m = JSON.parse(read('src/manifest.json'));
  const shell = read(m.shell);
  for (const [mark, what] of [[STYLE_MARK, '样式'], [SCRIPT_MARK, '脚本']]) {
    if (!shell.includes(mark)) throw new Error(`外壳 ${m.shell} 缺少${what}占位符 ${mark}`);
  }
  const out = shell
    .replace(STYLE_MARK, () => join(m.styles))
    .replace(SCRIPT_MARK, () => join(m.scripts));

  /* 单文件交付的底线:恰好一个 <script>,且不能被包成 IIFE/module */
  const nScript = (out.match(/<script>/g) || []).length;
  if (nScript !== 1) throw new Error(`产物应恰好含 1 个 <script>,实得 ${nScript}`);
  if (/<script[^>]+type=["']module/.test(out)) throw new Error('产物中出现了 type=module,顶层函数将不可见');

  return { manifest: m, out };
}

function main() {
  const check = process.argv.includes('--check');
  const { manifest, out } = build();
  const stale = [];
  for (const rel of manifest.outputs) {
    const abs = path.join(ROOT, rel);
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (cur === out) continue;
    stale.push(rel);
    if (!check) fs.writeFileSync(abs, out);
  }
  const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
  if (check) {
    if (stale.length) {
      console.error(`✗ 产物与 src/ 不同步: ${stale.join(', ')}`);
      console.error('  改完 src/ 请先跑 node tools/build.mjs 再提交。');
      process.exit(1);
    }
    console.log(`✓ 产物与 src/ 同步(${manifest.scripts.length} 个 JS 模块 / ${manifest.styles.length} 个 CSS 模块,${kb} KB)`);
  } else {
    console.log(stale.length ? `✓ 已更新: ${stale.join(', ')} (${kb} KB)` : `✓ 产物已是最新 (${kb} KB)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
