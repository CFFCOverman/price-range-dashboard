@echo off
rem 控制台:浏览器打开 http://127.0.0.1:5179 ,关掉这个窗口即停止
cd /d "%~dp0"
start "" http://127.0.0.1:5179
node console\server.mjs
