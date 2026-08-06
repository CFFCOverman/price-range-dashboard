#!/usr/bin/env node
/* tools/scratch/bat-lint.mjs —— .bat 静态检查(临时工具,不接 npm script)
 *
 * 为什么有这个文件:开发在 Linux 沙箱里,cmd.exe 一次都跑不了。setup.bat /
 * run-factset.bat 的正确性只能靠推演,而推演最容易漏的恰恰是"看不见"的几类问题:
 * 字节层面的(BOM、非 ASCII、LF)、跳转层面的(goto 到不存在的 label)、
 * 作用域层面的(FOR/IF 块里 set 完又用 %VAR% 读 —— 没开延迟展开时读到的是旧值)。
 * 这三类机器查得比人准,所以写下来。
 *
 * 用法:node tools/scratch/bat-lint.mjs [file.bat ...]
 * 不给参数就查 setup.bat 和 run-factset.bat。
 * 有 ERROR 退 1,只有 WARN 退 0。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = { red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', cyn: '\x1b[36m', dim: '\x1b[90m', off: '\x1b[0m' };

/* ---------- 小工具 ---------------------------------------------------- */

/* 一行的"有效命令部分":去掉行首空白和 @,判断它是不是注释 / echo。
 * echo 行要单独认出来:echo 后面的括号是字面文本,不参与块的括号配平,
 * 把它算进去会让整份文件的深度分析全错。 */
function classify(line) {
  const s = line.replace(/^[\s@]+/, '');
  if (/^rem\b/i.test(s) || s.startsWith('::')) return 'comment';
  if (/^echo\b/i.test(s) || /^echo\./i.test(s)) return 'echo';
  if (/^:[^:\s]/.test(s)) return 'label';
  return 'code';
}

/* 把不该被当成"变量读"的东西先抹掉:%%A(FOR 变量)、%~dp0(参数修饰)、
 * %1 %* (位置参数)。剩下的 %NAME% 才是真的读环境变量。 */
function readsOf(line) {
  const cleaned = line
    .replace(/%%[A-Za-z]/g, '')
    .replace(/%~[a-zA-Z$:]*[0-9]/g, '')
    .replace(/%[0-9*]/g, '');
  const out = [];
  for (const m of cleaned.matchAll(/%([A-Za-z_][^%\r\n]*?)%/g)) out.push(m[1].toLowerCase());
  return out;
}

function setsOf(line) {
  /* set "VAR=..." / set VAR=... / set /p "VAR=..." / set /a VAR=... */
  const m = line.match(/^\s*set\s+(?:\/[apAP]\s+)?"?([A-Za-z_][A-Za-z0-9_()#$'+,.\-]*)\s*=/);
  return m ? [m[1].toLowerCase()] : [];
}

/* 括号深度增量。只在 code 行上算,并且忽略引号里的括号和 ^ 转义的括号。 */
function parenDelta(line) {
  let d = 0, inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '^') { i++; continue; }
    if (ch === '"') { inQ = !inQ; continue; }
    if (inQ) continue;
    if (ch === '(') d++;
    else if (ch === ')') d--;
  }
  return d;
}

/* ---------- 各项检查 --------------------------------------------------- */

function lintBytes(buf, add) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    add('ERROR', 1, 'UTF-8 BOM:cmd.exe 会把 BOM 当成第一条命令的一部分,第一行直接报错');
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
    add('ERROR', 1, 'UTF-16 BOM:cmd.exe 完全读不了 UTF-16 的 .bat');

  let line = 1;
  const bad = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { line++; continue; }
    if (buf[i] > 0x7f) bad.push({ line, off: i, byte: buf[i] });
  }
  if (bad.length) {
    const head = bad.slice(0, 5).map(b => `L${b.line}@${b.off}=0x${b.byte.toString(16)}`).join(' ');
    add('ERROR', bad[0].line, `${bad.length} 个非 ASCII 字节(${head}${bad.length > 5 ? ' …' : ''}):.bat 按当时的控制台代码页解读,非 ASCII 一定会花`);
  }
}

