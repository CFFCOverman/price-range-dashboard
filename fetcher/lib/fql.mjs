/* lib/fql.mjs —— 期权链走 FactSet 自己的数据接口,不点 Download、不刮屏
 *
 * 为什么会有这个文件(2026-07-30 实地抓下来的):
 *
 * Options Montage 那个页面本身,数据不是渲染出来的,是它自己先向两个接口要来的。
 * 我们绕过页面直接问同样的两个接口,拿到的是**同一份数据的源头**,
 * 于是虚拟滚动读不全、500 合约导不出、手动下载这三件事同时消失。
 *
 *   1) GET  /services/IDCServ/oc?symbol=NVDA-USA
 *      整条期权链的**目录**:一行一个行权价,竖线分隔,首行是表头。
 *      NVDA 实测 1946 行(到 2028 年 12 月),AMD 3500 行。里面有我们要的三样:
 *      C_RT_SYM / P_RT_SYM(看涨、看跌两条腿的 FactSet 符号)、STRIKE、EXP_DATE(精确到天)。
 *      注意它**没有未平仓量** —— 这只是目录,不是数据。
 *
 *   2) POST /services/Fql?app=html_reports&string_na=1
 *      body: symbols=<逗号分隔>&exprs=<表达式;;表达式>
 *      拿着上一步的符号批量取数。`P_OPT_OPEN_INTEREST` 就是未平仓量。
 *      实测 626 个合约一次请求 2.8 秒、零错误,所以批量大小给到 300 是保守的。
 *
 * 这条路和导出那条路最要紧的区别不是"快",是**它读得全**:
 * 目录是服务端一次给全的,不存在"视口里只有二十行"这种事。
 *
 * 下面全是纯函数(解析 / 筛选 / 拼装),--selftest 里拿实地抄回来的真实字节做断言。
 * 真正碰网络的那几行在 steps/options.mjs 里,刻意分开:
 * 解析错了自检会红,网络错了台账会红,两种失败不该混在一个文件里。
 */

/** 期权链目录。symbol 用 `NVDA-US` / `NVDA-USA` / `NVDA` 都行(实测三者返回同一份) */
export const OC_PATH = '/services/IDCServ/oc';
/** 批量取数。app / string_na 两个参数照抄页面自己发的那份,别省 */
export const FQL_PATH = '/services/Fql?app=html_reports&string_na=1';
/** 一次问多少个合约符号。实测 626 个一次也没事,取 300 是留余量 */
export const FQL_BATCH = 300;
/** 往前看多少天。仪表盘只用 60 天以内的到期日,这里多取一点,免得跑批那天刚好卡在边上 */
export const OPT_API_MAX_DTE = 90;
/** 行权价窗口。仪表盘是 ±25%,这里放宽到 ±35%:两次跑批之间股价会动,窗口贴太紧会削掉边上的墙 */
export const OPT_API_WINDOW = 0.35;
/** 一只标的最多要多少个合约。到不了这个数才是常态;到了说明筛选条件出了问题,要吭声 */
export const OPT_API_MAX_CONTRACTS = 4000;
/** 有多少比例的合约取不到 OI 就算这一轮不可信(宁可失败,也不要交一份缺了一块的链) */
export const OPT_API_MAX_MISS = 0.2;

/** `NVDA-US` / `NVDA-USA` / `NVDA` → `NVDA`。交易所后缀两边写法不一样,只比裸符号 */
export function bareSym(s) { return String(s || '').split('-')[0].trim().toUpperCase(); }

