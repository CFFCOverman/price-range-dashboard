/* steps/options.mjs — 第 6 步:期权链未平仓量 OI
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { clickTextInFrames, page } from '../lib/browser.mjs';
import { today } from '../lib/companies.mjs';
import { BASE, FETCHER_DIR, assetPath } from '../lib/config.mjs';
import {
  FQL_BATCH, FQL_PATH, OC_PATH, OPT_API_MAX_CONTRACTS,
  assembleOptionRows, chunk, optApiVerdict, parseFqlValues, parseOptionChainTable, pickChainContracts,
} from '../lib/fql.mjs';
import { phase } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { optionsUrlCandidates, saveOptUrlTemplate } from '../lib/options-url.mjs';
import { mergeOptionSnapshots, OPT_EXTRA_FIELDS } from '../lib/opt-store.mjs';
import { csvCell, newsMonth, pad2, splitCsvLine } from './news.mjs';

/* ============ 期权链未平仓量(OI)—— 压力位面板的第三轨 ============
 * 前两轨(成交筹码 / 估值分位)都是回望的,期权 OI 是唯一前瞻的一轨:现在的钱押在哪个行权价。
 * 位置要记牢:期权页是与 **Company 平级的顶层页签**(和 Charting 一样),不是 Company 里的子页签,
 * 所以它不带公司上下文,要在页面自己的搜索框里输代码。地址解析与记忆见 lib/options-url.mjs。
 * 这一步是"尽力而为"的:不同账号权限下路径与表格结构都可能不同,
 * 所以下面按候选地址逐个试、表格按表头语义定位(而不是写死列号),失败只登记台账、不阻断整轮。
 * 解析器本身是纯函数(parseOptionRows),--selftest 里有可手算的断言;
 * 真正不确定的只有"页面长什么样",第一轮真跑时看日志里打印的候选 URL 命中情况就能收敛。 */
/* 累积上限与保留期都搬到了 lib/opt-store.mjs(OPT_CSV_MAX / OPT_RETAIN_DAYS)——
 * 一个数字只许有一处定义,不然改了一处忘了另一处,滚存就会按两个不同的规矩来。 */
