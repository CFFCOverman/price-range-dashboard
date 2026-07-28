@echo off
rem ============================================
rem  FactSet auto-fetch for Price Range Dashboard
rem  Double-click to run. First run installs deps.
rem ============================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install LTS from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo [SETUP] Installing dependencies, please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] npm install failed. See messages above.
    pause
    exit /b 1
  )
)

echo [RUN] Fetching FactSet data. If a login page appears in the
echo       browser window, just log in - the script continues by itself.
echo.
node factset-fetch.mjs %*

echo.
echo Done. Open the dashboard and click "Rescan folder" to load new data.
pause
