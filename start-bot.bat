@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title steam-now-playing

rem ============================================================
rem  Console manager for steam-now-playing (zapret-style menu).
rem  Bot runs in a background window titled "snp-bot"; its output
rem  goes to bot.log. "Remove service" stops it gracefully via
rem  stop.flag (artwork cleanup), taskkill is only a fallback.
rem  NOTE: keep this file ASCII-only (cmd misparses UTF-8 bats).
rem  All menu texts live in docs\menu-ru.txt / docs\menu-en.txt
rem  (UTF-8, loaded by :load_strings) and follow LANG from .env.
rem  Strings used inside ( ) blocks must not contain parentheses.
rem ============================================================

rem --- menu language + strings (docs\menu-<lang>.txt) ---
call :load_strings

rem --- CLI passthrough: start-bot.bat --update etc. = run node and exit ---
if not "%~1"=="" (
  call :requirements
  if errorlevel 1 exit /b 1
  node src/index.js %*
  exit /b %errorlevel%
)

call :requirements
if errorlevel 1 exit /b 1

rem Is stdin a real console? cls/live log only make sense interactively.
rem NOTE: no `< nul` on powershell here - it would redirect powershell's OWN
rem stdin and IsInputRedirected would always be True, so cls would never run
rem and the menu would scroll instead of clearing. Safe at startup: nothing
rem is buffered, powershell -Command does not read stdin anyway.
rem Default is False (cls allowed): cls is harmless in a real console, and a
rem failed powershell detection must not leave the menu permanently uncleaned.
rem An explicit True (piped stdin) still disables cls - cls can hang on pipes.
set "STDIN_REDIRECTED=False"
for /f %%i in ('powershell -NoProfile -Command "[Console]::IsInputRedirected"') do set "STDIN_REDIRECTED=%%i"

:menu
call :load_strings
call :refresh_info
call :cls_safe
call :bot_running
if errorlevel 1 (set "BOTSTAT=%L_STOPPED%") else set "BOTSTAT=%L_RUNNING% "
rem Compact layout: must fit a 25-line console window, otherwise each redraw
rem scrolls the viewport and the menu "creeps" instead of clearing.
echo.
echo   STEAM NOW-PLAYING BOT v%BOTVER%
echo   %L_BOT%: %BOTSTAT%  %L_SHOWCASE%: type=%SHOWCASE_TYPE% %SHOWCASE_STRETCH% slot=%SHOWCASE_SLOT%
echo   %L_SOURCES%:  lastfm=%LASTFM_USER%  statsfm=%STATSFM_USER%
echo   ----------------------------------------
echo   :: %L_SEC_SERVICE%
echo      %L_OPT_START%
echo      %L_OPT_REMOVE%
echo      %L_OPT_LOG%
echo   :: %L_SEC_SETTINGS%
echo      %L_OPT_SETTINGS%
echo   :: %L_SEC_DIAG%
echo      %L_OPT_SOURCES%
echo      %L_OPT_CARD%
echo      %L_OPT_SITES%
echo   :: %L_SEC_UPDATES%
echo      %L_OPT_CHECK%
echo   :: %L_SEC_CONFIG%
echo      %L_OPT_ENV_EDIT%
echo   ----------------------------------------
echo      %L_OPT_EXIT%
echo.
choice /c 0123456789 /n /m "   %L_PROMPT_MAIN% "
if errorlevel 250 exit /b 0
if errorlevel 10 goto opt_env_edit
if errorlevel 9 goto opt_check
if errorlevel 8 goto opt_sites
if errorlevel 7 goto opt_card
if errorlevel 6 goto opt_sources
if errorlevel 5 goto opt_env
if errorlevel 4 goto opt_log
if errorlevel 3 goto opt_remove
if errorlevel 2 goto opt_start
exit /b 0

rem --- 1: start bot in a background window (bot.log) ---
:opt_start
call :cls_safe
call :bot_running
if not errorlevel 1 (
  echo %L_ALREADY_RUNNING%
  ping -n 3 127.0.0.1 >nul
  goto menu
)
echo %L_STARTING%
start "snp-bot" /min cmd /c "node src\index.js >> bot.log 2>&1"
ping -n 3 127.0.0.1 >nul
call :bot_running
if errorlevel 1 (
  echo %L_START_FAILED%
) else (
  echo %L_STARTED%
)
ping -n 3 127.0.0.1 >nul
goto menu

