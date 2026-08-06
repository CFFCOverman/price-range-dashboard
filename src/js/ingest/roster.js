/* ================= ingest: roster.csv(拉取清单)=================
 *
 * 这个文件解决一件很具体的事:仪表盘扫的是文件夹,不是清单。
 * 你从 fetcher/tickers.txt 里删掉一个代码,数据还在 Assets/ 里躺着,于是它照样出现在表格里——
 * 只是从此再也不更新。那一行看不出任何异常,你却会照着一份停在几个月前的价格做判断。
 *
 * 所以 fetcher 每次启动会往 Assets/summary/roster.csv 写一份当前清单,这里读它。
 * 读到了就**只画清单里的公司**;读不到(旧的 Assets 文件夹、演示数据、别人发来的一堆表)
 * 就 state.roster = null,一个都不过滤——没有清单不等于清单是空的,这两件事绝不能弄混。
 *
 * 过滤只影响"画不画",不影响"读不读":落榜公司的数据照常载入,点一下就能展开看。
 * 真正的清理在 fetcher 那侧,而且要等满一年(见 fetcher/lib/roster.mjs)。
 */
function ingestRoster(recs) {
  const set = new Set();
  let markets = 0;
  for (const r of recs) {
    const tk = String(r.ticker || '').trim().toUpperCase();
    /* CSV 没有注释语法,文件末尾那句"别改这里"会被解析成一行数据。
     * 靠开头的 # 滤掉——这是和 fetcher/lib/roster.mjs 的 ROSTER_NOTE 对好的约定。 */
    if (!tk || tk.charAt(0) === '#') continue;
    if (String(r.active || '').trim() === '0') continue;
    /* 市场级序列(BENCH/SECTOR/CREDIT/RATES)不是公司,不进过滤集合:
     * 它们的数据走 state.market,本来就不出现在公司表格里。 */
    if (String(r.role || '').trim().toLowerCase() === 'company') set.add(tk);
    else markets++;
  }
  state.roster = set.size ? set : null;
  return { n: set.size, markets };
}

/** 该画哪些公司。没有清单、或用户点开了开关,就是全部。 */
function visibleCompanies() {
  const all = [...state.companies.values()];
  if (!state.roster || state.showOffRoster) return all;
  const on = all.filter(c => state.roster.has(c.ticker));
  /* 一个都不剩就不过滤。这种情况是清单和数据完全对不上(比如清单写的是另一批代码),
   * 此时交出一张空表格,看起来和"app 坏了"一模一样——宁可多显示,也不要静默地什么都不显示。 */
  return on.length ? on : all;
}

/** 参与计算的公司代码(目前只有"默认同行"这一处用)。
 *  刻意**不看** showOffRoster:那是个显示开关,点一下"展开看看"如果连同行中位数一起变了,
 *  同一家公司的估值区间会因为你点了个眼睛图标而漂移——没有比这更难查的数字来源。 */
function onRosterTickers() {
  const all = [...state.companies.keys()];
  if (!state.roster) return all;
  const on = all.filter(k => state.roster.has(k));
  return on.length ? on : all;
}

/** 被藏起来的有几家。上面那条"全落榜就不过滤"的退路在这里必须同步,否则会写出
 *  "已隐藏 6 家"却又把 6 家都画出来的自相矛盾提示。 */
function offRosterCount() {
  if (!state.roster) return 0;
  const all = [...state.companies.keys()];
  const n = all.filter(k => !state.roster.has(k)).length;
  return n < all.length ? n : 0;
}
