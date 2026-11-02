@echo off
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
chcp 65001 >nul
title ZTTeam Muse Branding Worker (Port 9245)
cd /d "%~dp0"

echo ========================================================
echo   ZTTeam Muse Branding Worker - Avatar va Cover (Port 9245)
echo   He thong: https://t4.goxo.us
echo ========================================================
echo.

node scripts/ztteam_muse_branding_worker.js --target=https://t4.goxo.us --chrome-port=9245 --worker-name=Branding-9245
pause
