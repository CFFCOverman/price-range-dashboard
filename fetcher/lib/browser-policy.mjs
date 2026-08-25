/* 浏览器窗口策略保持为纯函数：自检不启动 Chrome，也能把三种模式与登录回退钉死。 */
export function headlessMode(raw, loginOnly = false) {
  if (loginOnly) return 'visible';
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v || v === 'auto') return 'auto';
  if (v === '0') return 'visible';
  if (v === '1') return 'headless';
  throw new Error(`FS_HEADLESS 只接受 auto、0 或 1，收到: ${raw}`);
}

export function initialHeadless(mode) { return mode !== 'visible'; }

export function loginFallback(mode) {
  if (mode === 'headless') return 'error';
  return mode === 'auto' ? 'relaunch-visible' : 'wait-visible';
}

export function factsetSessionValid(url) {
  try {
    const u = new URL(String(url || ''));
    return u.hostname === 'my.apps.factset.com' && !/login|auth|signin/i.test(u.href);
  } catch { return false; }
}
