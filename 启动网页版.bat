@echo off
chcp 65001 >nul 2>nul
setlocal
title STARHERD - WEB
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "C:\Users\a\AppData\Local\Programs\Python\Python313\python.exe" set "PY=C:\Users\a\AppData\Local\Programs\Python\Python313\python.exe"

echo ==========================================================
echo   STARHERD  /  网页版 (HTTP + WebSocket)
echo ==========================================================

if not defined PY goto nopython
if not exist "python\mission_control.py" goto nohost

echo [1/1] %PY% python\mission_control.py --web
echo       服务启动后会自动打开默认浏览器；按 Ctrl+C 结束服务。
"%PY%" "python\mission_control.py" --web
if errorlevel 1 goto runerr
echo [OK] 服务已停止
goto end

:nopython
echo [ERROR] 找不到 python。请安装 Python 3.13
pause
exit /b 1

:nohost
echo [ERROR] 找不到 python\mission_control.py
pause
exit /b 1

:runerr
echo [ERROR] 启动失败，退出码 %errorlevel%
echo         可先跑 python python\selftest.py 查看具体原因
pause
exit /b 1

:end
endlocal
