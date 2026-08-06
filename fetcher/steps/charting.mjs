/* steps/charting.mjs — 第 7 步:Charting 日线导出(尽力开启成交量序列 / 5 年跨度 / OHLC)
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { clickTextInFrames, page } from '../lib/browser.mjs';
import { dumpChartDiag } from '../lib/chart-diag.mjs';
import { BASE, WANT_5Y, WANT_OHLC, WANT_VOLUME, WANT_YEARS, assetPath, volState } from '../lib/config.mjs';
import { phase } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';

export function xlsxHasVolume(file) {
  try {
    const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
    for (const sn of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
      const hdr = (aoa[0] || []).map(c => String(c || '').trim());
      if (hdr.some(h => / - Volume$/i.test(h) || /^volume$/i.test(h))) return true;
    }
  } catch {}
  return false;
}

/** 列名匹配:FactSet 导出写成 "NVIDIA Corp - Close",手搭的表可能只写 "Close"。
 *  两种都认,但**只认这两种** —— "52 Week High" 里也有 High,那不是当天的最高价,
 *  把它算进来等于凭空多出三列不存在的日内数据,比没有 OHLC 危险得多。 */
const hasCol = (hdr, word) => hdr.some(h => new RegExp('(^| - )' + word + '$', 'i').test(h));

/** 开/高/低三列齐了才算 OHLC。缺一列就不算:少了 Low 的"K 线"画不出下影线,
 *  真实波幅也算不出来 —— 那不是"部分可用",那是另一种东西。Close 眼下一直都有,不作为判据。 */
export function xlsxHasOHLC(file) {
  try {
    const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
    for (const sn of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
      const hdr = (aoa[0] || []).map(c => String(c || '').trim());
      if (hasCol(hdr, 'Open') && hasCol(hdr, 'High') && hasCol(hdr, 'Low')) return true;
    }
  } catch {}
  return false;
}

/* Excel 的日期落到 sheet_to_json 里通常是序列号(1900 体系,25569 = 1970-01-01)。
 * 上下界不是洁癖:价格、成交量也是数字,不设界的话 178.26 会被读成 1900 年的某一天,
 * 于是"跨度 126 年"这种荒谬结论会以一个合法数字的样子混过去。 */
const SERIAL_MIN = 20000, SERIAL_MAX = 80000;   // 约 1954-10 ~ 2119-01
function cellDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
  if (typeof v === 'number') {
    if (!(v >= SERIAL_MIN && v <= SERIAL_MAX)) return null;
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);              // 美式 MM/DD/YYYY,FactSet 导出偶尔这么写
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/**
 * 读出这份导出真正覆盖的时间轴:{ rows, first, last, years },读不出返回 null。
 *
 * 返回 null 和返回 "1 年" 必须是两件事。上一次栽跟头就栽在这儿:
 * "没有证据"和"证据表明是坏的"被同一个分支吞掉,于是屏幕上什么都没说,人以为一切正常。
 * 所以这里宁可交出 null 让调用方单独喊一嗓子,也不假装 0 年。
 */
export function xlsxDateSpan(file) {
  try {
    const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
    for (const sn of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
      if (!aoa.length) continue;
      const hdr = (aoa[0] || []).map(c => String(c == null ? '' : c).trim());
      /* 先按表头找;找不到就退到第 0 列 —— 改版改掉表头文案的概率,远大于把日期挪出第一列 */
      let di = hdr.findIndex(h => /^date\b/i.test(h));
      if (di < 0) di = 0;
      const days = [];
      for (let i = 1; i < aoa.length; i++) {
        const d = cellDate((aoa[i] || [])[di]);
        if (d) days.push(d);
      }
      if (days.length < 2) continue;
      days.sort();
      const first = days[0], last = days[days.length - 1];
      const years = (Date.parse(last) - Date.parse(first)) / (365.2425 * 86400000);
      return { rows: days.length, first, last, years };
    }
  } catch {}
  return null;
}

/** 跨度够不够。留半年余量:5Y 布局按自然日切出来通常是 4.98 年上下,卡死 5.0 会把成功判成失败 */
export function spanOK(span) { return !!span && span.years >= WANT_YEARS - 0.5; }

/** 把跨度判定写成一句可断言的话。三种情形必须在措辞上就分得开:
 *  读不出(未知)/ 够长 / 不够长 —— 合成一个 boolean 就是重蹈"没证据 = 没问题"的覆辙。 */
