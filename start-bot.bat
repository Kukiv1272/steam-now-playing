@echo off
chcp 65001 >nul
cd /d "%~dp0"
title steam-now-playing

rem Run with arguments (e.g. start-bot.bat --once) = single pass, no restart loop
if not "%~1"=="" (
  node src/index.js %*
  goto :eof
)

rem Normal run: bot keeps going; if it crashes it restarts in 5 seconds.
rem (ping delay instead of "timeout" - timeout fails with redirected stdin)
:loop
node src/index.js
echo.
echo Bot stopped (%date% %time%). Restarting in 5s - close this window or press Ctrl+C to quit.
ping -n 6 127.0.0.1 >nul
goto loop
