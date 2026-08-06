#!/usr/bin/env node
/* tools/setup.mjs —— 新机器一键准备:双击 setup.bat 之后干活的就是这个文件
 *
 * 为什么有这个文件:
 *   tools/doctor.mjs 只**诊断**,它把"缺什么"和"敲哪条命令"告诉你,然后就完了 ——
 *   人还得自己一条条抄。这个文件负责**动手**:该装的装上,装完再让 doctor 复查一遍。
 *   分工不许合并:诊断和施工混在一起的工具,出问题时你分不清是"检查错了"还是"装错了"。
 *
 * 硬规矩(和 doctor.mjs 同款,不许违反):
 *   1. **不许 import 任何第三方包**。这个文件的正职就是在 `npm install` 之前跑起来 ——
 *      自己都依赖 node_modules 的安装器,在最需要它的那一刻恰好起不来。
 *   2. **不许背着人装东西**。要下载的、要改机器的,一律先问一句;非交互(没有 TTY)时
 *      默认**不装** —— CI 里悄悄拖 150MB 浏览器是纯粹的恶意。
 *   3. **幂等**。第二次、第十次跑都必须是安全的:已经就绪的步骤原地报"已就绪"就走,
 *      不重装、不重下。一个"跑两次会坏"的准备脚本,没人敢在出问题的时候再点一次。
 *   4. 一步失败就**停在那一步**,不许硬着头皮往下跑。npm install 挂了还去跑测试,
 *      只会再叠一屏无关的红字,把真正的死因埋掉。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const C = { red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', cyn: '\x1b[36m', dim: '\x1b[90m', off: '\x1b[0m' };

/* ============================================================================
 * 纯函数区 —— 会判错方向的地方全拆出来,好在一台机器上把所有情形过一遍
 * ==========================================================================*/

/* 参数解析。
 * 关键设计:**不认识的参数一律报错退出**,不许静默忽略。
 * 理由很具体 —— 有人敲 `--skip-tests`(真名是 --skip-test),静默忽略的话他会以为
 * 自己跳过了测试,然后对着跑了十分钟的测试一脸困惑;更坏的是 CI 里写错 --yes 拼法,
 * 脚本卡在提问上直到超时。宁可当场红,不许假装听懂了。 */
export function parseArgs(argv = []) {
  const out = { yes: false, noBrowser: false, skipTest: false, selftest: false, help: false, unknown: [] };
  for (const a of argv) {
    switch (a) {
      case '-y': case '--yes':        out.yes = true; break;
      case '--no-browser':            out.noBrowser = true; break;
      case '--skip-test':             out.skipTest = true; break;
      case '--selftest':              out.selftest = true; break;
      case '-h': case '--help':       out.help = true; break;
      /* setup.bat 会把自己的开关原样透传过来,这两个是它的,不是我们的,认下但不做事 */
      case '--no-pause': case '--nopause': break;
      default:                        out.unknown.push(a);
    }
  }
  return out;
}

/* Windows 上 npm 是 `npm.cmd` 不是 `npm`。
 * 这条如果错了,用户看到的是 `Error: spawnSync npm ENOENT` —— 一句完全指错方向的报错
 * (机器上明明装了 npm)。而我在 Linux 沙箱里**永远测不出来这个 bug**,所以它必须是
 * 一个能在 Linux 上钉死 win32 行为的纯函数,而不是散在调用点的 process.platform 判断。 */
