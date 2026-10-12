@echo off
chcp 65001 >nul
title STARHERD - BUILD INSTALLER
cd /d "%~dp0"

echo.
echo   STARHERD  /  打包安装程序 (含选目录安装 + 桌面快捷方式)
echo   ------------------------------------------------------------
echo   产物: dist_exe\Starherd_安装程序.exe
echo   说明: 依赖 dist_exe\Starherd.exe 作为 payload；没有就先跑 build_exe.bat
echo.

if not exist "dist_exe\Starherd.exe" (
  echo   [ERROR] 找不到 dist_exe\Starherd.exe
  echo           请先运行 build_exe.bat 打包游戏本体。
  echo.
  pause
  exit /b 1
)

set "PY=python"
where python >nul 2>nul || set "PY=py -3"

%PY% python\build_installer.py %*
if errorlevel 1 (
  echo.
  echo   [FAIL] 安装程序打包或自检未通过。
  echo.
  pause
  exit /b 1
)

echo.
echo   [OK] 产物: %cd%\dist_exe\Starherd_安装程序.exe
echo        静默自检已通过（选目录安装 / 桌面快捷方式 / 开始菜单 / 卸载）
echo.
pause
