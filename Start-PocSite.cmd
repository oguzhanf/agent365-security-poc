@echo off
rem Starts the Agent 365 PoC demonstrator and tracker site and opens it in the browser.
rem Keep this window open while you use the site. Close it or press Ctrl+C to stop the site.
rem Optional arguments are passed to the server, for example: Start-PocSite.cmd --port 4366
setlocal
title Agent 365 PoC site - keep this window open
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto oldnode

if not exist "node_modules\docx\package.json" goto install
if not exist "node_modules\jszip\package.json" goto install
goto run

:install
echo Installing the site dependencies. This runs once.
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto installfailed

:run
if "%~1"=="" (
  node site\server.cjs --open
) else (
  node site\server.cjs %*
)
set "rc=%errorlevel%"
if not "%rc%"=="0" pause
exit /b %rc%

:nonode
echo Node.js 22 or later is required. Install it from https://nodejs.org, then run this file again.
pause
exit /b 1

:oldnode
echo Node.js 22 or later is required. Update Node.js, then run this file again.
pause
exit /b 1

:installfailed
echo The dependency installation failed. Check the network connection and npm access, then run this file again.
pause
exit /b 1