/** 月度期权到期日 = 当月第三个周五(FactSet 有时只给 "Aug '26" 这种粒度) */
export function thirdFriday(y, m) {
  const d = new Date(Date.UTC(y, m - 1, 1));
  const shift = (5 - d.getUTCDay() + 7) % 7;          // 到第一个周五
  return new Date(Date.UTC(y, m - 1, 1 + shift + 14)).toISOString().slice(0, 10);
}
/** 各种到期日写法 → YYYY-MM-DD;认不出返回 null(宁可丢一行,也不要造一个错日期) */
export function parseOptExpiry(s, ref) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  const yr = t => (t.length === 2 ? 2000 + +t : +t);
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return v;
  m = v.match(/^(\d{1,2})\s+([A-Z][a-z]{2})[a-z]*\.?\s*'?(\d{2,4})$/);            // 21 Aug '26
  if (m && newsMonth(m[2])) return `${yr(m[3])}-${pad2(newsMonth(m[2]))}-${pad2(+m[1])}`;
  m = v.match(/^([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s*'?(\d{2,4})$/);          // Aug 21, 2026
  if (m && newsMonth(m[1])) return `${yr(m[3])}-${pad2(newsMonth(m[1]))}-${pad2(+m[2])}`;
  m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);                           // 08/21/26(美式月在前)
  if (m) return `${yr(m[3])}-${pad2(+m[1])}-${pad2(+m[2])}`;
  m = v.match(/^([A-Z][a-z]{2})[a-z]*\.?\s*'?(\d{2,4})$/);                        // Aug '26 → 当月第三个周五
  if (m && newsMonth(m[1])) return thirdFriday(yr(m[2]), newsMonth(m[1]));
  return null;
}
/** "12,345" / "1.2K" / "-" / "" → 数字或 NaN */
export function parseOptNum(s) {
  const v = String(s ?? '').replace(/[,\s$]/g, '');
  if (!v || /^-+$/.test(v) || /^n\/?a$/i.test(v)) return NaN;
  const m = v.match(/^(-?[\d.]+)([KkMm])?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return NaN;
  return m[2] ? n * (/[Kk]/.test(m[2]) ? 1e3 : 1e6) : n;
}
/** 抓到的表格行 → [{expiry, strike, call_oi, put_oi}]
 * 列位置靠表头语义定位:Strike 左边最近的 Open Int 是看涨,右边第一个是看跌
 * (FactSet 期权链的标准排布:calls | strike | puts)。
 * 到期日可能在独立的分组行里(逐行继承),也可能是每行一列(Expiration)。 */
export function parseOptionRows(rows, ref) {
  const out = [];
  let idx = null, curExp = null, sawStrike = false;
  const oiRe = /open\s*int|^oi$|^o\.?i\.?$/;
  for (const r of rows || []) {
    if (!r || !r.length) continue;
    const cells = r.map(c => String(c ?? '').trim());
    const low = cells.map(c => c.toLowerCase());
    const si = low.findIndex(c => /^strike/.test(c));
    const oiCols = low.map((c, i) => (oiRe.test(c) ? i : -1)).filter(i => i >= 0);
    if (si >= 0 && oiCols.length) {                       // 表头行
      sawStrike = true;
      const left = oiCols.filter(i => i < si), right = oiCols.filter(i => i > si);
      idx = {
        strike: si,
        call: left.length ? left[left.length - 1] : -1,   // 取紧挨 strike 的那一列
        put: right.length ? right[0] : -1,
        exp: low.findIndex(c => /expir|^exp\b/.test(c)),
        type: low.findIndex(c => /^type$|call\/put|^c\/p$|^p\/c$/.test(c)),
        oi: oiCols[0], single: oiCols.length === 1,
      };
      continue;
    }
    const nNum = cells.filter(c => isFinite(parseOptNum(c))).length;
    if (nNum <= 1) {                                      // 分组行:只写了个到期日
      for (const c of cells) {
        const e = parseOptExpiry(c, ref);
        if (e) { curExp = e; break; }
      }
      continue;
    }
    if (!idx) continue;
    const expiry = idx.exp >= 0 ? parseOptExpiry(cells[idx.exp], ref) : curExp;
    const strike = parseOptNum(cells[idx.strike]);
    if (!expiry || !isFinite(strike) || strike <= 0) continue;
    let call = NaN, put = NaN;
    if (idx.single && idx.type >= 0) {                    // 单栏布局:靠 Type 列区分买权/卖权
      const v = parseOptNum(cells[idx.oi]);
      if (/^c/i.test(cells[idx.type])) call = v; else put = v;
    } else {                                              // calls | strike | puts 标准排布
      if (idx.call >= 0) call = parseOptNum(cells[idx.call]);
      if (idx.put >= 0) put = parseOptNum(cells[idx.put]);
    }
    if (!isFinite(call) && !isFinite(put)) continue;
    out.push({ expiry, strike, call_oi: isFinite(call) ? Math.round(call) : 0, put_oi: isFinite(put) ? Math.round(put) : 0 });
  }
  /* 同一 (到期日, 行权价) 可能被单栏布局拆成两行,合并回一行 */
  const merged = new Map();
  for (const r of out) {
    const k = r.expiry + '|' + r.strike, p = merged.get(k);
    if (p) { p.call_oi = Math.max(p.call_oi, r.call_oi); p.put_oi = Math.max(p.put_oi, r.put_oi); }
    else merged.set(k, r);
  }
  const arr = [...merged.values()].sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike));
  return { rows: arr, sawStrike };
}
/* ============ 走导出,而不是刮屏 ============================================
 * 2026-07-30 改的。原因不是"刮屏不优雅",是**刮屏在这一页上读不全**:
 * Options Montage 的表格是虚拟滚动的,DOM 里永远只有视口内那二十来行。
 * 于是 scrapeOptionChain 每轮兴高采烈地交回 20 个行权价、写进 csv、台账记"成功",
 * 而压力位面板拿这 20 行去算 max pain 和 OI 墙 —— 算得一本正经,结论毫无意义。
 * 这和空头持仓那一轮是同一类错误:**读到了不等于读全了**,而少读不会报警。
 *
 * 导出文件把这个问题从根上拿掉:一次拿到该月全部行权价、call/put 两边、到期日精确到天。
 * 实测三份真导出(NVDA / SPCX ×2)结构完全一致,21 列固定表头:
 *   A 列          分组行 "Options Expiring: July 2026",其余列全空 —— 跳过
 *   Call Open Interest / Put Open Interest / Expiration Date / Strike Price / Root Symbol
 * 列一律**按表头名认**,不写死列号:列号会因为你在页面上加减字段而漂移,表头名不会。
 *
 * sheet 名是 `NVDA-USA_20260728` —— **标的和快照日期都写在里面**。
 * 这一条比原来的 pageMentionsTicker 硬得多:后者只是问"页面上有没有这几个字母",
 * 而这里是文件自己声明它是谁、是哪天的。对不上就整份拒收,不允许把别人的链混进来。
 *
 * 导出有个硬限制,踩过才知道:**一次最多 500 份合约**(= 行权价 × 2)。
 * 超了不会给你一个截断的文件,而是弹一句 "More than 500 contracts to download…" 然后**什么都不给**。
 * 所以下载时要按月份页签分开下,并且把行权价收进 "% from At-the-Money = 25" ——
 * 这个 25 不是随便选的,它和仪表盘 OPT_WINDOW = 0.25 是同一个数,离得再远的行权价本来也不参与计算。
 */
export const OPT_EXPORT_GLOB = /^optionsMontage_.+\.xlsx$/i;
/** 导出文件多久之前的就不要了:OI 是存量,但一个月前的存量说明不了今天的赌注 */
export const OPT_EXPORT_MAX_AGE_DAYS = 45;
/** 表头名 → 用途。认名字不认列号。 */
export const OPT_EXPORT_COLS = [
  ['call', /^call\s*open\s*interest$/i],
  ['put', /^put\s*open\s*interest$/i],
  ['exp', /^expirat(?:ion)?\s*date$/i],
  ['strike', /^strike\s*(?:price)?$/i],
  ['root', /^root\s*symbol$/i],
];
/** 标的代码 → 裸符号:`NVDA-US` → `NVDA`(导出里写的是 `NVDA-USA`,交易所后缀两边不一样) */
export function optSymOf(ticker) { return String(ticker || '').split('-')[0].trim().toUpperCase(); }
/** sheet 名 `NVDA-USA_20260728` → { sym, exch, asof }。认不出返回 null —— 认不出就不敢用这份文件。 */
export function parseOptSheetName(name) {
  const m = /^([A-Za-z0-9.]+)-([A-Za-z]{2,4})_(\d{4})(\d{2})(\d{2})$/.exec(String(name || '').trim());
  if (!m) return null;
  const asof = `${m[3]}-${m[4]}-${m[5]}`;
  if (+m[4] < 1 || +m[4] > 12 || +m[5] < 1 || +m[5] > 31) return null;
  return { sym: m[1].toUpperCase(), exch: m[2].toUpperCase(), asof };
}
/**
 * 一份导出的二维数组 → { rows, asof, sym, expiries, skipped, badRoot }。
 * 纯函数,--selftest 里拿真导出的前几行做断言。任何一处对不上都返回 { error },**不返回半份数据**。
 *
 * @param sheetName 用来核对身份和取快照日期
 * @param want      期望的裸符号;传了就逐行核对 Root Symbol,对不上的行不要
 */
export function parseOptionsExport(rows, sheetName, want) {
  const id = parseOptSheetName(sheetName);
  if (!id) return { error: `sheet 名「${sheetName}」不是 <代码>-<交易所>_<YYYYMMDD> 的样子,不敢认这份文件是谁的` };
  if (want && id.sym !== optSymOf(want)) {
    return { error: `这份导出是 ${id.sym} 的,不是 ${optSymOf(want)} 的 —— 整份拒收(混链比没数据危险)` };
  }
  const grid = rows || [];
  let idx = null, headerAt = -1;
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const cells = (grid[i] || []).map(c => String(c ?? '').trim());
    const found = {};
    for (const [key, re] of OPT_EXPORT_COLS) {
      const j = cells.findIndex(c => re.test(c));
      if (j >= 0) found[key] = j;
    }
    if (found.call >= 0 && found.put >= 0 && found.strike >= 0 && found.exp >= 0) { idx = found; headerAt = i; break; }
  }
  if (!idx) {
    return { error: '导出里没找到表头(需要 Call Open Interest / Put Open Interest / Expiration Date / Strike Price 四列都在)' };
  }
  const out = [], expSet = new Set();
  let skipped = 0, badRoot = 0;
  for (let i = headerAt + 1; i < grid.length; i++) {
    const cells = (grid[i] || []).map(c => String(c ?? '').trim());
    const strike = parseOptNum(cells[idx.strike]);
    /* 分组行("Options Expiring: August 2026",只有 A 列有字)在这里自然被滤掉,不用专门认它 */
    if (!isFinite(strike) || strike <= 0) { if (cells.some(c => c)) skipped++; continue; }
    const expiry = parseOptExpiry(cells[idx.exp]);
    if (!expiry) { skipped++; continue; }
    /* 逐行身份核对:调整过的合约根符号会带后缀(SPCX1),所以是前缀匹配而不是全等 */
    if (want && idx.root >= 0 && cells[idx.root]) {
      if (!cells[idx.root].toUpperCase().startsWith(optSymOf(want))) { badRoot++; continue; }
    }
    const call = parseOptNum(cells[idx.call]), put = parseOptNum(cells[idx.put]);
    if (!isFinite(call) && !isFinite(put)) { skipped++; continue; }
    expSet.add(expiry);
    out.push({ expiry, strike, call_oi: isFinite(call) ? Math.round(call) : 0, put_oi: isFinite(put) ? Math.round(put) : 0 });
  }
  if (!out.length) return { error: `表头认出来了,但一行都没解析出来(跳过 ${skipped} 行,根符号不符 ${badRoot} 行)` };
  out.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike));
  return { rows: out, asof: id.asof, sym: id.sym, expiries: [...expSet].sort(), skipped, badRoot };
}
/** 到哪儿去找导出文件:环境变量 > fetcher/options-inbox/ > 系统下载目录 */
export function optInboxDirs() {
  const dirs = [];
  if (process.env.FS_OPT_INBOX) dirs.push(process.env.FS_OPT_INBOX);
  dirs.push(path.join(FETCHER_DIR, 'options-inbox'));
  try { dirs.push(path.join(os.homedir(), 'Downloads')); } catch {}
  return dirs.filter((d, i) => d && dirs.indexOf(d) === i);
}
/** 目录里所有像期权导出的文件(不判断是谁的 —— 那要打开 sheet 名才知道) */
export function listOptExports(dirs) {
  const out = [];
  for (const d of dirs || []) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!OPT_EXPORT_GLOB.test(n)) continue;
      try {
        const st = fs.statSync(path.join(d, n));
        if (st.isFile()) out.push({ dir: d, name: n, file: path.join(d, n), mtime: st.mtimeMs });
      } catch {}
    }
  }
  /* 新的排前面:同一个月重复下载过好几次时,后下的那份说了算 */
  return out.sort((a, b) => b.mtime - a.mtime);
}
/** 快照日期够不够新(太旧的 OI 说明不了今天的事) */
export function optExportFresh(asof, ref) {
  const a = Date.parse(String(asof) + 'T00:00:00Z'), r = Date.parse(String(ref || today) + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(r)) return false;
  return (r - a) / 86400000 <= OPT_EXPORT_MAX_AGE_DAYS;
}
/**
 * 把 inbox 里属于这只标的的导出全部读进来并合并。
 * **按月份分开下载是常态**(500 合约上限逼的),所以这里天然是"多份合成一份"。
 * 同一个 (到期日, 行权价) 出现在多份里时,取快照日期较新的那一份。
 */
