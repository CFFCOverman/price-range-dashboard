#!/usr/bin/env node
/* Windows 集成自检：在临时目录用 shim 真跑 .bat，不下载、不启动浏览器。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP run-factset.bat behavior test (Windows only)');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-factset-test-'));
let failed = 0;
const ok = (name, value, detail = '') => {
  console.log(`  ${value ? 'PASS' : 'FAIL'} ${name}${value || !detail ? '' : ': ' + detail}`);
  if (!value) failed++;
};

try {
  const fetcher = path.join(tmp, 'fetcher');
  /* cmd.exe 会先搜当前目录；把 shim 放在 bat 切入的 fetcher/，避免 Windows
   * 环境变量里 Path/PATH 大小写重复时选择顺序不确定。 */
  const bin = fetcher;
  fs.mkdirSync(fetcher);
  fs.copyFileSync(path.join(ROOT, 'run-factset.bat'), path.join(tmp, 'run-factset.bat'));
  fs.writeFileSync(path.join(fetcher, 'factset-fetch.mjs'),
    "process.exit(process.env.SCENARIO === 'fetchfail' ? 31 : 0);\n");
  fs.writeFileSync(path.join(fetcher, 'preflight.mjs'), [
    "const mode = process.argv[2];",
    "if (mode === 'deps') process.exit(process.env.SCENARIO === 'npmfail' ? 2 : 0);",
    "if (mode === 'chrome') process.exit(process.env.SCENARIO === 'browserfail' ? 2 : 0);",
    'process.exit(1);',
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\nexit /b 17\r\n');
  fs.writeFileSync(path.join(bin, 'npx.cmd'), '@echo off\r\nexit /b 23\r\n');

  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const cases = [
    ['npm failure', 'npmfail', 17, false],
    ['browser failure', 'browserfail', 23, false],
    ['fetch failure', 'fetchfail', 31, false],
    ['success', 'success', 0, true],
  ];
  for (const [name, scenario, code, successBanner] of cases) {
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call run-factset.bat <nul'], {
      cwd: tmp, encoding: 'utf8', env: { ...process.env, SCENARIO: scenario,
        Path: `${bin};${system32};${process.env.Path || ''}`, PATH: `${bin};${system32};${process.env.Path || ''}` },
    });
    const out = (r.stdout || '') + (r.stderr || '');
    ok(`${name}: exit ${code}`, r.status === code, `got ${r.status}\n${out}`);
    ok(`${name}: success banner ${successBanner ? 'shown' : 'hidden'}`,
      out.includes('Next   -> open index.html') === successBanner, out);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `FAIL ${failed}` : 'SELFTEST OK');
process.exit(failed ? 1 : 0);
