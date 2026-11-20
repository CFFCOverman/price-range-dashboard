/* lib/registry.mjs — 产出清单登记表:抓取与体检共用同一份元信息
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import { BASE } from './config.mjs';
import { MARKETS, marketFile } from './markets.mjs';
import { TICKERS } from './tickers.mjs';
import { optionsUrlHint } from './options-url.mjs';
import { INTEL_REPORTS } from '../steps/company-intel.mjs';

/* ============ 产出清单登记表:抓取与体检共用同一份元信息,永远不会对不上 ============ */
export const NAV = p => `${BASE}/workstation/navigator/company-security/${p}/`;
export const metaEst = (t, fy) => ({
  kind: 'estimates', freshHours: 0,
  file: `${t} ${fy} Estimate History.xlsx`, step: `${t} · 估值历史 ${fy}`,
  tab: 'Company/Security > Estimates > Estimate History',
  desc: `${fy} 逐月一致预期(Mean/Low/High/上调下调家数/P⁄E)`, url: NAV('estimate-history') + t,
});
export const metaValuation = t => ({
  kind: 'valuation', freshHours: 0,
  file: `${t} NTM Valuation History.csv`, step: `${t} · NTM 估值历史`,
  tab: 'FactSet Estimates > rolling NTM EPS and historical prices',
  desc: '近10年月末及最新 NTM P/E，逐历史日期对应盈利预测，独立于固定财年',
  url: `${BASE}/services/Fql?app=html_reports&string_na=1`,
});
export const metaTargets = t => ({
  kind: 'targets', freshHours: 144,
  file: `${t} Targets Ratings.xlsx`, step: `${t} · 目标价评级`,
  tab: 'Company/Security > Estimates > Targets & Ratings (Report Type=History)',
  desc: '月度评级分布/覆盖家数/目标价均值/隐含回报', url: NAV('targets-and-ratings') + t,
});
export const metaGuidance = t => ({
  kind: 'earnings', freshHours: 20,
  file: `${t} Guidance History.csv`, step: `${t} · 公司指引史`,
  tab: 'Company/Security > Estimates > Guidance History',
  desc: '近5年每次指引的上下限/发布时一致预期/实际/发布后股价反应(同源 JSON 接口)', url: NAV('guidance-history') + t,
});
export const metaSurprise = t => ({
  kind: 'earnings', freshHours: 20,
  file: `${t} Surprise History.csv`, step: `${t} · 业绩超预期史`,
  tab: 'Company/Security > Estimates > Surprise History (Quarterly)',
  desc: '近12季 EPS/营收 实际vs一致预期/家数/高低/财报后股价反应(同源 JSON 接口)', url: NAV('surprise-history') + t,
});
/** 公司情报各报告的登记信息,全部由 steps/company-intel.mjs § INTEL_REPORTS 生成,不在这里重写 */
export const metaIntel = (t, r) => ({
  kind: 'company-intel', freshHours: r.freshHours, file: r.file(t), step: `${t} · ${r.key}`,
  tab: r.tab, desc: r.desc, url: NAV(r.slug) + t,
});
export const metaResearchFeed = () => ({
  kind: 'research-feed', freshHours: 0,
  file: 'research-feed latest.json', step: 'Research OS 数据包(全清单)',
  tab: 'FQL 接口:指数/利率/汇率/行业 ETF 收盘 + 各公司一致预期',
  desc: 'SOX/SPX 高低/USDJPY/STOXX600/行业ETF 5日相对SPY/一致预期30日修正,供 Research OS 读取',
  url: `${BASE}/services/Fql?app=html_reports&string_na=1`,
});
export const metaCharting = (t, file, kind = 'charting') => ({
  kind, freshHours: 20,
  file: file || `${t} Daily Charting.xlsx`, step: `${t} · 日线`,
  tab: 'Charting > 下载菜单 > Download data to Excel',
  desc: '价格/成交量序列(频率与年限按账号保存的图表设置)', url: `${BASE}/workstation/charting/`,
});
export const metaNews = t => ({
  kind: 'news', freshHours: 20,
  file: `${t} News.csv`, step: `${t} · 新闻标题`,
  tab: 'Company/Security > News, Research & Filings > StreetAccount',
  desc: '近一年新闻标题(逐轮累积去重,供情绪面关键词打分)', url: NAV('streetaccount') + t,
});
export const metaOptions = t => ({
  kind: 'options', freshHours: 20,
  file: `${t} Options.csv`, step: `${t} · 期权链 OI`,
  /* Options 是与 Company 平级的**顶层页签**(和 Charting 一样),不在 Company 里面 */
  tab: '顶层 Options 页签 > 在其搜索框输入代码 > Option Chain',
  desc: '各到期日/行权价的未平仓量(逐轮累积,供压力位第三轨)', url: optionsUrlHint(t),
});
export const metaShortInt = () => ({
  kind: 'short', freshHours: 20,
  file: 'short-interest.csv', step: '空头持仓(全清单累积)',
  tab: 'Company/Security > Ownership > Company Summary',
  desc: '空头回补天数/占流通盘%,每次拉取累积一行成时间序列', url: NAV('ownership-summary'),
});
export const metaCompanies = () => ({
  kind: 'price', freshHours: 0,
  file: 'companies.csv', step: '价格汇总(全清单)',
  tab: 'Company/Security > Estimates > Estimate History(页头报价)',
  desc: '各公司现价汇总,仪表盘的价格锚', url: NAV('estimate-history'),
});
export function expectedArtifacts() {
  const out = [];
  for (const t of TICKERS) out.push(metaEst(t, 'FY1'), metaEst(t, 'FY2'), metaValuation(t), metaTargets(t), metaGuidance(t), metaSurprise(t), ...INTEL_REPORTS.map(r => metaIntel(t, r)), metaCharting(t), metaNews(t), metaOptions(t));
  for (const [sym, role] of MARKETS) out.push(metaCharting(sym, marketFile(sym, role), 'market'));
  out.push(metaShortInt(), metaCompanies(), metaResearchFeed());
  return out;
}
/** chk:数据体检 —— 回答"哪一步失效了、断在哪一环、该去 FactSet 哪个页面看" */
