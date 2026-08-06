/* ---- 文件归属解析:文件名 ticker > 公司全名匹配 > 价格接近 > 唯一公司(仅当无名字线索) ---- */
function normName(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function resolveTicker(fileName, nameStr, lastPrice) {
  const m = String(fileName || '').toUpperCase().match(/([A-Z.]{1,6}-[A-Z]{2})(?![A-Z])/);
  if (m) return m[1];
  const nn = normName(nameStr);
  let nameTried = false;
  if (nn.length >= 5) {
    nameTried = true;
    const hits = [...state.companies.values()].filter(c => {
      const fn = normName(c.fullName || '');
      return fn.length >= 5 && (fn.startsWith(nn) || nn.startsWith(fn));
    });
    if (hits.length === 1) return hits[0].ticker;
  }
  if (isFinite(lastPrice)) {
    const near = [...state.companies.values()].filter(c => isFinite(c.price) && Math.abs(lastPrice / c.price - 1) < 0.03);
    if (near.length === 1) return near[0].ticker;
  }
  if (!nameTried && state.companies.size === 1) return [...state.companies.keys()][0];
  return null;   /* 有名字但对不上任何公司:宁可不猜 */
}
