/* lib/chart-diag.mjs — 图表布局(5 年跨度 / OHLC / 成交量)自动切换失败时的**证据采集**
 *
 * 为什么单独一个文件:
 * steps/charting.mjs 里的 trySetRange5Y() / tryEnableOHLC() 那几组菜单文案和点击顺序,
 * **全部是从 tryEnableVolume() 的经验外推出来的猜测**,一次都没有在真实的 FactSet 界面上验过
 * (登录只能由用户本人完成,写代码的人打不开那个页面)。
 * 猜错了的表现是安静的:导出照样下载回来,只是还是一年、还是只有收盘价。
 *
 * 所以这一步真正缺的不是"再猜一种写法",而是**页面上到底写着什么字**。
 * 这个文件干的就是这件事:失败时把图表工具栏 / 下拉里能看见的文案原样倒出来,
 * 连同"我找的那几个词命中了没有"一起写进 Assets/_logs/chart-diag-YYYY-MM-DD.log,
 * 用户把那一个文件发回来,选择器就不用再猜了。
 *
 * 三条硬规矩(顺序就是重要性):
 *  1. **绝不抛异常**。它是诊断代码,失败时才跑;要是它自己把这一步搞崩了,
 *     那就是"为了查一个降级问题制造了一个阻断问题"。所以整条链路每一层都吞异常。
 *  2. **绝不输出任何能登录的东西**。这份日志是要发给别人看的。
 *     地址一律只留 origin+path,query/fragment 整段丢掉;凡是 token/session/密码那一类的
 *     键值对、JWT、Bearer、够长的不明串,一律换成 [已隐去]。
 *     本文件**从不去读浏览器的会话存储或本地存储**(自检里有一条断言钉死这一点)。
 *  3. **只读不写页面**。采集不点任何东西 —— 失败之后再乱点一通,只会把下一次的证据也搅浑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, ensureAssetDirs } from './config.mjs';
import { log } from './log.mjs';

/** 日志落在 Assets/_logs/,命名跟 fetch-YYYY-MM-DD.log 一个模子(见 lib/log.mjs 的 LOG_FILE)。
 *  按天一个文件、append —— 一天里跑好几轮时,几轮的证据要能并排看,不能互相盖掉。 */
export const CHART_DIAG_FILE = path.join(LOG_DIR, `chart-diag-${new Date().toISOString().slice(0, 10)}.log`);

export const REDACTED = '[已隐去]';

/* 会跟着"能登录的东西"一起出现的键名。刻意**不**收 key / code / state / sig 这几个太短太常见的词:
 * 它们出现在 OAuth 回调地址里,而地址的 query 早在第 3 条规则就被整段丢掉了;
 * 留在这张表里只会把 "Code: NVDA" 这种正经的界面文案也抹掉,而抹掉的正是我要看的东西。 */
const SECRET_KEYS = 'access_token|refresh_token|id_token|token|jsessionid|session_id|sessionid|session|sid'
  + '|authorization|auth|api_key|apikey|secret|password|passwd|pwd|cookie|credentials|credential'
  + '|signature|assertion|saml|nonce';

/**
 * 把一段文本里所有"能拿去登录的东西"换成 [已隐去]。
 *
 * 五条规则按**从具体到笼统**排,不能换序:笼统的那条(第 5 条)会把 JWT 整个吃掉,
 * 于是就看不出被抹掉的原本是个 JWT 还是别的什么 —— 排在后面它才只兜没被认出来的漏网之鱼。
 */
