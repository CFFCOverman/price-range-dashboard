#!/bin/bash
# macOS 控制台:服务起来后自动打开 http://127.0.0.1:5179 ;服务意外退出 3 秒后自动重启;关掉这个终端窗口即停止
cd "$(dirname "$0")" || exit 1
while true; do
  node console/server.mjs
  echo
  echo "控制台服务退出了(上面是原因),3 秒后自动重启;要停止请直接关闭本窗口。"
  sleep 3
  export PRD_CONSOLE_NO_OPEN=1
done
