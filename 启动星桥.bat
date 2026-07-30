@echo off
REM 双击此文件即可在 Windows 上启动星桥，并自动打开浏览器。
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 server.py --open
) else (
  python server.py --open
)
pause
