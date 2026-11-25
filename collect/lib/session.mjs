/**
 * FactSet 登录会话(重构 R2)。只做三件事:用专用 profile 启动 Chrome、确认登录、把页面交给 lib/api.mjs 发同源请求。
 * 窗口策略(后台 / 可见 / 登录回退)的纯函数在 ./session-policy.mjs。
 *   FS_HEADLESS=auto(默认):后台跑;登录失效时开可见窗口等你登录,登录后切回后台
 *   FS_HEADLESS=0:全程可见   FS_HEADLESS=1:全程后台,登录失效直接报错(给计划任务用)
 *   node collect/login.mjs:只开窗口登录一次,保存登录态后退出
 */
import { chromium } from 'playwright';
import { BASE, PROFILE } from './paths.mjs';
import { headlessMode, initialHeadless, loginFallback, factsetSessionValid, browserUsable } from './session-policy.mjs';

let ctx = null, page = null;
export const currentPage = () => page;

async function close() { const old = ctx; ctx = null; page = null; if (old) await old.close().catch(() => {}); }
export const closeSession = close;

async function launch(headless) {
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless, viewport: { width: 1600, height: 900 } });
  } catch (err) {
    ctx = null; page = null;
    if (/exitCode=21|ProcessSingleton|profile directory/i.test(String(err?.message || err))) {
      throw new Error('FactSet 专用 Chrome profile 正被另一个 Chrome 占用:关掉之前遗留的拉取窗口再试(不要删 .factset-bot-profile,里面是登录态)。', { cause: err });
    }
    throw err;
  }
  page = ctx.pages()[0] || await ctx.newPage();
}
async function signedIn() {
  await page.goto(BASE + '/workstation/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(5000);
  return factsetSessionValid(page.url());
}
async function waitForLogin(log) {
  log('请在弹出的 Chrome 里登录 FactSet,登录完成后会自动继续……');
  while (ctx) {
    const pages = ctx.pages().filter(p => !p.isClosed());
    const ok = pages.find(p => factsetSessionValid(p.url()));
    if (ok) { page = ok; await page.waitForTimeout(1500); if (!page.isClosed() && factsetSessionValid(page.url())) return; }
    if (!pages.length) throw new Error('登录窗口被关掉了,还没完成登录。');
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('登录浏览器已关闭。');
}

/** 拿到一个已登录、停在 my.apps.factset.com 的页面 */
export async function openSession({ mode = headlessMode(process.env.FS_HEADLESS), log = console.log } = {}) {
  if (browserUsable(ctx, page) && factsetSessionValid(page.url())) return page;
  await close();
  await launch(initialHeadless(mode));
  if (await signedIn()) return page;
  const fallback = loginFallback(mode);
  if (fallback === 'error') { await close(); throw new Error('FactSet 登录已失效(FS_HEADLESS=1 不开窗口):先运行 node collect/login.mjs 登录一次。'); }
  if (fallback === 'relaunch-visible') { await close(); await launch(false); await page.goto(BASE + '/workstation/', { waitUntil: 'domcontentloaded' }).catch(() => {}); }
  await waitForLogin(log);
  if (fallback === 'relaunch-visible') {
    const cookies = await ctx.cookies();
    await close(); await launch(true); await ctx.addCookies(cookies);
    if (!(await signedIn())) { await close(); throw new Error('登录后后台会话检查没通过,请重新运行。'); }
  }
  return page;
}
