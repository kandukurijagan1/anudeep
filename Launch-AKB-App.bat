@echo off
title Anudeep Khadi Bandar - Dedicated Workstation Launcher
cd /d "%~dp0"

:: 0. Silent sync check (dev safety: if .git exists, use local workspace files instead of remote GitHub)
if not exist "%APPDATA%\AnudeepKhadiBandar" mkdir "%APPDATA%\AnudeepKhadiBandar" >nul 2>&1
if not exist "%APPDATA%\AnudeepKhadiBandar\data" mkdir "%APPDATA%\AnudeepKhadiBandar\data" >nul 2>&1
if not exist "%~dp0data" mkdir "%~dp0data" >nul 2>&1

if exist "%~dp0.git" (
    copy /Y "%~dp0index.html" "%APPDATA%\AnudeepKhadiBandar\index.html" >nul 2>&1
    copy /Y "%~dp0server.js" "%APPDATA%\AnudeepKhadiBandar\server.js" >nul 2>&1
    copy /Y "%~dp0version.json" "%APPDATA%\AnudeepKhadiBandar\version.json" >nul 2>&1
) else (
    curl -s -m 3 -f -L "https://raw.githubusercontent.com/kandukurijagan1/anudeep/main/version.json" -o "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" >nul 2>&1
    if exist "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" (
        for %%F in ("%APPDATA%\AnudeepKhadiBandar\version.json.tmp") do if %%~zF GTR 10 (
            move /Y "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" "%APPDATA%\AnudeepKhadiBandar\version.json" >nul 2>&1
            copy /Y "%APPDATA%\AnudeepKhadiBandar\version.json" "%~dp0version.json" >nul 2>&1
        )
        if exist "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" del /Q "%APPDATA%\AnudeepKhadiBandar\version.json.tmp" >nul 2>&1
    )
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
)


:: 1. Ensure background Node.js server is running
:: On client machines, check if Host Workstation (10.209.191.184) is reachable first!
curl -s -m 1 http://127.0.0.1:3000/api/health >nul 2>&1
if not errorlevel 1 (
    set "TARGET_HOST_URL=http://127.0.0.1:3000"
) else (
    curl -s -m 1 http://10.209.191.184:3000/api/health >nul 2>&1
    if not errorlevel 1 (
        echo Found Host Workstation on LAN: http://10.209.191.184:3000
        set "TARGET_HOST_URL=http://10.209.191.184:3000"
    ) else (
        echo Starting local background server on port 3000...
        if exist "C:\Program Files\nodejs\node.exe" (
            start "AKB-Backend-Server" /min "C:\Program Files\nodejs\node.exe" "%~dp0server.js"
        ) else if exist "node.exe" (
            start "AKB-Backend-Server" /min "%~dp0node.exe" "%~dp0server.js"
        ) else (
            start "AKB-Backend-Server" /min node "%~dp0server.js"
        )
        timeout /t 2 /nobreak >nul 2>&1
        set "TARGET_HOST_URL=http://127.0.0.1:3000"
    )
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

:: 5. Fallback: Launch MS Edge in dedicated app mode connected to host or local backend
if defined TARGET_HOST_URL (
    start msedge --app="%TARGET_HOST_URL%/?mode=dedicated_app"
) else (
    start msedge --app="http://127.0.0.1:3000/?mode=dedicated_app"
)
exit

