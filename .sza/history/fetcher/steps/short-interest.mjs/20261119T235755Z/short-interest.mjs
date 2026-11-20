/* steps/short-interest.mjs — 第 4 步:Ownership 空头持仓
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 *
 * 这一步为什么被重写:原来的写法是「一条正则对整段文本」——
 *   Short Interest 2.5 Days / 1.39% of Float
 * 两个数字必须以这个顺序、这个连接方式、出现在同一个 frame 的同一段文本里,
 * 少一个空格、换个措辞、把两个数字拆到两个格子里,整步就失败,而且报出来的只有一句
 * 「未找到 Short Interest 字段(Ownership 页面板改版)」——**它没告诉你页面上究竟是什么**,
 * 于是每次改版都得重新人肉打开页面看一遍。
 *
 * 现在改成三条独立的原则:
 *   1. **等到出现为止,而不是赌固定 8 秒**。面板是异步渲染的,慢一点就"改版"了。
 *   2. **两个数字分开找**。回补天数和 %流通盘 是两件事,读到一个就先记一个,
 *      不要因为另一个换了写法把已经拿到的也扔掉。
 *   3. **失败时把页面原文摘一段打出来**。下一次坏掉时,日志里直接有证据,
 *      不用再开浏览器复现——这一条比前两条都值钱。
 *
 * 2026-07-30 第二次重写,因为上面第 2 条被自己咬了一口。真实页面长这样(实地抄回来的):
 *     SHORT INTEREST   2.5 DAYS / 1.4% FLOAT
 *     FLOAT            96.2%
 *     INST. OWNERSHIP  72.1% OF FLOAT
 * 注意空头那一格写的是 “1.4% FLOAT”,**没有 of**。于是要求 “% of Float” 的快路径落空,
 * 掉进"两个数字分开找"的慢路径,而慢路径拿到的是整个 frame 的文本——
 * `/([\d.,]+)\s*%\s*of\s*Float/` 于是精准地匹配到了隔壁机构持股的 **72.1%**。
 * CSV 里那一列 68.7 / 80.7 / 76 / 72.1 就是这么来的。
 *
 * 所以这次改的**不是正则,是取数的范围**:
 *   4. **先把范围收进 DOM 里那一格**(lib/browser.mjs 的 frameBlockContaining:
 *      从写着 Short Interest 的叶子往上爬到最小的含数字祖先,实测停在 `DIV.content-column`)。
 *      范围对了,隔壁的数字在结构上就够不着——这比再补几条更精细的正则牢靠:
 *      排版可以改,"数字和它的标题在同一个盒子里"不会改。
 *   5. **松正则只许在那一格里跑**。万一爬不出块、只能拿到整页文本,就只认
 *      "天数和占比紧挨着标签"的严格写法(RE_ADJ),宁可读不到,也不许再放松一次。
 */

import fs from 'node:fs';
import { frameBlockContaining, frameTextContaining, page } from '../lib/browser.mjs';
import { today } from '../lib/companies.mjs';
import { BASE, assetPath } from '../lib/config.mjs';
import { phase } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';

export const SHORTINT_CSV_NAME = 'short-interest.csv';
export const SHORTINT_CSV = () => assetPath(SHORTINT_CSV_NAME);

/** 面板存在与否的探针:只认这四个字,不带任何数字格式的假设 */
export const SHORTINT_NEEDLE = 'Short\\s*Interest';
/** 面板出现 + 数字渲染出来的最长等待(毫秒) */
export const SHORTINT_WAIT_MS = 45000;
const POLL_MS = 1500;

/* 快路径:两个数字都紧挨着标签,这一条**在整页文本上也安全**,因为它锚死了 Short Interest。
 * `of` 必须可选 —— 页面写的就是 “2.5 DAYS / 1.4% FLOAT”,当初漏了这个可选才引出后面一连串错误。 */
const RE_ADJ = /Short\s*Interest[\s:]*([\d.,]+)\s*Days?\s*[/|,]\s*([\d.,]+)\s*%\s*(?:of\s*)?(?:Free[-\s]?)?Float/i;
/* 慢路径:两个数字各找各的。**只允许在收窄后的那一格里跑**,给整页文本用就会读到隔壁。 */
const RE_DAYS = [
  /([\d.,]+)\s*Days?\s*to\s*Cover/i,
  /Days?\s*to\s*Cover[^\d%]{0,24}([\d.,]+)/i,
  /Short\s*Interest[^\d%]{0,24}([\d.,]+)\s*Days?/i,
  /([\d.,]+)\s*Days?\b/i,
];
const RE_PCT = [
  /([\d.,]+)\s*%\s*(?:of\s*)?(?:Free[-\s]?)?Float/i,
  /Short\s*Interest\s*(?:%|Pct|Percent)?\s*of\s*(?:Free[-\s]?)?Float[^\d%]{0,24}([\d.,]+)/i,
  /Short\s*Interest[^\d]{0,16}([\d.,]+)\s*%/i,
];

