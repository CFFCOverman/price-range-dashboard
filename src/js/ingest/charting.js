/* 最少 K 根(浏览器摄取侧的下限):一份导出少于这么多根,整份不收。
 * 以前这里写的是字面量 `px.length < 13`,回测那边写的是字面量 `px.length < 40`,
 * 于是"13 < 40"只是两个文件各写各的、看上去像巧合。这两个 const 就是把它声明出来。
 *
 * 13 的出处:src/js/valuation/volstats.js 的 `ph.length < 13`(它内部还要 `rets.length < 12`)。
 * 13 个点 = 12 个收益率 = 能算出一个样本方差的最少点数。比它更严没有收益,
 * 比它更松则会收下一条 volStats 注定返回 null 的序列。
 *
 * 为什么**不能**跟 Node 侧统一到 40:这一侧还要吃周线 / 月线导出(volStats 按日期中位间隔
 * 判频率,252 / 52 / 12 / 1 四档都支持),以及**新上市**的短日线序列 ——
 * 今天盘上 SPCX-US 就只有 36 根,按 40 收它会从面板上静默消失。
 *
 * 不变式:INGEST_MIN_BARS(13) < BACKTEST_MIN_BARS(40,见 tools/backtest.mjs)。
 * 中间 13–39 根这一段两侧**故意**不一致:浏览器收(照画),回测不收(样本不够不出结论)。
 * 想"顺手统一"的话,tests/test-app.mjs [16] 末尾那三条断言会先红。
 *
 * 这个 const **不进** tools/backtest.mjs 那行 bridge:Node 侧不读它(它有自己的 40),
 * 桥出去反而会让人以为两边共用同一个下限。 */
const INGEST_MIN_BARS = 13;

/* Charting 导出:Date + "<公司名> - Close" 周/日价格序列(真实价格 → 波动率);P/E-LTM 列仅作参考 */
function ingestChartingSheet(sheetName, aoa, fileName) {
  const hdr = (aoa[0] || []).map(c => String(c || '').trim());
  const di = hdr.findIndex(h => /^date$/i.test(h));
  const ci = hdr.findIndex(h => / - Close$/i.test(h));
  if (di < 0 || ci < 0) return null;
  const pi = hdr.findIndex(h => /P\/E/i.test(h));
  /* 成交量列(FactSet 导出为 "NVDA-US - Volume";也兼容裸 "Volume")→ 真实筹码分布;缺列时压力位退回停留时间口径 */
  const vi = hdr.findIndex(h => / - Volume$/i.test(h) || /^volume$/i.test(h));
  /* 开/高/低三列:FactSet 把图切成 K 线布局后才会多出来("NVDA-US - Open"),手搭的表可能只写 "Open"。
   * 正则与 fetcher/steps/charting.mjs 的 hasCol() **同一条** —— 那边用它判"这份导出算不算含 OHLC",
   * 两处不一致就会出现"抓取器说有、读取层不读"的静默错位。只认这两种写法是有意为之:
   * "52 Week High" 里也有 High,认进来等于凭空多出三列并不存在的日内数据。
   * 三列必须齐:少了 Low 的"蜡烛"画不出下影线,那不是"部分可用",是另一种东西(SPEC K.2)。
   * 没有这三列时下面整段不执行,记录形状与今天逐字段相同 —— 降级路径是主路径,不许被这段改动碰到。 */
  const ohlcIdx = w => hdr.findIndex(h => new RegExp('(^| - )' + w + '$', 'i').test(h));
  const oi = ohlcIdx('Open'), hi2 = ohlcIdx('High'), li2 = ohlcIdx('Low');
  const hasOHLCCols = oi >= 0 && hi2 >= 0 && li2 >= 0;
  let px = []; let lastPE = NaN;
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const d = toISODate(r[di]); const p = parseFloat(r[ci]);
    if (!d || !isFinite(p) || p <= 0) continue;
    const rec = { date: d, price: p };
    if (vi >= 0) { const v = parseFloat(String(r[vi]).replace(/,/g, '')); if (isFinite(v) && v > 0) rec.vol = v; }
    /* 自相矛盾的一根(最高 < 最低、收盘跑到影线外)整根退回"只有收盘价",不写 o/h/l:
     * 画一根自相矛盾的蜡烛比不画危险 —— 它看上去仍然像数据。 */
    if (hasOHLCCols) {
      const nm = x => parseFloat(String(x).replace(/,/g, ''));
      const o = nm(r[oi]), hh = nm(r[hi2]), ll = nm(r[li2]);
      if (isFinite(o) && o > 0 && isFinite(hh) && hh > 0 && isFinite(ll) && ll > 0
        && hh >= ll && hh >= Math.max(o, p) && ll <= Math.min(o, p)) { rec.o = o; rec.h = hh; rec.l = ll; }
    }
    px.push(rec);
    if (pi >= 0) { const v = parseFloat(r[pi]); if (isFinite(v) && v > 0) lastPE = v; }
  }
  /* 公司与市场序列走同一套“同日末行覆盖 + 严格升序”，避免市场收益/MA 重复计日。 */
  px = normalizePriceHist(px);
  if (px.length < INGEST_MIN_BARS) return null;
  /* 市场级序列(fetcher 输出 "_MARKET-角色 SYMBOL Daily Charting.xlsx")→ 存入 market,不建公司 */
  const mm = /_MARKET-(BENCH|SECTOR|CREDIT|RATES)\s+([A-Z.]{1,6}-[A-Z]{2})/i.exec(fileName || '');
  if (mm) {
    const role = mm[1].toUpperCase(), sym = mm[2].toUpperCase();
    const old = state.market.get(role);
    if (!old || px.length >= old.px.length || old.sym !== sym) state.market.set(role, { sym, px });
    return { ticker: null, text: t('mktMsg')(sym, t('mktRole')[role] || role, px.length) };
  }
  const nameStr = hdr[ci].replace(/ - Close$/i, '');
  const ticker = resolveTicker(fileName, nameStr, px[px.length - 1].price);
  if (!ticker) return { ticker: null, text: t('chartNoTicker') };
  if (!state.companies.has(ticker)) {
    state.companies.set(ticker, {
      ticker, name: ticker, currency: '', price: NaN, priceDate: '',
      eps: { fy1: { low: NaN, mean: NaN, high: NaN }, fy2: { low: NaN, mean: NaN, high: NaN } },
    });
  }
  setPriceHist(ticker, px);
  return {
    ticker,
    text: t('chartMsg')(ticker, px.length, px[0].date.slice(0, 7), px[px.length - 1].date.slice(0, 7))
      + (isFinite(lastPE) ? t('chartLtm')(lastPE.toFixed(1)) : ''),
  };
}
