@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title Price Range Dashboard - first-time setup
rem ===========================================================
rem  Price Range Dashboard - one-click setup (Windows entry)
rem  Double-click on a fresh machine. It finds (or installs)
rem  Node.js, then hands off to tools\setup.mjs which does the
rem  rest and speaks Chinese.
rem
rem  Deliberately ASCII-only and CRLF-terminated, same reason as
rem  run-factset.bat: cmd.exe reads a .bat with whatever console
rem  codepage is active at that moment, so non-ASCII text here
rem  gets mangled, and LF-only line endings break multi-line IF
rem  blocks. Everything the user actually reads is printed by
rem  the Node script, which has no such problem.
rem
rem  No delayed expansion on purpose: every variable is written
rem  in one block and read in another, so %VAR% is always safe.
rem  Do not "simplify" this by reading a variable inside the
rem  same parenthesised block that sets it.
rem ===========================================================

rem  RC and PAUSE_AT_END must be set BEFORE the first thing that can
rem  jump to :done. If cd /d fails while they are still undefined,
rem  :done evaluates if ""=="1" -> no pause, and the window closes on
rem  top of the error message the user was supposed to read.
set "RC=1"
set "PAUSE_AT_END=1"

rem  cd /d handles a different drive letter too. %~dp0 keeps its
rem  trailing backslash and is quoted, so a path with spaces
rem  ("...\Price Range Dashboard\") survives.
rem
rem  The errorlevel check alone is not enough. Launched from a UNC
rem  path (\\server\share\...), cmd.exe prints "CMD does not support
rem  UNC paths as current directories." to STDOUT - 2>nul does not
rem  hide it - and may leave errorlevel at 0, so the script would
rem  carry on in C:\Windows and later blame a missing tools\setup.mjs.
rem  So verify positively: after the cd, this file must be visible
rem  in the current directory.
cd /d "%~dp0" >nul 2>nul
if errorlevel 1 goto badcwd
if not exist "%CD%\setup.bat" goto badcwd

set "NODE_EXE="
for %%A in (%*) do (
  if /i "%%~A"=="--no-pause" set "PAUSE_AT_END=0"
  if /i "%%~A"=="--nopause"  set "PAUSE_AT_END=0"
)

rem  ProgramFiles(x86) has parentheses in its NAME, which breaks
rem  a FOR body if expanded in place. Copy it out here first.
rem  ProgramW6432 is the real 64-bit Program Files even when this
rem  script is launched from a 32-bit host process, where
rem  %ProgramFiles% silently points at the (x86) tree instead.
set "PF64=%ProgramFiles%"
set "PF32=%ProgramFiles(x86)%"
set "PFW6=%ProgramW6432%"
rem  Not defined on a 32-bit-only Windows. Left empty it would turn
rem  the probe entry into "\nodejs\node.exe" - the root of whatever
rem  drive is current - so point it somewhere harmless instead.
if not defined PFW6 set "PFW6=%PF64%"

call :findnode
if defined NODE_EXE goto havenode

echo.
echo   Node.js was not found on this machine.
echo   The dashboard HTML works without it, but tests, backtests
echo   and the FactSet fetcher all need it.
echo.
where winget >nul 2>nul
if errorlevel 1 goto nowinget

rem  Default is DECLINE, and that is deliberate. When stdin is at
rem  EOF (piped, redirected from nul, a CI runner) set /p returns
rem  without assigning anything - and it does the same when a human
rem  just presses Enter, so the two cases are indistinguishable from
rem  inside a .bat. setup.mjs refuses to install behind the user's
rem  back in a non-TTY; this honours the same rule the only way it
rem  can, by requiring the word to be typed.
set "ANS="
set /p "ANS=  Install Node.js LTS now with winget? Type y to install [y/N] "
if /i "%ANS%"=="y"   goto doinstall
if /i "%ANS%"=="yes" goto doinstall
goto declined

:doinstall
echo.
echo   Running: winget install -e --id OpenJS.NodeJS.LTS
echo   (a UAC prompt may appear - that is the installer, not this script)
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
set "WRC=%ERRORLEVEL%"
echo.

rem  winget does not refresh PATH for an already-open console, so
rem  "where node" can still miss right after a successful install.
rem  findnode also probes the standard install directories, which
rem  is what actually rescues this case.
rem
rem  Order matters: a node.exe that is now on disk wins no matter
rem  what winget returned (it exits non-zero for "already installed"
rem  too). Only when nothing was found does the exit code decide
rem  which explanation the user gets - "the install was refused"
rem  is very different advice from "reopen the window".
call :findnode
if defined NODE_EXE goto havenode
if not "%WRC%"=="0" goto wingetfailed
echo   Node.js still not visible from this window.
echo   That usually just means PATH has not refreshed yet:
echo   close this window, open a new one, and run setup.bat again.
goto done

:havenode
rem  A node.exe that exists but cannot run (broken install, wrong
rem  architecture) would otherwise fail later with a confusing
rem  error from inside setup.mjs. Prove it runs before handing off.
"%NODE_EXE%" -v >nul 2>nul
if errorlevel 1 goto brokennode

if not exist "tools\setup.mjs" goto incomplete

rem  THIS LINE IS LOAD-BEARING. On a machine where Node was just
rem  installed - or found only by directory probing - PATH still has
rem  no node/npm. setup.mjs step 1/5 spawns npm.cmd, which is
rem  resolved through PATH, so without this the very first run on the
rem  fresh machine this script exists for dies with ENOENT.
rem  %%~dpD is node.exe's own directory (npm.cmd sits beside it).
rem  We are inside setlocal, so the system PATH is not touched.
for %%D in ("%NODE_EXE%") do set "PATH=%%~dpD;%PATH%"

"%NODE_EXE%" "tools\setup.mjs" %*
set "RC=%ERRORLEVEL%"
goto done

rem ===========================================================
rem  Subroutine: locate node.exe
rem    1. PATH  2. the standard install directories, which is
rem    where winget/the .msi put it when PATH is stale.
rem  "if not defined" keeps the FIRST hit; it is evaluated at run
rem  time, so it works without delayed expansion.
rem ===========================================================
:findnode
for /f "delims=" %%I in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%~fI"
)
for %%P in (
  "%PF64%\nodejs\node.exe"
  "%PFW6%\nodejs\node.exe"
  "%PF32%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
) do (
  if not defined NODE_EXE if exist "%%~P" set "NODE_EXE=%%~P"
)
goto :eof

