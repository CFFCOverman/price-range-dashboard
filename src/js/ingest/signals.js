/* short-interest.csv(fetcher 逐日累积)*/
function ingestShortInt(recs) {
  let n = 0;
  for (const r of recs) {
    const tk = String(r.ticker || '').toUpperCase();
    const days = parseFloat(r.days_to_cover), pct = parseFloat(r.pct_of_float);
    if (!tk || !r.date || !isFinite(pct)) continue;
    const arr = state.shortInt.get(tk) || [];
    const at = arr.findIndex(x => x.date === r.date);
    if (at >= 0) arr[at] = { date: r.date, days, pct };  /* 文件旧→新导入：同日修订以后导入者为准 */
    else { arr.push({ date: r.date, days, pct }); n++; }
    arr.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    state.shortInt.set(tk, arr);
  }
  return n;
}
/* "{ticker} News.csv"(fetcher 从 StreetAccount 累积)—— 归属靠文件名前缀 */
function ingestNews(recs, fileName) {
  const tk = ((/^([A-Z.]{1,6}-[A-Z]{2})/.exec(fileName || '') || [])[1] || '').toUpperCase();
  const ticker = tk && state.companies.has(tk) ? tk : (tk ? resolveTicker(fileName, tk, NaN) : null);
  if (!ticker || !state.companies.has(ticker)) return { ticker: null, text: t('mNewsNoTicker') };
  const seen = new Map();
  for (const r of (state.news.get(ticker) || [])) seen.set(r.date + '|' + r.headline, r);
  for (const r of recs) {
    const date = String(r.date || '').trim(), headline = String(r.headline || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || headline.length < 4) continue;
    seen.set(date + '|' + headline, { date, headline });
  }
  const arr = [...seen.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  state.news.set(ticker, arr);
  return { ticker, text: t('mNewsRows')(ticker, arr.length) };
}
/* "{ticker} Options.csv"(fetcher 从期权链累积)—— 前五列兼容旧文件；新文件另带 volume/delta/bid/ask 等可选事实列
 * 保留每个 asof 快照：压力位读取参照日前最新快照，行为面板用相邻快照计算 OI 变化。 */
function ingestOptions(recs, fileName) {
  // Intraday Flow shares OI columns but is not a daily chain. Mixing the two
  // makes daily walls and delta-OI depend on folder import order.
  if (/ Options Flow\.csv$/i.test(fileName || '')) return { ticker:null, text:'盘中方向快照请在 Options 页面查看；每日 OI 不混入盘中数据。' };
  const tk = ((/^([A-Z.]{1,6}-[A-Z]{2})/.exec(fileName || '') || [])[1] || '').toUpperCase();
  const ticker = tk && state.companies.has(tk) ? tk : (tk ? resolveTicker(fileName, tk, NaN) : null);
  if (!ticker || !state.companies.has(ticker)) return { ticker: null, text: t('mOptNoTicker') };
  const seen = new Map();
  for (const r of (state.options.get(ticker) || [])) seen.set(r.asof + '|' + r.expiry + '|' + r.strike, r);
  for (const r of recs) {
    const expiry = String(r.expiry || '').trim();
    const strike = parseFloat(r.strike);
    const callOI = parseFloat(r.call_oi), putOI = parseFloat(r.put_oi);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !isFinite(strike) || strike <= 0) continue;
    if (!isFinite(callOI) && !isFinite(putOI)) continue;
    const optional = k => { const v = parseFloat(r[k]); return isFinite(v) ? v : null; };
    const rec = { asof: String(r.asof || '').trim(), fetchedAt: String(r.fetched_at || '').trim(), expiry, strike,
      callOI: isFinite(callOI) ? callOI : 0, putOI: isFinite(putOI) ? putOI : 0,
      callVolume: optional('call_volume'), putVolume: optional('put_volume'),
      callDelta: optional('call_delta'), putDelta: optional('put_delta'),
      callBid: optional('call_bid'), callAsk: optional('call_ask'), putBid: optional('put_bid'), putAsk: optional('put_ask'),
      callIV: optional('call_iv'), putIV: optional('put_iv'), callGamma: optional('call_gamma'), putGamma: optional('put_gamma') };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.asof)) continue;
    const key = rec.asof + '|' + expiry + '|' + strike;
    seen.set(key, rec); /* 同一快照同一合约的后导入修订覆盖旧值 */
  }
  const arr = [...seen.values()].sort((a, b) => a.asof < b.asof ? -1 : a.asof > b.asof ? 1
    : a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike);
  state.options.set(ticker, arr);
  const exp = [...new Set(arr.map(r => r.expiry))].length;
  const snaps = [...new Set(arr.map(r => r.asof))].length;
  return { ticker, text: t('mOptRows')(ticker, arr.length, exp, snaps) };
}

/* 关键词情绪:只用于"方向倾斜",不做精细 NLP —— 每条标题最多计一次多/空 */
const NEWS_POS = /\b(upgrad\w*|rais\w*|beat\w*|tops?|topped|record|surge\w*|jump\w*|soar\w*|rall\w*|outperform\w*|overweight|initiat\w+ (?:at |with )?buy|buy rating|strong|stronger|expand\w*|partnership|approval|approved|wins?|won|awarded|secur(?:es|ed)|boost\w*|upside|higher|guidance raised|accelerat\w*|profit\w* rose)\b/gi;
const NEWS_NEG = /\b(downgrad\w*|cut\w*|lower\w*|miss\w*|lawsuit\w*|probe\w*|investigat\w*|recall\w*|delay\w*|halt\w*|weak\w*|warn\w*|plunge\w*|slump\w*|sink\w*|tumbl\w*|fell|falls?|drop\w*|layoff\w*|resign\w*|ban(?:s|ned)?|restrict\w*|curb\w*|underperform\w*|underweight|sell rating|loss(?:es)?|declin\w*|concern\w*|shortfall|subpoena|antitrust|fine[ds]?)\b/gi;
const NEWS_WIN = 30, NEWS_PREV = 90;   /* 打分窗口 30 日;31–90 日只作条数对照,不参与打分 */
function newsScore(ticker, todayISO) {
  const arr = state.news.get(ticker);
  if (!arr || !arr.length) return null;
  const now = todayISO ? new Date(todayISO + 'T00:00:00Z') : new Date();
  const ageD = d => (now - new Date(d + 'T00:00:00Z')) / 86400000;
  let nPos = 0, nNeg = 0, tot = 0, prev = 0;
  for (const r of arr) {
    const a = ageD(r.date);
    if (a < 0 || a > NEWS_PREV) continue;
    if (a > NEWS_WIN) { prev++; continue; }
    tot++;
    const p = (r.headline.match(NEWS_POS) || []).length;
    const n = (r.headline.match(NEWS_NEG) || []).length;
    if (p > n) nPos++; else if (n > p) nNeg++;
  }
  if (!tot && !prev) return null;
  if (!tot) return { s: 0, why: t('dirWhyNewsQuiet')(prev), tot: 0, prev };
  /* 分母下限 4:只有一两条新闻时不至于把分数拉满 */
  const s = clamp1((nPos - nNeg) / Math.max(4, nPos + nNeg));
  return { s, why: t('dirWhyNews')(nPos, nNeg, tot, prev), tot, prev, nPos, nNeg };
}
/* Price Summary 导出:实时/最新价格页 */
