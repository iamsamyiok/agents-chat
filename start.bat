@echo off
title Agents Chat
cd /d "%~dp0"

set "PORT=3456"
if not "%AGENTS_CHAT_PORT%"=="" set "PORT=%AGENTS_CHAT_PORT%"

set "NODE=%~dp0bin\node.exe"
if exist "%NODE%" goto run

where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE=node"

:run
rem 静默后台启动（无任何弹窗）：
rem 网页打开期间服务保持运行；全部页面关闭且空闲 3 分钟后自动退出，
rem 也可随时运行 stop.bat 手动停止。日志见 .data\server.log
wscript "%~dp0start-hidden.vbs" %PORT% >nul 2>nul
if not errorlevel 1 goto waitloop

rem 极老系统无 wscript 时退回最小化窗口方式
start "agents-chat-server" /min "%NODE%" "%~dp0app\server.js" --port %PORT%

:waitloop
set /a TRIES=30
where curl >nul 2>nul
if errorlevel 1 goto wait_plain

:pollloop
ping -n 2 127.0.0.1 >nul
curl -s -o nul http://localhost:%PORT%/api/health
if not errorlevel 1 goto ready
set /a TRIES-=1
if %TRIES% leq 0 goto fail
goto pollloop

:wait_plain
ping -n 9 127.0.0.1 >nul
goto ready

:ready
rem 打开浏览器后本窗口自动关闭，无需用户操作
start "" http://localhost:%PORT%
exit /b 0

:fail
echo.
echo [ERROR] Server did not start within 60 seconds.
echo.
echo Troubleshooting:
echo  1. Windows SmartScreen may have blocked bin\node.exe
echo     Right-click bin\node.exe - Properties - tick Unblock - OK
echo     Then run start.bat again
echo  2. Antivirus may have quarantined bin\node.exe - restore it
echo  3. Check log file: .data\server.log
echo.
pause
exit /b 1

:nonode
echo [ERROR] Node.js not found and bin\node.exe is missing.
echo Please re-download the full zip package.
pause
exit /b 1
