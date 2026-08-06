#!/usr/bin/env node
/* tools/doctor.mjs —— 环境体检:把"环境没装好"和"代码坏了"分开
 *
 * 为什么有这个文件(踩过的坑,别删):
 *   同一份仓库换一台机器就跑不起来,而报错全是生的:
 *     · 没跑 npm install → ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'
 *       (node 还会好心建议 "Did you mean to import playwright/index.js?" —— 纯误导)
 *     · 没下浏览器 → browserType.launch: Failed to launch chromium ...
 *     · 没有授权数据 → ENOENT: no such file or directory, scandir '.../Assets/charting'
 *   这三句话都不告诉人该敲哪条命令。体检的职责就是:**每条问题都配一条能照抄的命令**。
 *
 * 硬规矩(不许违反):
 *   1. **这个文件不许 import 任何第三方包**。它要在 `npm install` 之前就能跑 ——
 *      自己都依赖 node_modules 的体检工具,在最需要它的那一刻恰好起不来。
 *   2. 体检自己崩了,不许拦住真正的测试:--preflight 模式下内部异常一律退 0 并留话,
 *      "体检工具有 bug" 不该表现成 "你的代码红了"。
 *   3. 只有**确实会让测试跑不起来**的项才算 fatal;缺数据、缺浏览器都只是 warn。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/* ---------- 授权数据在不在:三态,不是两态 ------------------------------------
 * FactSet 导出是授权数据,.gitignore 里 Assets/ 整个挡掉了 —— 所以**任何新克隆一定没有**。
 * 于是"没有数据"必须和"数据坏了"分开判,这是本文件存在的第二个理由:
 *   'no-dir' 目录压根不存在  → 从没装过数据(新机器的正常状态)→ 跳过,不算红;
 *   'empty'  目录在、却读不出任何导出 → 装过又空了 / 被谁清掉了 → 这是回归,该红;
 *   'ok'     读得到导出文件。
 * 判据只看**目录在不在**,不看文件数够不够 —— 文件数是会随导出变的东西,不许拿来当闸。
 * 语义不许改(tests/test-app.mjs 的 [18] 直接按这三个字符串分支)。 */
export function chartingStatus(root = ROOT) {
  const dir = path.join(root, 'Assets', 'charting');
  if (!fs.existsSync(dir)) return { state: 'no-dir', dir, files: [], coFiles: [], mktFiles: [] };
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => /\.xlsx?$/i.test(f)).sort();
  } catch (e) {
    return { state: 'empty', dir, files: [], coFiles: [], mktFiles: [], err: String(e.message || e) };
  }
  const coFiles = files.filter(f => !/^_MARKET-/i.test(f));
  const mktFiles = files.filter(f => /^_MARKET-/i.test(f));
  return { state: files.length ? 'ok' : 'empty', dir, files, coFiles, mktFiles };
}

/* ---------- 纯函数区:能单测的判定都从 IO 里拆出来 ---------------------------
 * 拆的理由很具体:版本分级和浏览器探测是这份工具里**唯二会判错方向**的地方
 * (把能跑的机器判成 fatal,或者把跑不了的判成 ok),而它们要是缠在 IO 里就只能
 * "换台机器试试"来验。拆成纯函数之后 --selftest 才能在一台机器上把四种 node 版本、
 * 两种浏览器路径情形全过一遍。不许再把判定逻辑塞回 IO 里。 */

/** 'v22.22.2' / '22.22.2' → 22;认不出来给 NaN,交给调用方兜。 */
export function parseMajor(version) {
  const m = /^v?(\d+)\./.exec(String(version || '').trim());
  return m ? Number(m[1]) : NaN;
}

/* node 版本分级。
 * 界在 18:playwright ^1.61 的 engines 要求 node >= 18,低于这个数是**真的起不来**,算 fatal。
 * 但 18/19 本身已经 EOL(不再有安全更新),能跑归能跑,该提醒还是要提醒 → warn。
 * 老实话写在 detail 里:本项目只在 22.x 上实测过,18/20 是照 playwright 的声明推的,
 * 不是我们验过的 —— 不许把这句话删掉换成"已支持 18+",那是假装验过。 */