/* 一格空头持仓统计里只该出现**一个**百分号。出现两个以上,说明取数范围没收进那一格
 * ——三块并排的 “1.4% FLOAT / 96.2% / 72.1% OF FLOAT” 就是三个。
 * 这条护栏很笨,但它挡住的正是 2026-07-29 那一轮:范围一宽,松正则必然读到隔壁。 */
export const SI_MAX_PCT_SIGNS = 1;
export function siBlockTooWide(text) {
  return (String(text || '').match(/%/g) || []).length > SI_MAX_PCT_SIGNS;
}

const num = s => parseFloat(String(s).replace(/,/g, ''));
/* 量纲护栏:读错格子时拿到的通常是市值、股数这类大数,直接挡在写盘之前。
 * 回补天数上限 200(极端逼空也就几十天),占流通盘 0–100%。 */
const okDays = v => isFinite(v) && v >= 0 && v <= 200;
const okPct = v => isFinite(v) && v >= 0 && v <= 100;
const first = (text, res, ok) => {
  for (const re of res) {
    const m = re.exec(text);
    if (m && ok(num(m[1]))) return num(m[1]);
  }
  return NaN;
};

/**
 * 从一段文本里读空头持仓。两个数字**互相独立**:
 * 任何一个读到就返回(另一个是 NaN),两个都读不到才返回 null。
 *
 * `wide` 是这个函数最要紧的一个参数,它说的是"你喂进来的是不是整页文本":
 *   - `wide: false`(默认,来自 frameBlockContaining 的那一格)—— 快路径落空后允许松正则兜底。
 *   - `wide: true`(整页文本兜底)—— **只认快路径**。松正则在整页文本上必然读到隔壁那一格,
 *     而错的数字比没有数字危险得多,所以这里宁可返回 null。
 */
export function parseShortInt(text, { wide = false } = {}) {
  const s = String(text || '');
  const both = RE_ADJ.exec(s);
  if (both && okDays(num(both[1])) && okPct(num(both[2]))) return { days: num(both[1]), pct: num(both[2]) };
  if (wide || siBlockTooWide(s)) return null;      // 范围不对就别猜,把失败交出去
  const days = first(s, RE_DAYS, okDays);
  const pct = first(s, RE_PCT, okPct);
  if (!isFinite(days) && !isFinite(pct)) return null;
  return { days, pct };
}

/* ---- 量级自洽:读到数字不等于读对了格子 ----------------------------------
 * 2026-07-29 那一轮的实际产物:AMD 1.6 天 / 68.7%、GOOGL 3.4 天 / 80.7%、NVDA 2.5 天 / 72.1%。
 * 正则匹配上了,台账写着成功,数字全是错的——它抓到的是隔壁那一格(看着像机构持股比例)。
 * **这比抓取失败严重得多**:失败会报警,而错的数字会一路走进走向概率面板,
 * 让每一只大盘股都常年吃一记 −0.25 的空头扣分,你在屏幕上看不出任何异样。
 *
 * 拆穿它不需要看页面,两个数字自己就互相矛盾:
 *   占流通盘% ÷ 回补天数 = (空头/流通盘) ÷ (空头/日均量) = **日均成交量占流通盘的百分比**。
 * AMD 是 68.7 ÷ 1.6 ≈ 43,即"每天换手 43% 的流通盘",比真实值高一个数量级还多。
 * 所以这里卡的是这个比值,而不是某个拍脑袋的上限。 */
export const SI_MAX_PCT = 50;        // 占流通盘上限:真到过这个量级的是史书级别的逼空,大盘股集体出现只能是读错
export const SI_MAX_TURNOVER = 20;   // pct/days 上限,含义就是日均换手率(%),20 已经给得很宽

/** 数字自洽吗?自洽返回 null,不自洽返回一句人话(直接进日志和台账) */
export function shortIntSanity(days, pct) {
  if (!okPct(pct)) return '没读到 %流通盘';
  if (pct > SI_MAX_PCT) return `占流通盘 ${pct}% —— 这个量级不可能,读到的多半是隔壁那一格(机构持股之类)`;
  if (okDays(days) && days > 0 && pct / days > SI_MAX_TURNOVER) {
    return `${pct}% 流通盘 ÷ ${days} 天回补 ⇒ 日均成交得占流通盘 ${(pct / days).toFixed(0)}%`
      + ',量级上不可能 —— 这两个数字不是同一件事,至少有一个读错了格子';
  }
  return null;
}

/**
 * 失败时的证据:把页面上 "Short Interest" 前后的原文摘出来。
 * 这段话是给下一次改版的人看的——有它就不用再开浏览器复现一遍。
 */
