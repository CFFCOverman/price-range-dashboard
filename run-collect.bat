@echo off
rem 采集 → 计算 → 交接。说明见 README.md
cd /d "%~dp0"
node collect\run.mjs %*
node process\run.mjs
echo.
pause
