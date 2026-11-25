/** 交易日期:FactSet 美股快照按纽约日期归档;UTC 午夜后纽约仍是前一日。唯一出处(重构 R3)。 */
export function marketDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = k => parts.find(x => x.type === k)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