export function ingestOptExports(ticker, dirs, ref) {
  const sym = optSymOf(ticker);
  const best = new Map();          // "expiry|strike" -> { asof, rec }
  const used = [], rejected = [];
  let latest = null;
  for (const f of listOptExports(dirs || optInboxDirs())) {
    let wb = null;
    /* xlsx 的 ESM 版没有 readFile(它不带 fs 绑定),全仓库统一走 read(readFileSync, buffer) */
    try { wb = XLSX.read(fs.readFileSync(f.file), { type: 'buffer' }); } catch (e) { rejected.push(`${f.name}:读不开(${e.message})`); continue; }
    for (const sheet of wb.SheetNames) {
      const id = parseOptSheetName(sheet);
      if (!id || id.sym !== sym) continue;               // 别人的链,静默跳过(下载目录里什么都有)
      if (!optExportFresh(id.asof, ref)) { rejected.push(`${f.name}:${id.asof} 太旧(超过 ${OPT_EXPORT_MAX_AGE_DAYS} 天)`); continue; }
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: '' });
      const r = parseOptionsExport(grid, sheet, ticker);
      if (r.error) { rejected.push(`${f.name}:${r.error}`); continue; }
      for (const rec of r.rows) {
        const k = rec.expiry + '|' + rec.strike, p = best.get(k);
        if (p && p.asof >= r.asof) continue;
        best.set(k, { asof: r.asof, rec });
      }
      if (!latest || r.asof > latest) latest = r.asof;
      used.push({ file: f.name, sheet, asof: r.asof, rows: r.rows.length, expiries: r.expiries });
    }
  }
  const rows = [...best.values()].map(v => v.rec)
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike));
  return { rows, asof: latest, used, rejected, expiries: [...new Set(rows.map(r => r.expiry))].sort() };
}

