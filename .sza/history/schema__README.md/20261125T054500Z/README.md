# schema · 数据存储类型(唯一出处)

> 本文件定义 G 盘上每类数据**放在哪、长什么样、口径是什么**。代码与其他文档只引用这里的节名,不复述字段。
> 数据目录由 `config/assets-path.txt` 指定(当前 `G:\My Drive\PriceRangeDashboard\Assets`),规则见 `collect/lib/paths.mjs`。

## 分区
| 区 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `config/` | 控制台(你) | collect、process | `universe.csv` 标的清单(现行版本;仓库里 `config/universe.seed.csv` 只作首次初始值) |
| `raw/` | collect | process | FactSet 原样数据,一个数据集一个子目录(§ raw) |
| `derived/` | process | 控制台、handoff | 计算结果:`levels/<代码>.json`、`valuation/<代码>.json`(§ derived) |
| `handoff/` | process | Research OS | 给账本的数据包:`latest.json`、`<日期>.json`、`previous.json`(§ handoff) |
| `_state/` | collect | 控制台 | `collect.json` 每项最后成功/失败;`last-run.json` 上一轮明细 |

## universe.csv
`symbol,kind,name,group,scale,breadth`
- `kind`:`company`(全部数据集)· `etf`(日线 + 期权)· `market`(只日线)· `breadth-only`(只进修订广度)· `price-only`;每类拉哪些数据集只在 `config/params.json § scope`
- `scale`:报价换算系数(IRX 报价 ×0.1 = 收益率 %),空 = 1
- `breadth`:修订广度分组名(如 `AI`),空 = 不参与
- `#` 开头的行是注释(停拉的标的保留在这里,写明原因)

## raw
日期一律纽约交易日 `YYYY-MM-DD`;金额为报价币种;`_30d` 后缀 = 30 天前的同一读数。
| 数据集 | 文件 | 主键 | 写法 |
|---|---|---|---|
| prices | `prices/<代码>.csv`:date, open, high, low, close, volume_k(千股) | date | 合并;高低只有当天一格 |
| consensus | `consensus/<代码>.csv`:每天一行,EPS NQ/FY1–FY4 的均值/最低/最高/标准差/家数,收入,目标价 | date | 合并 |
| valuation | `valuation/<代码>.csv`:月末 pe_ntm, price, eps_ntm(10 年) | date | 合并 |
| estimates | `estimates/<代码> FY1.csv`、`FY2.csv`:5 年月度一致预期 + P/E、PEG;`fiscal_period` 为财年标签 | date | 整表替换 |
| targets | `targets/<代码> history.csv`(月度一致)、`<代码> brokers.csv`(逐家,首行 `Mean` 为均值) | date / 当日 | 合并 / 替换 |
| ownership | `ownership/<代码>.csv`:机构/内部人/流通盘 %、short_pct_float、short_days、shares_os | date | 合并 |
| news | `news/<代码>.csv`:id, datetime(美东), headline, subjects, primary_symbols, body | id | 合并;`legacy:` 开头为旧版只有标题的 |
| guidance / surprise | `guidance/<代码>.csv`、`surprise/<代码>.csv` | — | 替换 |
| credit / cds / holders / supplychain / segments / georev | `<数据集>/<代码>.csv` | — | 替换 |
| breadth | `breadth/<组>.csv`:date, symbol, eps_ntm, eps_ntm_30d, FY1/FY2 上调/下调家数 | date+symbol | 合并 |
| options | `options/<代码>/<日期>.csv`:expiry, strike, call/put 的 oi、volume、last、bid、ask、delta、gamma;`*_oi_eod` 为次日补读的收盘 OI | 当日文件 | 一天一个文件,保留 `keep_days` |

## derived
- `levels/<代码>.json`:`{spot, options:{asof, oi_basis: eod|mixed|evening}, valuation:{pe_ntm, pe_pctile_now, bands[]}, levels[{price, role: resistance|support, source, strength, distance_pct, detail}], zones[{lo, hi, role, distance_pct, categories[], confluence, sources[]}]}`
- `valuation/<代码>.json`:`{applicable, reason?, forward_eps{low,mean,high,fy_weights[]}, exit_pe_3y{bear,base,bull}, matrix{eps×pe}, range{bear,base,bull}, upside_pct, hold_pe, regime_gap, now{pe_ntm, pe_pctile_3y, pe_pctile_10y, fair_now}, checks{sell_side_12m, vol_band_1y}}`
- 方法见 `process/README.md`。`【推算】` 标记的值是自算的,不是数据源给的。

## handoff
`latest.json` = 最新一份;`<日期>.json` = 当天归档;`previous.json` = 上一交易日(用于算变化)。`schema` 取 `config/params.json § handoff.schema`。
```
{ id: 内容哈希前 12 位(内容不变则不变), schema: "prd-handoff/2", asof, generated_at,
  symbols: { <代码>: { spot, nearest_resistance, nearest_support, confluence_zones[], options_oi_basis, options_asof,
                       valuation: { range{bear,base,bull}, upside_pct, hold_pe, regime_gap, pe_now, pe_pctile_3y, pe_pctile_10y,
                                    forward_eps_mean, sell_side_median } | { not_applicable } } },
  feeds: { <代码>: {                                   // 2 起:上一个包之后的新增读数
    news: [ { id, datetime_et, headline, subjects, summary(截断,不带全文), source } ],
    revisions: { asof, unit, basis, eps_fy1, eps_fy1_30d_pct, eps_fy1_n, eps_fy2, eps_fy2_30d_pct, eps_nq, eps_nq_30d_pct,
                 target_mean, target_30d_pct, target_n },          // 只有 company
    broker_changes: [ { broker, rating, rating_date, target, target_date } ],   // 只有 company
    short: { asof, unit, basis, short_days, short_pct_float, prev{asof, short_days, short_pct_float} } } },  // 只有 company
  breadth: { <组>: { asof, members, unit, basis, ntm_up, ntm_down, fy1_up, fy1_down, fy2_up, fy2_down } },
  changes: [ { symbol, what, from, to, change_pct?, unit? } ] }
```
「新增」的起点是上一个交易日的包(同一天重算时沿用同一起点);新闻按 id 去掉上一个包已给过的。交接包只做机械过滤,不分层、不分级:归层、筛选、分级由 Research OS 做(OS 技能 `modules/factset.md`)。
Research OS 的读法:`id` 与上次读到的相同就跳过;不同才处理。