rem ===========================================================
rem  Failure exits - each one names the single next action.
rem ===========================================================
:badcwd
echo.
echo   [ERROR] Could not switch to the folder this file lives in:
echo           %~dp0
echo           A network path (\\server\share) does not work here.
echo           Copy the repository to a local drive and try again.
goto done

:nowinget
echo   winget is not available on this machine (it ships with
echo   Windows 11 and recent Windows 10 builds).
echo.
echo   Install Node.js LTS by hand, then run setup.bat again:
echo       https://nodejs.org/en/download
goto done

:wingetfailed
echo.
echo   [ERROR] winget could not install Node.js (exit code %WRC%).
echo           The usual cause is the UAC prompt being dismissed or
echo           this account not being allowed to install software.
echo.
echo   Two ways forward:
echo     1. Right-click setup.bat -^> "Run as administrator", or
echo     2. Install Node.js LTS by hand, then run setup.bat again:
echo        https://nodejs.org/en/download
goto done

:declined
echo.
echo   Nothing installed (anything other than "y" means no).
echo   You can still open the dashboard:
echo       double-click price-range-dashboard.html
echo   When you want the tests or the fetcher, install Node.js
echo   from https://nodejs.org/en/download and run setup.bat again.
set "RC=0"
goto done

:brokennode
echo.
echo   [ERROR] Found node.exe but it will not run:
echo           %NODE_EXE%
echo           Reinstall Node.js LTS from https://nodejs.org/en/download
goto done

:incomplete
echo.
echo   [ERROR] tools\setup.mjs is missing next to this file.
echo           Expected: %~dp0tools\setup.mjs
echo.
echo   This copy of the repository is incomplete. If you cloned it
echo   from GitHub and got only a handful of files, the source has
echo   not been committed yet - ask for a full copy, or on the
echo   machine that has the working code run:
echo       git add -A ^&^& git commit -m "commit sources" ^&^& git push
goto done

:done
echo.
if "%PAUSE_AT_END%"=="1" pause
endlocal & exit /b %RC%
