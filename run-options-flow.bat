@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   Options Direction Monitor
echo   Enter ALL to monitor every active symbol in tickers.txt.
echo   Press Ctrl+C to stop.
echo ============================================================

set "FLOW_SYMBOLS="
set /p "FLOW_SYMBOLS=Symbols, ALL, or Enter for NVDA-US: "
if not defined FLOW_SYMBOLS set "FLOW_SYMBOLS=NVDA-US"
set "FS_HEADLESS=auto"

if /i "%FLOW_SYMBOLS%"=="ALL" (
  echo ALL mode: adaptive schedule based on US options market hours.
  node fetcher/options-flow.mjs --watch --all
  goto done
)

echo Selected-symbol mode: adaptive schedule based on US options market hours.
node fetcher/options-flow.mjs --watch %FLOW_SYMBOLS%

:done
echo.
echo Monitor stopped. Keep this window open if an error is shown above.
pause