export function spanNote(span) {
  if (!span) return '跨度未知';
  if (spanOK(span)) return `跨度 ${span.years.toFixed(1)} 年`;
  /* "仍是 1 年"这句话只在真的是一年时才说。实测 SPCX 那份只有 36 行、不到两个月 ——
   * 那是新上市、历史本来就短,不是布局没切成;把它也报成"仍是 1 年"就是拿一句现成的结论盖住一个不同的事实。 */
  if (span.years >= 0.8 && span.years < 1.5) return '跨度仍是 1 年';
  return `跨度只有 ${span.years.toFixed(1)} 年`;
}

/* 下面这几张候选清单原本是写在 for 循环里的字面量数组。**内容和顺序一个字都没动**,
 * 只是提到模块顶层,好让失败诊断能把"我找的是这几个词"原样报给用户 ——
 * 抄一份到诊断代码里迟早会跟这里说岔,而说岔的诊断比没有诊断更坏。
 * --selftest 里有断言逐字钉住这几张表的内容与顺序。 */
export const VOL_MENUS = ['Studies', 'Study', 'Indicators', 'Add Study'];
export const RANGE_MENUS = ['Date Range', 'Range', 'Period', 'Time Frame', 'Timeframe', 'Zoom'];
export const OHLC_MENUS = ['Chart Type', 'Chart Style', 'Series Type', 'Style'];
export const OHLC_SERIES_MENUS = ['Series', 'Edit Series', 'Studies', 'Study'];

/** 尽力而为地在图表上打开成交量序列。
 *  FactSet Charting 的工具栏是自绘控件,不同账号保存的布局也不一样,
 *  所以这里试几种常见入口,一种成功就返回;全失败也不抛错 —— 拿不到量只是降级,不该让整步失败。 */
