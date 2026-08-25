@echo off
setlocal
set "RC=1"
chcp 65001 >nul 2>&1
title Price Range Dashboard - FactSet fetch
rem ===========================================================
rem  Price Range Dashboard - FactSet data fetch (Windows entry)
rem  Double-click to run. First run installs dependencies.
rem
rem  Deliberately ASCII-only and CRLF-terminated: cmd.exe reads
rem  a .bat with the console codepage active at that moment, so
rem  non-ASCII text here gets mangled, and LF-only line endings
rem  break multi-line IF blocks. All Chinese output comes from
rem  the Node script, which has no such problem.
rem ===========================================================

cd /d "%~dp0fetcher"
if not exist "factset-fetch.mjs" goto nodir

where node >nul 2>nul
if errorlevel 1 goto nonode

node preflight.mjs deps
if not errorlevel 1 goto depsready
echo [setup] Dependencies are missing or differ from package-lock.json; repairing from lock.
call npm.cmd ci
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto noinstall
:depsready
node preflight.mjs chrome
if not errorlevel 1 goto browserready
echo [setup] Registering local Chrome for playwright.
call npx.cmd playwright install chrome
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto nobrowser
:browserready
echo.
echo [note] If you have never logged in to FactSet here, run: run-factset.bat --login
echo.

:run
echo.
echo [run] Starting. A browser window will open by itself - please do not touch it.
echo       If it stops on the login page, log in once and the script continues.
echo.
node factset-fetch.mjs %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto fetchfailed
goto done

:nodir
echo [ERROR] Could not find the fetcher folder next to this file.
echo         Expected: %~dp0fetcher\factset-fetch.mjs
echo         This .bat must stay at the repository root.
goto done

:nonode
echo [ERROR] Node.js not found on PATH.
echo         Install the LTS build from https://nodejs.org and run this again.
goto done

:noinstall
echo [ERROR] npm ci failed - the reason is in the output above.
goto done

:nobrowser
echo [ERROR] Playwright could not install or register Chrome.
echo         Retry from fetcher with: npx playwright install chrome
goto done

:fetchfailed
echo [ERROR] FactSet fetch failed (exit code %RC%).
echo         See the error above and Assets\_logs\ for details.
goto done

:done
echo.
if not "%RC%"=="0" goto finish
echo Data   -^> Assets\        (sorted into sub-folders by type)
echo Logs   -^> Assets\_logs\  (sources.txt and fetch-YYYY-MM-DD.log)
echo Next   -^> open index.html and click Rescan folder.
echo.
:finish
pause
endlocal & exit /b %RC%
