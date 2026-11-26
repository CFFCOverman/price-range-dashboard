@echo off
chcp 65001 >nul
rem 控制台:服务起来后自动打开 http://127.0.0.1:5179 ;服务意外退出会在 3 秒后自动重启;关掉这个窗口即停止
cd /d "%~dp0"
:loop
node console\server.mjs
echo.
echo 控制台服务退出了(上面是原因),3 秒后自动重启;要停止请直接关闭本窗口。
timeout /t 3 >nul
set PRD_CONSOLE_NO_OPEN=1
goto loop