export function npmBin(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

/* 要不要开 shell。
 * Node 18.20 / 20.12 / 22 之后修了 CVE-2024-27980:spawn 一个 .cmd/.bat **不开 shell** 会直接
 * 抛 EINVAL。所以 win32 上跑 npm.cmd 必须 shell:true。反过来,POSIX 上开 shell 纯属找麻烦
 * (参数要重新过一遍分词),一律关。
 * 安全前提:本文件传给 npm 的参数全是写死的常量(install / --no-audit / --no-fund),
 * 没有任何一个来自用户输入 —— 这一点变了的话,shell:true 就成了注入口子,不许乱加参数。 */
export function needsShell(cmd, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(String(cmd));
}

/* 哪些依赖没装。探文件存在性,不许改成 import() ——
 * import() 探一个缺失的包会**抛**,而那正是我们要替用户接住的异常。 */
export function missingDeps(root = ROOT, need = ['playwright', 'xlsx'], exists = fs.existsSync) {
  return need.filter(p => !exists(path.join(root, 'node_modules', p, 'package.json')));
}

/* playwright 自己的 CLI 在哪。
 * 用它而不用 `npx playwright`:npx 在 Windows 上又是一层 .cmd,而且联网时会去查注册表。
 * 我们已经装好了包,直接 `node node_modules/playwright/cli.js install chromium` 最短最稳。 */
export function playwrightCli(root = ROOT, exists = fs.existsSync) {
  for (const pkg of ['playwright', 'playwright-core']) {
    const p = path.join(root, 'node_modules', pkg, 'cli.js');
    if (exists(p)) return p;
  }
  return null;
}

/* 浏览器这一步到底该干嘛 —— 五种结论,一个都不许合并。
 * 合并的诱惑在于"反正都是不装",但这五种"不装"要对用户说的话完全不同:
 * 已经有了 / 你自己关了 / 你说不要 / 这里没人能回答所以我不敢下 / 装。
 * 把它们糊成一个 boolean,用户就只能看到一句"跳过浏览器",然后猜为什么。 */
export function decideBrowser({ found, noBrowser = false, yes = false, interactive = true, answer = null } = {}) {
  if (found)       return { action: 'ready',    why: '已经有 chromium 了,不重复下载' };
  if (noBrowser)   return { action: 'off',      why: '你传了 --no-browser' };
  if (yes)         return { action: 'install',  why: '你传了 --yes' };
  if (!interactive) return { action: 'noask',   why: '非交互环境(没有 TTY),不敢背着人下 150MB —— 要装就加 --yes' };
  if (answer === null) return { action: 'ask',  why: '得问一句' };
  return answer ? { action: 'install', why: '你答了要装' } : { action: 'declined', why: '你答了不装' };
}

/* 回答怎么解读。空回车 = 是 —— 提示里写的是 [Y/n],大写的那个就是默认值,这是终端惯例。
 * 中文的"是/好/要"也认:这脚本是给中文用户在中文 Windows 上双击的,只认 y 有点不近人情。 */
export function yesish(answer) {
  const s = String(answer == null ? '' : answer).trim();
  if (s === '') return true;
  return /^(y|yes|是|好|要|行|ok)$/i.test(s);
}

/* 退出码。
 * 只有 fail 才退 1。skip **不许**影响退出码 —— 跳过浏览器、跳过测试都是用户自己选的,
 * 把用户的选择表现成失败,他下次就不敢选了。 */
export function exitCodeFor(steps = []) {
  return steps.some(s => s.status === 'fail') ? 1 : 0;
}

/* 汇总一句话。写成纯函数是为了能钉住措辞 —— 这句是用户在一屏滚动之后唯一会读的东西。 */
export function summaryLine(steps = []) {
  const f = steps.filter(s => s.status === 'fail').length;
  const k = steps.filter(s => s.status === 'skip').length;
  const o = steps.filter(s => s.status === 'ok').length;
  if (f) return `没准备完:${f} 步失败、${o} 步完成${k ? `、${k} 步跳过` : ''}。上面第一条 ✗ 就是死因,后面的步骤没跑。`;
  if (k) return `准备完成:${o} 步完成、${k} 步跳过(跳过的都是你自己选的,不影响仪表盘)。`;
  return `准备完成:${o} 步全绿,这台机器可以干活了。`;
}

/* ============================================================================
 * 干活区
 * ==========================================================================*/

function say(s = '') { console.log(s); }
function head(n, total, title) { say(`\n${C.cyn}[${n}/${total}] ${title}${C.off}`); }
function okLine(s)   { say(`  ${C.grn}✓${C.off} ${s}`); }
function skipLine(s) { say(`  ${C.yel}—${C.off} ${s}`); }
function failLine(s) { say(`  ${C.red}✗${C.off} ${s}`); }

/* 统一的子进程入口。stdio 全程 inherit:npm install 要下三分钟东西,
 * 把输出憋到最后再吐,用户会以为卡死了然后去按 Ctrl+C。 */
function run(cmd, args, { cwd = ROOT } = {}) {
  const shell = needsShell(cmd);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell });
  if (r.error) return { ok: false, code: null, err: String(r.error.message || r.error) };
  return { ok: r.status === 0, code: r.status, err: null };
}
/* 要拿输出而不是直接打屏的时候用这个(只有环境概览需要)。 */
function capture(cmd, args, { cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: needsShell(cmd) });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, a => { rl.close(); resolve(a); });
  });
}

