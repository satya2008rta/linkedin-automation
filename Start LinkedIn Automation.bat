@echo off
setlocal
title LinkedIn Automation Dashboard
cd /d "%~dp0"

if not exist ".env" (
  echo No .env file found - creating one from .env.example
  copy /y ".env.example" ".env" >nul
  echo.
  echo IMPORTANT: Open the .env file in this folder and fill in your LinkedIn
  echo Client ID / Client Secret before connecting your account in Settings.
  echo.
)

REM Figure out which port this instance will use (matches .env, defaults to 3000).
set "APP_PORT=3000"
for /f "tokens=2 delims==" %%A in ('findstr /b /i "PORT=" ".env" 2^>nul') do set "APP_PORT=%%A"

REM Stop any previous instance of this app still holding that port. Without this, a
REM server left running from an earlier launch keeps executing its old, already-loaded
REM code in memory even after files on disk change - editing source or restarting via
REM this script wouldn't actually take effect until the stale process was killed.
REM
REM Tries a plain taskkill first (a small chance for anything mid-request to finish/error
REM out on its own) before force-killing - Windows gives no reliable way to guarantee a
REM headless console process shuts down cleanly, so this is a best-effort courtesy, not a
REM safety guarantee. The actual safety net against an interrupted mid-publish is in the
REM app itself: a post stuck 'posting' from a killed process lands on 'failed' with a clear
REM warning instead of silently auto-retrying (see reapStaleLocks in storage.service.js).
echo Checking for a previous instance of this app on port %APP_PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%APP_PORT% " ^| findstr "LISTENING"') do (
  echo Stopping previous server instance - PID %%P - so this run uses the latest code...
  taskkill /PID %%P >nul 2>&1
  timeout /t 2 /nobreak >nul
  taskkill /F /PID %%P >nul 2>&1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this machine.
  echo Install it from https://nodejs.org, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies for the first time - this can take a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed - see the errors above.
    pause
    exit /b 1
  )
)

echo Starting the dashboard at http://localhost:%APP_PORT% ...
echo.
echo Leave this window open while you use the app.
echo Close this window (or press Ctrl+C) to stop the server.
echo.

start "" /min "%~dp0scripts\openBrowser.bat" %APP_PORT%

call npm start

echo.
echo Server stopped.
pause
