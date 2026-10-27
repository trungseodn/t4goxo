@echo off
chcp 65001 >nul
title ZTTeam Muse Branding Worker (Avatar & Cover)
echo ========================================================
echo   ZTTeam - Muse Branding Auto Worker (Avatar & Cover)
echo   Cong Chrome Debugger rieng biet: 9245
echo   May chu VPS dich: http://169.58.190.115:3004
echo ========================================================
echo.

set "CHROME_PORT=9245"
set "PROFILE_DIR=%USERPROFILE%\chrome-muse-branding-profile"

set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_PATH%" (
    set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
)
if not exist "%CHROME_PATH%" (
    set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

echo [1] Kiem tra ket noi Chrome Port %CHROME_PORT%...
powershell -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%CHROME_PORT%/json/version' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Chrome Port %CHROME_PORT% chua bat. Dang tu dong khoi chay...
    start "" "%CHROME_PATH%" --remote-debugging-port=%CHROME_PORT% --user-data-dir="%PROFILE_DIR%" "https://muse.ai/"
    timeout /t 4 /nobreak >nul
) else (
    echo [OK] Chrome Port %CHROME_PORT% dang chay san sang!
)

echo.
echo [2] Khoi dong ZTTeam Muse Branding Worker...
echo.
node scripts/ztteam_muse_branding_worker.js --chrome-port=%CHROME_PORT% --target=http://169.58.190.115:3004
pause