export function nodeCheck(version = process.version) {
  const major = parseMajor(version);
  const base = { id: 'node', title: `node 版本 ${version}` };
  if (!Number.isFinite(major)) {
    return { ...base, level: 'warn',
      detail: `认不出这个版本号(${version}),没法判定;本项目实测过的是 22.x。`,
      fix: null };
  }
  if (major < 18) {
    return { ...base, level: 'fatal',
      detail: `太老了:playwright ^1.61 要求 node >= 18,${major}.x 上连依赖都装不上。装一个 LTS(https://nodejs.org)。`,
      fix: '# 去 https://nodejs.org 装 LTS 版(或 nvm install --lts),装完 node -v 应当 >= 20' };
  }
  if (major < 20) {
    return { ...base, level: 'warn',
      detail: `${major}.x 够 playwright 的最低要求,但已经 EOL(不再有安全更新),建议升到当前 LTS。` +
              `本项目只在 22.x 上实测过,${major}.x 能不能一路跑通没验过。`,
      fix: '# 去 https://nodejs.org 升到当前 LTS(或 nvm install --lts)' };
  }
  return { ...base, level: 'ok',
    detail: major === 22 ? '就是本项目实测过的版本线。'
                         : `>= 20,够用;不过本项目只在 22.x 上实测过,${major}.x 属于"应该没问题"而不是"验过没问题"。`,
    fix: null };
}

/* playwright 缓存目录:各平台默认位置。PLAYWRIGHT_BROWSERS_PATH 能整个顶掉。
 * 这里只是**猜** playwright 会去哪儿找,猜错的后果是把 ok 报成 warn(多一句废话),
 * 不会把跑不了的报成 ok —— 这个方向的偏差是可以接受的,反过来不行。 */