async function main(opt) {
  const TOTAL = 5;
  const steps = [];
  const push = (id, status, detail) => { steps.push({ id, status, detail }); return status; };
  const interactive = Boolean(process.stdin.isTTY);

  say(`${C.cyn}股价区间仪表盘 —— 新机器准备${C.off}`);
  say(`${C.dim}  仓库    ${ROOT}${C.off}`);
  say(`${C.dim}  node    ${process.version}  (${process.platform}/${process.arch})${C.off}`);
  const npmV = capture(npmBin(), ['-v']);
  say(`${C.dim}  npm     ${npmV || '(问不出版本号,后面装依赖那步会说清楚)'}${C.off}`);
  say(`${C.dim}  交互    ${interactive ? '是(有问题会问你)' : '否(没有 TTY,所有提问按"不"处理)'}${C.off}`);

  /* ---- 1/5 依赖 ---------------------------------------------------------- */
  head(1, TOTAL, '依赖(playwright、xlsx)');
  {
    const miss = missingDeps(ROOT);
    if (!miss.length) {
      okLine('已就绪,跳过 npm install。');
      push('deps', 'ok', 'already');
    } else {
      say(`  缺 ${miss.join('、')},开始 npm install(第一次会慢,别关窗口)……\n`);
      const r = run(npmBin(), ['install', '--no-audit', '--no-fund']);
      if (!r.ok) {
        failLine(`npm install 没成功${r.err ? `:${r.err}` : `(退出码 ${r.code})`}。`);
        if (r.err && /ENOENT/i.test(r.err)) {
          say('    看着像是找不到 npm 本身。装了 Node 之后**新开一个**命令行窗口再试 ——');
          say('    安装程序改的 PATH 不会作用到已经开着的窗口上。');
        } else {
          say('    常见原因:没联网、公司代理挡了 registry、或者磁盘满了。');
          say(`    手动重试:cd "${ROOT}" 然后 npm install`);
        }
        push('deps', 'fail', 'install-failed');
        return finish(steps);
      }
      const still = missingDeps(ROOT);
      if (still.length) {
        /* npm 退 0 但包还是不在 —— 见过,workspaces/缓存错乱时会这样。
         * 不复查就会把"装了个寂寞"当成成功,然后死在下一步一句莫名其妙的报错上。 */
        failLine(`npm install 说自己成功了,但 ${still.join('、')} 还是不在 node_modules 里。`);
        say('    这种情况多半是 npm 缓存坏了。试:npm cache clean --force 然后重跑一次准备。');
        push('deps', 'fail', 'still-missing');
        return finish(steps);
      }
      okLine('依赖装好了。');
      push('deps', 'ok', 'installed');
    }
  }

  /* ---- 2/5 浏览器 -------------------------------------------------------- */
  head(2, TOTAL, 'chromium(抓 FactSet 数据要用;只看仪表盘不用)');
  {
    const { browserProbe } = await import('./doctor.mjs');
    const probe = browserProbe();
    let d = decideBrowser({ found: probe.found, noBrowser: opt.noBrowser, yes: opt.yes, interactive });
    if (d.action === 'ask') {
      const a = await ask('  要装抓数据用的 chromium 吗?约 150MB,不装也不影响仪表盘和测试。[Y/n] ');
      d = decideBrowser({ found: false, noBrowser: opt.noBrowser, yes: opt.yes, interactive, answer: yesish(a) });
    }
    if (d.action === 'ready') {
      okLine(`chromium 已就绪(${probe.via}):${probe.path}`);
      push('browser', 'ok', 'already');
    } else if (d.action === 'install') {
      const cli = playwrightCli(ROOT);
      if (!cli) {
        failLine('找不到 node_modules/playwright/cli.js —— 依赖那步像是没真装上。');
        say('    手动装:npx playwright install chromium');
        push('browser', 'fail', 'no-cli');
        return finish(steps);
      }
      say('  开始下载 chromium(几分钟,别关窗口)……\n');
      const r = run(process.execPath, [cli, 'install', 'chromium']);
      if (!r.ok) {
        /* 浏览器装不上**不算 fail**:它只挡抓数据,仪表盘和绝大多数闸门照样能跑。
         * 为一个可选组件把整次准备判成失败,用户会以为整个项目坏了。 */
        skipLine(`chromium 没装成${r.err ? `:${r.err}` : `(退出码 ${r.code})`} —— 记下来,继续往下走。`);
        say('    它只影响抓数据,仪表盘和测试不受影响。回头单独重试:npx playwright install chromium');
        push('browser', 'skip', 'install-failed');
      } else {
        okLine('chromium 装好了。');
        push('browser', 'ok', 'installed');
      }
    } else {
      skipLine(`没装 chromium(${d.why})。要抓 FactSet 数据时再跑:npx playwright install chromium`);
      push('browser', 'skip', d.action);
    }
  }

  /* ---- 3/5 体检 ---------------------------------------------------------- */
  head(3, TOTAL, '环境体检(tools/doctor.mjs)');
  {
    say('');
    const r = run(process.execPath, [path.join(ROOT, 'tools', 'doctor.mjs')]);
    if (!r.ok) {
      failLine('体检有必修项(上面 ✗ 那几条),先按它给的命令修掉再跑一次准备。');
      push('doctor', 'fail', 'fatal');
      return finish(steps);
    }
    okLine('体检通过(黄色提醒不挡事,但值得看一眼)。');
    push('doctor', 'ok', 'pass');
  }

  /* ---- 4/5 构建校验 ------------------------------------------------------ */
  head(4, TOTAL, '构建校验(src/ 和交付的 HTML 对不对得上)');
  {
    const r = run(process.execPath, [path.join(ROOT, 'tools', 'build.mjs'), '--check']);
    if (!r.ok) {
      /* 这一步红,说明有人改了 src/ 却没重新构建 —— 或者反过来,直接改了产物 HTML。
       * 对新机器来说这不该发生,发生了就是仓库里两边不一致,得当场说清楚。 */
      failLine('src/ 与交付的 HTML 不一致。跑 npm run build 重新构建,或者查一下是不是有人直接改了产物 HTML。');
      push('build', 'fail', 'drift');
      return finish(steps);
    }
    okLine('src/ 与两份 HTML 一致。');
    push('build', 'ok', 'clean');
  }

  /* ---- 5/5 测试 ---------------------------------------------------------- */
  head(5, TOTAL, '全套测试(tests/test-app.mjs)');
  if (opt.skipTest) {
    skipLine('你传了 --skip-test,没跑。想跑:npm test');
    push('test', 'skip', 'flag');
  } else {
    say('');
    const r = run(process.execPath, [path.join(ROOT, 'tests', 'test-app.mjs')]);
    if (!r.ok) {
      failLine('测试有红。上面每条 FAIL 都带了实际值,照着看。');
      push('test', 'fail', 'red');
      return finish(steps);
    }
    okLine('全绿。');
    push('test', 'ok', 'green');
  }

  return finish(steps);
}

