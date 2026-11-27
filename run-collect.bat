@echo off
rem 采集 → 计算 → 交接,完成后自动打开控制台。说明见 README.md(macOS 用 run-collect.command)
cd /d "%~dp0"
node collect\run.mjs %*
node process\run.mjs
echo.
echo 完成:正在打开控制台(另一个窗口;已经开着的话只刷新浏览器)……
start "Price Range 控制台" "%~dp0console.bat"
pause
