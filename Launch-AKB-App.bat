@echo off
title Anudeep Khadi Bandar - Dedicated Workstation Launcher
cd /d "%~dp0"

:: 1. Ensure background Node.js server is running
curl -s -m 1 http://127.0.0.1:3000/api/health >nul 2>&1
if errorlevel 1 (
    echo Starting background server on port 3000...
    if exist "C:\Program Files\nodejs\node.exe" (
        start "AKB-Backend-Server" /min "C:\Program Files\nodejs\node.exe" "%~dp0server.js"
    ) else if exist "node.exe" (
        start "AKB-Backend-Server" /min "%~dp0node.exe" "%~dp0server.js"
    ) else (
        start "AKB-Backend-Server" /min node "%~dp0server.js"
    )
    timeout /t 2 /nobreak >nul 2>&1
)

:: 2. Launch via Electron (Preferred: Full native workstation container)
if exist "node_modules\electron" (
    start "" "node_modules\.bin\electron.cmd" .
    exit
)

:: 3. If packaged Electron app exists in dist, launch it directly
if exist "dist\AKB-Billing-win32-x64\AKB-Billing.exe" (
    start "" "dist\AKB-Billing-win32-x64\AKB-Billing.exe"
    exit
)

:: 4. Launch native workstation launcher (AKB-Billing.exe)
if exist "AKB-Billing.exe" (
    start "" "AKB-Billing.exe"
    exit
)

:: 5. Fallback: Launch MS Edge in dedicated app mode connected to local backend
start msedge --app="http://127.0.0.1:3000/?mode=dedicated_app"
exit