function lintEol(buf, add) {
  const text = buf.toString('latin1');
  const lines = text.split('\n');
  const lastIsEmpty = lines[lines.length - 1] === '';
  const real = lastIsEmpty ? lines.slice(0, -1) : lines;
  const lfOnly = [];
  real.forEach((l, i) => { if (!l.endsWith('\r')) lfOnly.push(i + 1); });
  if (lfOnly.length)
    add('ERROR', lfOnly[0], `${lfOnly.length} 行是 LF 结尾(首个 L${lfOnly[0]}):多行 IF/FOR 块在 LF-only 的 .bat 里基本必坏`);
  if (!lastIsEmpty)
    add('WARN', real.length, '文件最后一行没有换行符:cmd 对最后一条命令的处理会变得看运气,补一个 CRLF');
  return real.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function lintLabels(lines, add) {
  const labels = new Map();  // name -> line
  const targets = [];        // {name, line, kind}

  lines.forEach((raw, i) => {
    const n = i + 1;
    const kind = classify(raw);
    if (kind === 'label') {
      const m = raw.replace(/^[\s@]+/, '').match(/^:([^\s:+,;=]+)/);
      if (m && !labels.has(m[1].toLowerCase())) labels.set(m[1].toLowerCase(), n);
      return;
    }
    if (kind === 'comment' || kind === 'echo') return;
    for (const m of raw.matchAll(/\bgoto\s*:?\s*([^\s&|)<>"]+)/gi)) targets.push({ name: m[1].toLowerCase(), line: n, kind: 'goto' });
    for (const m of raw.matchAll(/\bcall\s+:([^\s&|)<>"]+)/gi)) targets.push({ name: m[1].toLowerCase(), line: n, kind: 'call' });
  });

  for (const t of targets) {
    if (t.name === 'eof') continue;                 // goto :eof 是内建的
    if (!labels.has(t.name))
      add('ERROR', t.line, `${t.kind} :${t.name} —— 文件里没有这个 label,cmd 会报 "系统找不到指定的批标签" 然后直接结束脚本`);
  }

  /* 可达性:被 goto/call 指到,或者从上一条语句顺着掉下来。 */
  const targeted = new Set(targets.map(t => t.name));
  const entry = new Map(); // label -> Set of ways in
  let flow = true;         // 上一条语句执行完还会不会往下走
  lines.forEach((raw, i) => {
    /* 空行和注释既不执行也不切断顺序流,直接跳过 —— 把它们当语句会让
     * "上一条语句还会不会往下走"这个判断全错(goto 后面隔一个空行就失效了)。 */
    if (!raw.trim()) return;
    const kind = classify(raw);
    if (kind === 'label') {
      const m = raw.replace(/^[\s@]+/, '').match(/^:([^\s:+,;=]+)/);
      if (m) {
        const name = m[1].toLowerCase();
        const ways = new Set();
        if (flow) ways.add('fallthrough');
        if (targeted.has(name)) ways.add('jump');
        entry.set(name, ways);
        flow = true; // label 之后总是可以往下执行
      }
      return;
    }
    if (kind === 'comment') return;
    if (kind === 'echo') { flow = true; return; }
    const s = raw.replace(/^[\s@]+/, '');
    /* 无条件转移才切断顺序流;if ... goto 之类前面有条件的不算 */
    if (/^(goto\b|exit\b)/i.test(s)) flow = false; else flow = true;
    void i;
  });

  for (const [name, ways] of entry) {
    if (ways.size === 0)
      add('WARN', labels.get(name), `:${name} 定义了但谁也到不了(没有 goto/call 指它,上一条语句也不会掉下来)`);
    else if (ways.has('fallthrough') && ways.has('jump'))
      add('NOTE', labels.get(name), `:${name} 既能被跳进来、也能从上一条语句掉进来 —— 确认这个贯穿是故意的`);
    else if (ways.has('fallthrough') && !ways.has('jump'))
      add('NOTE', labels.get(name), `:${name} 只靠贯穿进入(没人 goto 它),那它更像一段普通代码而不是 label`);
  }
}

/* 延迟展开陷阱:在同一个括号块里 set 了 VAR,又在这个块里用 %VAR% 读。
 * 没开 EnableDelayedExpansion 时,整个块的 %VAR% 在**进块之前**就一次性展开完了,
 * 读到的是块外的旧值 —— 这是 cmd 里最安静、最难查的一类错。 */
function lintDelayed(lines, add) {
  const hasDelayed = lines.some(l => /setlocal\s+.*enabledelayedexpansion/i.test(l));
  const stack = []; // [{startLine, sets:Map<name,line>}]
  lines.forEach((raw, i) => {
    const n = i + 1;
    const kind = classify(raw);
    if (kind === 'comment') return;

    if (stack.length) {
      for (const name of readsOf(raw)) {
        for (const f of stack) {
          if (f.sets.has(name))
            add(hasDelayed ? 'NOTE' : 'ERROR', n,
              `块内(L${f.startLine} 开的括号)先 set 了 ${name.toUpperCase()}(L${f.sets.get(name)})又用 %${name.toUpperCase()}% 读它${hasDelayed ? ';文件开了延迟展开,确认这里用的是 ! 不是 %' : ' —— 没开延迟展开,读到的是进块前的旧值'}`);
        }
      }
    }
    if (kind !== 'echo') {
      const d = parenDelta(raw);
      if (stack.length) for (const name of setsOf(raw)) if (!stack[stack.length - 1].sets.has(name)) stack[stack.length - 1].sets.set(name, n);
      for (let k = 0; k < d; k++) stack.push({ startLine: n, sets: new Map() });
      for (let k = 0; k < -d; k++) stack.pop();
    } else if (stack.length) {
      for (const name of setsOf(raw)) if (!stack[stack.length - 1].sets.has(name)) stack[stack.length - 1].sets.set(name, n);
    }
  });
  if (stack.length) add('ERROR', stack[0].startLine, `括号没配平:L${stack[0].startLine} 开的 ( 到文件结束都没关`);
}

/* ---------- 主流程 ------------------------------------------------------ */

function lintFile(file) {
  const buf = fs.readFileSync(file);
  const found = [];
  const add = (level, line, msg) => found.push({ level, line, msg });

  lintBytes(buf, add);
  const lines = lintEol(buf, add);
  lintLabels(lines, add);
  lintDelayed(lines, add);

  found.sort((a, b) => (a.line - b.line) || a.level.localeCompare(b.level));
  const nErr = found.filter(f => f.level === 'ERROR').length;
  const nWarn = found.filter(f => f.level === 'WARN').length;

  const r = path.relative(ROOT, file);
  const rel = (!r || r.startsWith('..')) ? file : r;
  console.log(`\n${C.cyn}${rel}${C.off} ${C.dim}(${lines.length} 行, ${buf.length} 字节)${C.off}`);
  if (!found.length) console.log(`  ${C.grn}✓${C.off} 干净:字节、换行、跳转、块作用域四项都没话说`);
  for (const f of found) {
    const col = f.level === 'ERROR' ? C.red : f.level === 'WARN' ? C.yel : C.dim;
    console.log(`  ${col}${f.level.padEnd(5)}${C.off} L${String(f.line).padEnd(4)} ${f.msg}`);
  }
  return { nErr, nWarn };
}

const argv = process.argv.slice(2);
const files = (argv.length ? argv : ['setup.bat', 'run-factset.bat']).map(f => path.resolve(ROOT, f));
let err = 0, warn = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`${C.red}没有这个文件:${f}${C.off}`); err++; continue; }
  const r = lintFile(f);
  err += r.nErr; warn += r.nWarn;
}
console.log(`\n${err ? C.red : C.grn}bat-lint:${err} 个 ERROR、${warn} 个 WARN,查了 ${files.length} 个文件${C.off}\n`);
process.exit(err ? 1 : 0);
