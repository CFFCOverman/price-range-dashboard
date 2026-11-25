/** 本轮要拉什么:纯函数。节奏数值只来自 config/params.json(见 collect/README.md § 数据集清单)。 */
export const stateKey = (dataset, symbol) => `${dataset}|${symbol}`;

/** 上次成功距今超过该数据集节奏(小时)才到期;force 时一律到期 */
export function isDue(params, dataset, lastOkIso, now = new Date(), force = false) {
  if (force || !lastOkIso) return true;
  const cad = params.datasets?.[dataset]?.cadence;
  const hours = params.cadence_hours?.[cad];
  if (!isFinite(hours)) throw new Error(`params.json 里 ${dataset} 的 cadence "${cad}" 没有对应的 cadence_hours`);
  return (now - new Date(lastOkIso)) / 3600e3 >= hours;
}

/** universe × scope → [{dataset, symbol, entry}];only / symbols 可缩小范围 */
export function planRun(params, universe, state, { now = new Date(), force = false, only = null, symbols = null } = {}) {
  const jobs = [];
  for (const entry of universe) {
    if (symbols && !symbols.includes(entry.symbol)) continue;
    const list = params.scope?.[entry.kind];
    if (!list) throw new Error(`universe.csv 里 ${entry.symbol} 的 kind "${entry.kind}" 在 params.scope 里没有定义`);
    for (const dataset of list) {
      if (only && !only.includes(dataset)) continue;
      if (isDue(params, dataset, state[stateKey(dataset, entry.symbol)]?.ok_at, now, force)) jobs.push({ dataset, symbol: entry.symbol, entry });
    }
  }
  /* 同一数据集排在一起:失败模式(登录、接口改版)通常按数据集成片出现,报告也好读 */
  const order = Object.keys(params.datasets);
  return jobs.sort((a, b) => order.indexOf(a.dataset) - order.indexOf(b.dataset));
}
