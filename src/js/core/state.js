/* ================= state ================= */
const SRC_RANK = { user: 3, file: 2, derived: 1 };   /* 现价来源优先级:手填 > 文件实价 > 模型反推 */
const state = {
  companies: new Map(),   // ticker -> {ticker,name,currency,price,priceSrc,priceDate,eps,extra}
  history: new Map(),     // ticker -> [{date, pe}] sorted by date
  priceHist: new Map(),   // ticker -> [{date, price}] sorted by date(用于波动率区间)
  overrides: new Map(),   // `${ticker}|${hz}` -> {low,mean,high}
  peManual: new Map(),    // ticker -> {p25,p50,p75}
  dirManual: new Map(),   // ticker -> {m,i,l} 宏观/行业/流动性打分('a'=跟随自动信号)
  market: new Map(),      // role(BENCH/SECTOR/CREDIT/RATES) -> {sym, px:[{date,price}]}
  peerSel: new Map(),     // ticker -> '逗号分隔同行代码'(空 = 其他全部有修正数据的公司)
  shortInt: new Map(),    // ticker -> [{date,days,pct}] 空头持仓(fetcher 逐日累积)
  news: new Map(),        // ticker -> [{date,headline}] StreetAccount 新闻标题(fetcher 累积去重)
  options: new Map(),     // ticker -> [{asof,expiry,strike,callOI,putOI}] 期权链未平仓量(按到期日+行权价取最新 asof)
  roster: null,           // Set(ticker) 拉取清单(Assets/summary/roster.csv);null = 没有清单文件,不过滤
  showOffRoster: false,   // 表格下方那个开关:临时把不在清单里的也画出来
  selected: null,
  horizon: 'fy1',        // **财年**(fy1/fy2),不是持有期。绝不能喂给 pressureLevels 的第四参。
  plHold: 'mid',         // 压力位面板的**持有期**('short'|'mid'|'long' → h = 5/21/63),与 horizon 是两回事
  klWin: 'w120',         // 价格走势面板画多少根('w60'|'w120'|'all');纯显示窗口,不进任何计算
  /* 买入模拟面板**只**记住用户挑了什么(跨公司切换保留),不缓存任何结果:
   * 回放结果是纯派生物,重算比缓存便宜,而缓存一旦跟着 state 走,切了票忘了清就会
   * 把 A 票的触发时点画在 B 票下面 —— 那种错看起来完全像真的。结果放 render/sim.js 的
   * 模块级 simLast,并且每次渲染都校验 ticker 对不对得上。 */
  simPref: { hold: 'mid', presetId: 'supportBuy', custom: '' },

  sortKey: 'midPct',
  sortDir: -1,
};

