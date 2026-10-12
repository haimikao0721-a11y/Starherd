@echo off
chcp 65001 >nul 2>nul
setlocal
title STARHERD - BUILD EXE
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "C:\Users\a\AppData\Local\Programs\Python\Python313\python.exe" set "PY=C:\Users\a\AppData\Local\Programs\Python\Python313\python.exe"

echo ==========================================================
echo   STARHERD  /  打包 EXE (+ 冒烟验证)
echo ==========================================================
echo   产物: dist_exe\Starherd.exe
echo   打包约 2-6 分钟，请勿关闭本窗口。
echo.

if not defined PY goto nopython
if not exist "python\build_exe.py" goto noscript

"%PY%" "python\build_exe.py" --smoke
if errorlevel 1 goto buildfail

echo.
echo [OK] 打包与冒烟全部通过: dist_exe\Starherd.exe
pause
exit /b 0

:nopython
echo [ERROR] 找不到 python。请安装 Python 3.13
pause
exit /b 1

:noscript
echo [ERROR] 找不到 python\build_exe.py
pause
exit /b 1

:buildfail
echo.
echo [ERROR] 打包或冒烟失败，退出码 %errorlevel%
echo         请向上翻看 PyInstaller / smoke 的输出定位原因。
pause
exit /b 1
