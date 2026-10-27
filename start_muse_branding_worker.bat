@echo off
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
chcp 65001 >nul
title ZTTeam Muse Branding Worker (Port 9245)
cd /d "%~dp0"

echo ========================================================
echo   ZTTeam Muse Branding Worker - Avatar va Cover (Port 9245)
echo   He thong VPS: http://169.58.190.115:3004
echo ========================================================
echo.

node scripts/ztteam_muse_branding_worker.js --target=http://169.58.190.115:3004 --chrome-port=9245 --worker-name=Branding-9245
pause
