#!/bin/bash
# macOS 计划任务(launchd)调用的入口,对应 Windows 的 run-scheduled.ps1。时刻在 config/params.json § run。
#   main:到期的数据集都拉 → 计算 → 写交接包    oi:补读收盘 OI → 重算 → 写交接包
MODE="${1:-main}"
cd "$(dirname "$0")/.." || exit 1
NODE="${NODE_BIN:-node}"
mkdir -p ops/logs
find ops/logs -name '*.log' -mtime +30 -delete 2>/dev/null
LOG="ops/logs/$(date +%F)-$MODE.log"
export FS_HEADLESS=1
echo "==== $(date '+%FT%T') $MODE ====" >> "$LOG"
if [ "$MODE" = oi ]; then "$NODE" collect/run.mjs --only=options-oi >> "$LOG" 2>&1; else "$NODE" collect/run.mjs >> "$LOG" 2>&1; fi
C1=$?
"$NODE" process/run.mjs >> "$LOG" 2>&1   # 拉取有个别失败也照样计算
C2=$?
echo "exit collect=$C1 process=$C2" >> "$LOG"
if [ $C1 -ne 0 ] || [ $C2 -ne 0 ]; then
  if grep -q '登录已失效' "$LOG"; then MSG='FactSet 登录已过期:请双击 ops/login.command 登录一次。'; else MSG='拉取或计算有失败项:打开控制台的「运行」页,或看 ops/logs。'; fi
  osascript -e "display notification \"$MSG\" with title \"Price Range 拉取\"" 2>/dev/null
  exit 1
fi