export async function tryEnableVolume() {
  // 入口 1:工具栏上直接有 Volume 开关(title/aria-label 命中)
  for (const f of page.frames()) {
    try {
      const hit = await f.evaluate(() => {
        const cand = [...document.querySelectorAll('[title],[aria-label]')]
          .find(e => /volume/i.test((e.title || '') + ' ' + (e.getAttribute('aria-label') || '')));
        if (!cand) return false;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          cand.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      });
      if (hit) { await page.waitForTimeout(2500); return 'toolbar'; }
    } catch {}
  }
  // 入口 2:先开 Studies / Indicators 菜单,再点里面的 Volume
  for (const menu of VOL_MENUS) {
    if (!(await clickTextInFrames(menu, false))) continue;
    await page.waitForTimeout(1500);
    if (await clickTextInFrames('Volume', false)) { await page.waitForTimeout(2500); return 'menu:' + menu; }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return null;
}

/** 在所有 frame 里找一个 title/aria-label 命中 re 的元素,派发完整鼠标事件序列。
 *  抽出来是因为下面三个 try* 各要用一遍,而"自绘控件得发全套 pointer/mouse 事件"
 *  这件事只该在一个地方写对 —— 抄三遍就会有一遍漏掉 pointerdown。 */
async function clickByLabel(re) {
  for (const f of page.frames()) {
    try {
      const hit = await f.evaluate(src => {
        const rx = new RegExp(src, 'i');
        const cand = [...document.querySelectorAll('[title],[aria-label]')]
          .find(e => rx.test((e.title || '') + ' ' + (e.getAttribute('aria-label') || '')));
        if (!cand) return false;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          cand.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      }, re.source || String(re));
      if (hit) return true;
    } catch {}
  }
  return false;
}

/** 尽力而为地把图表时间跨度切到 5 年。
 *
 *  为什么值得专门写:一年 252 根日线是这个项目所有验收数字的天花板 —— h=63 的回测
 *  只剩约 10 个独立聚类样本,统计上再怎么用力也造不出第 11 个。跨度是**保存在账号布局里**的,
 *  和当年的成交量一模一样,所以处理方式也一模一样:试几个入口,成了返回是哪个,全败返回 null,不抛错。
 *
 *  入口顺序按"代价从小到大"排,不是按"最可能成功"排:
 *   1. 区间快捷条(1D 1M 6M YTD 1Y 5Y 那一排)—— 一次点击、不弹面板,点错了也没有要收拾的状态;
 *   2. 时间区间下拉 —— 会弹面板,失败要按 Esc 收回来,否则挡住后面找下载按钮;
 *   3. 起始日期输入框 —— 唯一会**改写文本**的入口,猜错了会把图表留在一个奇怪的区间里,
 *      再点一下也回不去,所以只能垫底。
 *  注意返回值只说明"点着了什么",不说明"生效了没有" —— 生效与否一律以下载回来的文件为准。 */
export const RANGE_LABELS = ['5Y', '5 Years', '5 Year', '5Yr', '5yr'];
export async function trySetRange5Y() {
  // 入口 1:区间快捷条上的 5Y 按钮(文字节点)
  for (const lab of RANGE_LABELS) {
    if (await clickTextInFrames(lab, false)) { await page.waitForTimeout(2500); return 'range:' + lab; }
  }
  // 入口 1b:同一排按钮有时压根没有文字节点,只有 title/aria-label
  if (await clickByLabel(/\b5\s*(y|yr|years?)\b/)) { await page.waitForTimeout(2500); return 'toolbar'; }
  // 入口 2:先开时间区间下拉,再在里面点 5Y
  for (const menu of RANGE_MENUS) {
    if (!(await clickTextInFrames(menu, false))) continue;
    await page.waitForTimeout(1500);
    for (const lab of RANGE_LABELS) {
      if (await clickTextInFrames(lab, false)) { await page.waitForTimeout(2500); return 'menu:' + menu; }
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  // 入口 3:往起始日期输入框里打五年前的日期
  const back = new Date(Date.now() - Math.round(WANT_YEARS * 365.2425) * 86400000);
  const iso = back.toISOString().slice(0, 10);
  const us = `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  for (const f of page.frames()) {
    try {
      const hit = await f.evaluate(([isoV, usV]) => {
        const looksDate = s => /^\s*\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\s*$/.test(s || '');
        const metaOf = e => [e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.name, e.id, e.title]
          .filter(Boolean).join(' ');
        const inputs = [...document.querySelectorAll('input')].filter(e => !e.disabled && !e.readOnly);
        const isEnd = e => /\bend\b|\bto\b|through|thru|until/i.test(metaOf(e));
        const isDateish = e => (e.type || '').toLowerCase() === 'date' || /date/i.test(metaOf(e)) || looksDate(e.value);
        /* 只认**明确写着自己是起点**的那个框。这一条松不得:
         * 这个页面上第一个 input 是代码搜索框,往里面写日期等于把图表切到别的标的去;
         * 而写进"终点"框就更糟 —— 图表会退回到五年前那一天,当前价直接从数据里消失。 */
        let cand = inputs.find(e => /start|from|begin/i.test(metaOf(e)) && isDateish(e));
        if (!cand) {
          /* 退一步:没写清楚起终点时,只在**整页恰好只有一个** type=date 且没写着终点的框时才敢动它。
           * 有两个就意味着有起有终,这时候猜哪个是起点,猜错的代价比不改跨度大得多。 */
          const bare = inputs.filter(e => (e.type || '').toLowerCase() === 'date' && !isEnd(e));
          if (bare.length === 1) cand = bare[0];
        }
        if (!cand) return false;
        /* 按它原来的写法填,别把 ISO 硬塞进一个显示 MM/DD/YYYY 的框里 */
        const val = ((cand.type || '').toLowerCase() === 'date' || /^\d{4}-/.test(cand.value || '')) ? isoV : usV;
        const proto = Object.getPrototypeOf(cand);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        cand.focus();
        if (setter) setter.call(cand, val); else cand.value = val;   // 绕过 React 的受控值缓存
        cand.dispatchEvent(new Event('input', { bubbles: true }));
        cand.dispatchEvent(new Event('change', { bubbles: true }));
        for (const type of ['keydown', 'keypress', 'keyup']) {
          cand.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
        cand.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      }, [iso, us]);
      if (hit) { await page.waitForTimeout(3000); return 'startdate'; }
    } catch {}
  }
  return null;
}

/** 尽力而为地把序列从"只有收盘价的线"切成 OHLC / K 线。
 *
 *  为什么必须换图表类型而不是"多勾几列":开/高/低不是导出选项,是**序列本身的形态**。
 *  线图在 FactSet 眼里每天只有一个数,所以导出永远只有 Close —— 这不是导出少给了,是图里就没有。
 *
 *  入口顺序同样按代价排:先试工具栏上直接摆着的 K 线按钮(一次点击),
 *  再试写着 Chart Type 的下拉,最后才动 Series/Studies —— 那是最深的一层,
 *  面板留在屏幕上会挡住后面找下载按钮,所以失败必须 Esc 收回来。
 *  菜单里的候选按 Candlestick → OHLC → Bar 排:前两个词义唯一,Bar 太短容易撞上别的按钮,
 *  所以只在**已经打开的图表类型菜单里**才敢点它,绝不拿它做全页文本搜索。 */
export const OHLC_LABELS = ['Candlestick', 'Candle', 'OHLC', 'Bar'];
export async function tryEnableOHLC() {
  // 入口 1:工具栏上直接有 K 线 / OHLC 按钮(title/aria-label 命中)
  if (await clickByLabel(/candlestick|\bohlc\b/)) { await page.waitForTimeout(2500); return 'toolbar'; }
  // 入口 2:图表类型下拉 → 里面挑一种带 OHLC 的画法
  /* 候选里不放光秃秃的 "Type":它太常见了,页面上随便一个表头都叫这个,
   * 点开的多半不是图表类型菜单,而接下来那几个 Candlestick/Bar 就会在错误的面板里乱点。 */
  for (const menu of OHLC_MENUS) {
    if (!(await clickTextInFrames(menu, false))) continue;
    await page.waitForTimeout(1500);
    for (const lab of OHLC_LABELS) {
      if (await clickTextInFrames(lab, false)) { await page.waitForTimeout(2500); return 'menu:' + menu; }
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  // 入口 3:Series / Studies 那一层(最深,也最容易把面板留在屏幕上)
  for (const menu of OHLC_SERIES_MENUS) {
    if (!(await clickTextInFrames(menu, false))) continue;
    await page.waitForTimeout(1500);
    for (const lab of OHLC_LABELS) {
      if (await clickTextInFrames(lab, false)) { await page.waitForTimeout(2500); return 'series:' + menu; }
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return null;
}

/** 失败诊断要报告"我找的是这几个词"。这张表就是上面四组候选的**同一批引用**,
 *  不是抄写 —— 抄一份出来,改了那边忘了这边,诊断就会理直气壮地报错话。 */
export const CHART_PROBES = [
  ['时间跨度 · 快捷条/菜单项', RANGE_LABELS],
  ['时间跨度 · 菜单入口', RANGE_MENUS],
  ['K 线 · 图表类型选项', OHLC_LABELS],
  ['K 线 · 图表类型菜单入口', OHLC_MENUS],
  ['K 线 · Series 层菜单入口', OHLC_SERIES_MENUS],
  ['成交量 · 菜单入口', VOL_MENUS],
];

export async function fetchCharting(ticker, outName) {
  phase('导航');
  await page.goto(`${BASE}/workstation/charting/`, { waitUntil: 'domcontentloaded' });
  phase('等待页面');
  const ch = page.frameLocator('iframe[src*="/charting/"]');
  const box = ch.locator('input').first();
  await box.waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  phase('定位表格');   // 此处"表格"= 图表搜索框 + 下载菜单
  await box.click(); await box.fill(ticker); await box.press('Enter');
  await page.waitForTimeout(6000);
  /* 三个布局动作的顺序是有讲究的:先区间、再图表类型、最后才加成交量。
   * 换图表类型往往会把序列整个重建一遍,顺手把刚挂上去的 Volume 研究一起带走;
   * 反过来则不会 —— 所以"最容易被别人抹掉的那个"放在最后做。
   * 三个都是尽力而为:返回值只说明点着了什么入口,成没成一律等下载回来的文件说话。 */
  /* 三个 via 提到外面:它们是失败诊断的一半 —— "一个入口都没点着"和
   * "点着了 Chart Type 但导出还是只有收盘价"要采取的下一步动作完全不同,
   * 前者是词猜错了,后者是词对了但那个菜单不是我以为的那个。 */
  let via5y = null, viaOhlc = null, viaVol = null;
  /* 时间跨度:5 年最好(h=63 的回测才有够用的独立样本),拉不长就还是一年,不阻断本步 */
  if (WANT_5Y) {
    via5y = await trySetRange5Y().catch(() => null);
    if (via5y) log(`    · 已尝试把时间跨度切到 5 年(${via5y})`);
  }
  /* K 线:切成 OHLC 才会多出开/高/低三列;切不动就还是只有收盘价,不阻断本步 */
  if (WANT_OHLC) {
    viaOhlc = await tryEnableOHLC().catch(() => null);
    if (viaOhlc) log(`    · 已尝试切换到 OHLC / K 线(${viaOhlc})`);
  }
  /* 成交量:开着最好(仪表盘的压力位会用真实筹码分布),开不了就降级用停留时间,不阻断本步 */
  if (WANT_VOLUME) {
    viaVol = await tryEnableVolume().catch(() => null);
    if (viaVol) log(`    · 已尝试开启成交量序列(${viaVol})`);
  }
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
  if (!opened) throw new Error('未找到下载按钮(Charting 工具栏改版)');
  await page.waitForTimeout(1000);
  phase('写文件');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    clickTextInFrames('Download data to Excel', false),
  ]);
  const f = assetPath(outName || `${ticker} Daily Charting.xlsx`);
  await download.saveAs(f);
  /* 三项一律以文件内容为准,不以"点击是否成功"为准 —— 上面那三个 try* 只会说自己点着了什么。 */
  const vol = xlsxHasVolume(f);
  const span = xlsxDateSpan(f);
  const ohlc = xlsxHasOHLC(f);
  volState.set(path.basename(f), vol);
  log(`  ✔ ${path.basename(f)}(${spanNote(span)}${span ? '/' + span.rows + ' 行' : ''} · `
    + `${vol ? '含成交量' : '无成交量列'} · ${ohlc ? '含 OHLC' : '仅收盘价'})`);
  if (!vol && WANT_VOLUME) {
    log('    ℹ 没抓到成交量 → 压力位会退回"停留时间"口径(仍可用,只是权重钝一些)。');
    log('       想要真实筹码分布:在 FactSet Charting 里手动给图表加一条 Volume 序列并保存布局,下轮即自动带上。');
  }
  /* 跨度:"读不出"和"只有一年"分开说。前者是这份文件根本没被验证过,
   * 后者是验证过了、结论是不够长 —— 把它们并成一句"跨度不足"就等于又把没证据当成了没问题。 */
  if (!span) {
    log('    ⚠ 读不出日期列 → 这一份的时间跨度**没有被验证过**,不是"验证过、跨度不够"。');
    log('       多半是导出格式变了(日期列改了名或挪了位置)。请打开这个 xlsx 看一眼第一列,再回来改 xlsxDateSpan。');
  } else if (!spanOK(span) && WANT_5Y) {
    /* 措辞只有一处 —— 就是 spanNote。在这儿另写一句"仍然只有一年",迟早会和它说岔 */
    log(`    ℹ 自动切 5 年没有生效 —— ${spanNote(span)}(${span.rows} 行,${span.first} → ${span.last})。`);
    log('       后果很实在:h=63 的回测只剩约 10 个独立样本,项目里每一个验收数字都被这一条卡着。');
    log('       想要 5 年:在 FactSet Charting 里把图表时间跨度手动改成 5Y,再保存布局(Layout → Save),下轮即自动带上。');
    if (span.years < 0.8) log('       (这一份短得不像布局问题,更像新上市 —— 那样的话再怎么设 5Y 也只有这么多,不必折腾。)');
  }
  /* K 线同理:没有 Open/High/Low 就是没有,不许用"有收盘价"糊过去 */
  if (!ohlc && WANT_OHLC) {
    log('    ℹ 自动切 K 线没有生效 —— 导出仍然只有收盘价,没有 Open/High/Low 三列。');
    log('       后果:蜡烛图画不出来,日内真实波幅(ATR 那一类)也无从算起。');
    log('       想要 K 线:在 FactSet Charting 里把图表类型手动改成 Candlestick(或 OHLC),再保存布局(Layout → Save),下轮即自动带上。');
  }
  /* 只要 5Y / OHLC 有一项没到位,就把图表工具栏上**真实的文案**倒进 Assets/_logs/chart-diag-*.log。
   *
   * 为什么必须自动倒、而不是留一句"失败了请手动检查":trySetRange5Y / tryEnableOHLC 里的
   * 那几组词是**猜的**,没人在真界面上验过。让用户复述"我看到了什么"永远得不到 DOM 里的原文,
   * 而原文正是把猜测变成事实所需的唯一东西。倒一次,选择器就不用再猜第二次。
   *
   * 成交量不单独触发:它已经有一条走通过的路,失败多半是账号布局问题而不是选择器问题;
   * 但如果因为别的原因倒了日志,顺手把它的候选也一并报出来 —— 反正扫都扫了。
   *
   * 整句 await 不加 try:dumpChartDiag 自己保证不抛(见 lib/chart-diag.mjs 顶部第 1 条规矩)。
   * 在这儿再包一层 try 反而会把"它其实会抛"这件事永久藏起来。 */
  if ((WANT_5Y && !spanOK(span)) || (WANT_OHLC && !ohlc)) {
    await dumpChartDiag({
      ticker, file: path.basename(f),
      via: { '5Y': via5y, OHLC: viaOhlc, 成交量: viaVol },
      verdict: {
        '5Y': spanNote(span) + (span ? `(${span.rows} 行,${span.first} → ${span.last})` : ''),
        OHLC: ohlc ? '含 Open/High/Low' : '只有收盘价',
        成交量: vol ? '含成交量列' : '无成交量列',
      },
      probes: CHART_PROBES,
    });
  }
  return true;
}

/** Targets & Ratings 的 History 视图表格(月度:评级分布/覆盖家数/目标价均值) */
