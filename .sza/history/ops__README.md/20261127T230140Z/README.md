# ops · 运维

> 本文件是 `ops/` 的唯一大脑文件。数据集节奏与计划任务时刻都在 `config/params.json`(§ datasets、§ run),`install-schedule.ps1` 从那里读。

## L0 · 人 ↔ 系统
你做:装一次计划任务;登录过期时(会弹系统通知)双击 `login.bat`。
系统做:工作日收盘后「拉取 → 计算 → 交接」(`run.daily_at_et`);周二到周六盘前「补读收盘 OI → 重算 → 交接」(`run.options_oi_at_et`)。到点唤醒电脑,后台运行,不弹窗口;失败时弹系统通知。

## 文件
| 文件 | 做什么 |
|---|---|
| `install-schedule.ps1` | 注册两个 Windows 计划任务(唤醒运行、错过补跑、最长 2 小时、只在你登录时运行) |
| `uninstall-schedule.ps1` | 撤掉这两个任务 |
| `run-scheduled.ps1` | 计划任务调用的入口:`FS_HEADLESS=1` 跑 collect 再跑 process(拉取个别失败也照样计算),输出写 `ops/logs/`(留 30 天),失败时弹通知 |
| `login.bat` | 开窗口登录 FactSet 一次,保存登录态 |
| `logs/` | 每次计划运行的输出(不进 git) |

## 装
1. 先双击 `login.bat` 确认登录态是新的。
2. 在 PowerShell 里:`powershell -ExecutionPolicy Bypass -File ops\install-schedule.ps1`
3. 电源选项 → 更改高级电源设置 → 睡眠 → 允许使用唤醒定时器 = 启用。
4. 电脑可以睡眠,不能关机;Windows 账户要保持登录(锁屏可以)。
5. 试跑:`schtasks /run /tn "PriceRangeDashboard Collect"`,半分钟后看 `ops\logs\<今天>-main.log` 结尾是 `exit collect=0 process=0`。

运行状态也可以在控制台(`console.bat`)的「运行」页看。
