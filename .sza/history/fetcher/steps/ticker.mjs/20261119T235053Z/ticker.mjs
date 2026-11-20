/* steps/ticker.mjs — 单个 ticker 的 8 步编排与新鲜度跳过
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import { page, scrapeTable } from '../lib/browser.mjs';
import { hasPriceToday, isFresh, priceMap, today } from '../lib/companies.mjs';
import { noteArtifact, phase, stampUTC, step } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { metaCharting, metaEst, metaValuation, metaNews, metaOptions, metaShortInt, metaTargets, metaGuidance, metaSurprise } from '../lib/registry.mjs';
import { fetchGuidance, fetchSurprise } from './earnings.mjs';
import { assetPath } from '../lib/config.mjs';
import { dailyCadenceOK, xlsxDateSpan, fetchCharting } from './charting.mjs';
import { currentPeriod, estimateRowsVerdict, fyTag, openEstimateHistory, rowsWithOneRetry, saveEstimateXlsx, shiftLabel, switchPeriod } from './estimates.mjs';
import { fetchNews } from './news.mjs';
import { fetchOptions } from './options.mjs';
import { scrapePrice } from './price.mjs';
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
  if (freshFy1 && freshFy2) {
    R.FY1 = R.FY2 = true;
    log(`  估值数据未过期,跳过 Estimate History 页`);
    adv(2, `${ticker} · 估值已最新`);
    if (freshPx) R.价格 = true;
    else {
      /* 估值周更，但现价必须日更：只打开同一页读页头报价，不重写两份 Estimate 文件。 */
      adv(0, `${ticker} · 更新现价…`);
      try {
        const { tbl } = await openEstimateHistory(ticker);
        const price = await scrapePrice(tbl);
        if (isFinite(price)) {
          priceMap.set(ticker, [ticker, ticker, 'USD', price, today, '', '', '', '', '', ''].join(','));
          R.价格 = true;
        }
      } catch (e) { log(`  ⚠ ${ticker} 现价更新失败: ${e.message.split('\n')[0]}`); }
    }
    adv(1, `${ticker} · 价格记录`);
  } else {
    adv(0, `${ticker} · 打开 Estimate History…`);
    let price = NaN, tag0 = 'FY1', p0 = null, nav = null, tbl = null;
    const captureEstimate = async (period, tag, initialTable) => {
      let activeTable = initialTable;
      const captured = await rowsWithOneRetry(
        async attempt => {
          if (attempt === 2) {
            ({ nav, tbl: activeTable } = await openEstimateHistory(ticker));
            const current = await currentPeriod();
            if (period && current !== period) {
              phase('切换 Report Type');
              if (!(await switchPeriod(period))) throw new Error(`重拉时切回 ${period} 失败`);
              activeTable = nav.frameLocator('iframe[src*="estimate-reports"]');
              await page.waitForTimeout(1500);
            }
          }
          phase('解析行');
          return scrapeTable(activeTable);
        },
        rows => estimateRowsVerdict(tag, rows, { requirePe: false }),
        verdict => log(`  ⚠ ${ticker} ${tag} 首次数据异常: ${verdict.reason}；重新打开 FactSet 再拉一次`),
      );
      phase(captured.verdict.ok ? '写文件' : '解析行');
      const saved = saveEstimateXlsx(ticker, tag, captured.rows,
        `FactSet Estimate History ${period || tag} | ${stampUTC()}`,
        { quarantine: captured.attempts === 2 && !captured.verdict.ok, requirePe: false });
      if (!saved) throw new Error(captured.verdict.reason || '估值文件未保存');
      return saved;
    };
    let openingError = null;
    try {
      ({ nav, tbl } = await openEstimateHistory(ticker));
      price = await scrapePrice(tbl);
      p0 = await currentPeriod();
      tag0 = p0 ? fyTag(p0) : null;
      if (!['FY1', 'FY2'].includes(tag0)) throw new Error(`财年标签未确认：${p0 || '空'}；拒绝猜测 FY1`);
      log(`  当前财年: ${p0}(${tag0})  价格: ${price}`);
    } catch (e) { openingError = e; }
    if (openingError) {
      for (const tag of ['FY1', 'FY2']) {
        R[tag] = await step(metaEst(ticker, tag), async () => {
          phase('导航');
          throw new Error(`估值页初始化失败，未抓取 ${tag}：${openingError.message}`);
        });
      }
    } else {
      R[tag0] = await step(metaEst(ticker, tag0), () => captureEstimate(p0, tag0, tbl));
    }
    adv(1, `${ticker} · ${tag0} 完成`);
    /* 切到"另一个"财年:当前是 FY1 → +1 年;当前是 FY2 → −1 年 */
    if (!openingError && p0 && (tag0 === 'FY1' || tag0 === 'FY2')) {
      const other = shiftLabel(p0, tag0 === 'FY1' ? 1 : -1);
      const otherTag = fyTag(other);
      adv(0, `${ticker} · 切换财年 → ${other}…`);
      R[otherTag] = await step(metaEst(ticker, otherTag), async () => {
        phase('切换 Report Type');
        if (!(await switchPeriod(other))) throw new Error(`财年下拉切换到 ${other} 失败(可在 FactSet 手动切换后重跑)`);
        phase('定位表格');
        const tblO = nav.frameLocator('iframe[src*="estimate-reports"]');
        await page.waitForTimeout(1500);
        return captureEstimate(other, otherTag, tblO);
      });
    }
    adv(1, `${ticker} · 财年数据完成`);
    if (isFinite(price)) {
      priceMap.set(ticker, [ticker, ticker, 'USD', price, today, '', '', '', '', '', ''].join(','));
      R.价格 = true;
    }
    adv(1, `${ticker} · 价格记录`);
  }
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
