@echo off
title Anudeep Khadi Bandar - Dedicated Workstation Launcher
cd /d "%~dp0"

:: ========================================================
:: 0. Silent background auto-sync from GitHub (timeout 3s)
:: ========================================================
if not exist "%APPDATA%\AnudeepKhadiBandar" mkdir "%APPDATA%\AnudeepKhadiBandar" >nul 2>&1
if not exist "%APPDATA%\AnudeepKhadiBandar\data" mkdir "%APPDATA%\AnudeepKhadiBandar\data" >nul 2>&1
if not exist "%~dp0data" mkdir "%~dp0data" >nul 2>&1

curl -s -m 3 -f -L "https://raw.githubusercontent.com/kandukurijagan1/anudeep/main/index.html" -o "%APPDATA%\AnudeepKhadiBandar\index.html.tmp" >nul 2>&1
if exist "%APPDATA%\AnudeepKhadiBandar\index.html.tmp" (
    for %%F in ("%APPDATA%\AnudeepKhadiBandar\index.html.tmp") do if %%~zF GTR 1000 (
        move /Y "%APPDATA%\AnudeepKhadiBandar\index.html.tmp" "%APPDATA%\AnudeepKhadiBandar\index.html" >nul 2>&1
        copy /Y "%APPDATA%\AnudeepKhadiBandar\index.html" "%~dp0index.html" >nul 2>&1
    )
    if exist "%APPDATA%\AnudeepKhadiBandar\index.html.tmp" del /Q "%APPDATA%\AnudeepKhadiBandar\index.html.tmp" >nul 2>&1
)

curl -s -m 3 -f -L "https://raw.githubusercontent.com/kandukurijagan1/anudeep/main/server.js" -o "%APPDATA%\AnudeepKhadiBandar\server.js.tmp" >nul 2>&1
if exist "%APPDATA%\AnudeepKhadiBandar\server.js.tmp" (
    for %%F in ("%APPDATA%\AnudeepKhadiBandar\server.js.tmp") do if %%~zF GTR 1000 (
        move /Y "%APPDATA%\AnudeepKhadiBandar\server.js.tmp" "%APPDATA%\AnudeepKhadiBandar\server.js" >nul 2>&1
        copy /Y "%APPDATA%\AnudeepKhadiBandar\server.js" "%~dp0server.js" >nul 2>&1
    )
    if exist "%APPDATA%\AnudeepKhadiBandar\server.js.tmp" del /Q "%APPDATA%\AnudeepKhadiBandar\server.js.tmp" >nul 2>&1
)

curl -s -m 3 -f -L "https://raw.githubusercontent.com/kandukurijagan1/anudeep/main/version.json" -o "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" >nul 2>&1
if exist "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" (
    for %%F in ("%APPDATA%\AnudeepKhadiBandar\version.json.tmp") do if %%~zF GTR 10 (
        move /Y "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" "%APPDATA%\AnudeepKhadiBandar\version.json" >nul 2>&1
        copy /Y "%APPDATA%\AnudeepKhadiBandar\version.json" "%~dp0version.json" >nul 2>&1
    )
    if exist "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" del /Q "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" >nul 2>&1
)

:: ========================================================
:: 1. Ensure background Node.js server is running
:: ========================================================
set "TARGET_HOST_URL=http://127.0.0.1:3000"

curl -s -m 1 http://127.0.0.1:3000/api/health >nul 2>&1
if errorlevel 1 (
    curl -s -m 1 http://10.209.191.184:3000/api/health >nul 2>&1
    if not errorlevel 1 (
        echo [AKB Launcher] Connected to Host Workstation on LAN: http://10.209.191.184:3000
        set "TARGET_HOST_URL=http://10.209.191.184:3000"
    ) else (
        echo [AKB Launcher] Starting local background server on port 3000...
        if exist "C:\Program Files\nodejs\node.exe" (
            start "AKB-Backend-Server" /min "C:\Program Files\nodejs\node.exe" "%~dp0server.js"
        ) else if exist "node.exe" (
            start "AKB-Backend-Server" /min "%~dp0node.exe" "%~dp0server.js"
        ) else (
            start "AKB-Backend-Server" /min node "%~dp0server.js"
        )
        timeout /t 2 /nobreak >nul 2>&1
    )
)

:: ========================================================
:: 2. Launch Dedicated Workstation UI (Prioritized Pipeline)
:: ========================================================

:: Option A: Local Electron binary container (Fastest & direct)
if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
    exit
)

:: Option B: Installed Windows Program
if exist "%LOCALAPPDATA%\Programs\Anudeep Khadi Bandar - GST Billing\Anudeep Khadi Bandar - GST Billing.exe" (
    start "" "%LOCALAPPDATA%\Programs\Anudeep Khadi Bandar - GST Billing\Anudeep Khadi Bandar - GST Billing.exe"
    exit
)

:: Option C: Compiled C# Native Launcher
if exist "AKB-Billing.exe" (
    start "" "AKB-Billing.exe"
    exit
)

:: Option D: Google Chrome Dedicated App Mode
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app="%TARGET_HOST_URL%/?mode=dedicated_app"
    exit
)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --app="%TARGET_HOST_URL%/?mode=dedicated_app"
    exit
)

:: Option E: Microsoft Edge Dedicated App Mode (Default Windows Fallback)
start msedge --app="%TARGET_HOST_URL%/?mode=dedicated_app"
exit
