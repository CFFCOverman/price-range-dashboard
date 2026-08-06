/* 任务 #62 交付证据:用无头 chromium 打开**构建产物**,证明价格走势面板真的画出来了。
 * 只读,不改任何 src/ 代码;两条路径各跑一遍:
 *   A) 降级路径(主路径):喂真实的 Assets/charting/*.xlsx —— 盘上今天没有 OHLC,应当画收盘折线。
 *   B) 蜡烛路径:页面内用构造的 O/H/L 夹具喂 ingestChartingSheet —— 今天无真实数据可验,只能这样。
 * 用法: node tools/scratch/k62-panel-probe.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const APP = 'file://' + path.join(ROOT, 'price-range-dashboard.html');
const XLSX_PATH = ['node_modules', 'fetcher/node_modules']
  .map(d => path.join(ROOT, d, 'xlsx/dist/xlsx.full.min.js'))
  .find(p => fs.existsSync(p));

const TK = 'NVDA-US';
const files = [path.join(ROOT, 'Assets/summary/companies.csv'),
  path.join(ROOT, `Assets/charting/${TK} Daily Charting.xlsx`)].filter(fs.existsSync);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
await page.goto(APP);
if (XLSX_PATH) await page.addScriptTag({ path: XLSX_PATH }).catch(() => {});
await page.waitForFunction(() => typeof renderCandles === 'function');

/* SVG 里到底有什么:元素按标签计数 + 关键类名计数 + 面板文案 + 填色去重 */
const probe = () => page.evaluate(() => {
  const sec = document.getElementById('klSec');
  const svg = document.querySelector('#klChart svg');
  const tags = {};
  if (svg) for (const n of svg.querySelectorAll('*')) tags[n.tagName] = (tags[n.tagName] || 0) + 1;
  const bodies = svg ? [...svg.querySelectorAll('rect.klbody')] : [];
  const line = svg ? svg.querySelector('path.klline') : null;
  return {
    secHidden: sec.hidden,
    secVisible: !!sec.offsetParent,
    svgPresent: !!svg,
    svgBox: svg ? (r => ({ w: Math.round(r.width), h: Math.round(r.height) }))(svg.getBoundingClientRect()) : null,
    ariaLabel: svg ? svg.getAttribute('aria-label') : null,
    tagCounts: tags,
    bodies: bodies.length,
    wicks: svg ? svg.querySelectorAll('line.klwick').length : 0,
    klline: svg ? svg.querySelectorAll('path.klline').length : 0,
    kllinePts: line ? (line.getAttribute('d').match(/[ML]/g) || []).length : 0,
    kllineHead: line ? line.getAttribute('d').slice(0, 60) : null,
    bodyFills: [...new Set(bodies.map(r => r.getAttribute('fill')))],
    bodyHeights: bodies.slice(0, 5).map(r => +r.getAttribute('height')),
    bodyXs: bodies.slice(0, 3).map(r => +r.getAttribute('x')),
    texts: svg ? [...svg.querySelectorAll('text')].map(x => x.textContent).slice(0, 6) : [],
    legend: document.getElementById('klLegend').textContent.replace(/\s+/g, ' ').trim(),
    note: [...document.querySelectorAll('#klNote .plnl')].map(p => p.textContent.replace(/\s+/g, ' ').trim()),
    tabs: [...document.querySelectorAll('#klWinTabs button')].map(b => b.dataset.klw + (b.classList.contains('on') ? '*' : '')),
    barsInState: (state.priceHist.get(state.selected) || []).length,
    ohlcInState: (state.priceHist.get(state.selected) || []).filter(d => d.o > 0).length,
  };
});
const show = (tag, p) => {
  console.log(`\n===== ${tag} =====`);
  console.log('  #klSec hidden=%s 可见=%s   svg=%s  尺寸=%o', p.secHidden, p.secVisible, p.svgPresent, p.svgBox);
  console.log('  aria-label:', p.ariaLabel);
  console.log('  SVG 元素标签计数:', JSON.stringify(p.tagCounts));
  console.log('  rect.klbody=%d  line.klwick=%d  path.klline=%d (折线顶点=%d)', p.bodies, p.wicks, p.klline, p.kllinePts);
  if (p.kllineHead) console.log('  折线 d 开头:', p.kllineHead, '…');
  if (p.bodies) console.log('  实体填色去重=%o  前5根高度=%o  前3根 x=%o', p.bodyFills, p.bodyHeights, p.bodyXs);
  console.log('  轴文本(前6):', JSON.stringify(p.texts));
  console.log('  窗口档:', p.tabs.join(' '));
  console.log('  图例:', p.legend);
  for (const l of p.note) console.log('  正文:', l);
  console.log('  state 里的根数=%d,其中带 OHLC 的=%d', p.barsInState, p.ohlcInState);
};

