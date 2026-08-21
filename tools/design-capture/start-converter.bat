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

REM Optional: start Ollama for the local-AI tier. Prefer a PATH install; else fall back to the BUNDLED
REM portable ollama.exe shipped in the assembled kit (probe a few candidate relative paths). Non-fatal —
REM never blocks the service. Only when using the BUNDLED exe do we point OLLAMA_MODELS at the kit's
REM models dir beside it (matching the top-level kit launcher); a system install keeps its own default.
set "OLLAMA_EXE="
where ollama >nul 2>nul && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%~dp0..\..\ollama\ollama.exe" set "OLLAMA_EXE=%~dp0..\..\ollama\ollama.exe"
if not defined OLLAMA_EXE if exist "%~dp0..\..\..\ollama\ollama.exe" set "OLLAMA_EXE=%~dp0..\..\..\ollama\ollama.exe"
if not defined OLLAMA_EXE if exist "%~dp0..\..\..\..\ollama\ollama.exe" set "OLLAMA_EXE=%~dp0..\..\..\..\ollama\ollama.exe"
if defined OLLAMA_EXE (
  echo Starting Ollama ^(local AI^)...
  if not "%OLLAMA_EXE%"=="ollama" for %%I in ("%OLLAMA_EXE%") do (
    if not exist "%%~dpImodels" mkdir "%%~dpImodels" >nul 2>nul
    set "OLLAMA_MODELS=%%~dpImodels"
  )
  start "" /min "%OLLAMA_EXE%" serve
)

REM Free BOTH ports from any PREVIOUS run so THIS launch rebinds them with the CURRENT code. We kill 8787
REM (capture service) AND 4600 (dashboard): the version-check "reuse a current dashboard" optimization
REM silently left a STALE dashboard server serving old /api routes after a code update — which reads to
REM the user as a feature that's "not found". A clean kill of both every launch is correct over cute.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>nul
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4600 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>nul

REM Always pop the dashboard open when the converter is STARTED — a fresh tab every launch (even a
REM duplicate) beats silently none when the previous tab was closed. Mid-conversion auto-opens stay quiet.
set DASHBOARD_FORCE_OPEN=1

echo.
echo   Starting the UnysonPlus capture service...
echo   The dashboard is at  http://localhost:4600  ^(a browser tab opens automatically^)
echo   Keep this window open while you convert.  Press Ctrl+C to stop.
echo.
node serve.mjs

echo.
echo   The capture service stopped.
pause
