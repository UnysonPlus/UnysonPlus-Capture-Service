@echo off
REM ============================================================================
REM  UnysonPlus Converter - one-click launcher (Windows)
REM  Double-click this file. It starts the capture service and the dashboard
REM  (http://localhost:4600 opens automatically), plus Ollama if installed
REM  (for the Experimental local-AI tier). Leave the window open while you convert.
REM ============================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed or not on PATH.
  echo   Install Node 20+ from https://nodejs.org/ then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright-core" (
  echo First run - installing dependencies ^(npm install^), this happens once...
  call npm install
)

REM Optional: start Ollama for the Experimental local-AI tier, if it's installed. Non-fatal.
where ollama >nul 2>nul && (
  echo Starting Ollama ^(local AI - Experimental^)...
  start "" /min ollama serve
)

echo.
echo   Starting the UnysonPlus capture service...
echo   The dashboard opens automatically at  http://localhost:4600
echo   Keep this window open while you convert.  Press Ctrl+C to stop.
echo.
REM Explicit launch → always pop the dashboard tab (bypass the anti-spam lockfile).
set "DASHBOARD_FORCE_OPEN=1"
node serve.mjs

echo.
echo   The capture service stopped.
pause
