@echo off
setlocal
cd /d "%~dp0"

rem Use the same independent, hidden tray launcher as FactSet menu option 10.
if not exist "%~dp0fetcher\options-flow-tray-launch.vbs" goto missing
if not exist "%~dp0fetcher\options-flow-tray.ps1" goto missing
wscript.exe "%~dp0fetcher\options-flow-tray-launch.vbs"
exit /b %ERRORLEVEL%

:missing
echo [ERROR] Could not find the Options Flow tray launcher in fetcher.
pause
exit /b 1
