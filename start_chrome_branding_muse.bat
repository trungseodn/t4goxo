@echo off
chcp 65001 >nul
title Chrome Muse Branding (Port 9245)
echo ========================================================
echo   ZTTeam - Khoi chay Chrome cho Tao Anh Bia & Avatar Muse
echo   Cong Remote Debugging rieng biet: 9245 (Khong trung Reel 9222)
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

echo [1] Kiem tra duong dan Chrome:
echo     "%CHROME_PATH%"
echo [2] Thu muc Profile rieng biet:
echo     "%PROFILE_DIR%"
echo [3] Kiem tra xung dot cong %CHROME_PORT%...

powershell -Command "$c = Get-NetTCPConnection -LocalPort %CHROME_PORT% -ErrorAction SilentlyContinue; if ($c) { exit 1 } else { exit 0 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo [THONG BAO] Cong %CHROME_PORT% da co ung dung dang lang nghe hoac Chrome da mo.
    echo Kiem tra ket noi Chrome Debugger...
    powershell -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%CHROME_PORT%/json/version' -TimeoutSec 2; Write-Host '[OK] Chrome Debugger tren cong %CHROME_PORT% da san sang!' } catch { Write-Host '[CANH BAO] Cong %CHROME_PORT% bi chiem boi tien trinh khac khong phai Chrome!' }"
) else (
    echo [4] Dang khoi chay Chrome moi tai cong %CHROME_PORT%...
    start "" "%CHROME_PATH%" --remote-debugging-port=%CHROME_PORT% --user-data-dir="%PROFILE_DIR%" "https://muse.ai/"
    echo [OK] Da bat Chrome Muse Branding tren cong %CHROME_PORT%!
)

echo.
echo ========================================================
echo   Luu y: Hay dang nhap tai khoan Muse.ai tren cua so Chrome vua mo.
echo   Sau do bat file 'start_muse_branding_worker.bat' de xu ly hang doi.
echo ========================================================
pause
