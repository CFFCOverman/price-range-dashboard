/** news:StreetAccount 新闻,NewsSearch 同源 JSON 接口(2026-11-19 实测,替代页面滚动刮表)。按 id 合并攒历史。 */
import { readCsvFile, upsertCsv } from '../lib/store.mjs';

export const NEWS_PATH = '/services/NewsSearch?input=PURE-JSON&output=PURE-JSON&request_source=';
export const NEWS_COLS = ['id', 'datetime', 'headline', 'subjects', 'primary_symbols', 'body'];
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
export function newsBody(symbol, start, end, page, size) {
  return { databases: ['SA'], returned_fields: ['id', 'headline', 'story_datetime', 'subjects', 'primary_symbols', 'minimal_body'],
    search_timeout: 12000, page, output_encoding: 'UTF8',
    criteria: [{ operator: 'OR', criteria: [{ field: 'primary_symbols', detail: [symbol], operator: 'IN' }] }],
    start_datetime: `${ymd(start)}T000000`, end_datetime: `${ymd(end)}T235959`, max_docs: size,
    sort_spec: 'story_datetime desc', matched_count_request: 1, detect_duplicates: 'remove', exclude_empty_fields: 1, max_symbols: 3000 };
}
/** HTML 正文 → 纯文本(列表项换成 "• ") */
export function htmlText(h) {
  return String(h || '').replace(/<li[^>]*>/gi, '\n• ').replace(/<br\s*\/?>|<\/p>|<\/ul>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
/** 20261119T175344 → 2026-11-19T17:53:44(美东,接口原样) */
export function newsTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : '';
}
/** 增量起点:接口行已覆盖到回看窗口开头(留 30 天余量)→ 从最新一条往前 3 天;否则还没回补完 → 从窗口开头拉 */
export function newsStart(haveSorted, now, lookbackDays) {
  const from = new Date(now - lookbackDays * 864e5);
  const covered = haveSorted.length && Date.parse(haveSorted[0].slice(0, 10)) <= from.getTime() + 30 * 864e5;
  return covered ? new Date(Date.parse(haveSorted.at(-1).slice(0, 10)) - 3 * 864e5) : from;
}
export const newsRow = r => ({ id: r.id, datetime: newsTime(r.story_datetime), headline: r.headline || '', subjects: r.subjects || '',
  primary_symbols: r.primary_symbols || '', body: htmlText(r.minimal_body) });

export const news = {
  key: 'news',
  async run({ symbol, p, file, api, now }) {
    const f = file('news', symbol);
    /* 增量:从接口拉到过的最新一条往前留 3 天重叠;旧版迁移来的 legacy 行不算(它们没有正文),没有就回看 lookback_days */
    const have = readCsvFile(f).rows.filter(r => !String(r.id).startsWith('legacy:')).map(r => r.datetime).filter(Boolean).sort();
    const start = newsStart(have, now, p.lookback_days);
    const rows = [];
    for (let page = 1; page <= p.max_pages; page++) {
      const j = await api.postJ(NEWS_PATH, newsBody(symbol, start, now, page, p.page_size), 'NewsSearch');
      const got = Array.isArray(j.results) ? j.results : [];
      rows.push(...got.map(newsRow));
      if (got.length < p.page_size) break;
    }
    const { total, added } = upsertCsv(f, NEWS_COLS, rows, r => r.id);
    return { rows: total, note: `+${added}(本次取回 ${rows.length})` };
  },
};
