#!/bin/bash
# macOS:只登录一次 FactSet(第一次,或计划任务提示登录过期时)
cd "$(dirname "$0")/.." || exit 1
node collect/login.mjs
read -r -p "按回车关闭" _
