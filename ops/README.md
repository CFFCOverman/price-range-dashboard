# ops · 运维

> 本文件是 `ops/` 的唯一大脑文件。数据集节奏与计划任务时刻都在 `config/params.json`(§ datasets、§ run),Windows 的 `install-schedule.ps1` 与 macOS 的 `install-schedule-mac.sh` 都从那里读。

## L0 · 人 ↔ 系统
你做:装一次计划任务;登录过期时(会弹系统通知)双击 `login.bat`(macOS:`login.command`)。
系统做:工作日收盘后「拉取 → 计算 → 交接」(`run.daily_at_et`);周二到周六盘前「补读收盘 OI → 重算 → 交接」(`run.options_oi_at_et`)。到点唤醒电脑,后台运行,不弹窗口;失败时弹系统通知。

## 文件
| 文件 | 做什么 |
|---|---|
| `install-schedule.ps1` | 注册两个 Windows 计划任务(唤醒运行、错过补跑、最长 2 小时、只在你登录时运行) |
| `uninstall-schedule.ps1` | 撤掉这两个任务 |
| `run-scheduled.ps1` | 计划任务调用的入口:`FS_HEADLESS=1` 跑 collect 再跑 process(拉取个别失败也照样计算),输出写 `ops/logs/`(留 30 天),失败时弹通知 |
| `login.bat` | 开窗口登录 FactSet 一次,保存登录态 |
| `install-schedule-mac.sh` / `uninstall-schedule-mac.sh` | macOS:注册 / 撤掉两个 launchd 计划任务(`~/Library/LaunchAgents/com.pricerange.*`) |
| `run-scheduled.sh` | macOS 计划任务调用的入口,做法同 `run-scheduled.ps1`,失败时发系统通知 |
| `login.command` | macOS:开窗口登录 FactSet 一次 |
| `logs/` | 每次计划运行的输出(不进 git) |

## 装(Windows)
1. 先双击 `login.bat` 确认登录态是新的。
2. 在 PowerShell 里:`powershell -ExecutionPolicy Bypass -File ops\install-schedule.ps1`
3. 电源选项 → 更改高级电源设置 → 睡眠 → 允许使用唤醒定时器 = 启用。
4. 电脑可以睡眠,不能关机;Windows 账户要保持登录(锁屏可以)。
5. 试跑:`schtasks /run /tn "PriceRangeDashboard Collect"`,半分钟后看 `ops\logs\<今天>-main.log` 结尾是 `exit collect=0 process=0`。

## 装(macOS)
1. 装 Node.js 与 Google Chrome;仓库里跑一次 `npm install`。
2. Google Drive 桌面版登录同一个账号。数据目录自动识别 `~/Library/CloudStorage/GoogleDrive-<账号>/My Drive/PriceRangeDashboard/Assets`(规则见 `collect/lib/paths.mjs`),不用写 `config/assets-path.txt`;位置特殊时再写。
3. 双击 `ops/login.command` 登录一次。第一次双击 `.command` 文件若被拦,在 Finder 里右键 → 打开。
4. 手动跑:双击 `run-collect.command`(跑完自动开控制台);只看控制台:双击 `console.command`。
5. 自动跑:终端里 `bash ops/install-schedule-mac.sh`。合盖睡眠时到点不运行,唤醒后会补跑一次;关机不补跑。本机时区应为美东。

运行状态也可以在控制台(`console.bat` / `console.command`)的「运行」页看。
