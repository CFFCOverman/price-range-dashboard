/** 同源请求:在已登录的 FactSet 页面里发 fetch(登录态由 fetcher/lib/browser.mjs 管)。所有数据集只通过这里取数。 */
import { apiGet, apiFql, ensureFactsetOrigin } from '../../fetcher/steps/options.mjs';
import { getJson } from '../../fetcher/lib/report-api.mjs';
import { fqlTable } from '../../fetcher/steps/research-feed.mjs';
import { page } from '../../fetcher/lib/browser.mjs';

async function origin() {
  if (!(await ensureFactsetOrigin())) throw new Error('页面不在 my.apps.factset.com 上(多半是登录态掉了)');
}
export async function get(pathQuery) { await origin(); return apiGet(pathQuery); }
/** GET + 要求 JSON;网关错误自动重试(规则见 fetcher/lib/report-api.mjs § getJson) */
export async function getJ(pathQuery, what) { await origin(); return getJson(apiGet, pathQuery, what); }
/** FQL → Map("<sym>|<expr>" → 值数组) */
export async function fql(symbols, exprs) {
  await origin();
  const r = await apiFql(symbols, exprs);
  if (r.status !== 200 || !r.json) throw new Error(`FQL 回了 HTTP ${r.status}${r.text ? ':' + r.text.slice(0, 120) : ''}`);
  return fqlTable(r.json);
}
/** 同源 JSON POST(NewsSearch 用) */
export async function postJ(pathQuery, body, what) {
  await origin();
  const r = await page.evaluate(async ([p, b]) => {
    const res = await fetch(p, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: b });
    return { status: res.status, text: await res.text() };
  }, [pathQuery, JSON.stringify(body)]);
  if (r.status !== 200) throw new Error(`${what} 接口回了 HTTP ${r.status}`);
  try { return JSON.parse(r.text); } catch { throw new Error(`${what} 接口回的不是 JSON(多半是登录页)`); }
}