export function scrubSecrets(s) {
  let t = String(s == null ? '' : s);
  /* 1) JWT:三段点分的 base64url,以 eyJ 开头(那是 {" 的 base64) */
  t = t.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]{4,}/g, REDACTED);
  /* 2) Authorization 头的两种写法 */
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 ' + REDACTED);
  /* 3) 地址:query 和 fragment **整段**丢掉,只留 origin+path。
   *    不做"逐个参数判断哪个敏感"——判断错一次就泄一次,而路径本身已经够说明是哪个页面了。 */
  t = t.replace(/(https?:\/\/[^\s"'<>]*?)[?#][^\s"'<>]*/gi, '$1?' + REDACTED);
  /* 4) 裸的 键=值 / 键: 值 */
  t = t.replace(new RegExp('\\b(' + SECRET_KEYS + ')\\s*[=:]\\s*[^\\s&;,"\'<>]+', 'gi'), '$1=' + REDACTED);
  /* 5) 兜底:32 字符以上的不明连续串。**不含斜杠**是故意的 ——
   *    含上斜杠的话 "com/workstation/company-security/ownership-summary/NVDA-US" 这种正经路径
   *    会被整条抹掉,那就等于为了防泄漏把要看的东西也一起删了。 */
  t = t.replace(/(?<![A-Za-z0-9+=_-])[A-Za-z0-9+=_-]{32,}(?![A-Za-z0-9+=_-])/g, REDACTED);
  return t;
}

/** 一行一个候选词,短的用 " · " 串起来,长的换行 —— 纯排版,失败也不该炸 */
const joinShort = arr => (Array.isArray(arr) ? arr : []).map(x => scrubSecrets(x)).filter(Boolean).join(' | ');

/** 这一批采集里,label 这个词到底有没有出现过。返回命中的那条原文,没有则返回 null。
 *  文本按**全等**比(工具栏按钮的文字节点就是 "5Y",不是一段话),
 *  title/aria-label 按**包含**比(那一串常写成 "Zoom to 5 Years")。 */
function probeHit(label, frames) {
  const want = String(label == null ? '' : label).trim().toLowerCase();
  if (!want) return null;
  for (const fr of frames) {
    for (const t of (fr && Array.isArray(fr.texts) ? fr.texts : [])) {
      if (String(t).trim().toLowerCase() === want) return String(t);
    }
  }
  for (const fr of frames) {
    for (const l of (fr && Array.isArray(fr.labels) ? fr.labels : [])) {
      if (String(l).toLowerCase().includes(want)) return String(l);
    }
  }
  return null;
}

/**
 * 把一次采集渲染成人能读、也能直接贴给我的报告。**纯函数** —— 不碰浏览器、不碰磁盘,
 * 所以 --selftest 能拿各种畸形输入喂它。
 *
 * 入参全都当成不可信:frames 可能是 undefined、可能是字符串、里面可能混着 null。
 * 这不是防御性洁癖 —— 它的调用时机恰恰是"页面已经不是我以为的样子"的那一刻。
 */
export function formatChartDiag(info) {
  const d = (info && typeof info === 'object') ? info : {};
  const frames = Array.isArray(d.frames) ? d.frames.filter(f => f && typeof f === 'object') : [];
  const out = [];
  const at = scrubSecrets(d.at || '');
  out.push(`======== 图表布局诊断 · ${scrubSecrets(d.ticker || '-')} · ${at || '(无时间戳)'} ========`);
  if (d.file) out.push(`产出文件: ${scrubSecrets(path.basename(String(d.file)))}`);
  out.push('本轮结论(以下载回来的文件为准,不以"点没点着"为准):');
  const via = (d.via && typeof d.via === 'object') ? d.via : {};
  const verdict = (d.verdict && typeof d.verdict === 'object') ? d.verdict : {};
  const keys = [...new Set([...Object.keys(verdict), ...Object.keys(via)])];
  if (!keys.length) out.push('  (没有传入任何结论)');
  for (const k of keys) {
    const v = via[k];
    out.push(`  ${scrubSecrets(k).padEnd(8)}: ${scrubSecrets(verdict[k] ?? '未知')}`
      + `   (自动切换点到的入口: ${v ? scrubSecrets(v) : '一个入口都没点着'})`);
  }
  /* 这一段是整份日志里最有用的:它把"我猜的词"和"页面上真有的词"摆在一起。
   * 全是 [未命中] 就说明我猜的这一套词页面上压根不存在 —— 那才是真正需要用户回填的东西。 */
  const probes = Array.isArray(d.probes) ? d.probes : [];
  out.push('候选文案命中情况(未命中的那些 = 代码里猜错的词,请照着下面 frame 段落里的真实文案纠正):');
  if (!probes.length) out.push('  (没有传入候选清单)');
  for (const p of probes) {
    const name = Array.isArray(p) ? p[0] : (p && p.name);
    const labels = Array.isArray(p) ? p[1] : (p && p.labels);
    const list = Array.isArray(labels) ? labels : [];
    const hits = list.map(l => [l, probeHit(l, frames)]).filter(x => x[1]);
    if (hits.length) {
      out.push(`  [命中  ] ${scrubSecrets(name || '?')}: ${joinShort(list)}`);
      for (const [l, h] of hits) out.push(`             ↳ "${scrubSecrets(l)}" 页面上确有:${scrubSecrets(h)}`);
    } else {
      out.push(`  [未命中] ${scrubSecrets(name || '?')}: ${joinShort(list) || '(空清单)'}`);
    }
  }
  if (!frames.length) {
    out.push('--- 一个 frame 都没扫到 ---');
    out.push('    页面可能已经跳走 / 还没加载完 / 采集本身出错了。这种情况请补一张整页截图。');
  }
  frames.forEach((fr, i) => {
    out.push(`--- frame #${i + 1}  ${scrubSecrets(fr.url || '(无地址)')} ---`);
    const labels = Array.isArray(fr.labels) ? fr.labels : [];
    out.push(`  带 title / aria-label 的元素 ${labels.length} 个:`);
    if (!labels.length) out.push('    (一个都没有)');
    for (const l of labels) out.push('    ' + scrubSecrets(l));
    const texts = Array.isArray(fr.texts) ? fr.texts : [];
    out.push(`  短文本叶子 ${texts.length} 个(工具栏按钮和下拉项的文字多半都在这里):`);
    if (!texts.length) out.push('    (一个都没有)');
    for (let j = 0; j < texts.length; j += 8) {
      out.push('    ' + texts.slice(j, j + 8).map(t => '"' + scrubSecrets(t) + '"').join(' · '));
    }
  });
  out.push('======== 诊断结束 ========');
  /* 再整体过一遍脱敏:上面每个字段都单独过过了,这一遍是**兜底**。
   * 多一遍的代价是几毫秒,少一遍的代价是把一个能登录的串发给了别人。 */
  return scrubSecrets(out.join('\n'));
}

/** 在页面里跑的采集函数(会被序列化进浏览器,所以只能用自带的东西,不能引用模块作用域)。
 *  只读 DOM 的 title / aria-label / 叶子文本 —— 不读会话信息,不点任何东西。 */
const IN_PAGE = () => {
  const cut = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const labels = [], texts = [], seenL = new Set(), seenT = new Set();
  for (const e of document.querySelectorAll('[title],[aria-label]')) {
    const t = cut((e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || ''), 60);
    if (!t) continue;
    const k = e.tagName + '|' + t;
    if (seenL.has(k)) continue;
    seenL.add(k);
    labels.push(e.tagName + ' "' + t + '"');
    if (labels.length >= 120) break;
  }
  for (const e of document.querySelectorAll('*')) {
    if (e.children.length) continue;
    const t = cut(e.textContent, 40);
    /* 只留短文本:工具栏按钮和下拉项都是 "5Y" "Candlestick" 这种。
     * 长句是正文/免责声明,倒进日志只会把真正有用的那几十个词淹掉。 */
    if (!t || t.length > 28) continue;
    if (seenT.has(t)) continue;
    seenT.add(t);
    texts.push(t);
    if (texts.length >= 300) break;
  }
  return { url: location.href, labels, texts };
};

/** 默认采集:遍历所有 frame。任何一个 frame 读失败都只跳过它,不影响别的。 */
async function defaultHarvest() {
  const { page } = await import('./browser.mjs');
  const frames = [];
  if (!page || typeof page.frames !== 'function') return frames;
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(IN_PAGE);
      if (r && (r.labels || r.texts)) frames.push(r);
    } catch { /* frame 可能正在被换掉,跳过 */ }
  }
  return frames;
}

