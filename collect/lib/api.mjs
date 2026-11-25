/** 同源请求:在已登录的 FactSet 页面里发 fetch。所有数据集只通过这里取数(重构 R2:不再借用旧 fetcher 的页面)。 */
import { openSession } from './session.mjs';
import { BASE } from './paths.mjs';
import { getJson } from '../parsers/report-api.mjs';
import { fqlTable } from '../parsers/fql.mjs';

export const FQL_PATH = '/services/Fql?app=html_reports&string_na=1';

async function page() {
  const p = await openSession();
  if (!/^https:\/\/my\.apps\.factset\.com\//.test(p.url())) await p.goto(`${BASE}/workstation/`, { waitUntil: 'domcontentloaded' });
  return p;
}
/** GET → {status, text} */
export async function get(pathQuery) {
  return (await page()).evaluate(async q => { const r = await fetch(q, { credentials: 'include' }); return { status: r.status, text: await r.text() }; }, pathQuery);
}
/** GET + 要求 JSON;网关错误自动重试(规则见 collect/parsers/report-api.mjs § getJson) */
export const getJ = (pathQuery, what) => getJson(get, pathQuery, what);
/** FQL 原始响应 → {status, json, text}(期权、估值历史用) */
export async function fqlRaw(symbols, exprs) {
  return (await page()).evaluate(async ([p, syms, ex]) => {
    const body = new URLSearchParams({ symbols: syms.join(','), exprs: ex.join(';;') });
    const r = await fetch(p, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: json ? '' : text.slice(0, 400) };
  }, [FQL_PATH, symbols, exprs]);
}
/** FQL → Map("<sym>|<expr>" → 值数组) */
export async function fql(symbols, exprs) {
  const r = await fqlRaw(symbols, exprs);
  if (r.status !== 200 || !r.json) throw new Error(`FQL 回了 HTTP ${r.status}${r.text ? ':' + r.text.slice(0, 120) : ''}`);
  return fqlTable(r.json);
}
/** 同源 JSON POST(NewsSearch 用) */
export async function postJ(pathQuery, body, what) {
  const r = await (await page()).evaluate(async ([p, b]) => {
    const res = await fetch(p, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: b });
    return { status: res.status, text: await res.text() };
  }, [pathQuery, JSON.stringify(body)]);
  if (r.status !== 200) throw new Error(`${what} 接口回了 HTTP ${r.status}`);
  try { return JSON.parse(r.text); } catch { throw new Error(`${what} 接口回的不是 JSON(多半是登录页)`); }
}
