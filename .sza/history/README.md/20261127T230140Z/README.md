# Price Range Dashboard · FactSet → 压力/支撑与估值区间 → Research OS

**Author / 作者: Xuhao Chao** · License: 见 LICENSE · 不构成投资建议 · FactSet 数据不进 git(见 PRIVATE_DATA.md)

> 本文件是仓库根的唯一大脑文件(语义缩放 L0)。每个节点只在它自己的 README 里展开一层;数值只在 `config/params.json`。

## L0 · 人 ↔ 系统
```
你 ──(控制台:增删标的、看运行状态、手动重跑)──▶ 系统
                                                    │
① 采集 collect   FactSet 同源接口 ─▶ G:\…\Assets\raw\
② 计算 process   raw ─▶ 压力/支撑价位 + 估值区间 ─▶ Assets\derived\
③ 交接 handoff   derived ─▶ Assets\handoff\(一份带编号的数据包)
④ Research OS    早晚两轮读数据包:编号与上次相同就跳过;不同就更新账本的价位与估值,并把变化用于研究
```
你做:维护标的清单;登录过期时登录一次。系统做:定时拉取、计算、交接。交易决定只归你。

## L1 · 节点
| 节点 | 位置 | 状态 |
|---|---|---|
| 采集 | [collect/](collect/README.md) | 已完成(数据集清单见 `config/params.json § datasets`) |
| 计算 | [process/](process/README.md):压力/支撑、一年前瞻估值区间 | 已完成 |
| 交接 | `process/handoff.mjs` → `Assets/handoff/latest.json` | 已完成 |
| Research OS 接入 | OS 技能 `modules/factset.md`(7.0.0 起):早晚两轮读交接包,写账本 `factset` 集合,页面「价位与估值(FactSet · L7)」 | 已上线(2026-11-24) |
| 控制台 | [console/](console/README.md):双击 `console.bat` | 已完成 |
| 运维 | [ops/](ops/README.md):Windows 计划任务、登录 | 已备好;你选择暂不安装,手动跑 `run-collect.bat` |
| 数据存储类型 | [schema/](schema/README.md):G 盘分区与每类数据的字段 | 已完成 |
| 配置 | `config/`:`config/params.json`(全部数值);`config/universe.seed.csv`(标的初始值,现行清单在 G 盘) | — |
| 测试 | `tests/`,`npm test` | — |

文件:`run-collect.bat`(手动跑一轮:拉取到期项 → 计算 → 交接)· `console.bat` · `package.json` · `package-lock.json`(依赖锁定) · `CHANGELOG.md` · [LICENSE](LICENSE) · `PRIVATE_DATA.md`(哪些数据不能进 git)· `zoom.hints.json`(星图的手写边)· `zoom.json`【生成文件】(星图清单)· `.sza/history/`(改前快照,`_repo/` 不进 git)。

## 概念 → 唯一出处
改任何东西之前先查这张表,只改出处那一处;别处都是引用。
| 概念 | 出处 |
|---|---|
| 全部数值(节奏、窗口、分位、阈值、运行时刻) | `config/params.json` |
| 每类标的拉哪些数据集 | `config/params.json § scope` |
| 标的清单的列与写法 | `schema/README.md § universe.csv` |
| G 盘分区、raw 文件格式 | `schema/README.md § 分区`、`§ raw` |
| derived 字段 | `schema/README.md § derived` |
| 交接包格式与编号规则 | `schema/README.md § handoff` |
| 数据集的来源与取数方法 | `collect/README.md § 数据集清单` |
| FactSet 覆盖到哪、哪些不拉 | `collect/README.md § 七层覆盖` |
| 压力位与支撑位的方法 | `process/README.md § 压力位与支撑位` |
| 一年前瞻估值区间的方法 | `process/README.md § 估值区间` |
| 交接变化怎么算 | `process/README.md § 交接` |
| 控制台页面与 API | `console/README.md` |
| 计划任务的安装与登录 | `ops/README.md` |
| Research OS 怎么读交接包、怎么用 | OS 技能 `modules/factset.md` |
| 数据许可与不进 git 的内容 | `PRIVATE_DATA.md` |

重构记录:2026-11-24 起旧 fetcher 与旧仪表盘已全部删除(快照在 `.sza/history/_repo/`,不进 git);步骤与版本见 `CHANGELOG.md`。