/** `20260821` → `2026-08-21`;不是八位数字返回 null(认不出就不要,不要造日期) */
export function ocDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 两个 `YYYY-MM-DD` 之间差几天(按 UTC 零点算,不受本机时区影响) */
export function daysBetween(fromYmd, toYmd) {
  const a = Date.parse(String(fromYmd) + 'T00:00:00Z'), b = Date.parse(String(toYmd) + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

/**
 * /services/IDCServ/oc 的响应 → { header, rows }。
 *
 * 格式:竖线分隔,**每行末尾还有一根多余的竖线**(所以要 slice(0,-1),不然凭空多一个空列)。
 * 首行是表头。字段名照抄实地那一份:
 *   YEAR|MONTH|DISP_DATE|ROOT|C_RT_SYM|P_RT_SYM|C_DISP_SYM|P_DISP_SYM|STRIKE|SIZE|
 *   UNDERLIER|ADJUSTED|UNDERLIER_IS_US|ANALYTICS_CALC_METHOD|DELIVERABLES|C_OCC_SYM|P_OCC_SYM|
 *   FREQUENCY|VENUE|SETTLEMENT_METHOD|EXERCISE_STYLE|SETTLEMENT_STYLE|OPTION_TYPE|EXCHANGES|EXP_DATE|
 *
 * **空响应是这里最要紧的一种情况**:代码不存在、或这只标的根本没有期权时,
 * 接口给的是 HTTP 200 + 空 body —— 不是 404。所以"请求成功"完全不代表"拿到了链",
 * 必须在这里把它变成一个显式的 error,否则它会一路静悄悄走到写文件那一步。
 */
export function parseOptionChainTable(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { error: '期权链目录是空的(接口回了 200 但 body 为空 —— 代码不对,或这只标的没有期权)' };
  const lines = raw.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length);
  if (lines.length < 2) return { error: `期权链目录只有 ${lines.length} 行,连表头带数据都不够` };
  const header = lines[0].split('|');
  if (header.length && header[header.length - 1] === '') header.pop();   // 行尾那根多余的竖线
  const need = ['C_RT_SYM', 'P_RT_SYM', 'STRIKE', 'EXP_DATE'];
  const miss = need.filter(k => !header.includes(k));
  if (miss.length) return { error: `期权链目录的表头少了 ${miss.join(' / ')}(接口字段改了,对照 lib/fql.mjs 顶部那份注释)` };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('|');
    if (c.length && c[c.length - 1] === '') c.pop();
    if (c.length < header.length) continue;
    const o = {};
    for (let j = 0; j < header.length; j++) o[header[j]] = c[j];
    rows.push(o);
  }
  if (!rows.length) return { error: '期权链目录有表头但一行数据都没有' };
  return { header, rows };
}

/**
 * 整条链(几千行,一路排到两年后)→ 我们真正要问 OI 的那一小撮。
 *
 * 四道筛,每一道都有原因:
 *   · 已到期 / 太远  —— 仪表盘只看 60 天内,取到 90 天是留余量
 *   · 离钱太远        —— 深度价内外的 OI 不构成"墙",问它只是白花请求
 *   · ADJUSTED = 'Y'  —— 拆股、并购调整过的合约,一张不是 100 股,和别人不可比
 *   · UNDERLIER 对不上 —— 和导出那条路核对 sheet 名是同一个动作:
 *                          **别人的链混进来,比没有数据危险得多**
 *
 * 返回 { kept, stats },kept 里每项都带着两条腿的符号,下一步直接拿去问 FQL。
 */
export function pickChainContracts(rows, opt) {
  const o = opt || {};
  const today = o.today;
  const spot = +o.spot;
  const maxDte = isFinite(o.maxDte) ? o.maxDte : OPT_API_MAX_DTE;
  const win = isFinite(o.window) ? o.window : OPT_API_WINDOW;
  const want = o.ticker ? bareSym(o.ticker) : null;
  const stats = { total: (rows || []).length, expired: 0, farDate: 0, farStrike: 0, adjusted: 0, wrongUnderlier: 0, bad: 0 };
  const kept = [];
  for (const r of rows || []) {
    const expiry = ocDate(r.EXP_DATE);
    const strike = Number(String(r.STRIKE || '').replace(/,/g, ''));
    if (!expiry || !isFinite(strike) || strike <= 0 || !r.C_RT_SYM || !r.P_RT_SYM) { stats.bad++; continue; }
    if (String(r.ADJUSTED || '').toUpperCase() === 'Y') { stats.adjusted++; continue; }
    if (want && r.UNDERLIER && bareSym(r.UNDERLIER) !== want) { stats.wrongUnderlier++; continue; }
    const dte = daysBetween(today, expiry);
    if (!isFinite(dte) || dte <= 0) { stats.expired++; continue; }
    if (dte > maxDte) { stats.farDate++; continue; }
    if (isFinite(spot) && spot > 0 && Math.abs(strike / spot - 1) > win) { stats.farStrike++; continue; }
    kept.push({ expiry, strike, dte, call: r.C_RT_SYM, put: r.P_RT_SYM, root: r.ROOT || '' });
  }
  kept.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike));
  stats.kept = kept.length;
  stats.expiries = [...new Set(kept.map(k => k.expiry))].sort();
  return { kept, stats };
}

