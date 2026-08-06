/* lib/markets.mjs — 市场级序列清单 markets.txt
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import { MARKETS_FILE } from './config.mjs';
import { VALID } from './tickers.mjs';

/* ============ 市场级序列(走向概率的宏观/行业/流动性自动信号)============
 * markets.txt 每行: SYMBOL 角色   角色 ∈ BENCH(市场基准) SECTOR(行业) CREDIT(信用/流动性) RATES(利率)
 * 只拉日线 Charting,输出文件名 "_MARKET-角色 SYMBOL Daily Charting.xlsx",App 按角色自动识别 */
export const MARKET_ROLES = ['BENCH', 'SECTOR', 'CREDIT', 'RATES'];
export const MARKETS_DEFAULT = [
  ['SPY-US', 'BENCH'],    // 标普500 ETF — 市场基准 + 波动率代理
  ['SOXX-US', 'SECTOR'],  // 半导体 ETF — 行业相对强弱(按你的持仓行业可改)
  ['HYG-US', 'CREDIT'],   // 高收益债 ETF — 信用利差 / 流动性代理
  ['IEF-US', 'RATES'],    // 7-10年美债 ETF — 价格升 = 利率降(对高PE成长股为顺风)
];
export function loadMarkets() {
  try {
    if (fs.existsSync(MARKETS_FILE)) {
      const out = [];
      for (const raw of fs.readFileSync(MARKETS_FILE, 'utf8').split(/\r?\n/)) {
        const s = raw.replace(/#.*$/, '').trim().toUpperCase();
        if (!s) continue;
        const [sym, role] = s.split(/\s+/);
        if (VALID.test(sym) && MARKET_ROLES.includes(role)) out.push([sym, role]);
      }
      return out;   /* 文件存在就以文件为准(清空 = 不拉市场数据) */
    }
  } catch {}
  return MARKETS_DEFAULT.map(x => [...x]);
}
export function saveMarkets(list) {
  fs.writeFileSync(MARKETS_FILE,
    '# 市场级数据清单(走向概率的宏观/行业/流动性自动信号)—— 只拉日线\n' +
    '# 每行: SYMBOL 角色    角色可选: BENCH=市场基准  SECTOR=行业  CREDIT=信用/流动性  RATES=利率\n' +
    '# 行业请换成贴合你持仓的 ETF(半导体 SOXX-US / 软件 IGV-US / 云 SKYY-US 等);全部删掉 = 不拉市场数据\n' +
    list.map(([s, r]) => s.padEnd(10) + r).join('\n') + '\n');
}
export let MARKETS = loadMarkets();
if (!fs.existsSync(MARKETS_FILE)) saveMarkets(MARKETS);
export const marketFile = (sym, role) => `_MARKET-${role} ${sym} Daily Charting.xlsx`;
export function setMarkets(list) { MARKETS = list; }
