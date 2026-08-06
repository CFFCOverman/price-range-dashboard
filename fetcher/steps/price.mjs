/* steps/price.mjs — 第 2 步:页面头部现价
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import { findTextInFrames } from '../lib/browser.mjs';

export async function scrapePrice() {
  const t = await findTextInFrames('\\$[\\d,]+\\.\\d{2}');
  return t ? parseFloat(t.replace(/[$,]/g, '')) : NaN;
}

/** Charting 日线导出(失败向上抛,由 step() 记录断点) */
/** 导出的 Charting xlsx 里到底有没有成交量列?这是唯一可信的判据 ——
 *  UI 上点没点中不重要,文件里有没有那一列才重要。 */