/* ============ A) 真实导出 → 降级路径(主路径) ============ */
await page.setInputFiles('#fileInput', files);
await page.waitForFunction(t => state.priceHist.has(t) && state.priceHist.get(t).length > 100, TK, { timeout: 60000 });
await page.evaluate(t => { state.selected = t; renderAll(); }, TK);
await page.waitForTimeout(200);
show(`A 真实文件 ${TK} Daily Charting.xlsx(默认 120 根窗口)`, await probe());
await page.locator('#klSec').screenshot({ path: path.join(DIR, 'k62-panel-A-line-real.png') });

/* 切到 all 档:窗口按钮真的重画(顶点数应变成全序列长度) */
await page.evaluate(() => document.querySelector('#klWinTabs button[data-klw="all"]').click());
await page.waitForTimeout(150);
show('A2 同一份真实数据,窗口切到 all', await probe());
await page.evaluate(() => document.querySelector('#klWinTabs button[data-klw="w120"]').click());

/* ============ B) 构造 OHLC → 蜡烛路径 ============ */
await page.evaluate(() => {
  state.companies.clear(); state.history.clear(); state.priceHist.clear();
  state.overrides.clear(); state.roster = null; state.showOffRoster = false;
  const D = i => new Date(Date.UTC(2025, 7, 1) + i * 86400000).toISOString().slice(0, 10);
  /* 正弦 + 漂移:涨跌两种实体都要出现,否则填色去重只会看到一种颜色 */
  const rows = [['Date', 'Probe Co - Close', 'Probe Co - Open', 'Probe Co - High', 'Probe Co - Low', 'Probe Co - Volume']];
  for (let i = 0; i < 150; i++) {
    const c = 100 + i * 0.25 + Math.sin(i / 6) * 9;
    const o = 100 + (i - 1) * 0.25 + Math.sin((i - 1) / 6) * 9;
    rows.push([D(i), +c.toFixed(2), +o.toFixed(2), +(Math.max(c, o) + 2.5).toFixed(2), +(Math.min(c, o) - 2.5).toFixed(2), 1e6 + i]);
  }
  ingestChartingSheet('s', rows, 'PRB-US Daily Charting.xlsx');
  state.selected = 'PRB-US';
  const co = state.companies.get('PRB-US');
  co.price = state.priceHist.get('PRB-US').slice(-1)[0].price;
  co.currency = 'USD'; co.eps = { fy1: { low: 4, mean: 5, high: 6 }, fy2: null };
  renderAll();
});
await page.waitForTimeout(200);
show('B 构造 OHLC 夹具(150 根,窗口 120)', await probe());
await page.locator('#klSec').screenshot({ path: path.join(DIR, 'k62-panel-B-candle-fixture.png') });

console.log('\n页面错误:', errs.length ? errs : '(无)');
console.log('截图: tools/scratch/k62-panel-A-line-real.png, tools/scratch/k62-panel-B-candle-fixture.png');
await browser.close();
