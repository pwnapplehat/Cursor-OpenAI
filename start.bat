@echo off
setlocal enabledelayedexpansion
title Cursor OpenAI Gateway
cd /d "%~dp0"

echo ============================================
echo   Cursor OpenAI Gateway
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo.
  echo Please install Node.js 18 or newer from https://nodejs.org
  echo ^(the "LTS" download is fine^), then run this file again.
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies - this only happens once, it may take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo "npm install" failed. Scroll up for details, or ask for help with the error above.
    pause
    exit /b 1
  )
)

if not exist "dist\index.js" (
  echo Building the gateway - this only happens once...
  call npm run build
  if errorlevel 1 (
    echo.
    echo Build failed. Scroll up for details, or ask for help with the error above.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo No .env file found - the setup wizard will open in your browser to configure everything.
  echo.
)

echo Starting the gateway... a browser window should open automatically.
echo Close this window (or press Ctrl+C) to stop the gateway.
echo.

call npm start

echo.
echo The gateway has stopped.
pause
