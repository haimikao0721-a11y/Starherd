@echo off
chcp 65001 >nul 2>nul
setlocal
title STARHERD
cd /d "%~dp0"

set "EXE=dist_exe\Starherd.exe"
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "C:\Users\a\AppData\Local\Programs\Python\Python313\python.exe" set "PY=C:\Users\a\AppData\Local\Programs\Python\Python313\python.exe"

echo ==========================================================
echo   STARHERD  /  牧星者
echo ==========================================================

if exist "%EXE%" goto runexe
echo [1/2] 未找到 %EXE%，改用 Python 源码模式
goto runpy

:runexe
echo [1/2] 启动打包版: %EXE%
"%EXE%"
if errorlevel 1 goto fallback
echo [OK] 游戏窗口已关闭，退出码 0
goto end

:fallback
echo [WARN] 打包版退出码 %errorlevel%，回退到 Python 源码模式...

:runpy
if not defined PY goto nopython
echo [2/2] 启动 Python 源码模式: %PY% python\mission_control.py
"%PY%" "python\mission_control.py"
if errorlevel 1 goto runerr
echo [OK] 游戏窗口已关闭，退出码 0
goto end

:nopython
echo [ERROR] 找不到 python。请安装 Python 3.13，或先运行 build_exe.bat 生成 dist_exe\Starherd.exe
pause
exit /b 1

:runerr
echo [ERROR] 启动失败，退出码 %errorlevel%
echo         可先跑 python python\selftest.py 查看具体原因
pause
exit /b 1

:end
endlocal