/**
 * 采集 → 渲染 → 落盘 → 在终端上留一行指路。**任何情况下都不抛异常,也不返回 undefined**。
 *
 * opts.harvest —— 换一个采集函数(--selftest 用它在没有浏览器的情况下喂各种畸形返回)。
 * opts.file    —— 换一个落盘路径(--selftest 用它验证"写不进去也不炸")。
 * opts.quiet   —— 只写文件不打终端。
 */
export async function dumpChartDiag(info, opts) {
  try {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const harvest = typeof o.harvest === 'function' ? o.harvest : defaultHarvest;
    let frames = [];
    try { frames = await harvest(); } catch { frames = []; }
    if (!Array.isArray(frames)) frames = [];
    const base = (info && typeof info === 'object') ? info : {};
    const text = formatChartDiag({ ...base, at: base.at || new Date().toISOString().slice(0, 19) + 'Z', frames });
    const file = o.file || CHART_DIAG_FILE;
    let wrote = false;
    try { ensureAssetDirs(); fs.appendFileSync(file, text + '\n\n'); wrote = true; } catch { wrote = false; }
    if (!o.quiet) {
      try {
        if (wrote) {
          log(`    ⓘ 图表工具栏的真实文案已倒进 ${file}`);
          log('       自动切 5 年 / K 线大概率就是猜错了词。把这个文件发回来,选择器就不用再猜了(里面不含任何登录信息)。');
        } else {
          log('    ⓘ 图表布局诊断写盘失败,下面直接打印:');
          for (const line of text.split('\n')) log('      ' + line);
        }
      } catch { /* 连打印都失败也不许影响抓取 */ }
    }
    return text;
  } catch {
    return '';   /* 诊断代码自己出错,绝不能让它把这一步拖挂 */
  }
}