export function shortIntDiagnosis(text, span = 110) {
  if (!text) return '  ⓘ 该页所有 frame 的可见文本里都没有出现 “Short Interest”:可能是没登录、这只标的没有这项数据,或者面板压根没加载出来。';
  const out = ['  ⓘ 页面上 “Short Interest” 附近的原文(照着它改 steps/short-interest.mjs 里的正则,不用再猜"改版成什么样"):'];
  const re = /Short\s*Interest/gi;
  let m, n = 0;
  while ((m = re.exec(text)) !== null && n < 3) {
    n++;
    out.push('     …' + text.slice(Math.max(0, m.index - 24), m.index + span).replace(/\s+/g, ' ').trim() + '…');
  }
  return out.join('\n');
}

export function hasShortIntToday(ticker) {
  try {
    return fs.readFileSync(SHORTINT_CSV(), 'utf8').split(/\r?\n/)
      .some(l => l.startsWith(ticker + ',' + today + ','));
  } catch { return false; }
}
export function appendShortInt(ticker, days, pct) {
  let lines = [];
  try { if (fs.existsSync(SHORTINT_CSV())) lines = fs.readFileSync(SHORTINT_CSV(), 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean); } catch {}
  lines = lines.filter(l => !l.startsWith(ticker + ',' + today + ','));
  const cell = v => (isFinite(v) ? v : '');   /* 缺的那一格留空,不要写 NaN —— 仪表盘按空值跳过 */
  lines.push([ticker, today, cell(days), cell(pct)].join(','));
  lines.sort();
  fs.writeFileSync(SHORTINT_CSV(), 'ticker,date,days_to_cover,pct_of_float\n' + lines.join('\n') + '\n');
}

export async function fetchShortInterest(ticker) {
  const url = `${BASE}/workstation/navigator/company-security/ownership-summary/${ticker}`;
  phase('导航');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  phase('等待页面');
  /* 轮询而不是 sleep:面板出现得早就早走,出现得晚也等得到。
   * 注意面板文字先出、数字后填是常态,所以判据是"解析成功"而不是"文字出现"。 */
  const t0 = Date.now();
  let text = null, block = null, si = null;
  for (;;) {
    /* 先要那一格。爬不出块时 frameBlockContaining 仍然会把整页文本交回来当证据。 */
    const r = await frameBlockContaining(SHORTINT_NEEDLE);
    if (r) { block = r.block || block; text = r.frameText || text; }
    else text = (await frameTextContaining(SHORTINT_NEEDLE)) || text;
    si = block ? parseShortInt(block) : null;
    /* 只有整页文本时也试一下,但走的是 wide 模式:只认紧挨标签的严格写法 */
    if ((!si || !okPct(si.pct)) && text) si = parseShortInt(text, { wide: true }) || si;
    if (si && okPct(si.pct)) break;
    if (Date.now() - t0 >= SHORTINT_WAIT_MS) break;
    await page.waitForTimeout(POLL_MS);
  }

  phase('解析行');
  if (!si || !okPct(si.pct)) {
    if (block) log(`  ⓘ 收窄到的那一格是:「${block}」`);
    log(shortIntDiagnosis(text));
    throw new Error(text
      ? (block
        ? '找到了空头持仓那一格,但读不出 %流通盘(这一格的写法变了 —— 上面已打印原文)'
        : '面板文字在,但没能从 DOM 里收窄出"空头持仓"那一格,而整页文本上只认严格写法'
          + '(松正则在整页上会读到隔壁的机构持股 —— 见文件顶部注释)')
      : `${Math.round(SHORTINT_WAIT_MS / 1000)} 秒内页面上没出现 Short Interest 面板(未登录 / 该标的无此数据 / 加载超时)`);
  }
  /* 读到了 ≠ 读对了。不自洽就当没读到:错数字会安静地走进打分,比缺数据危险得多。 */
  const bad = shortIntSanity(si.days, si.pct);
  if (bad) {
    log(shortIntDiagnosis(text));
    throw new Error(`读出来了但不对劲:${bad}。宁可这一格空着,也不能拿错的数去打分`
      + '(阈值 SI_MAX_PCT / SI_MAX_TURNOVER 就在 steps/short-interest.mjs 顶部)');
  }

  phase('写文件');
  appendShortInt(ticker, si.days, si.pct);
  if (!okDays(si.days)) {
    log(`  ✔ Short Interest: 回补 —— 天 / ${si.pct}% 流通盘 → ${SHORTINT_CSV_NAME}`);
    log('  · 回补天数这次没读到(只缺这一个,占比照常记入)。真在意的话,看上面日志里 Short Interest 附近的原文。');
  } else {
    log(`  ✔ Short Interest: 回补 ${si.days} 天 / ${si.pct}% 流通盘 → ${SHORTINT_CSV_NAME}`);
  }
  return true;
}
