/**
 * factset-fetch.mjs — 自动抓取 Price Range Dashboard 所需的 FactSet 数据
 *
 * 抓什么(每个 ticker):
 *   1. Estimate History FY1 + FY2(逐月一致预期:Mean/Low/High/上调下调家数/P⁄E)→ xlsx
 *   2. 当前价格(从页面头部)→ 汇总进 companies.csv
 *   3. Charting 日线数据导出(尽力而为;失败会提示手动)→ xlsx
 * 输出全部写入 OUT_DIR(默认 Assets 文件夹),仪表盘"连接文件夹/重新扫描"即可食用。
 *
 * 首次使用:
 *   npm init -y && npm i playwright xlsx
 *   node factset-fetch.mjs --login     ← 打开浏览器,手动登录 FactSet 一次(登录态存在本地 profile 里)
 * 日常使用:
 *   node factset-fetch.mjs             ← 全自动跑完 TICKERS 列表
 *
 * 注意:请遵守你的 FactSet 许可条款;本脚本仅自动化你有权手动执行的导出,低频个人使用。
 */
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ================= 配置 =================
const TICKERS_DEFAULT = ['NVDA-US', 'GOOGL-US'];  // 首次默认;之后以 tickers.txt 为准
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/* 输出目录相对脚本定位(fetcher 的上一级 /Assets)——整个项目文件夹可整体搬迁/克隆,零改动可用;FS_OUT 环境变量可覆盖 */
const OUT_DIR = process.env.FS_OUT || path.resolve(SCRIPT_DIR, '..', 'Assets');
const TICKERS_FILE = path.join(SCRIPT_DIR, 'tickers.txt');   // 一行一个代码,# 开头为注释,记事本随时可改
const TICKERS_JSON_OLD = path.join(SCRIPT_DIR, 'tickers.json');
const APP_HTML = ['price-range-dashboard.html', 'index.html']
  .map(f => path.join(path.dirname(OUT_DIR), f)).find(f => { try { return fs.existsSync(f); } catch { return false; } })
  || path.join(path.dirname(OUT_DIR), 'price-range-dashboard.html');
const PROFILE = path.join(os.homedir(), '.factset-bot-profile');   // 独立浏览器 profile(保存登录态)
const BASE = 'https://my.apps.factset.com';
const LOGIN_ONLY = process.argv.includes('--login');
const HEADLESS = false;                            // FactSet 登录/SSO 建议始终有头运行
// ========================================