rem --- 2: graceful stop via stop.flag, taskkill only as a fallback ---
:opt_remove
call :cls_safe
call :bot_running
if errorlevel 1 (
  echo %L_NOT_RUNNING%
  ping -n 3 127.0.0.1 >nul
  goto menu
)
echo %L_STOP_SIGNAL%
type nul > stop.flag
for /l %%i in (1,1,10) do (
  ping -n 2 127.0.0.1 >nul
  call :bot_running
  if errorlevel 1 goto stopped
)
echo %L_FORCE_KILL%
taskkill /f /fi "WINDOWTITLE eq snp-bot*" /t >nul 2>&1
:stopped
if exist stop.flag del stop.flag
echo %L_STOPPED_MSG%
ping -n 3 127.0.0.1 >nul
goto menu

rem --- 4: settings submenu (writes .env, bot hot-reloads it) ---
:opt_env
call :cls_safe
call :load_strings
rem Read all settings with ONE powershell spawn: eight separate env_get calls
rem made the settings redraw take seconds of blank screen.
set "CUR_LANG=ru"
set "CUR_ENABLED=true"
set "CUR_TYPE=22"
set "CUR_STRETCH=wide"
set "CUR_CLEAR=true"
set "CUR_DEDUP=track"
set "CUR_LFM="
set "CUR_SFM="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$c=[IO.File]::ReadAllText((Join-Path (Get-Location) '.env')); $p = @('LANG','CUR_LANG'),('SHOWCASE_ENABLED','CUR_ENABLED'),('SHOWCASE_TYPE','CUR_TYPE'),('SHOWCASE_STRETCH','CUR_STRETCH'),('SHOWCASE_CLEAR_ON_EXIT','CUR_CLEAR'),('SHOWCASE_DEDUP','CUR_DEDUP'),('LASTFM_USERNAME','CUR_LFM'),('STATSFM_USERNAME','CUR_SFM'); foreach($k in $p){ $m=[regex]::Match($c,'(?m)^\s*'+$k[0]+'\s*=([^\r\n]*)'); if($m.Success){ Write-Output ($k[1]+'='+$m.Groups[1].Value) } }" ^< nul`) do set "%%v"
if /i "%CUR_ENABLED%"=="true" (set "DISP_ENABLED=%L_ON%") else set "DISP_ENABLED=%L_OFF%"
if "%CUR_TYPE%"=="22" (set "DISP_TYPE=%L_TYPE22%") else set "DISP_TYPE=%L_TYPE13%"
if /i "%CUR_CLEAR%"=="true" (set "DISP_CLEAR=%L_ON%") else set "DISP_CLEAR=%L_OFF%"
if /i "%CUR_DEDUP%"=="track" (set "DISP_DEDUP=%L_DEDUP_TRACK%") else set "DISP_DEDUP=%L_DEDUP_ALBUM%"
set "DISP_STRETCH=%CUR_STRETCH%"
if "%CUR_LFM%"=="" set "CUR_LFM=%L_NOT_SET%"
if "%CUR_SFM%"=="" set "CUR_SFM=%L_NOT_SET%"
echo.
echo   %L_SET_TITLE%
echo   ----------------------------------------
echo.
echo      %L_SET_LANG% [%CUR_LANG%]
echo      %L_SET_SHOWCASE% [%DISP_ENABLED%]
echo      %L_SET_TYPE% [%DISP_TYPE%]
echo      %L_SET_STRETCH% [%DISP_STRETCH%]
echo      %L_SET_CLEAR% [%DISP_CLEAR%]
echo      %L_SET_DEDUP% [%DISP_DEDUP%]
echo      %L_SET_LFM% [%CUR_LFM%]
echo      %L_SET_SFM% [%CUR_SFM%]
echo      %L_SET_LOGIN%
echo.
echo   ----------------------------------------
echo      %L_SET_BACK%
echo.
choice /c 0123456789 /n /m "   %L_PROMPT_SET% "
if errorlevel 250 goto menu
if errorlevel 10 goto set_login
if errorlevel 9 goto set_sfm
if errorlevel 8 goto set_lfm
if errorlevel 7 goto set_dedup
if errorlevel 6 goto set_clear
if errorlevel 5 goto set_stretch
if errorlevel 4 goto set_type
if errorlevel 3 goto set_enabled
if errorlevel 2 goto set_lang
goto menu

:set_lang
if /i "%CUR_LANG%"=="ru" (call :env_set LANG en) else call :env_set LANG ru
call :load_strings
call :saved
goto opt_env

:set_enabled
if /i "%CUR_ENABLED%"=="true" (call :env_set SHOWCASE_ENABLED false) else call :env_set SHOWCASE_ENABLED true
call :saved
goto opt_env

:set_type
if "%CUR_TYPE%"=="22" (call :env_set SHOWCASE_TYPE 13) else call :env_set SHOWCASE_TYPE 22
call :saved
goto opt_env

