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
`<Assets>` 的位置见 `config/assets-path.txt`(不进 git;规则见 `lib/paths.mjs`)。

## L1 · 节点
| 节点 | 文件 | 职责 |
|---|---|---|
| 入口 | `run.mjs` | 读配置 → 排计划 → 逐项执行 → 写状态与报告 |
| 登录 | `login.mjs` · `lib/session.mjs` · `lib/session-policy.mjs` | 专用 Chrome profile;后台跑,登录失效时开窗口(策略为纯函数) |
| 取数 | `lib/api.mjs` | 页面同源 GET / POST / FQL;数据集只通过这里碰网络 |
| 计划 | `lib/plan.mjs` | 哪些 (数据集 × 代码 / 组) 到期:纯函数 |
| 配置 | `lib/paths.mjs` · `lib/config.mjs` · `lib/clock.mjs` | 数据目录与站点常量;读 params / universe;纽约交易日 |
| 存储 | `lib/store.mjs` | CSV 读写、按 key 合并、原子写、状态文件 |
| 解析 | `parsers/*.mjs` | 纯函数:FQL 与期权链、快照合并、报表接口、业绩、公司情报、预期历史、估值史 |
| 数据集 | `datasets/*.mjs` | 每个数据集一个 `run()`;注册表 `datasets/index.mjs` |
| 迁移 | `migrate.mjs` | 一次性把旧布局里补不回来的历史并进 raw/ |

迁移期(重构 R1–R3,2026-11-24):旧 `fetcher/` 的同名函数改为转发到这里,不再自有定义;仪表盘切到新数据后整个删除(见根 README 的重构顺序)。

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

## 计划 v2(2026-11-24,按 Research OS 七层补齐;实施后并入上面的数据集清单)
依据:Research OS 七层清单(OS 技能 `modules/selection.md` 2.1)逐项对照 FactSet。原则:只补**公开来源拿不稳、FactSet 有同源连续数据**的项;宏观数据、CFTC、主经纪商/资金流研报留给 OS 的公开来源。
状态:✅ 已在拉 · 🔍 待实测(需登录后在浏览器里试接口) · — 不拉

### 新增与扩充(2026-11-24 登录后逐项实测)
| 项 | OS 层 | 结果 | 落地 |
|---|---|---|---|
| 修订广度 breadth | L2 | ✅ 一次 FQL 批量取 44 家(10 家公司 + 34 家 breadth-only):NTM EPS 现值与 30 天前(NTMA 无财年切换跳变)、FY1/FY2 上调/下调家数(UP/DOWN,FactSet 默认窗口)、FY1 家数 | 已实现:`breadth/AI.csv`;成员 = universe.csv 的 `breadth` 列 |
| 跨资产扩充(并入 prices) | L5 | ✅ US2YR/US10YR/US30YR(收益率 %,取代 TNX/TYX)、KOSPI-KRX、DX00-USA(美元指数期货)、CL00-USA(WTI)、GC00-USA(金)、VIX3M-CBO、VXN、VVIX;✘ 日经、台股、Brent、MOVE、HY/IG OAS 未找到代码 → 留给 OS 公开来源 | 已加进 universe.csv |
| 期权 gamma | L4 | ✅ P_OPT_GAMMA、P_OPT_VEGA 可取;✘ 隐含波动率无直接字段 → process 层用期权价反推(标【推算】) | gamma 已加进期权链 |
| 股本变动 | L3 | ✅ P_COM_SHS_OUT(回购/稀释);✘ Form 4 逐笔无接口(SEC 公开,留给 OS) | ownership 已含 shares_os,不另建 |
| 财报日期 | L6 | ✘ FQL 与快照页都没找到下次财报日字段 → OS 日历照旧用公开来源 | 不做 |
| CDS 扩充 | L2 | 待实施时随 credit/cds 试 CRWV 等 | 下一步 |

### 不拉
财报日期、Form 4 逐笔、日经/台股/Brent/MOVE/OAS(见上表),以及 L1 宏观数据(BLS/BEA/FRED 公开够用)、CTA/主经纪商/CFTC/资金流研报(FactSet 没有)、电话会全文(无稳定接口)、SEC 正文(公开)。

### 运行时刻(美东)
- 17:45 主拉取(收盘后,赶在 OS EVENING 20:53 之前);周六补 weekly、每月 1 日补 monthly。
- 06:30 期权链补一轮:OI 次日盘前才更新,这一轮的 OI 才是上一交易日的(赶在 OS MORNING 07:52 之前)。
- 由 Windows 计划任务触发,勾选「唤醒计算机运行此任务」;登录过期时弹通知。

### 交给 Research OS(由 process 层产出,collect 只负责 raw)
- 文件:`<Assets>/reports/daily-<日期>.json` 与 `.md`,17:45 拉完后生成;06:30 那轮追加期权段。OS 经 Google Drive 连接器读。
- 只写**变化**(阈值放 `config/params.json`,process 层定义),按 OS 七层分段:
  - L3:FY1/FY2 修订(30 天 %、上调/下调家数)、目标价与评级变动(逐家)、新指引/超预期、估值在 3 年区间的分位、Street Takeaways 标题
  - L2:修订广度、供应链/分部变动、AI 融资链 CDS 异动
  - L4:空头天数与占比变化、13F 增减、期权 OI 集中位/ΔOI/put-call、隐含 vs 实现波动、行业 ETF 5 日相对 SPY
  - L5:曲线、美元、油金、亚洲指数、信用利差的日变动
  - L6:未来 10 个交易日财报日期
- 每条带【FactSet】来源标签、数据口径日期与单位,符合 OS 宪法 12 的数据纪律。
- 前提:OS 宪法第 2 条「只用公开来源」需用户在 OS 那边改(大版本 +1);未改之前,摘要照常生成,OS 不读。

## 怎么跑
```
node collect/login.mjs     # 只登录一次(第一次、或提示登录失效时)
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
