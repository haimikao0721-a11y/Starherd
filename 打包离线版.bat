@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================================
echo   牧星者 - 打包单文件离线版
echo   产物：dist_offline\Starherd_离线单文件版.html
echo   特性：不需要 Python 宿主、不需要联网、不需要装任何环境
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] 未检测到 node，跳过前端构建（沿用现有 dist\app.js）
) else (
  echo [1/3] 构建前端 …
  call node tools\build.mjs || goto :fail
)

echo [2/3] 打包离线单文件 …
python python\build_offline.py || goto :fail

echo [3/3] 验收（file:// 直接打开，检查素材/关卡/物理/报错）…
python tools\verify_offline.py
if errorlevel 1 (
  echo.
  echo [警告] 离线段验收未全部通过，请查看上面的输出。
  pause
  exit /b 1
)

echo.
echo 完成。把下面这个文件复制到任何电脑、双击即可游玩：
echo   %cd%\dist_offline\Starherd_离线单文件版.html
echo.
pause
exit /b 0

:fail
echo.
echo [失败] 打包过程中出错。
pause
exit /b 1
