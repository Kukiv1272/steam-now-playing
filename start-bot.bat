@echo off
chcp 65001 >nul
cd /d "%~dp0"
title steam-now-playing

echo === steam-now-playing ===

rem --- 1. Node.js installed? If not - offer auto-download (portable, project-local) ---
where node >nul 2>nul
if not errorlevel 1 goto node-ok
type "docs\node-missing.txt" 2>nul
rem choice: single keypress, works with any stdin (set /p is unreliable in pipes)
choice /c YN /n /m "Download Node.js LTS automatically? (Y/N): "
if errorlevel 2 goto node-manual
call install-node.bat
if errorlevel 1 goto node-manual
rem Portable node: pick the extracted folder (name contains the version)
for /d %%D in ("%~dp0node\node-v*-win-x64") do set "PATH=%%D;%PATH%"
:node-ok
where node >nul 2>nul
if errorlevel 1 goto node-manual

rem --- 2. npm available? (comes with Node.js) ---
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Reinstall Node.js LTS from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem --- 3. Node.js version 18+ ---
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
for /f "tokens=1 delims=." %%a in ("%NODEVER:v=%") do set "NODEMAJOR=%%a"
if "%NODEMAJOR%"=="" set "NODEMAJOR=0"
if %NODEMAJOR% LSS 18 (
  echo [ERROR] Node.js 18 or newer is required, found %NODEVER%. Download LTS: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo [check] Node.js %NODEVER%

rem --- 4. Correct folder (project root)? ---
if not exist "package.json" (
  echo [ERROR] start-bot.bat must be placed in the project folder ^(package.json not found^).
  pause
  exit /b 1
)

rem --- 5. .env from template if missing ---
if not exist ".env" if exist ".env.example" (
  copy /y ".env.example" ".env" >nul
  echo [setup] Created .env from .env.example
)

rem --- 6. Dependencies: try to load the key modules ---
node -e "require('undici');require('steam-user');require('@napi-rs/canvas');require('cheerio')" >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing dependencies ^(npm install^)... this can take a couple of minutes.
  call npm install --no-audit --no-fund
  node -e "require('undici');require('steam-user');require('@napi-rs/canvas');require('cheerio')" >nul 2>nul
  if errorlevel 1 (
    type "docs\npm-failed.txt" 2>nul
    if errorlevel 1 echo [ERROR] npm install failed. Check your internet connection.
    echo.
    pause
    exit /b 1
  )
  echo [setup] Dependencies installed
)
echo [check] dependencies OK
echo.

rem --- Run with arguments (e.g. start-bot.bat --once) = single pass, no restart loop ---
if not "%~1"=="" (
  node src/index.js %*
  goto :eof
)

rem --- Normal run: bot keeps going; if it crashes it restarts in 5 seconds ---
rem (ping delay instead of "timeout" - timeout fails with redirected stdin)
:loop
node src/index.js
echo.
echo Bot stopped (%date% %time%). Restarting in 5s - close this window or press Ctrl+C to quit.
ping -n 6 127.0.0.1 >nul
goto loop

rem --- Node.js missing and auto-install declined or failed: manual instructions ---
:node-manual
type "docs\install-help.txt" 2>nul
if errorlevel 1 echo [ERROR] Node.js is not installed. Download LTS: https://nodejs.org/
echo.
pause
exit /b 1