/* ============ 主路:直接问 FactSet 自己的数据接口 ==========================
 * 2026-07-30 加的,把"手动导出"这一步整个拿掉了。
 *
 * Options Montage 页面上的表格并不是数据的源头 —— 它自己也是先向两个接口要来的:
 * `/services/IDCServ/oc` 给整条链的目录,`/services/Fql` 按符号批量取数。
 * 我们直接问同样的两个接口,于是三件事同时消失:虚拟滚动读不全、500 合约导不出、要人手点下载。
 * 接口和字段的完整说明在 lib/fql.mjs 顶部,那里的每一个字段名都是实地抄回来的。
 *
 * 这里只负责"碰网络"这几行。解析、筛选、拼装全在 lib/fql.mjs 里,是纯函数,自检覆盖。
 * 分开是有意的:**解析错了自检会红,网络错了台账会红**,两种失败不该缠在一起查。
 *
 * 请求是在页面上下文里用 fetch 发的,不是 Playwright 的 request —— 这样 cookie、
 * 以及 FactSet 在同源请求上依赖的那些东西,全都和你在浏览器里看到的那一份完全一致。
 */
/** 把页面挪回 FactSet 同源页(其它步骤可能把它带到别处去了),不然同源 fetch 发不出去 */
export async function ensureFactsetOrigin() {
  try {
    if (/^https:\/\/my\.apps\.factset\.com\//.test(page.url() || '')) return true;
  } catch {}
  try {
    await page.goto(`${BASE}/workstation/`, { waitUntil: 'domcontentloaded' });
    return /^https:\/\/my\.apps\.factset\.com\//.test(page.url() || '');
  } catch { return false; }
}
/** 在页面上下文里发一个同源 GET,原样把状态码和正文交回来 */
export async function apiGet(pathQuery) {
  return await page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    return { status: r.status, text: await r.text() };
  }, pathQuery);
}
/** 在页面上下文里发一个 FQL 批量取数(POST,表单编码,和页面自己发的那份一模一样) */
export async function apiFql(symbols, exprs) {
  return await page.evaluate(async ([p, syms, ex]) => {
    const body = new URLSearchParams({ symbols: syms.join(','), exprs: ex.join(';;') });
    const r = await fetch(p, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: json ? '' : text.slice(0, 400) };
  }, [FQL_PATH, symbols, exprs]);
}
/**
 * 走接口拿一整条链。成功返回 { rows, expiries, spot, stats, miss, legs },失败直接抛。
 *
 * 抛出来的话都写成"下一步该干什么",因为这一步失败时你在终端里能看到的只有这一句。
 */
