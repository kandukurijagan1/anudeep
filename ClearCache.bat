@echo off
echo ========================================================
echo       Anudeep Khadi Bandar - Cache Clear Utility
echo ========================================================
echo.
echo 1. Force-killing background Node.js, Electron, and Chrome processes...
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM AKB-Billing.exe /T >nul 2>&1
taskkill /F /IM chrome.exe /T >nul 2>&1
taskkill /F /IM msedge.exe /T >nul 2>&1

echo.
echo 2. Wiping outdated HTML, scripts, and logs (PRESERVING WhatsApp linked credentials)...
del /F /Q "%APPDATA%\AnudeepKhadiBandar\index.html" >nul 2>&1
del /F /Q "%APPDATA%\AnudeepKhadiBandar\all_scripts.js" >nul 2>&1
del /F /Q "%APPDATA%\AnudeepKhadiBandar\server.js" >nul 2>&1
del /F /Q "%APPDATA%\AnudeepKhadiBandar\server.js.bak" >nul 2>&1
del /F /Q "%APPDATA%\AnudeepKhadiBandar\server.log" >nul 2>&1
del /F /Q "%APPDATA%\AnudeepKhadiBandar\server2.log" >nul 2>&1
del /F /Q "%APPDATA%\AnudeepKhadiBandar\wwebjs_chrome.pid" >nul 2>&1
:: Note: .wwebjs_auth and whatsapp_session.json are intentionally PRESERVED so WhatsApp stays linked across restarts!

echo.
echo 3. Syncing latest server code and WhatsApp web cache to AppData...
copy /Y "%~dp0server.js" "%APPDATA%\AnudeepKhadiBandar\server.js" >nul 2>&1
copy /Y "%~dp0index.html" "%APPDATA%\AnudeepKhadiBandar\index.html" >nul 2>&1
if not exist "%APPDATA%\AnudeepKhadiBandar\.wwebjs_cache" mkdir "%APPDATA%\AnudeepKhadiBandar\.wwebjs_cache" >nul 2>&1
xcopy /Y /E /I /Q "%~dp0.wwebjs_cache" "%APPDATA%\AnudeepKhadiBandar\.wwebjs_cache" >nul 2>&1

echo.
echo ========================================================
echo  Cache cleared successfully! 
echo  You can now relaunch the app:
echo  Double-click Launch-AKB-App.bat or run: npm run electron
echo ========================================================
echo.
pause
