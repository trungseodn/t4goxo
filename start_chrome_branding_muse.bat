@echo off
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
chcp 65001 >nul
title Chrome Muse Branding - Avatar va Cover (Port 9245)
cd /d "%~dp0"

echo ========================================================
echo   ZTTeam: Khoi dong Google Chrome cho Muse.ai Branding
echo   Tao Anh Bia va Avatar Fanpage (Debug Port: 9245)
echo ========================================================
echo.

set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_PATH%" (
    set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)
if not exist "%CHROME_PATH%" (
    set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)
if not exist "%CHROME_PATH%" (
    set "CHROME_PATH=chrome.exe"
)

set "P_DIR=%LOCALAPPDATA%\Google\Chrome_Muse_Branding"
set "FLAGS=--remote-allow-origins=* --no-first-run --no-default-browser-check"

echo [1] Tim thay Google Chrome tai:
echo     "%CHROME_PATH%"
echo [2] Thu muc Profile:
echo     "%P_DIR%"
echo [3] Dang mo Chrome tren Port 9245...
echo.

start "Chrome Muse Branding (9245)" "%CHROME_PATH%" --remote-debugging-port=9245 %FLAGS% --user-data-dir="%P_DIR%" "https://muse.ai/"

echo ========================================================
echo   Da bat Chrome thanh cong!
echo   Vui long dang nhap Muse.ai tren cua so Chrome vua mo.
echo   Sau khi dang nhap xong, chay tiep: start_muse_branding_worker.bat
echo ========================================================
pause