:set_stretch
if /i "%CUR_STRETCH%"=="wide" (call :env_set SHOWCASE_STRETCH vertical) else (
  if /i "%CUR_STRETCH%"=="vertical" (call :env_set SHOWCASE_STRETCH none) else call :env_set SHOWCASE_STRETCH wide
)
call :saved
goto opt_env

:set_clear
if /i "%CUR_CLEAR%"=="true" (call :env_set SHOWCASE_CLEAR_ON_EXIT false) else call :env_set SHOWCASE_CLEAR_ON_EXIT true
call :saved
goto opt_env

:set_dedup
if /i "%CUR_DEDUP%"=="track" (call :env_set SHOWCASE_DEDUP album) else call :env_set SHOWCASE_DEDUP track
call :saved
goto opt_env

:set_lfm
set "NEWNICK="
set /p "NEWNICK=   %L_NICK_LFM% "
if not "%NEWNICK%"=="" call :env_set LASTFM_USERNAME "%NEWNICK%"
goto opt_env

:set_sfm
set "NEWNICK="
set /p "NEWNICK=   %L_NICK_SFM% "
if not "%NEWNICK%"=="" call :env_set STATSFM_USERNAME "%NEWNICK%"
goto opt_env

:set_login
call :cls_safe
node src/index.js --login
echo.
echo %L_PRESS_KEY%
pause >nul
goto opt_env

:saved
call :cls_safe
echo.
echo   %L_SAVED%
ping -n 2 127.0.0.1 >nul
exit /b 0

rem --- write KEY=VALUE into .env (replace or append) ---
:env_set
set "ENV_KEY=%~1"
set "ENV_VAL=%~2"
powershell -NoProfile -Command "$f=Join-Path (Get-Location) '.env'; $c=[IO.File]::ReadAllText($f); $k=$env:ENV_KEY; $v=$env:ENV_VAL.Replace('$','$$'); $rx='(?m)^'+[regex]::Escape($k)+'=.*$'; if ($c -match $rx) { $c=[regex]::Replace($c,$rx,($k+'='+$v)) } else { if (-not $c.EndsWith(\"`n\")) { $c+=\"`r`n\" }; $c=$c+$k+'='+$v+\"`r`n\" }; [IO.File]::WriteAllText($f,$c)" < nul
exit /b 0

rem --- 3: live log view (auto-refresh every 2s, 0 = back) ---
rem Non-interactive stdin (pipe/script): show the tail once, no loop -
rem choice-with-timeout would spin forever on EOF.
:opt_log
call :cls_safe
if not exist "bot.log" (
  echo %L_LOG_MISSING%
  echo.
  echo %L_PRESS_KEY%
  pause >nul
  goto menu
)
if "%STDIN_REDIRECTED%"=="True" (
  echo %L_LOG_TAIL%
  echo.
  powershell -NoProfile -Command "Get-Content -Path 'bot.log' -Tail 25 -Encoding UTF8" < nul
  echo.
  goto menu
)
:log_loop
call :cls_safe
echo %L_LOG_LIVE%
echo.
powershell -NoProfile -Command "Get-Content -Path 'bot.log' -Tail 25 -Encoding UTF8" < nul
echo.
echo   %L_LOG_REFRESH%
choice /c 0x /n /t 2 /d x /m "   "
if errorlevel 250 goto menu
if errorlevel 2 goto log_loop
goto menu

rem --- 9: edit .env in Notepad ---
:opt_env_edit
call :cls_safe
notepad .env
goto menu

rem --- 5: what is playing now (JSON) ---
:opt_sources
call :cls_safe
node src/index.js --check-sources
echo.
echo %L_DONE%
pause >nul
goto menu

rem --- 6: upload card now (one-shot showcase) ---
:opt_card
call :cls_safe
node src/index.js --showcase-test
echo.
echo %L_DONE%
pause >nul
goto menu

rem --- 7: site availability (respects proxy from .env) ---
:opt_sites
call :cls_safe
node src/index.js --check-sites
echo.
echo %L_DONE%
pause >nul
goto menu

rem --- 8: check for updates; offer Y/N when found ---
:opt_check
call :cls_safe
node src/index.js --check-updates
if errorlevel 3 (
  echo.
  choice /c YN /n /m "   %L_UPDATE_PROMPT% "
  if not errorlevel 2 (
    call :cls_safe
    node src/index.js --update
  )
)
echo.
echo %L_DONE%
pause >nul
goto menu

rem ===== helpers =====

rem --- cls that is safe when stdout/stdin are redirected ---
:cls_safe
rem cls hangs when stdout/stdin are redirected - clear only in a real console
if "%STDIN_REDIRECTED%"=="False" cls
exit /b 0

