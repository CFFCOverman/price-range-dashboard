@echo off
rem 采集层:到期的数据拉进 Assets\raw\。说明见 collect\README.md
cd /d "%~dp0"
node collect\run.mjs %*
echo.
pause
