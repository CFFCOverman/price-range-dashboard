/** 标的清单的校验(纯函数)。字段含义见 schema/README.md § universe.csv。 */
export const UNIVERSE_COLS = ['symbol', 'kind', 'name', 'group', 'scale', 'breadth'];
const SYM = /^[A-Z0-9][A-Z0-9.&]*(?:-[A-Z0-9]{2,4})?$/;
/** → { rows(清洗后), errors[] } */
export function validateUniverse(input, kinds) {
  const errors = [], seen = new Set(), rows = [];
  input.forEach((r, i) => {
    const row = Object.fromEntries(UNIVERSE_COLS.map(c => [c, String(r[c] ?? '').trim()]));
    row.symbol = row.symbol.toUpperCase();
    const at = `第 ${i + 1} 行(${row.symbol || '空'})`;
    if (!SYM.test(row.symbol)) errors.push(`${at}:代码格式不对,美股写成 NVDA-US`);
    if (seen.has(row.symbol)) errors.push(`${at}:代码重复`);
    if (!kinds.includes(row.kind)) errors.push(`${at}:类型必须是 ${kinds.join(' / ')}`);
    if (row.scale && !(Number(row.scale) > 0)) errors.push(`${at}:换算系数必须是正数或留空`);
    if (/[,"\n]/.test(row.name + row.group + row.breadth)) errors.push(`${at}:名称、分组里不要用逗号或引号`);
    if (row.scale === '1') row.scale = '';
    seen.add(row.symbol); rows.push(row);
  });
  return { rows, errors };
}
