/** 已有解析器的报表:guidance / surprise(collect/parsers/earnings.mjs)与公司情报六张表(collect/parsers/company-intel.mjs)。
 *  解析规则只在 collect/parsers 里定义;这里只负责把结果写到 raw/<数据集>/<代码>.csv。 */
import { guidanceUrl, surpriseUrl, parseGuidance, parseSurprise, GUIDANCE_COLS, SURPRISE_COLS, SURPRISE_ITEMS, toCsv } from '../parsers/earnings.mjs';
import { INTEL_REPORTS } from '../parsers/company-intel.mjs';
import { atomicWrite } from '../lib/store.mjs';

const stamp = () => new Date().toISOString();
export const guidance = {
  key: 'guidance',
  async run({ symbol, file, api }) {
    const rows = parseGuidance(await api.getJ(guidanceUrl(symbol), 'Guidance History'), symbol, stamp());
    atomicWrite(file('guidance', symbol), toCsv(GUIDANCE_COLS, rows));   // 空表合法:这家公司不给指引
    return { rows: rows.length, note: rows.length ? `最近 ${rows[0].guid_date}` : '无指引' };
  },
};
export const surprise = {
  key: 'surprise',
  async run({ symbol, file, api }) {
    const all = [];
    for (const item of SURPRISE_ITEMS) {
      const rows = parseSurprise(await api.getJ(surpriseUrl(symbol, item), `Surprise ${item}`), symbol, item, stamp());
      if (!rows.some(r => r.reported)) throw new Error(`${item} 一个已公布季度都没解析出来`);
      all.push(...rows);
    }
    atomicWrite(file('surprise', symbol), toCsv(SURPRISE_COLS, all));
    return { rows: all.length };
  },
};
/* 数据集名 → company-intel 里的报表 key */
export const INTEL_MAP = { credit: 'credit', cds: 'cds-history', holders: 'ownership', supplychain: 'supply-chain', segments: 'segments', georev: 'georev' };
export const intel = Object.fromEntries(Object.entries(INTEL_MAP).map(([ds, key]) => {
  const report = INTEL_REPORTS.find(r => r.key === key);
  if (!report) throw new Error(`company-intel 里没有 ${key}`);
  return [ds, {
    key: ds,
    async run({ symbol, file, api }) {
      const out = await report.build(symbol, (url, what) => api.getJ(url, what));
      atomicWrite(file(ds, symbol), out.csv);
      return { rows: out.count, note: out.note || '' };
    },
  }];
}));
