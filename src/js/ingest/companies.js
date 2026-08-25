function ingestCompanies(recs) {
  let n = 0;
  for (const r of recs) {
    const t = (r.ticker || '').toUpperCase();
    if (!t || !r.price) continue;
    const num = k => { const v = parseFloat(r[k]); return isFinite(v) ? v : NaN; };
    const prev = state.companies.get(t);
    const userPx = prev && prev.priceSrc === 'user';
    state.companies.set(t, {
      ticker: t,
      name: r.name || t,
      fullName: prev ? prev.fullName : undefined,
      currency: (r.currency || '').toUpperCase(),
      price: userPx ? prev.price : num('price'),
      priceSrc: userPx ? 'user' : 'file',
      priceDate: userPx ? prev.priceDate : (r.price_date || ''),
      extra: prev ? prev.extra : undefined,
      eps: (() => {   /* 合并语义:CSV 里留空的 EPS 不覆盖已有值 */
        const keep = (k, pv) => { const v = num(k); return isFinite(v) ? v : (prev ? pv : NaN); };
        const pe1 = prev ? prev.eps.fy1 : {}, pe2 = prev ? prev.eps.fy2 : {};
        return {
          fy1: { low: keep('eps_fy1_low', pe1.low), mean: keep('eps_fy1_mean', pe1.mean), high: keep('eps_fy1_high', pe1.high) },
          fy2: { low: keep('eps_fy2_low', pe2.low), mean: keep('eps_fy2_mean', pe2.mean), high: keep('eps_fy2_high', pe2.high) },
        };
      })(),
    });
    n++;
  }
  return n;
}
function ingestHistory(recs) {
  let n = 0;
  const buf = new Map(), pbuf = new Map();
  for (const r of recs) {
    const tk = (r.ticker || '').toUpperCase();
    if (!tk || !r.date) continue;
    const px = parseFloat(r.price);
    if (isFinite(px) && px > 0) {
      if (!pbuf.has(tk)) pbuf.set(tk, []);
      pbuf.get(tk).push({ date: r.date, price: px });
    }
    let pe = parseFloat(r.pe_ntm);
    if (!isFinite(pe)) {
      const e = parseFloat(r.eps_ntm);
      if (isFinite(px) && isFinite(e) && e > 0) pe = px / e;
    }
    if (!isFinite(pe) || pe <= 0) continue;
    if (!buf.has(tk)) buf.set(tk, []);
    buf.get(tk).push({ date: r.date, pe });
    n++;
  }
  for (const [tk, arr] of buf) {
    arr.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    state.history.set(tk, arr);   // replace whole series for that ticker
  }
  for (const [tk, arr] of pbuf) {
    arr.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    setPriceHist(tk, arr);
  }
  return n;
}

/* 价格序列择优:长的赢,但带成交量的序列值 1.5 倍长度——
 * 因为筹码分布靠成交量加权,一条稍短但有量的日线比一条更长的纯收盘价序列有用得多。 */
const hasVol = a => !!(a && a.length && a.some(d => isFinite(d.vol) && d.vol > 0));
function normalizePriceHist(arr) {
  const byDate = new Map();
  for (const d of (arr || [])) if (d && d.date) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}
function setPriceHist(ticker, arr) {
  if (!arr || !arr.length) return;
  /* 同日重复行以本次输入中最后一行为准，再恢复严格升序。否则 as-of 截断
   * 虽不一定报错，却会让“当天收盘”取决于排序实现如何摆放相等元素。 */
  const next = normalizePriceHist(arr);
  if (!next.length) return;
  const old = state.priceHist.get(ticker) || [];
  const score = a => a.length * (hasVol(a) ? 1.5 : 1);
  /* 文件按旧→新导入；质量同分时必须让后导入者覆盖，才能刷新同长度日线。 */
  if (score(next) >= score(old)) state.priceHist.set(ticker, next);
}
