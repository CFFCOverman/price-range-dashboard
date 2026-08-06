/* lib/opt-store.mjs —— Options.csv 的合并与滚存,纯函数,不碰 fs、不碰网络
 *
 * 为什么单独拎出来:v16.7 之前这段逻辑长在 steps/options.mjs 的 saveOptionsCsv 里,
 * 里面藏了两条"杀历史"的语句 ——
 *   1) 键用 `到期日|行权价`,今天的快照会把昨天那行原地盖掉,一年只剩最后一天;
 *   2) 写盘前 `filter(r => r.expiry >= today)`,到期的链整段删掉。
 * 而"某个行权价上那堵 OI 墙,后来到底顶住没有"——想回测这句话,要的恰好就是
 * **已经到期的、按日期一层层叠起来的**那些行。两条语句一条都不能留。
 *
 * 拆成纯函数还有一个用处:--selftest 能覆盖它。写盘那一层混着 fs,自检只能干看着。
 *
 * 对仪表盘是否安全,是查过代码才敢改的,不是猜的:
 *   · src/js/ingest/signals.js  ingestOptions 按 `到期日|行权价` 去重、**取 asof 最新的那条**
 *     → 表里多出历史行不会影响当期读数;
 *   · src/js/pressure/options.js:57  `if (r.expiry <= today) continue;`
 *     → 已到期的链仪表盘本来就跳过,留着不会污染 OI 墙 / max pain 面板。
 * 所以这次改动只动写入端,仪表盘一行都不用改。
 */

/** 一份快照保留多久。用户选的是"一年":365 天以前的整段快照滚掉 */
export const OPT_RETAIN_DAYS = 365;

/** 单个 ticker 的行数上限。实测一轮约 37 行,天天跑一年约 9.3k 行(≈350 KB);
 *  两万行给的是两年以上的余量,真顶到了也是按"整份最老的快照"往外扔,不会剩半份。 */
export const OPT_CSV_MAX = 20000;

const ymd = /^\d{4}-\d{2}-\d{2}$/;

/** 两个 ISO 日期相差几天(UTC)。fql.mjs 里有个同名的,这里不 import 是为了让本文件零依赖 */
function dayDiff(fromYmd, toYmd) {
  const a = Date.parse(fromYmd + 'T00:00:00Z'), b = Date.parse(toYmd + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

/**
 * 老行 + 这一轮的新行 → 该写回文件的全部行。
 *
 * @param oldRows  从 csv 读出来的对象数组,字段都是字符串:{asof,expiry,strike,call_oi,put_oi}
 * @param recs     这一轮抓到的记录:{expiry,strike,call_oi,put_oi}(数字或字符串都行)
 * @param stamp    这一轮的 asof(YYYY-MM-DD)
 * @param todayISO 今天,用来算保留期。单独传进来而不是在函数里取 new Date(),纯函数才测得动
 * @returns {{rows,added,agedOut,dropped,capped,days,snapshots}}
 */
export function mergeOptionSnapshots(oldRows, recs, stamp, todayISO, opts = {}) {
  const retain = opts.retainDays ?? OPT_RETAIN_DAYS;
  const max = opts.max ?? OPT_CSV_MAX;
  const seen = new Map();                       // 键:asof|到期日|行权价
  let agedOut = 0, dropped = 0;

  const put = r => {
    const asof = String(r.asof ?? '').trim();
    const expiry = String(r.expiry ?? '').trim();
    const strike = String(r.strike ?? '').trim();
    /* 日期不合法的行直接扔:一份说不清是哪天的快照,回测用不了(排不进时间轴),
     * 仪表盘那边也危险(ingestOptions 是按 asof 字符串比大小挑最新的)。计数报出来,不闷声删。 */
    if (!ymd.test(asof) || !ymd.test(expiry) || !strike) { dropped++; return; }
    if (isFinite(dayDiff(asof, todayISO)) && dayDiff(asof, todayISO) > retain) { agedOut++; return; }
    seen.set(asof + '|' + expiry + '|' + strike,
      { asof, expiry, strike, call_oi: String(r.call_oi ?? ''), put_oi: String(r.put_oi ?? '') });
  };

  for (const r of oldRows || []) put(r);
  const before = seen.size;
  /* 同一天重跑就地覆盖(后写的更全),跨天则各存各的一层 —— 这就是"不覆盖"的全部含义。
   * 注意这里**没有**"asof 更新就不倒退"那条判断了:带上 asof 之后各层互不相干,不存在倒退。 */
  for (const r of recs || []) put({ ...r, asof: stamp });

  let rows = [...seen.values()].sort(cmpRow);
  let capped = 0;
  if (rows.length > max) {
    /* 超上限时按"整份最老的快照"往外扔,不是从尾巴上切一刀 ——
     * 切一刀会留下半份链,而半份链算出来的 max pain 是错的,比没有更糟。
     * 今天这份永远不动:哪怕它一份就超了上限,当期读数也不能缺。 */
    const days = [...new Set(rows.map(r => r.asof))].sort();
    while (rows.length > max && days.length > 1) {
      const oldest = days.shift();
      const keep = rows.filter(r => r.asof !== oldest);
      capped += rows.length - keep.length;
      rows = keep;
    }
  }
  const snapshots = new Set(rows.map(r => r.asof)).size;
  return { rows, added: Math.max(0, seen.size - before), agedOut, dropped, capped, snapshots };
}

/** 排序:先按 asof,再按到期日,再按行权价。
 *  按 asof 升序意味着最新一层永远在文件末尾 —— 追加写出来的文件,人读起来也应该是这个样子。 */
export function cmpRow(a, b) {
  if (a.asof !== b.asof) return a.asof < b.asof ? -1 : 1;
  if (a.expiry !== b.expiry) return a.expiry < b.expiry ? -1 : 1;
  return (+a.strike || 0) - (+b.strike || 0);
}