rem --- Load menu strings: docs\menu-<lang>.txt follows LANG from .env ---
rem Files are UTF-8 KEY=value lines; PowerShell decodes them reliably, so the
rem .bat itself stays ASCII-only. Only "en" switches the language, everything
rem else (including missing/empty LANG) falls back to ru - like the bot does.
rem Strings are cached per language file: reloading them on every redraw
rem (a powershell spawn) made menu redraws visibly slow.
:load_strings
set "MENU_LANG=ru"
for /f "tokens=2 delims== " %%v in ('findstr /b /i "LANG=" .env 2^>nul') do set "MENU_LANG=%%v"
if /i "%MENU_LANG%"=="en" (set "LANGFILE=docs\menu-en.txt") else set "LANGFILE=docs\menu-ru.txt"
if not exist "%LANGFILE%" set "LANGFILE=docs\menu-en.txt"
if "%LANGFILE%"=="%LOADED_LANGFILE%" exit /b 0
set "LOADED_LANGFILE=%LANGFILE%"
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "Get-Content -LiteralPath '%LANGFILE%' -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' }" ^< nul`) do set "%%v"
exit /b 0

rem --- Is the background bot running? (window title filter) ---
:bot_running
tasklist /fi "WINDOWTITLE eq snp-bot*" 2>nul | find /i "cmd.exe" >nul
exit /b %errorlevel%

rem --- Header info: version + showcase settings from .env ---
:refresh_info
for /f "tokens=2 delims==" %%v in ('findstr /b "SHOWCASE_TYPE=" .env 2^>nul') do set "SHOWCASE_TYPE=%%v"
for /f "tokens=2 delims==" %%v in ('findstr /b "SHOWCASE_STRETCH=" .env 2^>nul') do set "SHOWCASE_STRETCH=%%v"
for /f "tokens=2 delims==" %%v in ('findstr /b "SHOWCASE_SLOT=" .env 2^>nul') do set "SHOWCASE_SLOT=%%v"
for /f "tokens=2 delims==" %%v in ('findstr /b "LASTFM_USERNAME=" .env 2^>nul') do set "LASTFM_USER=%%v"
for /f "tokens=2 delims==" %%v in ('findstr /b "STATSFM_USERNAME=" .env 2^>nul') do set "STATSFM_USER=%%v"
if not defined SHOWCASE_TYPE set "SHOWCASE_TYPE=22"
if not defined SHOWCASE_STRETCH set "SHOWCASE_STRETCH=wide"
if not defined SHOWCASE_SLOT set "SHOWCASE_SLOT=0"
if not defined BOTVER for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul ^< nul') do set "BOTVER=%%v"
if not defined BOTVER set "BOTVER=?"
exit /b 0

rem ===== requirements: node, npm, folder, .env, dependencies =====
:requirements
rem --- 1. Node.js installed? If not - offer auto-download (portable, project-local) ---
where node >nul 2>nul
if not errorlevel 1 goto node-ok
type "docs\node-missing.txt" 2>nul
choice /c YN /n /m "   %L_NODE_ASK% "
if errorlevel 2 goto node-manual
call install-node.bat
if errorlevel 1 goto node-manual
rem Portable node: pick the extracted folder (name contains the version)
for /d %%D in ("%~dp0node\node-v*-win-x64") do set "PATH=%%D;%PATH%"
:node-ok
where node >nul 2>nul
if errorlevel 1 goto node-manual

rem --- 2. Node.js version 18+ ---
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
for /f "tokens=1 delims=." %%a in ("%NODEVER:v=%") do set "NODEMAJOR=%%a"
if "%NODEMAJOR%"=="" set "NODEMAJOR=0"
if %NODEMAJOR% LSS 18 (
  echo %L_ERR_NODE_VER% %NODEVER%
  echo %L_ERR_NODE_LTS%
  pause
  exit /b 1
)
echo %L_CHECK% Node.js %NODEVER%

rem --- 3. Correct folder (project root)? ---
if not exist "package.json" (
  echo %L_ERR_FOLDER%
  pause
  exit /b 1
)

rem --- 4. .env from template if missing ---
if exist ".env" goto env-ok
copy /y ".env.example" ".env" >nul
echo %L_SETUP_ENV%
:env-ok

rem --- 5. Dependencies: try to load the key modules ---
node -e "require('undici');require('steam-user');require('@napi-rs/canvas');require('cheerio')" >nul 2>nul
if not errorlevel 1 goto deps-ok
echo %L_SETUP_NPM%
call npm install --no-audit --no-fund
node -e "require('undici');require('steam-user');require('@napi-rs/canvas');require('cheerio')" >nul 2>nul
if errorlevel 1 (
  echo %L_ERR_NPM%
  pause
  exit /b 1
)
:deps-ok
echo %L_CHECK% %L_DEPS_OK%
exit /b 0

:node-manual
type "docs\install-help.txt" 2>nul
echo.
pause
exit /b 1
