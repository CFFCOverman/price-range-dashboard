/* macOS 启动器静态验收：Windows CI 无法执行 /bin/sh 和 open，但可以钉死会让
 * Finder 双击立即失败的文件契约，以及安装/参数转发/退出码路径。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(ROOT, 'run-factset.command');
const bytes = fs.readFileSync(file);
const src = bytes.toString('utf8');
let fail = 0;
const ok = (name, pass) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`);
  if (!pass) fail++;
};

ok('存在 macOS 双击入口', fs.existsSync(file));
ok('第一行是 POSIX sh shebang', src.startsWith('#!/bin/sh\n'));
ok('全文件只有 LF,没有 CRLF', !src.includes('\r'));
ok('从启动器自身位置定位仓库,不依赖 Finder 的 cwd', /dirname -- "\$0"/.test(src));
ok('路径和转发参数都有引号', /cd "\$FETCHER_DIR"/.test(src) && /factset-fetch\.mjs "\$@"/.test(src));
ok('缺 Node 时给 nodejs.org 与 Homebrew 两条安装路径', /nodejs\.org/.test(src) && /brew install node/.test(src));
ok('依赖严格从 lock 安装', /preflight\.mjs deps/.test(src) && /npm ci/.test(src));
ok('Chrome 有预检和安装回退', /preflight\.mjs chrome/.test(src) && /playwright install chrome/.test(src));
ok('抓取退出码原样返回', /RC=\$\?/.test(src) && /exit "\$RC"/.test(src));
ok('不含 Windows 专属 start/notepad/cmd.exe', !/\b(?:start|notepad|cmd\.exe)\b/i.test(src));

process.exit(fail ? 1 : 0);
