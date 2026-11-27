#!/bin/bash
# macOS:采集 → 计算 → 交接,完成后自动打开控制台。说明见 README.md(Windows 用 run-collect.bat)
cd "$(dirname "$0")" || exit 1
node collect/run.mjs "$@"
node process/run.mjs
echo
echo "完成:正在打开控制台(新终端窗口)……"
open -a Terminal "$(pwd)/console.command"
