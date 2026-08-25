/* steps/ticker.mjs — 单个 ticker 的 8 步编排与新鲜度跳过
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import { page, scrapeTable } from '../lib/browser.mjs';
import { hasPriceToday, isFresh, priceMap, today } from '../lib/companies.mjs';
import { noteArtifact, phase, stampUTC, step } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { metaCharting, metaEst, metaNews, metaOptions, metaShortInt, metaTargets } from '../lib/registry.mjs';
import { fetchCharting } from './charting.mjs';
import { currentPeriod, fyTag, openEstimateHistory, saveEstimateXlsx, shiftLabel, switchPeriod } from './estimates.mjs';
import { fetchNews } from './news.mjs';
import { fetchOptions } from './options.mjs';
import { scrapePrice } from './price.mjs';
import { fetchShortInterest, hasShortIntToday } from './short-interest.mjs';
import { fetchTargets } from './targets.mjs';

export async function fetchTicker(ticker, R, adv) {
  const freshFy1 = isFresh(metaEst(ticker, 'FY1'));
  const freshFy2 = isFresh(metaEst(ticker, 'FY2'));
  const freshCh  = isFresh(metaCharting(ticker));
  const freshTg = isFresh(metaTargets(ticker));
  const freshNw = isFresh(metaNews(ticker));
  const freshOp = isFresh(metaOptions(ticker));
  const freshSi = hasShortIntToday(ticker);
  const freshPx = hasPriceToday(ticker);
  /* 跳过时也把元信息登记进台账,体检才认得出"这个产出应该存在" */
  for (const m of [metaEst(ticker, 'FY1'), metaEst(ticker, 'FY2'), metaTargets(ticker), metaCharting(ticker), metaNews(ticker), metaOptions(ticker), metaShortInt()]) noteArtifact(m);
  if (freshFy1 && freshFy2 && freshCh && freshTg && freshNw && freshOp && freshSi && freshPx) {
    R.FY1 = R.FY2 = R.价格 = R.日线 = R.目标价 = R.空头 = R.新闻 = R.期权 = true; R.fresh = true;
    log(`==== ${ticker} ==== 各项本地数据仍在各自新鲜周期内,整体跳过`);
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
        await openEstimateHistory(ticker);
        const price = await scrapePrice();
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
    R.FY1 = await step(metaEst(ticker, 'FY1'), async () => {
      phase('导航'); ({ nav, tbl } = await openEstimateHistory(ticker));
      phase('解析行');
      price = await scrapePrice();
      p0 = await currentPeriod();
      tag0 = (p0 ? fyTag(p0) : null) || 'FY1';
      log(`  当前财年: ${p0}(${tag0})  价格: ${price}`);
      /* 标签空的时候上面那个 FY1 是**猜**的:FactSet 打开默认停在 FY1,绝大多数时候猜得对,
       * 但猜错就是拿 FY2 的表覆盖掉 FY1 的文件,而文件名看不出任何异常。说一声,别闷着。 */
      if (!p0) log(`  ⚠ 财年标签没读出来,这份表按 FY1 存了(默认页就是 FY1);要是 P/E 明显不对,删掉 ${ticker} FY1 Estimate History.xlsx 重拉一轮`);
      phase('写文件');
      const okNow = saveEstimateXlsx(ticker, tag0, await scrapeTable(tbl), `FactSet Estimate History ${p0 || tag0} | ${stampUTC()}`);
      if (tag0 !== 'FY1') { R[tag0] = okNow; return okNow; }   /* 极少见:页面停在 FY2 */
      return okNow;
    });
    adv(1, `${ticker} · ${tag0} 完成`);
    /* 切到"另一个"财年:当前是 FY1 → +1 年;当前是 FY2 → −1 年 */
    if (p0 && (tag0 === 'FY1' || tag0 === 'FY2')) {
      const other = shiftLabel(p0, tag0 === 'FY1' ? 1 : -1);
      const otherTag = fyTag(other);
      adv(0, `${ticker} · 切换财年 → ${other}…`);
      R[otherTag] = await step(metaEst(ticker, otherTag), async () => {
        phase('切换 Report Type');
        if (!(await switchPeriod(other))) throw new Error(`财年下拉切换到 ${other} 失败(可在 FactSet 手动切换后重跑)`);
        phase('定位表格');
        const tblO = nav.frameLocator('iframe[src*="estimate-reports"]');
        await page.waitForTimeout(1500);
        phase('写文件');
        return saveEstimateXlsx(ticker, otherTag, await scrapeTable(tblO), `FactSet Estimate History ${other} | ${stampUTC()}`);
      });
    } else {
      /* 标签读不出来(或认不出是 FY1/FY2)就没法切财年 —— 但**必须显式记一笔失败**。
       * 原来这里是干脆 if 掉:汇总表打 ✖FY2、提示"详见 sources.txt",
       * 而 sources.txt 里躺的还是上一轮那行 OK。让人去查一份写着"一切正常"的台账,
       * 比不报错更耗时间。走 step() 就会写 FAIL 行,失败环节也点得出名。 */
      R.FY2 = await step(metaEst(ticker, 'FY2'), async () => {
        phase('解析行');
        throw new Error(p0
          ? `财年标签「${p0}」认不出是 FY1 还是 FY2,没法切到另一个财年`
          : '页面上读不到财年标签(那一格 Jul \'26E),重试 3 次仍为空 —— 这轮拿不到 FY2');
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
