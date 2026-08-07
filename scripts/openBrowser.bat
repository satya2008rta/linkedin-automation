@echo off
REM Gives the server a moment to boot before opening the browser tab.
REM Usage: openBrowser.bat [port]  (defaults to 3000)
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3000"
timeout /t 3 /nobreak >nul
start "" "http://localhost:%PORT%"
