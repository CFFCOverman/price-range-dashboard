#!/usr/bin/env node
/* run-factset.bat 的只读准备检查。退出 0=已经就绪，2=需要修复/安装，1=检查器自身出错。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

export function dependenciesReady(root = DIR, exists = fs.existsSync, read = p => fs.readFileSync(p, 'utf8')) {
  try {
    const pkg = JSON.parse(read(path.join(root, 'package.json')));
    const lock = JSON.parse(read(path.join(root, 'package-lock.json')));
    const wanted = pkg.dependencies || {};
    const lockedWanted = lock.packages?.['']?.dependencies || {};
    const names = Object.keys(wanted).sort();
    if (names.length !== Object.keys(lockedWanted).length || names.some(name => wanted[name] !== lockedWanted[name])) return false;
    for (const name of names) {
      const installedPath = path.join(root, 'node_modules', name, 'package.json');
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      if (!locked || !exists(installedPath)) return false;
      if (JSON.parse(read(installedPath)).version !== locked) return false;
    }
    /* Playwright 的 JS 包与 core 必须同版；只验顶层包会漏掉半安装。 */
    const pw = lock.packages?.['node_modules/playwright']?.version;
    const corePath = path.join(root, 'node_modules', 'playwright-core', 'package.json');
    const core = lock.packages?.['node_modules/playwright-core']?.version;
    return !!pw && pw === core && exists(corePath) && JSON.parse(read(corePath)).version === core;
  } catch {
    return false;
  }
}

export function chromeCandidates(env = process.env) {
  const suffix = path.win32.join('Google', 'Chrome', 'Application', 'chrome.exe');
  return [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter(Boolean).map(base => path.win32.join(base, suffix)))];
}

export function chromeReady(env = process.env, exists = fs.existsSync) {
  return chromeCandidates(env).some(exists);
}

function selftest() {
  const fixture = {
    'package.json': JSON.stringify({ dependencies: { playwright: '^1.61.1', xlsx: '^0.18.5' } }),
    'package-lock.json': JSON.stringify({ packages: {
      '': { dependencies: { playwright: '^1.61.1', xlsx: '^0.18.5' } },
      'node_modules/playwright': { version: '1.61.1' },
      'node_modules/playwright-core': { version: '1.61.1' },
      'node_modules/xlsx': { version: '0.18.5' },
    } }),
    'node_modules/playwright/package.json': JSON.stringify({ version: '1.61.1' }),
    'node_modules/playwright-core/package.json': JSON.stringify({ version: '1.61.1' }),
    'node_modules/xlsx/package.json': JSON.stringify({ version: '0.18.5' }),
  };
  const key = p => path.relative('X', p).replaceAll('\\', '/');
  const read = p => fixture[key(p)];
  const exists = p => Object.hasOwn(fixture, key(p));
  const results = [
    ['完整依赖与 lock 同版', dependenciesReady('X', exists, read)],
    ['缺直接依赖会要求修复', !dependenciesReady('X', p => key(p) !== 'node_modules/xlsx/package.json' && exists(p), read)],
    ['Playwright/core 不同版会要求修复', !dependenciesReady('X', exists, p => key(p) === 'node_modules/playwright-core/package.json' ? '{"version":"1.60.0"}' : read(p))],
    ['Chrome 候选存在才算就绪', chromeReady({ LOCALAPPDATA: 'C:\\Local' }, p => /chrome\.exe$/i.test(p))],
    ['Chrome 候选全不存在不假绿', !chromeReady({ LOCALAPPDATA: 'C:\\Local' }, () => false)],
  ];
  for (const [name, pass] of results) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`);
  process.exit(results.every(([, pass]) => pass) ? 0 : 1);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--selftest') selftest();
  if (mode === 'deps') process.exit(dependenciesReady() ? 0 : 2);
  if (mode === 'chrome') process.exit(chromeReady() ? 0 : 2);
  console.error('usage: node preflight.mjs deps|chrome');
  process.exit(1);
}
