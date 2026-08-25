/* lib/browser.mjs — 浏览器按需启动 + 跨 iframe 的通用抓取原语
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import { chromium } from 'playwright';
import { BASE, HEADLESS_MODE, LOGIN_ONLY, PROFILE } from './config.mjs';
import { factsetSessionValid, initialHeadless, loginFallback } from './browser-policy.mjs';
import { log } from './log.mjs';

/* ============ 浏览器按需启动:菜单先出现,按回车开始拉取时才弹 Chrome 窗口 ============ */
export let ctx = null, page = null;
async function closeBrowser() {
  const old = ctx; ctx = null; page = null;
  if (old) await old.close().catch(() => {});
}
async function launchBrowser(headless) {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless, viewport: { width: 1600, height: 900 },
    acceptDownloads: true,
  });
  page = ctx.pages()[0] || await ctx.newPage();
}
async function openAndCheck() {
  await page.goto(BASE + '/workstation/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(5000);
  return factsetSessionValid(page.url());
}
export async function ensureBrowser() {
  if (ctx) return;
  const firstHeadless = initialHeadless(HEADLESS_MODE);
  log(firstHeadless ? '⏳ 正在后台启动 Chrome 并检查 FactSet 登录……'
    : '⏳ 正在启动可见 Chrome……拉取期间请不要关闭或操作它。');
  await launchBrowser(firstHeadless);

  if (LOGIN_ONLY) {
    await page.goto(BASE);
    log('请在打开的浏览器里完成 FactSet 登录,然后关闭浏览器窗口。登录态会被记住。');
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    await closeBrowser();
    process.exit(0);
  }

  log('⏳ 正在检查 FactSet 登录状态,请稍等……');
  if (!await openAndCheck()) {
    const fallback = loginFallback(HEADLESS_MODE);
    if (fallback === 'error') {
      await closeBrowser();
      throw new Error('FactSet 登录已失效，但 FS_HEADLESS=1 禁止打开登录窗口。请先运行 npm run fetch:login，或改用 FS_HEADLESS=auto / 0。');
    }
    if (fallback === 'relaunch-visible') {
      log('检测到登录失效 —— 正在关闭后台 Chrome，并以可见窗口重开……');
      await closeBrowser();                 // persistent profile 不允许两个 context 并发占用
      await launchBrowser(false);
      await page.goto(BASE + '/workstation/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    log('检测到未登录 —— 请在打开的窗口里登录 FactSet,登录完成后脚本会自动继续……');
    await page.waitForURL(u => factsetSessionValid(u.href), { timeout: 0 });
    await page.waitForTimeout(6000);
  }
  log('✔ 已登录 FactSet。');
}
export async function scrapeTable(tbl) {
  return await tbl.locator('body').evaluate(body => {
    return [...body.querySelectorAll('tr')].map(r =>
      [...r.querySelectorAll('th,td')].map(c => c.innerText.trim()));
  });
}

/** 在所有 frame 的可见文本里找第一个匹配 */
export async function findTextInFrames(reSource) {
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
/**
 * 返回**第一个**包含 needle 的 frame 的整段可见文本。
 * 和 findTextInFrames 的区别是它交出上下文而不只是命中的那一小段——
 * 页面改版时,只有上下文能告诉你现在长什么样;只拿到 null 的话,除了"改版了"什么都说不出来。
 */
export async function frameTextContaining(reSource) {
  for (const f of page.frames()) {
    try {
      const txt = await f.evaluate(src => {
        const t = (document.body && document.body.innerText) || '';
        return new RegExp(src, 'i').test(t) ? t : null;
      }, reSource);
      if (txt) return txt;
    } catch { /* frame 可能在读的过程中被换掉,跳过即可 */ }
  }
  return null;
}
/**
 * 找到写着 label 的那个叶子元素,然后**往上爬到"最小的、文本里含数字的祖先"**,交出这一块的文字。
 *
 * 为什么需要它,而不是继续用 frameTextContaining:
 * 2026-07-29 那一轮空头持仓全军读错,根因不在正则,在**取数的范围**。Ownership 面板上三个统计块是并排的:
 *     SHORT INTEREST   2.5 DAYS / 1.4% FLOAT
 *     FLOAT            96.2%
 *     INST. OWNERSHIP  72.1% OF FLOAT
 * 整个 frame 的 innerText 把三块拼成一段,于是 `/([\d.,]+)\s*%\s*of\s*Float/` 越过空头那一格,
 * 一路匹配到机构持股的 72.1% —— 正则本身没写错,它只是被喂了不该看见的文本。
 * 只要把范围收进 DOM 里那一格(实测是 `DIV.content-column`),隔壁的数字在**结构上**就够不着了,
 * 这比再补几条更精细的正则牢靠得多:排版可以改,"数字和它的标题在同一个盒子里"不会改。
 *
 * 停在"最小的含数字祖先":标签叶子自己通常只有 "SHORT INTEREST" 没有数字,
 * 再往上一层就把数字包进来了;继续往上则会把兄弟统计块也吞进来,所以见到数字就停。
 * 返回 { block, frameText }:block 用来解析,frameText 用来在失败时打印证据。
 */
export async function frameBlockContaining(label, maxUp = 6) {
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(([lab, up]) => {
        const t = (document.body && document.body.innerText) || '';
        const re = new RegExp(lab, 'i');
        if (!re.test(t)) return null;
        const leaves = [...document.querySelectorAll('*')]
          .filter(e => e.children.length === 0 && re.test(e.textContent || ''));
        const hasNum = s => /\d/.test(s || '');
        for (const leaf of leaves) {
          let el = leaf;
          for (let i = 0; i < up && el; i++) {
            const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
            /* 既写着标签、又已经含上数字 —— 就是这一格,不要再往上 */
            if (re.test(txt) && hasNum(txt)) return { block: txt, frameText: t };
            el = el.parentElement;
          }
        }
        return { block: null, frameText: t };
      }, [label, maxUp]);
      if (r && r.block) return r;
      if (r) return r;                 // 文字在这个 frame 里但没爬出块:仍然交出原文当证据
    } catch { /* frame 可能在读的过程中被换掉,跳过即可 */ }
  }
  return null;
}
/** 对精确文本的叶子元素派发完整鼠标事件序列(自定义控件需要) */
export async function clickTextInFrames(txt, pickLast) {
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