/** 切批。FQL 一次问太多会慢,一次问太少会多跑几个来回,300 是实测下来两边都不难受的数 */
export function chunk(arr, n) {
  const size = Math.max(1, n | 0), out = [];
  for (let i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * FQL 的响应 → Map(symbol → 数字)。
 *
 * 响应是一个**扁平数组**,一个 (symbol, expression) 一项,长这样:
 *   { "$error":0, "$expression":"P_OPT_OPEN_INTEREST", "$symbol":"NVDA#G3126C145000-USA", "$value":[[180]] }
 * 出错的那项没有 $value,而是 $error:1 + $error_description。
 * 这里**只收 $error 为 0 且值是数字的**,其余一律当没拿到 —— 缺多少由调用方去判断够不够格。
 */
export function parseFqlValues(json, expr) {
  const out = new Map();
  for (const x of Array.isArray(json) ? json : []) {
    if (!x || x.$error) continue;
    if (expr && x.$expression !== expr) continue;
    const v = Array.isArray(x.$value) && Array.isArray(x.$value[0]) ? x.$value[0][0] : null;
    if (typeof v === 'number' && isFinite(v)) out.set(x.$symbol, v);
  }
  return out;
}

/**
 * 筛出来的合约 + OI 表 → csv 那四列 [{expiry, strike, call_oi, put_oi}]。
 *
 * 两条腿哪条没取到就记成缺一次,并且**在 miss 里数出来**。
 * 两条腿都是 0 的行直接不要:它只会把 csv 撑大,仪表盘那边本来也会跳过。
 */
export function assembleOptionRows(kept, oiMap, metricMaps = {}) {
  const m = oiMap instanceof Map ? oiMap : new Map(Object.entries(oiMap || {}));
  const metric = (name, sym) => {
    const map = metricMaps[name];
    if (!(map instanceof Map) || !map.has(sym)) return '';
    const v = map.get(sym);
    return typeof v === 'number' && isFinite(v) ? v : '';
  };
  const out = [];
  let miss = 0, legs = 0;
  for (const k of kept || []) {
    const c = m.has(k.call) ? m.get(k.call) : null;
    const p = m.has(k.put) ? m.get(k.put) : null;
    legs += 2;
    if (c === null) miss++;
    if (p === null) miss++;
    const call_oi = Math.round(c || 0), put_oi = Math.round(p || 0);
    if (call_oi <= 0 && put_oi <= 0) continue;
    out.push({ expiry: k.expiry, strike: k.strike, call_oi, put_oi,
      call_volume: metric('P_OPT_VOLUME', k.call), put_volume: metric('P_OPT_VOLUME', k.put),
      call_delta: metric('P_OPT_DELTA', k.call), put_delta: metric('P_OPT_DELTA', k.put),
      call_bid: metric('P_OPT_BID_PRICE', k.call), call_ask: metric('P_OPT_ASK_PRICE', k.call),
      put_bid: metric('P_OPT_BID_PRICE', k.put), put_ask: metric('P_OPT_ASK_PRICE', k.put) });
  }
  out.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike));
  return { rows: out, miss, legs, expiries: [...new Set(out.map(r => r.expiry))].sort() };
}

/** 缺了太多腿就别交货了。返回 null 表示可以用,返回字符串就是拒收理由 */
export function optApiVerdict(res) {
  if (!res || !res.legs) return '一条合约都没有';
  const ratio = res.miss / res.legs;
  if (ratio > OPT_API_MAX_MISS) {
    return `${res.legs} 条腿里有 ${res.miss} 条没取到未平仓量(${(ratio * 100).toFixed(0)}%,上限 ${OPT_API_MAX_MISS * 100}%)`
      + ' —— 缺一块的链算出来的 max pain 和 OI 墙是错的,宁可这一轮不写';
  }
  if (!res.rows.length) return '所有合约的未平仓量都是 0(这只标的的期权可能根本没人交易)';
  return null;
}
