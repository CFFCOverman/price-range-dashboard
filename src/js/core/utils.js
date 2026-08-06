/* ================= utils ================= */
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  for (const k in (attrs || {})) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
};
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function rankPct(sorted, v) {
  let c = 0; for (const x of sorted) if (x <= v) c++;
  return Math.round(100 * c / sorted.length);
}
const fmtN = v => {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtPct = v => isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + '%' : '—';
const fmtX = v => isFinite(v) ? v.toFixed(1) + 'x' : '—';
/* 大整数(期权 OI)压缩:12345 → 12.3k,只用于表格里的紧凑标注 */
const fmtInt = v => !isFinite(v) ? '—' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v));