export async function fetchOptionsViaApi(ticker) {
  if (!(await ensureFactsetOrigin())) throw new Error('页面不在 my.apps.factset.com 上,同源接口发不出去(多半是登录态掉了)');
  phase('取现价');
  const px = await apiFql([ticker], ['P_PRICE']);
  if (px.status !== 200) throw new Error(`FQL 取现价回了 HTTP ${px.status}(登录态或权限的问题,不是解析的问题)`);
  const spot = parseFqlValues(px.json, 'P_PRICE').get(ticker)
    ?? [...parseFqlValues(px.json, 'P_PRICE').values()][0];
  if (!isFinite(spot) || spot <= 0) throw new Error(`FQL 没给出 ${ticker} 的现价,没有现价就框不出行权价窗口`);

  phase('取期权链目录');
  const oc = await apiGet(`${OC_PATH}?symbol=${encodeURIComponent(ticker)}`);
  if (oc.status !== 200) throw new Error(`期权链目录回了 HTTP ${oc.status}(${OC_PATH})`);
  /* 这里最容易被骗:代码不对或标的没有期权时,接口给的是 **200 + 空 body**,不是 404。
   * parseOptionChainTable 把这种情况显式变成 error,不让它当成"成功但零行"混过去。 */
  const table = parseOptionChainTable(oc.text);
  if (table.error) throw new Error(table.error);

  phase('筛合约');
  const { kept, stats } = pickChainContracts(table.rows, { today, spot, ticker });
  if (!kept.length) {
    throw new Error(`目录有 ${stats.total} 行,但没有一个合约落在窗口里`
      + `(现价 ${spot},已到期 ${stats.expired} / 太远 ${stats.farDate} / 离钱太远 ${stats.farStrike}`
      + ` / 调整过 ${stats.adjusted} / 标的对不上 ${stats.wrongUnderlier})`);
  }
  if (kept.length * 2 > OPT_API_MAX_CONTRACTS) {
    log(`  · ${ticker} 窗口里有 ${kept.length * 2} 条腿,超过 ${OPT_API_MAX_CONTRACTS} 的上限,只取靠前的那些`);
    kept.length = Math.floor(OPT_API_MAX_CONTRACTS / 2);
  }

  phase('取未平仓量 / 成交量 / 最新成交价 / Delta / 报价');
  const syms = [];
  for (const k of kept) syms.push(k.call, k.put);
  const oi = new Map();
  const optionalExprs = ['P_OPT_VOLUME', 'P_OPT_CLOSE_PRICE', 'P_OPT_DELTA', 'P_OPT_BID_PRICE', 'P_OPT_ASK_PRICE'];
  const metricMaps = Object.fromEntries(optionalExprs.map(x => [x, new Map()]));
  const batches = chunk(syms, FQL_BATCH);
  for (let i = 0; i < batches.length; i++) {
    const r = await apiFql(batches[i], ['P_OPT_OPEN_INTEREST', ...optionalExprs]);
    if (r.status !== 200) throw new Error(`FQL 第 ${i + 1}/${batches.length} 批回了 HTTP ${r.status}`);
    if (!r.json) throw new Error(`FQL 第 ${i + 1}/${batches.length} 批返回的不是 JSON:${r.text}`);
    for (const [k, v] of parseFqlValues(r.json, 'P_OPT_OPEN_INTEREST')) oi.set(k, v);
    for (const expr of optionalExprs) for (const [k, v] of parseFqlValues(r.json, expr)) metricMaps[expr].set(k, v);
  }

  phase('拼装');
  const built = assembleOptionRows(kept, oi, metricMaps);
  const bad = optApiVerdict(built);
  if (bad) throw new Error(bad);
  const coverage = Object.fromEntries(optionalExprs.map(expr => [expr,
    built.legs ? metricMaps[expr].size / built.legs : 0]));
  return { ...built, spot, stats, batches: batches.length, coverage };
}

