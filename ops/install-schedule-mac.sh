#!/bin/bash
# macOS:注册两个 launchd 计划任务(对应 Windows 的 install-schedule.ps1)。时刻只在 config/params.json § run。
# 用法:在终端里 bash ops/install-schedule-mac.sh
# 合盖睡眠时到点不会运行,唤醒后 launchd 会补跑一次错过的任务;关机不会补跑。
cd "$(dirname "$0")/.." || exit 1
REPO="$(pwd)"
NODE_BIN="$(command -v node)" || { echo "找不到 node:请先安装 Node.js"; exit 1; }
read -r MAIN OI < <("$NODE_BIN" -e "const r=require('./config/params.json').run;console.log(r.daily_at_et,r.options_oi_at_et)")
AGENTS="$HOME/Library/LaunchAgents"; mkdir -p "$AGENTS"
plist() { # 名字 模式 时刻 星期列表
  local label="com.pricerange.$1" h="${3%%:*}" m="${3##*:}" days=""
  for d in $4; do days="$days<dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>$((10#$h))</integer><key>Minute</key><integer>$((10#$m))</integer></dict>"; done
  cat > "$AGENTS/$label.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/ops/run-scheduled.sh</string><string>$2</string></array>
<key>EnvironmentVariables</key><dict><key>NODE_BIN</key><string>$NODE_BIN</string><key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StartCalendarInterval</key><array>$days</array>
<key>WorkingDirectory</key><string>$REPO</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist" && echo "已注册 $label:$3(星期 $4,本机时区)"
}
plist collect main "$MAIN" "1 2 3 4 5"
plist options-oi oi "$OI" "2 3 4 5 6"
echo "本机时区应为美东;改时刻请改 config/params.json § run 后重跑本脚本。试跑:launchctl kickstart gui/$(id -u)/com.pricerange.collect"
