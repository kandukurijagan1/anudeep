@echo off
title Anudeep Khadi Bandar - Dedicated Workstation Launcher
cd /d "%~dp0"

:: 1. If packaged Electron app exists in dist, launch it directly
if exist "dist\AKB-Billing-win32-x64\AKB-Billing.exe" (
    start "" "dist\AKB-Billing-win32-x64\AKB-Billing.exe"
    exit
)

:: 2. Launch high-speed native workstation launcher (AKB-Billing.exe)
if exist "AKB-Billing.exe" (
    start "" "AKB-Billing.exe"
    exit
)

:: 3. Launch via Electron if node_modules is present
if exist "node_modules\electron" (
    start "" npx electron .
    exit
)

:: 4. Fallback: Launch MS Edge or Chrome in dedicated app mode
start msedge --app="file:///%~dp0index.html"
exit