/** 读回 "{ticker} Options.csv" 已有的行;文件不在或读坏了都当空表(纯读,不抛) */
export function readOptionsCsv(f) {
  const out = [];
  try {
    if (!fs.existsSync(f)) return out;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const header = splitCsvLine(lines.shift() || '').map(x => x.trim().toLowerCase());
    for (const line of lines) {
      if (!line.trim()) continue;
      const c = splitCsvLine(line);
      const row = Object.fromEntries(header.map((h, i) => [h, c[i] ?? '']));
      if (row.asof && row.expiry) out.push(row);
    }
  } catch {}
  return out;
}

/** 按 asof **追加**写入 "{ticker} Options.csv" —— 每天一层,一年内的都留着。
 *  合并/滚存的规矩全在 lib/opt-store.mjs 里(纯函数,自检覆盖得到),这里只负责读盘写盘。 */
export function saveOptionsCsv(ticker, recs, asof) {
  const f = assetPath(`${ticker} Options.csv`);
  const stamp = asof || today;
  const fetched_at = new Date().toISOString();
  const enriched = (recs || []).map(r => ({ ...r, fetched_at: r.fetched_at || fetched_at }));
  const m = mergeOptionSnapshots(readOptionsCsv(f), enriched, stamp, today);
  const fields = ['asof', 'fetched_at', 'expiry', 'strike', 'call_oi', 'put_oi', ...OPT_EXTRA_FIELDS.filter(x => x !== 'fetched_at')];
  fs.writeFileSync(f, fields.join(',') + '\n'
    + m.rows.map(r => fields.map(k => csvCell(r[k] ?? '')).join(',')).join('\n') + '\n');
  return { total: m.rows.length, added: m.added, snapshots: m.snapshots, agedOut: m.agedOut + m.capped };
}
/** 期权链表格:先找规规矩矩的 <tr>,再退回按 bounding rect 还原(和新闻页同一套办法) */
export async function scrapeOptionChain() {
  let best = null;
  for (const f of page.frames()) {
    try {
      const rows = await f.evaluate(() => {
        if (!document.body || !/strike/i.test(document.body.innerText)) return null;
        const tr = [...document.querySelectorAll('tr')]
          .map(r => [...r.querySelectorAll('th,td')].map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()))
          .filter(r => r.length > 2 && r.some(c => c));
        if (tr.length > 3) return tr;
        const cells = [...document.querySelectorAll('[class*="grid-cell"],[role="gridcell"],[role="columnheader"]')];
        if (cells.length < 12) return null;
        const m = new Map();
        for (const c of cells) {
          const b = c.getBoundingClientRect();
          if (b.height <= 0 || b.width <= 0) continue;
          const k = Math.round(b.top / 2) * 2;
          if (!m.has(k)) m.set(k, []);
          m.get(k).push([b.left, (c.innerText || '').replace(/\s+/g, ' ').trim()]);
        }
        return [...m.entries()].sort((a, b) => a[0] - b[0])
          .map(([, v]) => v.sort((a, b) => a[0] - b[0]).map(x => x[1]));
      });
      if (rows && rows.length > 3 && (!best || rows.length > best.length)) best = rows;
    } catch {}
  }
  return best;
}

/** 轮询真实表格状态，避免每个候选地址无条件睡 5–8 秒。 */
export async function waitForOptionChain(timeout = 7000) {
  const until = Date.now() + timeout;
  do {
    const rows = await scrapeOptionChain();
    if (rows) return rows;
    await page.waitForTimeout(300);
  } while (Date.now() < until);
  return null;
}

async function clickFirstTextWhenReady(labels, timeout = 6000) {
  const until = Date.now() + timeout;
  do {
    for (const label of labels) if (await clickTextInFrames(label, false)) return label;
    await page.waitForTimeout(250);
  } while (Date.now() < until);
  return null;
}
/** 把代码打进页面自己的搜索框(顶层 Options 页签不带公司上下文,和 Charting 一样要自己输)。
 *  找不到输入框不算错——有些布局是地址栏直接带 ticker 的。 */
export async function typeTickerOnOptionsPage(ticker) {
  for (const f of page.frames()) {
    try {
      const box = f.locator('input:visible').first();
      if (!(await box.count())) continue;
      await box.click({ timeout: 3000 });
      await box.fill(ticker, { timeout: 3000 });
      await box.press('Enter');
      await waitForOptionChain(6000); // 这里只等状态；调用方仍会重新读取并校验 ticker
      return true;
    } catch {}
  }
  return false;
}
/** 页面上到底是不是这只股票?顶层页签不带公司上下文,所以这是唯一的旁证。
 *  只报警不拦截 —— 页面用短代码(NVDA 而非 NVDA-US)显示是常态,不该因此判失败。 */
