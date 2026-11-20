# collect · 采集层

> 生成/维护:Claude(2026-11-19 重写)。本文件是 `collect/` 的唯一大脑文件;数值一律在 [config/params.json](../config/params.json),标的一律在 [config/universe.csv](../config/universe.csv),这里只引用。

## L0 · 人 ↔ 系统
你做两件事:**保持 FactSet 已登录**(第一次或掉线时在弹出的 Chrome 里登录一次),**改清单**(`config/universe.csv` 加删一行)。
系统做一件事:按节奏把到期的数据拉下来,原样存进 `<Assets>/raw/`,并在 `<Assets>/_state/` 记下每项最后一次成功/失败。
下游(`process/` → 仪表盘)只读 `raw/`,不碰 FactSet。

```
FactSet(已登录页面,同源接口) ──collect──▶ Assets/raw/<数据集>/<代码>.csv ──process──▶ Assets/views/ ──▶ 仪表盘
                                          └▶ Assets/_state/collect.json · last-run.json
```
`<Assets>` 的位置见 `fetcher/assets-path.txt`(当前 G:\My Drive\PriceRangeDashboard\Assets)。

## L1 · 节点
| 节点 | 文件 | 职责 |
|---|---|---|
| 入口 | `run.mjs` | 读配置 → 排计划 → 逐项执行 → 写状态与报告 |
| 计划 | `lib/plan.mjs` | 哪些 (数据集×代码) 到期:纯函数 |
| 配置 | `lib/config.mjs` | 读 params / universe;定 raw/、_state/ 路径 |
| 存储 | `lib/store.mjs` | CSV 读写、按 key 合并、原子写、状态文件 |
| 取数 | `lib/api.mjs` | 页面同源 GET / POST / FQL(登录态由 `fetcher/lib/browser.mjs` 管) |
| 数据集 | `datasets/*.mjs` | 每个数据集一个 `run()`;注册表 `datasets/index.mjs` |
| 迁移 | `migrate.mjs` | 一次性把旧布局里补不回来的历史并进 raw/ |

## 数据集清单
节奏(daily/weekly/monthly 各多少小时)和每个数据集用哪个节奏:见 `config/params.json` § `cadence_hours` / `datasets`。哪类标的拉哪些:见 § `scope`。

| 数据集 | 来源(2026-11-19 实测可用) | 写法 | raw 文件 |
|---|---|---|---|
| prices | FQL `P_DATE/P_PRICE/P_PRICE_OPEN/P_VOLUME(NOW,区间,D)`;高低只有当天一格 | 合并(按日) | `prices/<T>.csv` |
| consensus | FQL `FE_ESTIMATE` NQ/FY1/FY2/收入/目标价,及 30 天前值 | 合并(每天一行) | `consensus/<T>.csv` |
| valuation | FQL 月末 NTM P/E(规则见 `fetcher/steps/valuation.mjs`) | 合并 | `valuation/<T>.csv` |
| estimates | Estimate History 接口 period=1/2(FY1/FY2),自带 5 年月度 | 整表替换 | `estimates/<T> FY1.csv` |
| targets | Targets & Ratings `ksTnrExcel` HISTORY(月度一致)+ DETAIL(券商明细) | 合并 / 替换 | `targets/<T> history.csv`、`<T> brokers.csv` |
| ownership | `FOS_OWNERSHIP_STATS`:机构/内部人/流通盘/**空头天数与占比** | 合并(每天一行) | `ownership/<T>.csv` |
| news | `NewsSearch`(StreetAccount,JSON,含正文摘要) | 合并(按 id) | `news/<T>.csv` |
| guidance / surprise | 解析见 `fetcher/steps/earnings.mjs` | 替换 | `guidance/<T>.csv`、`surprise/<T>.csv` |
| credit / cds / holders / supplychain / segments / georev | 解析见 `fetcher/steps/company-intel.mjs` § INTEL_REPORTS | 替换 | `<数据集>/<T>.csv` |
| options | 期权链接口,合并规则见 `fetcher/lib/opt-store.mjs` | 合并(按日快照) | `options/<T>.csv` |

不拉的:transcripts 列表(无稳定接口)、Snapshot/Price Summary 导入、页面导出的 Charting xlsx(被 FQL 日线取代)。
盘中 15 分钟的期权方向托盘(`fetcher/options-flow.mjs`)不在这里,照旧单独运行。

## 怎么跑
```
npm run collect:dry        # 只列本轮会拉什么
npm run collect            # 到期的都拉(第一次会把 5 年日线、10 年估值、1 年新闻全拉一遍)
node collect/run.mjs --force --only=news --symbols=NVDA-US   # 强制重拉某几项
npm run collect:migrate    # 一次性:旧 Assets 里的期权快照/估值/空头/旧新闻并进 raw/
npm run test:collect       # 纯函数自检(不联网)
```
失败不中断:每项单独记账,下次运行只补到期或失败的。退出码非 0 = 有失败,明细在 `_state/last-run.json`。

## 已知限制
- 日内高/低:FQL 只给当天,历史缺;下游按 close/open 处理。
- MCLD:FQL 价格全是 @NA,已在 universe 里注释掉。
- 旧版新闻(`legacy:` id)与接口新闻会有同标题重复,去重在 process 层按 日期+标题 做。
