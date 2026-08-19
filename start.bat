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
rem 已有服务在跑：直接打开页面即可（上次会话的进程仍存活）
where curl >nul 2>nul
if errorlevel 1 goto startsvr
curl -s -o nul -m 2 http://localhost:%PORT%/api/health
if not errorlevel 1 goto ready

:startsvr
rem 静默后台启动（无任何弹窗）：网页打开期间服务保持运行；
rem 全部页面关闭且空闲约 1 分钟后自动退出，也可随时运行 stop.bat 手动停止
wscript "%~dp0start-hidden.vbs" %PORT% >nul 2>nul
if errorlevel 1 goto fallback

rem 等待服务就绪（最多约 20 秒）
set /a TRIES=10
where curl >nul 2>nul
if errorlevel 1 goto wait_plain

:poll1
ping -n 3 127.0.0.1 >nul
curl -s -o nul -m 2 http://localhost:%PORT%/api/health
if not errorlevel 1 goto ready
set /a TRIES-=1
if %TRIES% leq 0 goto heal
goto poll1

:fallback
rem 极老系统无 wscript 时退回最小化窗口方式
start "agents-chat-server" /min "%NODE%" "%~dp0app\server.js" --port %PORT%
set /a TRIES=10
where curl >nul 2>nul
if errorlevel 1 goto wait_plain

:poll2
ping -n 3 127.0.0.1 >nul
curl -s -o nul -m 2 http://localhost:%PORT%/api/health
if not errorlevel 1 goto ready
set /a TRIES-=1
if %TRIES% leq 0 goto fail
goto poll2

:heal
rem 服务一直没起来：大概率是旧版本残留的隐藏进程占着端口，清掉后重启一次
echo 服务未就绪，正在清理可能残留的旧进程并重试...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node' -and $_.CommandLine -like '*app\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
ping -n 3 127.0.0.1 >nul
wscript "%~dp0start-hidden.vbs" %PORT% >nul 2>nul
set /a TRIES=20

:poll3
ping -n 3 127.0.0.1 >nul
curl -s -o nul -m 2 http://localhost:%PORT%/api/health
if not errorlevel 1 goto ready
set /a TRIES-=1
if %TRIES% leq 0 goto fail
goto poll3

:wait_plain
rem 无 curl 的老系统：固定等几秒直接开页面
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