export function browsersCacheDir({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

/* 浏览器探测:三条路,顺序必须和 tests/test-app.mjs 里的 BROWSER_EXE 一致。
 *   1. PLAYWRIGHT_EXECUTABLE_PATH —— 显式覆盖,**无条件优先**;
 *   2. 沙箱路径 /opt/pw-browsers/chromium,存在才算;
 *   3. playwright 自己的缓存目录里有没有 chromium-* 子目录。
 * 第 1 条有个陷阱,别"顺手修好":test-app.mjs 拿到环境变量就直接当 executablePath 用,
 * 不检查存不存在、也不回退。所以这里环境变量指着个不存在的路径时,结论必须是"没浏览器",
 * 不许偷偷 fall through 到第 2、3 条 —— 那样体检报绿、测试照样炸,比不体检更坏。 */
export function browserProbe({ env = process.env, home = os.homedir(), platform = process.platform,
                               exists = p => fs.existsSync(p) } = {}) {
  const envPath = env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (envPath) {
    return exists(envPath)
      ? { found: true,  via: 'env',     path: envPath }
      : { found: false, via: 'env-bad', path: envPath };
  }
  const sandbox = '/opt/pw-browsers/chromium';
  if (exists(sandbox)) return { found: true, via: 'sandbox', path: sandbox };

  const cache = browsersCacheDir({ env, home, platform });
  let hit = null;
  try {
    if (exists(cache)) hit = fs.readdirSync(cache).filter(d => /^chromium-/.test(d)).sort().pop() || null;
  } catch { /* 缓存目录读不动就当没有,体检不该因为一个目录权限问题自己炸 */ }
  return hit
    ? { found: true,  via: 'cache',      path: path.join(cache, hit) }
    : { found: false, via: 'cache-miss', path: cache };
}

/* ---------- 各检查项 ---------------------------------------------------------
 * 每项都返回 { id, level, title, detail, fix }。
 * fix 必须是**能整条粘进终端**的东西,不许写"请安装依赖"这种废话;
 * 实在没有可执行命令的(比如要去网页下 node),就写成 # 开头的注释行。 */

/* 依赖装没装。用文件存在性探,不许改成 import() ——
 * import() 探一个缺失的包会**抛** ERR_MODULE_NOT_FOUND,而这正是我们要替用户接住的那个异常;
 * 用抛异常的方式去检查"会不会抛异常",体检自己先倒下。 */
function depsCheck(root) {
  const need = ['playwright', 'xlsx'];
  const missing = need.filter(p => !fs.existsSync(path.join(root, 'node_modules', p, 'package.json')));
  if (!missing.length) {
    return { id: 'deps', level: 'ok', title: '依赖已安装', detail: `node_modules 里 ${need.join('、')} 都在。`, fix: null };
  }
  return { id: 'deps', level: 'fatal', title: `依赖缺失:${missing.join('、')}`,
    detail: '不装这些,tests/test-app.mjs 一行都跑不到,只会甩一句 ' +
            "Cannot find package '" + missing[0] + "'(后面 node 还会建议 \"Did you mean to import " +
            missing[0] + '/index.js?\" —— 那是误导,别顺着改 import 路径)。',
    fix: 'npm install' };
}

/* 浏览器。缺浏览器只是 warn:test-app.mjs 里除了浏览器那套,还有一堆闸门照样能跑,
 * 一票否决会让"只是没下浏览器"看起来像"整个项目坏了"。 */
function browserCheck() {
  const p = browserProbe();
  if (p.found) {
    const how = { env: '环境变量 PLAYWRIGHT_EXECUTABLE_PATH', sandbox: '沙箱路径', cache: 'playwright 缓存目录' }[p.via];
    return { id: 'browser', level: 'ok', title: 'chromium 就绪', detail: `${how}:${p.path}`, fix: null };
  }
  if (p.via === 'env-bad') {
    return { id: 'browser', level: 'warn', title: 'PLAYWRIGHT_EXECUTABLE_PATH 指着一个不存在的路径',
      detail: `环境变量指向 ${p.path},但那里没有东西。注意 tests/test-app.mjs 拿到这个变量就无条件用,` +
              '不会回退去找别的浏览器 —— 所以这条不清掉,装了浏览器也没用。',
      fix: '# 先清掉这个变量(Windows: set PLAYWRIGHT_EXECUTABLE_PATH= / bash: unset PLAYWRIGHT_EXECUTABLE_PATH),再跑 npx playwright install chromium' };
  }
  return { id: 'browser', level: 'warn', title: '没找到 chromium',
    detail: `找过的地方:环境变量 PLAYWRIGHT_EXECUTABLE_PATH、/opt/pw-browsers/chromium、缓存目录 ${p.path}。` +
            '浏览器那套测试会起不来,其余闸门不受影响。',
    fix: 'npx playwright install chromium' };
}

/* 授权数据。三态各有各的话要说,不许合并成"有/没有"两态。 */
function dataCheck(root) {
  const s = chartingStatus(root);
  if (s.state === 'ok') {
    return { id: 'data', level: 'ok', title: '授权数据在位',
      detail: `${s.dir} 读到 ${s.coFiles.length} 个公司文件、${s.mktFiles.length} 个市场文件(_MARKET-*)。`,
      fix: null };
  }
  if (s.state === 'no-dir') {
    return { id: 'data', level: 'warn', title: '没有 Assets/charting(新克隆的正常状态)',
      detail: 'FactSet 导出是授权数据,.gitignore 里 Assets/ 整个挡掉了,所以**任何新克隆都一定没有**,' +
              '这不是仓库坏了。自己去导一份:跑 run-factset.bat(Windows)或 npm run fetch,' +
              '也可以手动把导出的 xlsx 丢进 Assets/charting/。',
      fix: 'npm run fetch' };
  }
  return { id: 'data', level: 'warn', title: 'Assets/charting 在,但读不出导出文件',
    detail: `${s.dir} 存在却一个 .xlsx 都没有` + (s.err ? `(读目录还报了:${s.err})` : '') +
            '。这更像是被清掉了,而不是从没装过 —— 先想想是不是自己刚删过或同步工具动过手,再重新导。',
    fix: 'npm run fetch' };
}

/* 在不在仓库根目录。用户真踩过:在 C:\\Users\\pinyo 底下敲 npm test,
 * 得到 ENOENT: ... open 'C:\\Users\\pinyo\\package.json' —— 那句报错完全不提示"你走错目录了"。 */
function cwdCheck(root) {
  /* Windows 上盘符大小写会随用户怎么敲 cd 而变(c:\Users\… vs C:\Users\…),
   * 逐字比会冤枉人报一条假 warn。体检报假警报比不报还坏 —— 报三次之后没人再看它。
   * 所以 win32 下折成小写再比;POSIX 保持大小写敏感(那边路径本来就区分)。 */
  const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  const real = p => { try { return fold(fs.realpathSync(p)); } catch { return fold(path.resolve(p)); } };
  const here = process.cwd();
  if (real(here) === real(root)) {
    return { id: 'cwd', level: 'ok', title: '工作目录就是仓库根', detail: here, fix: null };
  }
  return { id: 'cwd', level: 'warn', title: '当前目录不是仓库根',
    detail: `你在 ${here},仓库根是 ${root}。在别处敲 npm test 只会得到一句 ` +
            "ENOENT: no such file or directory, open '<当前目录>/package.json'。",
    fix: `cd "${root}"` };
}

/* git 工作副本状态 —— 这条是本轮最大的发现,别当成锦上添花的检查。
 * 用户的仓库里只提交了 14 个文件:src/ tools/ tests/ docs/ package.json 全都还没提交,
 * 最后一次 commit 还停在 v10 时代。也就是说**现在谁克隆下来都跑不起来**,拿到的是个残缺快照。
 * 这种病在本机是完全隐形的(本地文件都在,测试全绿),只有别人克隆时才炸,所以必须由体检替他看着。
 * 实现上一律走 spawnSync:execSync 在没装 git / 不是 git 仓库时会**抛**,而这两种情况都属于
 * "静默跳过"而不是"出问题",不许让它抛。 */
function gitCheck(root, enabled) {
  const skip = (detail) => ({ id: 'git', level: 'ok', title: 'git 检查跳过', detail, fix: null });
  if (!enabled) return skip('调用方传了 git:false。');

  const run = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const ls = run('ls-files');
  if (ls.error) return skip('本机没有 git(或不在 PATH 里),跳过。');
  if (ls.status !== 0) return skip('这里不是 git 仓库,跳过(云端这份工作副本就不是)。');

  const tracked = ls.stdout.split('\n').filter(Boolean);
  const st = run('status', '--porcelain');
  const dirty = st.status === 0 ? st.stdout.split('\n').filter(Boolean).length : null;
  const dirtyNote = dirty === null ? '' : `未提交条目 ${dirty} 个。`;

  const missing = [];
  if (!tracked.includes('package.json')) missing.push('package.json');
  if (!tracked.some(f => f.startsWith('tests/'))) missing.push('tests/');
  if (!tracked.some(f => f.startsWith('tools/'))) missing.push('tools/');
  if (!tracked.some(f => f.startsWith('src/'))) missing.push('src/');
  /* 这两个是"克隆下来能不能一键跑起来"的入口。上面四条按目录前缀判断,tools/ 里
   * 随便一个文件被跟踪就算过 —— 恰好漏掉的就是 tools/setup.mjs 本身。入口没提交,
   * 别人克隆到的 setup.bat 双击就报"仓库不完整",而本机永远看不到这个现象。 */
  if (!tracked.includes('setup.bat')) missing.push('setup.bat');
  if (!tracked.includes('tools/setup.mjs')) missing.push('tools/setup.mjs');

  if (missing.length) {
    return { id: 'git', level: 'warn', title: `这些还没进版本库:${missing.join('、')}`,
      detail: `git 只跟踪了 ${tracked.length} 个文件。${dirtyNote}` +
              '意思是**别人克隆到的不是你现在这份代码** —— 他拿到的是个残缺快照,连 npm test 都无从跑起。' +
              '本机一切正常,所以这病只有别人克隆时才会发作。',
      fix: 'git add -A && git commit -m "把 src/ tools/ tests/ 与 package.json 补进版本库" && git push  # 这条要你自己在终端里跑' };
  }
  return { id: 'git', level: 'ok', title: `版本库完整(跟踪 ${tracked.length} 个文件)`,
    detail: `package.json、tests/、tools/、src/,以及一键入口 setup.bat + tools/setup.mjs,都已提交。${dirtyNote}`, fix: null };
}

/* ---------- 对外的总入口 ---------------------------------------------------- */
export function runChecks({ root = ROOT, git = true } = {}) {
  return [
    nodeCheck(),
    depsCheck(root),
    browserCheck(),
    dataCheck(root),
    cwdCheck(root),
    gitCheck(root, git),
  ];
}

/* ---------- 输出 ------------------------------------------------------------- */
const C = { red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', dim: '\x1b[90m', off: '\x1b[0m' };
const MARK = { ok: `${C.grn}✓${C.off}`, warn: `${C.yel}!${C.off}`, fatal: `${C.red}✗${C.off}` };

function printFull(checks) {
  console.log('环境体检 —— 换一台机器跑不起来时,先看这里\n');
  for (const c of checks) {
    console.log(`${MARK[c.level]} ${c.title}`);
    if (c.detail) console.log(`${C.dim}    ${c.detail}${C.off}`);
    if (c.level !== 'ok' && c.fix) console.log(`    怎么修:${c.fix}`);
  }
  const fatal = checks.filter(c => c.level === 'fatal');
  const warn = checks.filter(c => c.level === 'warn');
  console.log('');
  if (fatal.length) console.log(`${C.red}体检未通过${C.off}:${fatal.length} 项必修、${warn.length} 项提醒。必修的不解决,npm test 跑不起来。`);
  else if (warn.length) console.log(`${C.grn}体检通过${C.off},另有 ${warn.length} 项提醒(不挡测试,但值得看一眼)。`);
  else console.log(`${C.grn}体检通过${C.off},六项全绿。`);
  return fatal.length ? 1 : 0;
}

/* --preflight:npm test 的守门员。
 * 它每跑一次测试就执行一次,所以**没问题时只许打一行** —— 一个天天刷屏的守门员,
 * 用户三天之后就开始无视它,那它在真出事那天也拦不住人。 */
function printPreflight(checks) {
  const fatal = checks.filter(c => c.level === 'fatal');
  const warn = checks.filter(c => c.level === 'warn');
  if (fatal.length) {
    console.log(`${C.red}✗ 环境体检未通过,测试没跑${C.off}`);
    for (const c of fatal) {
      console.log(`  ✗ ${c.title}`);
      if (c.detail) console.log(`${C.dim}      ${c.detail}${C.off}`);
      if (c.fix) console.log(`      怎么修:${c.fix}`);
    }
    console.log(`${C.dim}  完整体检:npm run doctor${C.off}`);
    return 1;
  }
  if (warn.length) {
    console.log(`${C.grn}✓ 环境体检通过${C.off} ${C.dim}(另有 ${warn.length} 项提醒:${warn.map(c => c.title).join(' / ')};详见 npm run doctor)${C.off}`);
    return 0;
  }
  console.log(`${C.grn}✓ 环境体检通过${C.off}`);
  return 0;
}

/* ---------- 自检:全在临时目录里跑,一个字都不碰真仓库 ─────────────────────── */
function cmdSelftest() {
  let n = 0, bad = 0;
  const ok = (name, cond) => { n++; if (cond) console.log(`  PASS  ${name}`); else { bad++; console.log(`  ${C.red}FAIL  ${name}${C.off}`); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-selftest-'));

  /* chartingStatus 三态:三个态各造一个真目录验,不许拿 mock 糊弄 —— 这三个字符串
   * 是 tests/test-app.mjs 直接分支的东西,判错一个就是整套测试走错路。 */
  const noDir = path.join(tmp, 'case-no-dir');
  fs.mkdirSync(noDir, { recursive: true });
  ok("chartingStatus:Assets/charting 不存在 → 'no-dir'(新克隆的正常状态)", chartingStatus(noDir).state === 'no-dir');

  const emptyDir = path.join(tmp, 'case-empty');
  fs.mkdirSync(path.join(emptyDir, 'Assets', 'charting'), { recursive: true });
  ok("chartingStatus:目录在但一个 xlsx 都没有 → 'empty'(装过又被清掉,是回归)", chartingStatus(emptyDir).state === 'empty');

  const okDir = path.join(tmp, 'case-ok');
  fs.mkdirSync(path.join(okDir, 'Assets', 'charting'), { recursive: true });
  fs.writeFileSync(path.join(okDir, 'Assets', 'charting', 'AAPL-US Daily Charting.xlsx'), 'x');
  fs.writeFileSync(path.join(okDir, 'Assets', 'charting', 'MSFT-US Daily Charting.xlsx'), 'x');
  fs.writeFileSync(path.join(okDir, 'Assets', 'charting', '_MARKET-BENCH SPY-US Daily Charting.xlsx'), 'x');
  fs.writeFileSync(path.join(okDir, 'Assets', 'charting', 'readme.txt'), 'x');   // 非 xlsx 不许被数进去
  const s = chartingStatus(okDir);
  ok("chartingStatus:有 xlsx → 'ok',公司/市场文件按 _MARKET- 前缀分开数,txt 不算",
    s.state === 'ok' && s.coFiles.length === 2 && s.mktFiles.length === 1 && s.files.length === 3);
  /* 文件数是现读的,不是写死的 —— 加一个文件,数就得跟着变,否则 detail 里那个数就是骗人的 */
  fs.writeFileSync(path.join(okDir, 'Assets', 'charting', 'NVDA-US Daily Charting.xlsx'), 'x');
  ok('chartingStatus:文件数从文件夹现读(加一个文件,公司数跟着 +1)', chartingStatus(okDir).coFiles.length === 3);

  /* node 版本分级:界在 18(playwright 的硬要求)和 20(EOL 与否)。 */
  ok('nodeCheck:v16 → fatal(低于 playwright 要求的 18,连依赖都装不上)', nodeCheck('v16.20.2').level === 'fatal');
  ok('nodeCheck:v18 → warn(够 playwright 最低要求,但已 EOL)', nodeCheck('v18.19.0').level === 'warn');
  /* v19 单独钉一条:少了它,把 EOL 界从 20 挪到 19 这种改动能一声不响地溜过去。 */
  ok('nodeCheck:v19 → warn(奇数版本从来没有 LTS,一样已 EOL)', nodeCheck('v19.9.0').level === 'warn');
  ok('nodeCheck:v20 → ok', nodeCheck('v20.11.1').level === 'ok');
  ok('nodeCheck:v22 → ok(本项目唯一实测过的版本线)', nodeCheck('v22.22.2').level === 'ok');
  ok('nodeCheck:fatal 项必须给一条能照抄的 fix', typeof nodeCheck('v16.20.2').fix === 'string');
  ok('nodeCheck:ok 项不给 fix(没毛病就别塞命令给人抄)', nodeCheck('v22.22.2').fix === null);
  ok('nodeCheck:认不出的版本号不许当成 fatal(判不了就提醒,别乱红)', nodeCheck('banana').level === 'warn');
  ok('parseMajor:带不带 v 都认', parseMajor('v22.1.0') === 22 && parseMajor('20.0.0') === 20);
  ok('nodeCheck 文案里保留"只在 22.x 上实测过"的老实话(不许改成假装验过老版本)',
    /只在 22\.x 上实测过/.test(nodeCheck('v20.11.1').detail));

  /* 浏览器探测:环境变量那条最要命,因为 test-app.mjs 拿到它就无条件用。 */
  const fakeExe = path.join(tmp, 'fake-chromium');
  fs.writeFileSync(fakeExe, '#!/bin/sh\n');
  const pOk = browserProbe({ env: { PLAYWRIGHT_EXECUTABLE_PATH: fakeExe }, home: tmp, platform: 'linux' });
  ok('browserProbe:环境变量指向一个存在的路径 → found,且 via=env', pOk.found === true && pOk.via === 'env');
  const pBad = browserProbe({ env: { PLAYWRIGHT_EXECUTABLE_PATH: path.join(tmp, 'nope', 'chromium') }, home: tmp, platform: 'linux' });
  ok('browserProbe:环境变量指向不存在的路径 → 不 found,via=env-bad', pBad.found === false && pBad.via === 'env-bad');
  /* 这条锁的是口径:环境变量坏了**不许**悄悄回退到缓存目录,因为 test-app.mjs 不会回退。
   * 体检报绿而测试照炸,比不体检更坏。 */
  const cacheHome = path.join(tmp, 'home-with-cache');
  fs.mkdirSync(path.join(cacheHome, '.cache', 'ms-playwright', 'chromium-1194'), { recursive: true });
  const pNoFallback = browserProbe({ env: { PLAYWRIGHT_EXECUTABLE_PATH: path.join(tmp, 'nope', 'chromium') },
    home: cacheHome, platform: 'linux' });
  ok('browserProbe:环境变量坏了不许回退到缓存目录(要和 test-app.mjs 的无条件覆盖一致)',
    pNoFallback.found === false && pNoFallback.via === 'env-bad');
  const pCache = browserProbe({ env: {}, home: cacheHome, platform: 'linux', exists: p => p !== '/opt/pw-browsers/chromium' && fs.existsSync(p) });
  ok('browserProbe:没有环境变量、没有沙箱路径时,认缓存目录里的 chromium-* 子目录',
    pCache.found === true && pCache.via === 'cache');
  const pMiss = browserProbe({ env: {}, home: path.join(tmp, 'empty-home'), platform: 'linux',
    exists: p => p !== '/opt/pw-browsers/chromium' && fs.existsSync(p) });
  ok('browserProbe:三条路都空 → 不 found,via=cache-miss', pMiss.found === false && pMiss.via === 'cache-miss');
  ok('browsersCacheDir:PLAYWRIGHT_BROWSERS_PATH 能整个顶掉默认位置',
    browsersCacheDir({ env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' }, home: tmp, platform: 'linux' }) === '/opt/pw-browsers');
  ok('browsersCacheDir:三个平台各自的默认位置',
    browsersCacheDir({ env: {}, home: '/h', platform: 'linux' }) === '/h/.cache/ms-playwright' &&
    browsersCacheDir({ env: {}, home: '/h', platform: 'darwin' }) === '/h/Library/Caches/ms-playwright' &&
    /ms-playwright$/.test(browsersCacheDir({ env: { LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, home: '/h', platform: 'win32' })));

  /* runChecks 的形状:tests/test-app.mjs 和 CLI 都按这个形状读,不许悄悄改字段。 */
  const checks = runChecks({ root: noDir, git: false });
  ok('runChecks:每项都有 id/level/title/detail/fix 五个字段',
    checks.every(c => 'id' in c && 'level' in c && 'title' in c && 'detail' in c && 'fix' in c));
  ok('runChecks:level 只有 ok/warn/fatal 三种', checks.every(c => ['ok', 'warn', 'fatal'].includes(c.level)));
  ok('runChecks:非 ok 项一律配一条能照抄的 fix(没命令的检查项不许存在)',
    checks.filter(c => c.level !== 'ok').every(c => typeof c.fix === 'string' && c.fix.length > 0));
  ok('runChecks:六项检查一个不少(node/deps/browser/data/cwd/git)',
    checks.map(c => c.id).join(',') === 'node,deps,browser,data,cwd,git');
  ok('runChecks:缺授权数据只算 warn,不许升成 fatal(没数据照样能跑大半闸门)',
    checks.find(c => c.id === 'data').level === 'warn');
  ok('runChecks:缺依赖是 fatal,fix 就是 npm install',
    checks.find(c => c.id === 'deps').level === 'fatal' && checks.find(c => c.id === 'deps').fix === 'npm install');
  ok('runChecks:git:false 时那条静默跳过,不许报红', checks.find(c => c.id === 'git').level === 'ok');
  /* 不是 git 仓库(云端这份工作副本就是)也必须静默跳过,不许把它当成毛病。 */
  ok('runChecks:临时目录不是 git 仓库 → git 那条仍是 ok',
    runChecks({ root: noDir, git: true }).find(c => c.id === 'git').level === 'ok');

  /* 硬规矩 1 的自我看守:这份文件不许 import 第三方包。 */
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const imports = [...self.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  ok('本文件只 import node: 内置模块(体检工具不许自己依赖 node_modules)',
    imports.length > 0 && imports.every(m => m.startsWith('node:')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `${C.red}SELFTEST FAILED${C.off} ${bad}/${n}` : `${C.grn}SELFTEST OK${C.off} ${n}`);
  return bad === 0;
}

/* ---------- 入口 ------------------------------------------------------------- */
/* 只在被直接执行时跑 CLI:tests/test-app.mjs 会 import 这个文件拿 chartingStatus,
 * 那时候不许有任何输出,更不许 process.exit。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    process.exit(cmdSelftest() ? 0 : 1);
  } else if (argv.includes('--preflight')) {
    /* 硬规矩 2:体检自己崩了,不许拦住真正的测试。
     * 整个流程包一层 —— "体检有 bug" 表现成 "你的代码红了" 是最坏的一种失败,
     * 它会让人去改一份根本没问题的代码。宁可放行,也不许误伤。 */
    try {
      process.exit(printPreflight(runChecks()));
    } catch (e) {
      console.log('体检工具自己出错了,跳过体检直接跑测试:' + String((e && e.message) || e).split('\n')[0]);
      process.exit(0);
    }
  } else if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法:node tools/doctor.mjs [--preflight | --selftest]');
    console.log('  (无参数)   打印完整体检报告,有必修项时退 1');
    console.log('  --preflight npm test 的守门员:没问题只打一行,有必修项退 1 拦住测试');
    console.log('  --selftest  纯函数自检,全在临时目录里跑,不碰真仓库');
  } else {
    process.exit(printFull(runChecks()));
  }
}
