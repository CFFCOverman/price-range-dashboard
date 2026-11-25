@echo off
rem 只登录一次 FactSet(第一次,或计划任务提示登录过期时)
cd /d "%~dp0.."
node collect\login.mjs
pause
