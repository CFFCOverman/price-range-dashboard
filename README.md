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
| 采集 | [collect/](collect/README.md) | 已完成(17 个数据集) |
| 计算 | `process/`(压力/支撑已有初版;估值区间待做) | 进行中 |
| 交接 | `process/` 输出到 `Assets/handoff/` | 待做 |
| 控制台 | `console/`(本机网页) | 待做 |
| 运维 | `ops/`(计划任务、登录) | 脚本已写,未启用 |
| 配置 | `config/params.json`(参数唯一出处);标的清单将挪到 G 盘 | — |
| 测试 | `tests/`,`npm test` | — |

重构计划与进度:2026-11-24 起旧 fetcher 与旧仪表盘已全部删除(快照在 `.sza/history/_repo/`,不进 git)。
