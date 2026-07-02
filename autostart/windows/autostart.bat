@echo off
setlocal
cd /d "%~dp0"
title Cursor-OpenAI Gateway - Autostart Manager

:menu
cls
echo ============================================================
echo   Cursor-OpenAI Gateway - Autostart Manager (Windows)
echo ============================================================
echo.
echo   1. Install autostart   (run hidden at every logon)
echo   2. Uninstall autostart (stops autostarting; leaves it running)
echo   3. Show status
echo   4. Start gateway now   (hidden, same as autostart would)
echo   5. Stop gateway
echo   6. Exit
echo.
set "choice="
set /p choice="Choose an option (1-6): "

if "%choice%"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "Install-Autostart.ps1"
    echo.
    pause
    goto menu
)
if "%choice%"=="2" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "Uninstall-Autostart.ps1"
    echo.
    pause
    goto menu
)
if "%choice%"=="3" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "Status.ps1"
    echo.
    pause
    goto menu
)
if "%choice%"=="4" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "Gateway-Runner.ps1"
    echo.
    echo Done. Check Status ^(option 3^) for details.
    pause
    goto menu
)
if "%choice%"=="5" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "Stop-Gateway.ps1"
    echo.
    pause
    goto menu
)
if "%choice%"=="6" (
    endlocal
    exit /b 0
)

echo.
echo Invalid choice: %choice%
pause
goto menu