function finish(steps) {
  const code = exitCodeFor(steps);
  say('\n' + '═'.repeat(74));
  say((code ? C.red : C.grn) + summaryLine(steps) + C.off);
  if (!code) {
    say('');
    say('  接下来能干的事:');
    say(`    ${C.dim}·${C.off} 看仪表盘   双击 price-range-dashboard.html(不需要装任何东西)`);
    say(`    ${C.dim}·${C.off} 抓数据     双击 run-factset.bat,或 npm run fetch(要你自己登录 FactSet)`);
    say(`    ${C.dim}·${C.off} 跑回测     npm run backtest ${C.dim}(需要 Assets/charting 里有导出数据)${C.off}`);
    say(`    ${C.dim}·${C.off} 再体检     npm run doctor`);
  }
  say('═'.repeat(74) + '\n');
  return code;
}

/* ============================================================================
 * 自检 —— 全在纯函数上跑,一个字节都不下载、一个进程都不 spawn
 * ==========================================================================*/
function cmdSelftest() {
  let n = 0, bad = 0;
  const ok = (name, cond, got) => {
    n++;
    if (cond) console.log(`  PASS  ${name}`);
    else { bad++; console.log(`  ${C.red}FAIL  ${name}${C.off}${got !== undefined ? `  →  ${got}` : ''}`); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-selftest-'));

  /* --- 参数 --- */
  ok('parseArgs:全默认关', (() => { const a = parseArgs([]); return !a.yes && !a.noBrowser && !a.skipTest && !a.unknown.length; })());
  ok('parseArgs:-y 与 --yes 等价', parseArgs(['-y']).yes === true && parseArgs(['--yes']).yes === true);
  ok('parseArgs:--no-browser / --skip-test 各管各的',
    parseArgs(['--no-browser']).noBrowser === true && parseArgs(['--no-browser']).skipTest === false &&
    parseArgs(['--skip-test']).skipTest === true && parseArgs(['--skip-test']).noBrowser === false);
  /* 这条是防"静默忽略"的:拼错的开关必须被抓出来,不许当没看见 */
  ok('parseArgs:不认识的参数进 unknown(--skip-tests 是常见笔误,不许静默忽略)',
    parseArgs(['--skip-tests']).unknown.join() === '--skip-tests' && parseArgs(['--skip-tests']).skipTest === false);
  ok('parseArgs:setup.bat 自己的 --no-pause 要认下来,不许报成未知参数',
    parseArgs(['--no-pause']).unknown.length === 0);

  /* --- Windows 那两条我在 Linux 上永远撞不到的 --- */
  ok("npmBin:win32 → 'npm.cmd'(错了就是 spawnSync npm ENOENT,一句指错方向的报错)",
    npmBin('win32') === 'npm.cmd', npmBin('win32'));
  ok("npmBin:linux/darwin → 'npm'", npmBin('linux') === 'npm' && npmBin('darwin') === 'npm');
  ok('needsShell:win32 上的 .cmd 必须开 shell(CVE-2024-27980 之后不开会抛 EINVAL)',
    needsShell('npm.cmd', 'win32') === true);
  ok('needsShell:win32 上的非 .cmd(比如 node 本体)不开 shell',
    needsShell('C:\\Program Files\\nodejs\\node.exe', 'win32') === false);
  ok('needsShell:POSIX 一律不开 shell,哪怕名字里带 .cmd',
    needsShell('npm.cmd', 'linux') === false && needsShell('npm', 'darwin') === false);
  /* .bat 单独钉一条:上面那条只喂了 .cmd,把正则收窄成 /\.cmd$/ 能一声不响地溜过去。
   * 而仓库里就摆着 setup.bat / run-factset.bat —— 哪天有人从这里 spawn 一个 .bat,
   * 不开 shell 同样吃 EINVAL,而 Linux 上永远撞不到。 */
  ok('needsShell:win32 上的 .bat 也必须开 shell(仓库里就有 setup.bat / run-factset.bat)',
    needsShell('run-factset.bat', 'win32') === true && needsShell('SETUP.BAT', 'win32') === true);

  /* --- 依赖探测 --- */
  const depRoot = path.join(tmp, 'deps');
  fs.mkdirSync(path.join(depRoot, 'node_modules', 'playwright'), { recursive: true });
  fs.writeFileSync(path.join(depRoot, 'node_modules', 'playwright', 'package.json'), '{}');
  ok('missingDeps:装了 playwright、没装 xlsx → 只报 xlsx',
    missingDeps(depRoot).join() === 'xlsx', missingDeps(depRoot).join());
  /* 只有目录、没有 package.json 的空壳不许算装好了 —— 中断的 npm install 就长这样 */
  fs.mkdirSync(path.join(depRoot, 'node_modules', 'xlsx'), { recursive: true });
  ok('missingDeps:只有空目录没有 package.json,仍然算没装(装到一半中断就是这个样子)',
    missingDeps(depRoot).join() === 'xlsx');
  fs.writeFileSync(path.join(depRoot, 'node_modules', 'xlsx', 'package.json'), '{}');
  ok('missingDeps:两个都齐了 → 空', missingDeps(depRoot).length === 0);

  /* --- playwright CLI 定位 --- */
  const pwRoot = path.join(tmp, 'pw');
  ok('playwrightCli:两个包都没有 → null(要能说人话,不能返回一个不存在的路径)',
    playwrightCli(pwRoot) === null);
  fs.mkdirSync(path.join(pwRoot, 'node_modules', 'playwright-core'), { recursive: true });
  fs.writeFileSync(path.join(pwRoot, 'node_modules', 'playwright-core', 'cli.js'), '');
  ok('playwrightCli:只有 playwright-core 时退而求其次',
    playwrightCli(pwRoot) === path.join(pwRoot, 'node_modules', 'playwright-core', 'cli.js'));
  fs.mkdirSync(path.join(pwRoot, 'node_modules', 'playwright'), { recursive: true });
  fs.writeFileSync(path.join(pwRoot, 'node_modules', 'playwright', 'cli.js'), '');
  ok('playwrightCli:playwright 优先于 playwright-core',
    playwrightCli(pwRoot) === path.join(pwRoot, 'node_modules', 'playwright', 'cli.js'));

  /* --- 浏览器决策矩阵:五种结论各钉一条,外加两条优先级 --- */
  const B = (o) => decideBrowser(o).action;
  ok('decideBrowser:已经有了 → ready(不重复下 150MB)', B({ found: true }) === 'ready');
  ok('decideBrowser:已经有了时,--yes 也不许重下', B({ found: true, yes: true }) === 'ready');
  /* found 必须排在 noBrowser 前面。把 noBrowser 提上去看着无害(反正都不装),但结论会从
   * ready 变成 off,用户读到的是"你传了 --no-browser"而不是"已经有了" —— 机器上明明有
   * chromium,他却以为自己把它关掉了,于是去掉开关重跑,白等一次 150MB 的下载判断。 */
  ok('decideBrowser:已经有了时,--no-browser 也只报 ready(不许说成"你自己关的",机器上明明有)',
    B({ found: true, noBrowser: true }) === 'ready');
  ok('decideBrowser:--no-browser → off', B({ found: false, noBrowser: true }) === 'off');
  ok('decideBrowser:--no-browser 压过 --yes(明确说不要,就不许装)',
    B({ found: false, noBrowser: true, yes: true }) === 'off');
  ok('decideBrowser:--yes → 直接装,不问', B({ found: false, yes: true }) === 'install');
  ok('decideBrowser:没 TTY 且没 --yes → noask(硬规矩 2:不许背着人下东西)',
    B({ found: false, interactive: false }) === 'noask');
  ok('decideBrowser:没 TTY 但给了 --yes → 还是装(CI 明确要就给)',
    B({ found: false, interactive: false, yes: true }) === 'install');
  ok('decideBrowser:交互且没答 → ask', B({ found: false, interactive: true }) === 'ask');
  ok('decideBrowser:答了要 → install;答了不要 → declined',
    B({ found: false, answer: true }) === 'install' && B({ found: false, answer: false }) === 'declined');
  ok('decideBrowser:五种结论都带一句 why(每种"不装"要说的话都不一样)',
    [{ found: true }, { found: false, noBrowser: true }, { found: false, yes: true },
     { found: false, interactive: false }, { found: false, answer: false }]
      .every(o => typeof decideBrowser(o).why === 'string' && decideBrowser(o).why.length > 0));

  /* --- 回答解读 --- */
  ok('yesish:空回车 = 是(提示写的是 [Y/n],大写那个就是默认值)', yesish('') === true && yesish('  ') === true);
  ok('yesish:y / Y / yes 都认', yesish('y') && yesish('Y') && yesish('YES'));
  ok('yesish:中文的 是/好/要 也认(这脚本就是给中文 Windows 用户双击的)',
    yesish('是') && yesish('好') && yesish('要'));
  ok('yesish:n / no / 否 / 随便打点什么 → 不是', !yesish('n') && !yesish('no') && !yesish('否') && !yesish('asdf'));
  /* 锚点(^...$)不许掉。掉了之后 /要/ 会命中"不要"、/行/ 会命中"不行"、/好/ 会命中"不好" ——
   * 也就是把中文里最自然的三种拒绝答法**全部反读成同意**,然后当着人的面下 150MB。
   * 上面那条只喂了 n/no/否/asdf,一个带"要/行/好"的否定词都没有,盖不住这个洞。 */
  ok('yesish:不要 / 不行 / 不好 都是"不"(正则锚点掉了会把这三种拒绝反读成同意)',
    !yesish('不要') && !yesish('不行') && !yesish('不好'));

  /* --- 退出码与汇总 --- */
  const S = (...st) => st.map((s, i) => ({ id: 'x' + i, status: s }));
  ok('exitCodeFor:全 ok → 0', exitCodeFor(S('ok', 'ok', 'ok')) === 0);
  ok('exitCodeFor:有 skip 没 fail → 还是 0(跳过是用户自己选的,不许表现成失败)',
    exitCodeFor(S('ok', 'skip', 'skip')) === 0);
  ok('exitCodeFor:有 fail → 1', exitCodeFor(S('ok', 'skip', 'fail')) === 1);
  ok('exitCodeFor:空数组 → 0(一步都没跑不算失败)', exitCodeFor([]) === 0);
  ok('summaryLine:失败时要指路"第一条 ✗ 就是死因"',
    /第一条/.test(summaryLine(S('ok', 'fail'))));
  ok('summaryLine:有跳过时要说清跳过不影响仪表盘',
    /不影响仪表盘/.test(summaryLine(S('ok', 'skip'))));
  ok('summaryLine:全绿时不许提"跳过"两个字(没跳过就别制造疑虑)',
    !/跳过/.test(summaryLine(S('ok', 'ok'))));

  /* --- 硬规矩 1 的自我看守 --- */
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const imports = [...self.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  ok('本文件顶层只 import node: 内置模块(安装器不许自己依赖 node_modules)',
    imports.length > 0 && imports.every(m => m.startsWith('node:')), imports.join());
  /* doctor.mjs 是动态 import 的,那是本地文件不是包,允许;但也只许这一处动态 import */
  const dyn = [...self.matchAll(/await import\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  ok("动态 import 只许有 './doctor.mjs' 这一处(本地文件,不是包)",
    dyn.length === 1 && dyn[0] === './doctor.mjs', dyn.join());

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `${C.red}SELFTEST FAILED${C.off} ${bad}/${n}` : `${C.grn}SELFTEST OK${C.off} ${n}`);
  return bad === 0;
}

/* ============================================================================
 * 入口
 * ==========================================================================*/
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.unknown.length) {
    console.log(`${C.red}不认识这些参数:${opt.unknown.join(' ')}${C.off}`);
    console.log('  没有静默忽略,是怕你以为它生效了。可用的:--yes / --no-browser / --skip-test / --selftest / --help');
    process.exit(2);
  }
  if (opt.help) {
    console.log('用法:node tools/setup.mjs [--yes] [--no-browser] [--skip-test]');
    console.log('  (无参数)      按步骤准备,要下载的东西会先问一句');
    console.log('  --yes, -y     所有提问都当"是"(CI 用;会下 chromium)');
    console.log('  --no-browser  不装 chromium(只看仪表盘的话用这个最快)');
    console.log('  --skip-test   准备完不跑测试');
    console.log('  --selftest    纯函数自检,不下载、不 spawn、不碰真仓库');
    process.exit(0);
  }
  if (opt.selftest) {
    process.exit(cmdSelftest() ? 0 : 1);
  }
  main(opt).then(code => process.exit(code)).catch(e => {
    console.log(`\n${C.red}准备脚本自己出错了${C.off}:${String((e && e.stack) || e)}`);
    console.log('这是 setup.mjs 的 bug,不是你机器的问题。绕开它:npm install 然后 npm test。');
    process.exit(1);
  });
}
