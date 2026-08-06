/* lib/options-url.mjs — 期权页的地址解析与记忆
 *
 * 为什么单独一个文件:期权链**不在 Company/Security 里面**——它是与 Company 平级的顶层页签
 * (和 Charting 一样)。地址形态因此和其它步骤都不同,而且不同账号的权限/版本下 slug 可能不一样,
 * 所以这里把"去哪个地址"这件事和"怎么解析表格"彻底分开:
 *   1) FS_OPT_URL 环境变量最优先——你把浏览器地址栏里的真实地址贴进来,一次搞定,不用等我猜;
 *   2) 其次用上一轮**探测成功后记住的**地址(.options-url);
 *   3) 都没有才按候选 slug 逐个试,最后退回"点顶层 Options 页签"现场探测。
 * 探测成功会把地址写回 .options-url,所以这个代价只付一次。
 *
 * 本文件不 import 浏览器,只碰 fs —— 台账(registry)和自检都能安全地引它。
 */

import fs from 'node:fs';
import path from 'node:path';
import { BASE, FETCHER_DIR } from './config.mjs';

export const OPT_URL_FILE = path.join(FETCHER_DIR, '.options-url');
/* 顶层页签的候选 slug(与 charting 同级:/workstation/<slug>/)。
 * options-montage 排第一是**实测**结果:2026-07-29 那一轮点顶层 Options 页签,落地就是它;
 * 其余几个是留给别的账号权限/版本的后备,猜错不要紧,试一个失败就换下一个。 */
export const OPT_TOP_SLUGS = ['options-montage', 'options', 'option-chain', 'options-chain', 'derivatives'];

/** 把模板里的 {ticker} 换成实际代码。**没有占位符就原样使用**——
 *  顶层页签(实测的 /workstation/options-montage/)地址里根本没有代码那一段,
 *  代码是落地后打进页面自己的搜索框的。早先这里对目录式地址自动补代码,
 *  于是记住的地址下一轮变成 .../options-montage/NVDA-US,那是个没人验证过的地址。 */
export function expandOptUrl(tpl, ticker) {
  const s = String(tpl || '').trim();
  if (!s) return '';
  if (s.includes('{ticker}')) return s.replace(/\{ticker\}/g, ticker);
  return s;
}
/** 一个模板可能对应两种真实地址,按可信度排序返回:
 *  先"原样"(顶层页签就是这形态),再"目录式补上代码"(万一那个 slug 其实是按公司分页的)。
 *  两条都试的代价是一次失败导航,换来的是不用赌对形态。 */
export function expandOptUrlVariants(tpl, ticker) {
  const base = expandOptUrl(tpl, ticker);
  if (!base) return [];
  const out = [base];
  if (!String(tpl).includes('{ticker}') && /\/$/.test(base)) out.push(base + ticker);
  return out;
}
/** 反过来:把一个成功过的实际地址转回模板,方便换 ticker 复用。
 *  地址里压根没有代码(顶层页签的常态)时原样返回,不硬造占位符。 */
export function templatizeOptUrl(url, ticker) {
  const s = String(url || '').trim();
  if (!s || !ticker) return s;
  return s.split(ticker).join('{ticker}');
}
/** 读回上一轮记住的地址模板(读不到就空串,绝不抛错) */
export function readOptUrlTemplate() {
  try {
    const raw = fs.readFileSync(OPT_URL_FILE, 'utf8');
    const line = raw.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
    return line || '';
  } catch { return ''; }
}
/** 探测成功后记住它。写失败不影响本轮结果,只是下轮还得再探一次。 */
export function saveOptUrlTemplate(url, ticker) {
  const tpl = templatizeOptUrl(url, ticker);
  if (!tpl) return false;
  try {
    fs.writeFileSync(OPT_URL_FILE,
      '# 期权页地址(探测成功后自动记住;{ticker} 会被替换成实际代码)\n'
      + '# 想改成别的地址:直接编辑这一行,或设环境变量 FS_OPT_URL(优先级更高)。\n'
      + tpl + '\n');
    return true;
  } catch { return false; }
}
/** 本轮要依次尝试的地址(去重、保序) */
export function optionsUrlCandidates(ticker) {
  const out = [];
  const push = v => { if (v && !out.includes(v)) out.push(v); };
  const pushTpl = tpl => { for (const v of expandOptUrlVariants(tpl, ticker)) push(v); };
  pushTpl(process.env.FS_OPT_URL || '');
  pushTpl(readOptUrlTemplate());
  /* 盲试时先试不带代码的目录式地址:顶层页签按定义就没有公司上下文 */
  for (const seg of OPT_TOP_SLUGS) { push(`${BASE}/workstation/${seg}/`); push(`${BASE}/workstation/${seg}/${ticker}`); }
  return out;
}
/** 台账里显示哪一条:优先显示"我们真的会用的那一条" */
export function optionsUrlHint(ticker) {
  return optionsUrlCandidates(ticker)[0] || `${BASE}/workstation/options-montage/`;
}
