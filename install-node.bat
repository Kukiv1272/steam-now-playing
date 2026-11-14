@echo off
rem Downloads and extracts Node.js LTS (win-x64) into the project 'node' folder.
rem Portable install: nothing is written to the system, PATH is set by the caller.
rem ASCII only: this file is parsed by cmd.exe (no UTF-8 batch files after chcp 65001).

set "NODE_VER=22.14.0"
set "NODE_NAME=node-v%NODE_VER%-win-x64"
set "NODE_DIR=%~dp0node\%NODE_NAME%"
set "NODE_ZIP=%TEMP%\node-lts-%NODE_VER%.zip"
rem Full path: powershell may be missing from a broken PATH
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if exist "%NODE_DIR%\node.exe" (
  echo [setup] Node.js already downloaded.
  exit /b 0
)

echo [setup] Downloading Node.js v%NODE_VER% LTS (~30 MB)...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VER%/%NODE_NAME%.zip' -OutFile '%NODE_ZIP%' -UseBasicParsing } catch { exit 1 }"
if not errorlevel 1 goto extract

echo [setup] nodejs.org unreachable, trying mirror...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri 'https://npmmirror.com/mirrors/node/v%NODE_VER%/%NODE_NAME%.zip' -OutFile '%NODE_ZIP%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
  echo [setup] Download failed.
  exit /b 1
)

:extract
echo [setup] Extracting...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -LiteralPath '%NODE_ZIP%' -DestinationPath '%~dp0node' -Force } catch { exit 1 }"
if errorlevel 1 (
  echo [setup] Extract failed.
  exit /b 1
)
del "%NODE_ZIP%" >nul 2>nul

if not exist "%NODE_DIR%\node.exe" (
  echo [setup] node.exe not found after extraction.
  exit /b 1
)
echo [setup] Node.js installed to the project 'node' folder.
exit /b 0