/* ============ 进度条(TTY 动态刷新;无终端时打印里程碑) ============ */
const isTTY = !!process.stdout.isTTY;
let barState = null;
function drawBar() {
  if (!barState || !isTTY) return;
  const { done, total, label } = barState;
  const W = 26, f = Math.min(W, Math.round(done / total * W));
  const pct = String(Math.round(done / total * 100)).padStart(3);
  process.stdout.write('\r[' + '█'.repeat(f) + '░'.repeat(W - f) + '] ' + pct + '% (' + done + '/' + total + ') ' + String(label).slice(0, 50) + '    ');
}
function barClear() { if (isTTY && barState) process.stdout.write('\r' + ' '.repeat(110) + '\r'); }
function bar(done, total, label) {
  barState = { done, total, label };
  if (isTTY) drawBar();
  else console.log(`[进度 ${Math.round(done / total * 100)}%] (${done}/${total}) ${label}`);
}
function barEnd() { if (isTTY && barState) { drawBar(); process.stdout.write('\n'); } barState = null; }
const log = (...a) => { barClear(); console.log(new Date().toISOString().slice(11, 19), ...a); drawBar(); };
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ============ 源出清单:fetcher/sources.txt(第二个管理文件,自动维护 文件↔FactSet源头 对照) ============ */
const SOURCES_FILE = path.join(SCRIPT_DIR, 'sources.txt');
const sourceMap = new Map();
try {
  if (fs.existsSync(SOURCES_FILE)) {
    for (const line of fs.readFileSync(SOURCES_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue;
      const i = line.indexOf(' | ');
      if (i > 0) sourceMap.set(line.slice(0, i).trim(), line);
    }
  }
} catch {}
function recordSource(file, src) { sourceMap.set(file, file + ' | ' + src); }
function writeSources() {
  const head = '# 数据源出清单 — 由 factset-fetch 自动维护(每次拉取更新对应条目,勿手改格式)\n'
    + '# 格式: 文件名 | FactSet 页签路径 | 财年/内容 | 表格说明 | URL | 抓取时间(UTC)\n';
  fs.writeFileSync(SOURCES_FILE, head + [...sourceMap.values()].sort().join('\n') + '\n');
}

/* --selftest:不开浏览器,验证核心逻辑(财年判定/标签位移/xlsx 写读回) */
if (process.argv.includes('--selftest')) {
  let fail = 0;
  const eq = (got, want, name) => {
    if (got === want) console.log('  PASS', name, '=', got);
    else { console.log('  FAIL', name, 'got', got, 'want', want); fail++; }
  };
  eq(fyTag("Jan '27E"), 'FY1', "fyTag Jan'27E");
  eq(fyTag("Jan '28E"), 'FY2', "fyTag Jan'28E");
  eq(fyTag("Dec '26E"), 'FY1', "fyTag Dec'26E");
  eq(fyTag("Dec '27E"), 'FY2', "fyTag Dec'27E");
  eq(shiftLabel("Jan '27E", 1), "Jan '28E", 'shiftLabel +1');
  eq(shiftLabel("Dec '27E", -1), "Dec '26E", 'shiftLabel -1');
  const fake13 = [["28 Jul '26", '9.00', '-', '47', '35', '1', '8.20', '9.85', '0.32', '0.3', '0.02', '21.9', '0.6']];
  const fake12 = [["28 Jul '26", '12.75', '45', '35', '1', '9.65', '16.45', '1.29', '0.9', '0.11', '15.4', '0.4']];
  eq(saveEstimateXlsx('TEST-US', 'FY1', [['junk'], ...fake13]), true, 'save 13-col');
  eq(saveEstimateXlsx('TEST-US', 'FY2', [['junk'], ...fake12]), true, 'save 12-col');
  const wbBack = XLSX.read(fs.readFileSync(path.join(OUT_DIR, 'TEST-US FY2 Estimate History.xlsx')), { type: 'buffer' });
  const back = XLSX.utils.sheet_to_json(wbBack.Sheets['TEST-US'], { header: 1 });
  eq(String(back[2][2]), 'Sharp Cons', 'header col3');
  eq(String(back[3][1]), '12.75', 'FY2 mean roundtrip');
  eq(String(back[3][6]), '9.65', 'FY2 low in col7 (Sharp Cons 补位正确)');
  console.log(fail === 0 ? 'SELFTEST OK' : `SELFTEST ${fail} FAILURES`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ============ 拉取清单:tickers.txt(一行一个,# 注释),控制台可批量增删或直接弹记事本编辑 ============ */
const VALID = /^[A-Z.]{1,6}-[A-Z]{2}$/;
function loadTickers() {
  try {
    if (fs.existsSync(TICKERS_FILE)) {
      const list = fs.readFileSync(TICKERS_FILE, 'utf8').split(/\r?\n/)
        .map(s => s.replace(/#.*$/, '').trim().toUpperCase())
        .filter(s => s && VALID.test(s));
      if (list.length) return [...new Set(list)];
    }
    if (fs.existsSync(TICKERS_JSON_OLD)) {   // 兼容旧版 json,自动迁移
      const list = JSON.parse(fs.readFileSync(TICKERS_JSON_OLD, 'utf8')).tickers;
      saveTickers(list);
      return list;
    }
  } catch {}
  return [...TICKERS_DEFAULT];
}
function saveTickers(list) {
  fs.writeFileSync(TICKERS_FILE,
    '# Price Range Dashboard 拉取清单 — 一行一个代码(如 NVDA-US),# 开头为注释\n' +
    '# 可直接用记事本编辑保存;也可在运行时的控制台里增删。\n' +
    list.join('\n') + '\n');
}
function printList(list) {
  console.log('\n当前拉取清单(' + list.length + ' 家):');
  list.forEach((t, i) => console.log('   ' + String(i + 1).padStart(2) + '. ' + t));
}
let TICKERS = loadTickers();
if (!fs.existsSync(TICKERS_FILE)) saveTickers(TICKERS);
if (!LOGIN_ONLY && process.stdin.isTTY) {   /* 无终端(如定时任务)时跳过交互,直接按清单拉取 */
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => Promise.race([rl.question(q), new Promise(res => rl.once('close', () => res('')))]);
  printList(TICKERS);
  console.log('操作:输代码添加(可多个,逗号/空格分隔)| -代码 删除 | edit 编辑清单 | sources 查看源出台账 | 回车 开始拉取');
  while (true) {
    const ans = (await ask('> ')).trim();
    if (!ans) break;
    if (/^edit$/i.test(ans)) {
      saveTickers(TICKERS);
      exec(`start notepad "${TICKERS_FILE}"`);
      await ask('已打开记事本(tickers.txt)—— 编辑保存后回到这里按回车刷新清单 ');
      TICKERS = loadTickers();
      printList(TICKERS);
      continue;
    }
    if (/^(sources|src)$/i.test(ans)) {
      if (!fs.existsSync(SOURCES_FILE)) writeSources();
      exec(`start notepad "${SOURCES_FILE}"`);
      console.log('已打开源出台账(sources.txt,只读性质——每次拉取自动更新,手改会被覆盖)');
      continue;
    }
    for (let tok of ans.split(/[,,;\s]+/).filter(Boolean)) {
      tok = tok.toUpperCase();
      if (tok.startsWith('-')) {
        const t = tok.slice(1);
        if (TICKERS.includes(t)) { TICKERS = TICKERS.filter(x => x !== t); console.log('  已删除', t); }
        else console.log('  ⚠ 清单里没有', t);
      } else if (!VALID.test(tok)) {
        console.log('  ⚠ 跳过无法识别的代码:', tok, '(格式应如 AMZN-US / ASML-US)');
      } else if (!TICKERS.includes(tok)) {
        TICKERS.push(tok); console.log('  已添加', tok);
      } else console.log('  已在清单中:', tok);
    }
    saveTickers(TICKERS);
    printList(TICKERS);
    console.log('继续增删,或回车开始拉取');
  }
  rl.close();
  saveTickers(TICKERS);
  if (!TICKERS.length) { console.log('清单为空,已退出。'); process.exit(0); }
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: HEADLESS, viewport: { width: 1600, height: 900 },
  acceptDownloads: true,
});
const page = ctx.pages()[0] || await ctx.newPage();

if (LOGIN_ONLY) {
  await page.goto(BASE);
  log('请在打开的浏览器里完成 FactSet 登录,然后关闭浏览器窗口。登录态会被记住。');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await ctx.close();
  process.exit(0);
}

/* 自动登录检测:未登录时在同一窗口等你登完,自动继续(无需单独 login 命令) */
await page.goto(BASE + '/workstation/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(5000);
if (!/my\.apps\.factset\.com/.test(page.url()) || /login|auth|id\.factset/i.test(page.url())) {
  log('检测到未登录 —— 请在打开的窗口里登录 FactSet,登录完成后脚本会自动继续……');
  await page.waitForURL(u => /my\.apps\.factset\.com/.test(u.href) && !/login|auth/i.test(u.href), { timeout: 0 });
  await page.waitForTimeout(6000);
  log('登录成功,开始抓取。');
}

/** 进入某 ticker 的 Estimate History 页,返回 {navFrame, tableFrame} */
async function openEstimateHistory(ticker) {
  await page.goto(`${BASE}/workstation/navigator/company-security/estimate-history/${ticker}`, { waitUntil: 'domcontentloaded' });
  const nav = page.frameLocator('iframe[src*="company-security"]');
  const tbl = nav.frameLocator('iframe[src*="estimate-reports"]');
  await tbl.locator('tr').nth(5).waitFor({ timeout: 45000 });   // 等表格渲染
  await page.waitForTimeout(1500);
  return { nav, tbl };
}

/** 从内层 iframe 抓表格 → 二维数组 */
async function scrapeTable(tbl) {
  return await tbl.locator('body').evaluate(body => {
    return [...body.querySelectorAll('tr')].map(r =>
      [...r.querySelectorAll('th,td')].map(c => c.innerText.trim()));
  });
}

/** 在所有 frame 的可见文本里找第一个匹配 */
async function findTextInFrames(reSource) {
  for (const f of page.frames()) {
    try {
      const m = await f.evaluate(src => {
        const mm = document.body && document.body.innerText.match(new RegExp(src));
        return mm ? mm[0] : null;
      }, reSource);
      if (m) return m;
    } catch {}
  }
  return null;
}
/** 对精确文本的叶子元素派发完整鼠标事件序列(自定义控件需要) */
async function clickTextInFrames(txt, pickLast) {
  for (const f of page.frames()) {
    try {
      const ok = await f.evaluate(([t, last]) => {
        const els = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim() === t);
        if (!els.length) return false;
        const el = els[last ? els.length - 1 : 0];
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      }, [txt, !!pickLast]);
      if (ok) return true;
    } catch {}
  }
  return false;
}
/** 财年标签 → FY1/FY2/FY3:按财年末距今的月数判定,绝不靠假设 */
function fyTag(label) {
  const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const m = label.match(/([A-Z][a-z]{2}) '(\d{2})E/);
  if (!m) return null;
  const end = new Date(2000 + +m[2], MONTHS[m[1]], 0);
  const months = (end - Date.now()) / 86400000 / 30.44;
  return months < 12 ? 'FY1' : months < 24 ? 'FY2' : 'FY3';
}
function shiftLabel(label, years) {
  const m = label.match(/([A-Z][a-z]{2}) '(\d{2})E/);
  return `${m[1]} '${String(+m[2] + years).padStart(2, '0')}E`;
}
async function currentPeriod() { return await findTextInFrames("[A-Z][a-z]{2} '\\d{2}E"); }
async function switchPeriod(label) {
  const cur = await currentPeriod();
  if (!cur) return false;
  if (!(await clickTextInFrames(cur, false))) return false;   // 打开财年下拉
  await page.waitForTimeout(1200);
  if (!(await clickTextInFrames(label, true))) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  await page.waitForTimeout(4500);
  return (await currentPeriod()) === label;
}

/** 表格数组 → 仪表盘可识别的 Estimate History xlsx(B2 写入数据源出处,app 解析不受影响) */
function saveEstimateXlsx(ticker, fyTag, rows, srcInfo) {
  const HEAD = ['Date','Mean','Sharp Cons','Num of Est','Num Up','Num Down','Low','High','Std Dev','Chg (%)','Chg Amt','P/E (x)','PEG (x)'];
  const data = rows.filter(r => /^\d{1,2} [A-Z][a-z]{2} '\d{2}$/.test(r[0] || ''))
    .map(r => r.length === 12 ? [...r.slice(0, 2), '-', ...r.slice(2)] : r);   // 无 Sharp Cons 列时补齐
  if (!data.length) { log(`  ⚠ ${ticker} ${fyTag}: 未抓到数据行`); return false; }
  const src = srcInfo || `FactSet Company/Security > Estimates > Estimate History (${ticker})`;
  const ws = XLSX.utils.aoa_to_sheet([[ticker], ['Estimate History', src], HEAD, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ticker.slice(0, 31));
  const f = path.join(OUT_DIR, `${ticker} ${fyTag} Estimate History.xlsx`);
  XLSX.writeFile(wb, f);
  const span = data.length > 1 ? `${data[data.length - 1][0]} ~ ${data[0][0]}` : data[0][0];
  log(`  ✔ ${path.basename(f)} (${data.length} 行, ${span})`);
  recordSource(path.basename(f), src);
  return true;
}

/** 页面头部抓当前价格 */
async function scrapePrice() {
  const t = await findTextInFrames('\\$[\\d,]+\\.\\d{2}');
  return t ? parseFloat(t.replace(/[$,]/g, '')) : NaN;
}

/** Charting 日线导出(尽力而为) */
async function fetchCharting(ticker) {
  try {
    await page.goto(`${BASE}/workstation/charting/`, { waitUntil: 'domcontentloaded' });
    const ch = page.frameLocator('iframe[src*="/charting/"]');
    const box = ch.locator('input').first();
    await box.waitFor({ timeout: 30000 });
    await page.waitForTimeout(3000);
    await box.click(); await box.fill(ticker); await box.press('Enter');
    await page.waitForTimeout(6000);
    // 打开下载菜单(按 title/aria-label 全帧搜索)→ Download data to Excel
    let opened = false;
    for (const f of page.frames()) {
      try {
        opened = await f.evaluate(() => {
          const cand = [...document.querySelectorAll('[title],[aria-label]')]
            .find(e => /download/i.test((e.title || '') + (e.getAttribute('aria-label') || '')));
          if (!cand) return false;
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            cand.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        });
        if (opened) break;
      } catch {}
    }
    if (!opened) throw new Error('未找到下载按钮');
    await page.waitForTimeout(1000);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      clickTextInFrames('Download data to Excel', false),
    ]);
    const f = path.join(OUT_DIR, `${ticker} Daily Charting.xlsx`);
    await download.saveAs(f);
    log(`  ✔ ${path.basename(f)}`);
    recordSource(path.basename(f), `FactSet 页签: Charting > 下载菜单 > Download data to Excel | ${ticker} | 表格: 价格/成交量及图上指标序列(频率与年限按账号保存的图表设置) | ${BASE}/workstation/charting/ | ${new Date().toISOString().slice(0, 16)}Z`);
    return true;
  } catch (e) {
    log(`  ⚠ ${ticker} Charting 自动导出失败(UI 可能改版),请手动导一次:`, e.message.split('\n')[0]);
    return false;
  }
}

// ================= 主流程 =================
const priceRows = [['ticker', 'name', 'currency', 'price', 'price_date',
  'eps_fy1_low', 'eps_fy1_mean', 'eps_fy1_high', 'eps_fy2_low', 'eps_fy2_mean', 'eps_fy2_high']];
const today = new Date().toISOString().slice(0, 10);

const results = {};
const TOTAL = TICKERS.length * 4;   /* 每家 4 步:当前财年 / 另一财年 / 价格 / 日线 */
let done = 0;
for (const ticker of TICKERS) {
  log(`==== ${ticker} ====`);
  const R = results[ticker] = { FY1: false, FY2: false, 价格: false, 日线: false };
  const base = done;
  try {
    bar(done, TOTAL, `${ticker} · 打开 Estimate History…`);
    const { nav, tbl } = await openEstimateHistory(ticker);
    const price = await scrapePrice();
    const p0 = await currentPeriod();
    const tag0 = (p0 ? fyTag(p0) : null) || 'FY1';
    bar(done, TOTAL, `${ticker} · 抓取 ${tag0}(${p0 || '?'})…`);
    const ehUrl = `${BASE}/workstation/navigator/company-security/estimate-history/${ticker}`;
    const srcOf = lbl => `FactSet 页签: Company/Security > Estimates > Estimate History | 财年 ${lbl} | 表格: 逐月一致预期(Mean/Low/High/上调下调家数/P⁄E) | ${ehUrl} | 抓取于 ${new Date().toISOString().slice(0, 16)}Z`;
    log(`  当前财年: ${p0}(${tag0})  价格: ${price}`);
    R[tag0] = saveEstimateXlsx(ticker, tag0, await scrapeTable(tbl), srcOf(p0 || tag0));
    bar(++done, TOTAL, `${ticker} · ${tag0} 完成`);
    /* 切到"另一个"财年:当前是 FY1 → +1 年;当前是 FY2 → −1 年 */
    if (p0 && (tag0 === 'FY1' || tag0 === 'FY2')) {
      const other = shiftLabel(p0, tag0 === 'FY1' ? 1 : -1);
      bar(done, TOTAL, `${ticker} · 切换财年 → ${other}…`);
      if (await switchPeriod(other)) {
        const tblO = nav.frameLocator('iframe[src*="estimate-reports"]');
        await page.waitForTimeout(1500);
        R[fyTag(other)] = saveEstimateXlsx(ticker, fyTag(other), await scrapeTable(tblO), srcOf(other));
      } else {
        log(`  ⚠ 财年切换到 ${other} 失败,本轮只有 ${tag0};可在 FactSet 手动切换后重跑`);
      }
    }
    bar(++done, TOTAL, `${ticker} · 财年数据完成`);
    if (isFinite(price)) {
      priceRows.push([ticker, ticker, 'USD', price, today, '', '', '', '', '', '']);
      R.价格 = true;
    }
    bar(++done, TOTAL, `${ticker} · Charting 日线导出…`);
    R.日线 = await fetchCharting(ticker);
    bar(++done, TOTAL, `${ticker} · 完成`);
  } catch (e) {
    log(`  ✖ ${ticker} 失败:`, e.message.split('\n')[0]);
    done = base + 4;
    bar(done, TOTAL, `${ticker} · 跳过`);
  }
}
barEnd();

if (priceRows.length > 1) {
  fs.writeFileSync(path.join(OUT_DIR, 'companies.csv'), priceRows.map(r => r.join(',')).join('\n'));
  log('✔ companies.csv(价格汇总;EPS 列留空由 Estimate History 补全)');
  recordSource('companies.csv', `FactSet 页签: Company/Security > Estimates > Estimate History | 各公司页头实时价格汇总 | ${priceRows.length - 1} 家 | ${BASE}/workstation/navigator/company-security/estimate-history/ | ${new Date().toISOString().slice(0, 16)}Z`);
}
writeSources();
log(`✔ 源出清单已更新: ${SOURCES_FILE}`);
/* ============ 拉取结果清单 ============ */
console.log('\n================ 拉取结果 ================');
for (const [tk, R] of Object.entries(results)) {
  console.log('  ' + tk.padEnd(10) + Object.entries(R).map(([k, v]) => (v ? ' ✔' : ' ✖') + k).join('  '));
}
const misses = Object.values(results).reduce((a, R) => a + Object.values(R).filter(v => !v).length, 0);
console.log(misses === 0 ? '全部完成 ✔' : `有 ${misses} 项未完成(✖),可重跑或按提示手动补。`);
console.log('==========================================');
await ctx.close();

/* ============ 自动打开 Price Range Dashboard ============ */
if (process.platform === 'win32' && fs.existsSync(APP_HTML)) {
  log('正在打开 Price Range Dashboard……浏览器里点「重连上次文件夹」→「允许」即可载入最新数据(首次使用请点「连接文件夹」选择 Assets)。');
  exec(`start "" "${APP_HTML}"`);
} else {
  log('完成。打开仪表盘 → 连接文件夹/重新扫描 即可。');
}
