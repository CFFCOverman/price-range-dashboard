/* steps/ticker.mjs — 单个 ticker 的 8 步编排与新鲜度跳过
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import { hasPriceToday, isFresh, priceMap, today } from '../lib/companies.mjs';
import { noteArtifact, phase, stampUTC, step } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { metaCharting, metaEst, metaValuation, metaNews, metaOptions, metaShortInt, metaTargets, metaGuidance, metaSurprise, metaIntel } from '../lib/registry.mjs';
import { fetchGuidance, fetchSurprise } from './earnings.mjs';
import { INTEL_REPORTS, fetchIntel } from './company-intel.mjs';
import { assetPath } from '../lib/config.mjs';
import { dailyCadenceOK, xlsxDateSpan, fetchCharting } from './charting.mjs';
import { estimateRowsVerdict, fetchEstimateApi, saveEstimateXlsx } from './estimates.mjs';
import { apiFql, apiGet, ensureFactsetOrigin } from './options.mjs';
import { parseFqlValues } from '../lib/fql.mjs';
import { fetchNews } from './news.mjs';
import { fetchOptions } from './options.mjs';
import { fetchShortInterest, hasShortIntToday } from './short-interest.mjs';
import { fetchTargets } from './targets.mjs';
import { fetchValuationHistory } from './valuation.mjs';

export async function fetchTicker(ticker, R, adv, { force = false } = {}) {
  // A separate required artifact means a newly added ticker cannot be skipped
  // merely because its FY forecasts and prices are already fresh.
  const valuationMeta = metaValuation(ticker);
  if (!force && isFresh(valuationMeta)) {
    noteArtifact(valuationMeta); R.NTM = true;
  } else R.NTM = await step(valuationMeta, () => fetchValuationHistory(ticker, { forceHistory: force }));
  adv(1, `${ticker} · NTM 历史${R.NTM ? '完成' : '未完成'}`);
  /* 业绩事件史:两个同源 JSON 接口,不依赖页面渲染,和 NTM 一样放在最前面独立判断新鲜度 */
  {
    const gm = metaGuidance(ticker), sm = metaSurprise(ticker);
    const gOk = !force && isFresh(gm) ? (noteArtifact(gm), true) : await step(gm, () => fetchGuidance(ticker));
    const sOk = !force && isFresh(sm) ? (noteArtifact(sm), true) : await step(sm, () => fetchSurprise(ticker));
    R.业绩 = gOk && sOk;
    adv(1, `${ticker} · 指引/超预期史${R.业绩 ? '完成' : '未完成'}`);
  }
  /* 公司情报:报告清单见 steps/company-intel.mjs § INTEL_REPORTS,各按自己的新鲜周期 */
  {
    let ok = true;
    for (const r of INTEL_REPORTS) {
      const m = metaIntel(ticker, r);
      if (!force && isFresh(m)) { noteArtifact(m); continue; }
      ok = (await step(m, () => fetchIntel(r, ticker))) && ok;
    }
    R.情报 = ok;
    adv(1, `${ticker} · 公司情报${ok ? '完成' : '部分未完成'}`);
  }
  const freshFy1 = !force && isFresh(metaEst(ticker, 'FY1'));
  const freshFy2 = !force && isFresh(metaEst(ticker, 'FY2'));
  const freshCh = !force && isFresh(metaCharting(ticker)) && dailyCadenceOK(xlsxDateSpan(assetPath(metaCharting(ticker).file)));
  const freshTg = !force && isFresh(metaTargets(ticker));
  const freshNw = !force && isFresh(metaNews(ticker));
  /* 字段升级或人工复核时可只强制重拉期权；其它数据仍按各自新鲜周期判断。 */
  const freshOp = !force && process.env.FS_FORCE_OPTIONS !== '1' && isFresh(metaOptions(ticker));
  const freshSi = !force && hasShortIntToday(ticker);
  const freshPx = !force && hasPriceToday(ticker);
  /* 跳过时也把元信息登记进台账,体检才认得出"这个产出应该存在" */
  for (const m of [metaEst(ticker, 'FY1'), metaEst(ticker, 'FY2'), metaTargets(ticker), metaCharting(ticker), metaNews(ticker), metaOptions(ticker), metaShortInt()]) noteArtifact(m);
  if (freshFy1 && freshFy2 && freshCh && freshTg && freshNw && freshOp && freshSi && freshPx) {
    R.FY1 = R.FY2 = R.价格 = R.日线 = R.目标价 = R.空头 = R.新闻 = R.期权 = true;
    log(`==== ${ticker} ==== 其余8项本地数据仍在各自新鲜周期内,跳过`);
    adv(8, `${ticker} · 已最新`);
    return;
  }
  log(`==== ${ticker} ====`);
  /* 估值史 FY1/FY2 与现价:走同源接口(原因与接口形状见 steps/estimates.mjs § 估值史走同源接口)。
   * 旧的页面刮表路径(openEstimateHistory / switchPeriod)保留在 estimates.mjs 里,只作退路和自检用。 */
  const request = async p => { if (!(await ensureFactsetOrigin())) throw new Error('页面不在 my.apps.factset.com 上(多半是登录态掉了)'); return apiGet(p); };
  for (const [tag, period, fresh] of [['FY1', 1, freshFy1], ['FY2', 2, freshFy2]]) {
    if (fresh) { R[tag] = true; continue; }
    R[tag] = await step(metaEst(ticker, tag), async () => {
      phase('取接口');
      const rows = await fetchEstimateApi(ticker, period, request);
      phase('解析行');
      const verdict = estimateRowsVerdict(tag, rows, { requirePe: false });
      if (!verdict.ok) throw new Error(verdict.reason);
      phase('写文件');
      if (!saveEstimateXlsx(ticker, tag, rows, `FactSet Estimate History API period=${period} | ${stampUTC()}`, { requirePe: false })) throw new Error('估值文件未保存');
      return true;
    });
  }
  adv(2, `${ticker} · FY1/FY2 ${R.FY1 && R.FY2 ? '完成' : '未完成'}`);
  if (freshPx) R.价格 = true;
  else {
    try {
      if (!(await ensureFactsetOrigin())) throw new Error('登录态');
      const px = await apiFql([ticker], ['P_PRICE(NOW)']);
      const price = parseFqlValues(px.json, 'P_PRICE(NOW)').get(ticker);
      if (isFinite(price) && price > 0) {
        priceMap.set(ticker, [ticker, ticker, 'USD', price, today, '', '', '', '', '', ''].join(','));
        R.价格 = true;
      } else log(`  ⚠ ${ticker} 现价:FQL 没返回数值`);
    } catch (e) { log(`  ⚠ ${ticker} 现价更新失败: ${e.message.split('\n')[0]}`); }
  }
  adv(1, `${ticker} · 价格记录`);
  if (freshTg) {
    R.目标价 = true;
    log(`  目标价/评级历史未过期,跳过`);
    adv(1, `${ticker} · 目标价已最新`);
  } else {
    adv(0, `${ticker} · Targets & Ratings 月度历史…`);
    R.目标价 = await step(metaTargets(ticker), () => fetchTargets(ticker));
    adv(1, `${ticker} · 目标价完成`);
  }
  if (freshSi) {
    R.空头 = true;
    log(`  空头持仓今日已记录,跳过`);
    adv(1, `${ticker} · 空头已最新`);
  } else {
    adv(0, `${ticker} · 空头持仓…`);
    R.空头 = await step({ ...metaShortInt(), step: `${ticker} · 空头持仓` }, () => fetchShortInterest(ticker));
    adv(1, `${ticker} · 空头完成`);
  }
  if (freshNw) {
    R.新闻 = true;
    log(`  新闻标题未过期,跳过 StreetAccount`);
    adv(1, `${ticker} · 新闻已最新`);
  } else {
    adv(0, `${ticker} · StreetAccount 新闻标题…`);
    R.新闻 = await step(metaNews(ticker), () => fetchNews(ticker));
    adv(1, `${ticker} · 新闻完成`);
  }
  if (freshOp) {
    R.期权 = true;
    log(`  期权链未过期,跳过`);
    adv(1, `${ticker} · 期权已最新`);
  } else {
    adv(0, `${ticker} · 期权链未平仓量…`);
    /* 尽力而为:没有期权权限、或页面路径变了,只记台账不阻断本轮 */
    R.期权 = await step(metaOptions(ticker), () => fetchOptions(ticker));
    adv(1, `${ticker} · 期权完成`);
  }
  if (freshCh) {
    R.日线 = true;
    log(`  日线未过期,跳过 Charting`);
    adv(1, `${ticker} · 日线已最新`);
  } else {
    adv(0, `${ticker} · Charting 日线导出…`);
    R.日线 = await step(metaCharting(ticker), () => fetchCharting(ticker));
    adv(1, `${ticker} · 完成`);
  }
}
