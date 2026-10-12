@echo off
title Anudeep Khadi Bandar - Dedicated Workstation Launcher
cd /d "%~dp0"

:: 1. Launch via Electron
if exist "node_modules\electron" (
    start "" "node_modules\.bin\electron.cmd" .
    exit
)

:: 2. If packaged Electron app exists in dist, launch it directly
if exist "dist\AKB-Billing-win32-x64\AKB-Billing.exe" (
    start "" "dist\AKB-Billing-win32-x64\AKB-Billing.exe"
    exit
)

:: 3. Launch high-speed native workstation launcher (AKB-Billing.exe)
if exist "AKB-Billing.exe" (
    start "" "AKB-Billing.exe"
    exit
)

:: 4. Fallback: Launch MS Edge or Chrome in dedicated app mode
start msedge --app="https://kandukurijagan1.github.io/anudeep/?mode=dedicated_app"
exit