export async function pageMentionsTicker(ticker) {
  const sym = String(ticker).split('-')[0];
  if (!sym) return true;
  const re = new RegExp('\\b' + sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  for (const f of page.frames()) {
    try {
      const txt = await f.evaluate(() => (document.body && document.body.innerText) || '');
      if (re.test(txt)) return true;
    } catch {}
  }
  return false;
}
/** 现场探测:回到 workstation 首页,点顶层导航里那个叫 Options 的页签,记下落地地址。
 *  这是最后一招——slug 猜不中时,让页面自己告诉我们地址是什么。 */
export async function discoverOptionsTab() {
  try {
    await page.goto(`${BASE}/workstation/`, { waitUntil: 'domcontentloaded' });
  } catch { return null; }
  const labels = ['Options', 'Option Chain', 'Derivatives'];
  for (let attempt = 0; attempt < labels.length; attempt++) {
    const label = await clickFirstTextWhenReady(labels, attempt ? 1000 : 6000);
    if (!label) break;
    await page.waitForURL(u => !/\/workstation\/?$/.test(u.pathname), { timeout: 8000 }).catch(() => {});
    const u = page.url();
    if (u && !/\/workstation\/?$/.test(u)) { log(`  · 顶层页签「${label}」落地:${u}`); return u; }
  }
  return null;
}
/**
 * 找不到导出时打印的那段话。写全一点:这一步失败时你需要的是**操作步骤**,
 * 不是"未找到期权链"五个字 —— 后者只会让你再开一次浏览器自己摸索一遍。
 * 下面每一步都是 2026-07-30 实地点过一遍确认的,包括那个 500 合约的坑。
 */
export function optExportHowTo(ticker, dirs) {
  const sym = optSymOf(ticker);
  return [
    `  ⓘ 没找到 ${sym} 的期权导出。在 FactSet 里手动下一次,下轮就自动读进来了:`,
    '     1. 打开顶层 Options 页签(Options Montage),搜索框输入代码',
    '     2. 左上角行权价下拉 →「Custom Strikes」→ 选「% from At-the-Money」→ 填 25 → OK',
    '        这个 25 不是随便填的:它和仪表盘的 OPT_WINDOW = 0.25 是同一个数,',
    '        更远的行权价本来就不参与计算,填大了只会撞上下面那个上限。',
    '     3. 选一个月份页签(Jul \'26 / Aug \'26 …),右上角工具图标 →「Download」',
    '        **一次最多 500 份合约(= 行权价 × 2)**。超了不会给你截断的文件,',
    '        而是弹一句 “More than 500 contracts to download…” 然后什么都不给。',
    '        所以按月份一个一个下,别想一次下完 —— 多份文件这边会自动合并。',
    '     4. 文件会落在浏览器的下载目录,名字形如 optionsMontage_' + sym + '-USA_YYYYMMDD.xlsx,',
    '        原地放着就行,不用改名也不用搬。',
    '  ⓘ 找过这几个目录(把文件放进任意一个都认):',
    ...(dirs || optInboxDirs()).map(d => '     ' + d),
    '     也可以用环境变量 FS_OPT_INBOX 指定别的目录。',
  ].join('\n');
}
export async function fetchOptions(ticker) {
  /* ---- 三层降级,顺序是按"读得全不全"排的,不是按"好不好写"排的 --------------
   *   1. 接口   —— 服务端一次给全整条链。全自动,没有上限,没有人工。
   *   2. 导出   —— 你手动下的 xlsx。也是全的,但要人点,而且一次 500 合约封顶。
   *   3. 刮屏   —— 只能拿到视口里那二十来行,**而且不会因此失败**。
   *
   * 第 3 层是唯一会安安静静给出错误答案的一层,所以它必须排最后,而且必须自己喊出来。
   * 前两层任意一层成了,就不该再往下走。 */
  phase('走接口');
  try {
    const api = await fetchOptionsViaApi(ticker);
    phase('写文件');
    const { total, added, snapshots } = saveOptionsCsv(ticker, api.rows, today);
    log(`  ✔ ${ticker} Options.csv (接口 ${api.rows.length} 个行权价 / ${api.expiries.length} 个到期日`
      + `,现价 ${api.spot},${api.legs} 条腿分 ${api.batches} 批取回,新增 ${added},累计 ${total} 行 / ${snapshots} 天)`);
    if (api.miss) log(`  · 有 ${api.miss} 条腿没给出未平仓量(占 ${(api.miss / api.legs * 100).toFixed(1)}%,在容忍范围内,按 0 计)`);
    const cv = api.coverage || {};
    log(`  · 附加字段覆盖率:Volume ${((cv.P_OPT_VOLUME || 0) * 100).toFixed(0)}% / Last ${((cv.P_OPT_CLOSE_PRICE || 0) * 100).toFixed(0)}% / Delta ${((cv.P_OPT_DELTA || 0) * 100).toFixed(0)}% / Bid ${((cv.P_OPT_BID_PRICE || 0) * 100).toFixed(0)}% / Ask ${((cv.P_OPT_ASK_PRICE || 0) * 100).toFixed(0)}%`);
    return true;
  } catch (e) {
    /* 接口这条路失败只降级、不中断:导出那条路照样能把这一轮救回来。
     * 但一定要把原因原样打出来 —— 接口改了和登录态掉了,是两件完全不同的事。 */
    log(`  · 接口取期权链没成:${e.message}`);
    log('    (往下试导出;要看接口本身怎么回事,对照 fetcher/lib/fql.mjs 顶部那份实地记录)');
  }

  phase('读导出');
  const dirs = optInboxDirs();
  const ing = ingestOptExports(ticker, dirs, today);
  for (const bad of ing.rejected) log(`  · 跳过导出 ${bad}`);
  if (ing.rows.length) {
    for (const u of ing.used) log(`  · 读入导出 ${u.file}(${u.asof},${u.rows} 行,到期日 ${u.expiries.join(' / ')})`);
    phase('写文件');
    const { total, added, snapshots } = saveOptionsCsv(ticker, ing.rows, ing.asof || today);
    log(`  ✔ ${ticker} Options.csv (导出 ${ing.rows.length} 个行权价 / ${ing.expiries.length} 个到期日,新增 ${added},累计 ${total} 行 / ${snapshots} 天)`);
    if (ing.asof && ing.asof < today) {
      log(`  · 注意:最新的一份导出是 ${ing.asof} 的,不是今天的。OI 是存量数字,过几天再补一次就行。`);
    }
    return true;
  }

  let rows = null, hitUrl = null;
  /* 期权是与 Company 平级的顶层页签,地址形态和其它步骤不同 —— 候选顺序见 lib/options-url.mjs */
  const tries = [...optionsUrlCandidates(ticker), null];   // 末位 null = 退回现场探测
  for (const cand of tries) {
    phase('导航');
    let url = cand;
    if (url === null) { url = await discoverOptionsTab(); if (!url) break; }
    else { try { await page.goto(url, { waitUntil: 'domcontentloaded' }); } catch { continue; } }
    phase('等待页面');
    phase('定位表格');
    /* 地址里没有代码 = 顶层页签不带公司上下文 → **先输代码再读表**。
     * 不能先读:同一个浏览器会话里,页面很可能还停在上一只股票的链上,
     * 那样读到的是一张完整、合理、但属于别人的表 —— 最难发现的一类错。 */
    const urlHasTicker = String(url).includes(ticker);
    if (!urlHasTicker) await typeTickerOnOptionsPage(ticker);
    let r = await waitForOptionChain(7000);
    if (!r && urlHasTicker) { await typeTickerOnOptionsPage(ticker); r = await scrapeOptionChain(); }
    if (!r) r = await waitForOptionChain(5000);
    if (r && !urlHasTicker && !(await pageMentionsTicker(ticker))) {
      log(`  ⚠ 页面上没找到 ${ticker} 字样,代码可能没打进去 —— 本轮期权数据存疑,请打开 Options 页签核对一眼`);
    }
    if (r) {
      rows = r; hitUrl = page.url() || url;
      log(`  · 期权页命中:${hitUrl}`);
      if (saveOptUrlTemplate(hitUrl, ticker)) log('    (地址已记入 fetcher/.options-url,下轮直接走这条)');
      break;
    }
  }
  if (!rows) {
    log(optExportHowTo(ticker, dirs));
    throw new Error('没有导出文件,刮屏也没找到期权链表格。**首选是导出**(上面已经写了完整步骤)。'
      + '刮屏这条退路也试过了:' + optionsUrlCandidates(ticker).length + ' 个候选地址加点击顶层页签,都没命中。'
      + '要修刮屏这条路,把地址栏的地址设进环境变量 FS_OPT_URL(可用 {ticker} 占位)或写进 fetcher/.options-url。'
      + '也可能是账号没有期权权限。');
  }
  phase('解析行');
  const { rows: recs, sawStrike } = parseOptionRows(rows);
  if (!recs.length) {
    log(optExportHowTo(ticker, dirs));
    throw new Error(sawStrike
      ? '找到了表头但没解析出行(Open Int 列位置或到期日写法变了)'
      : '页面里没有 Strike / Open Int 表头(可能停在概览视图,需要先切到 Option Chain)');
  }
  phase('写文件');
  const { total, added, snapshots } = saveOptionsCsv(ticker, recs, today);
  const exp = [...new Set(recs.map(r => r.expiry))].length;
  log(`  ✔ ${ticker} Options.csv (刮屏 ${recs.length} 个行权价 / ${exp} 个到期日,新增 ${added},累计 ${total} 行 / ${snapshots} 天)  ${hitUrl}`);
  /* 这句警告必须留着。刮屏在这一页上**结构性地读不全**(虚拟滚动,DOM 里只有视口那几行),
   * 而少读不会失败 —— 它会给你一份看着挺正常的 csv,然后压力位面板拿它一本正经地算错。 */
  log(`  ⚠ 这一轮走的是刮屏,不是导出:Options Montage 的表格是虚拟滚动的,`
    + `DOM 里只有视口内那些行,${recs.length} 个行权价很可能不是全部。`
    + `max pain 和 OI 墙都依赖"这一列是完整的"这个前提,所以请照下面的步骤手动导出一次。`);
  log(optExportHowTo(ticker, dirs));
  return true;
}
