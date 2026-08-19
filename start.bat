@echo off
title Agents Chat
chcp 65001 >nul
cd /d "%~dp0"

set "PORT=3456"
if not "%AGENTS_CHAT_PORT%"=="" set "PORT=%AGENTS_CHAT_PORT%"

set "NODE=%~dp0bin\node.exe"
if exist "%NODE%" goto run

where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE=node"

:run
where curl >nul 2>nul
if errorlevel 1 goto wait_no_curl

rem ---- 就绪探测：页面内容含 PAGE_VERSION 标记 = 本程序的服务已就绪 ----
rem --noproxy 防止系统代理环境变量劫持 localhost 探测
curl -s -m 5 --noproxy "*" http://localhost:%PORT%/ 2>nul | findstr /C:"PAGE_VERSION" >nul 2>nul
if not errorlevel 1 goto ready

rem ---- 端口被其他程序占用（有响应但内容对不上）：自动换相邻端口 ----
curl -s -o nul -m 5 --noproxy "*" http://localhost:%PORT%/ >nul 2>nul
if errorlevel 1 goto startsvr
echo 端口 %PORT% 被其他程序占用，正在自动换用相邻端口...
set /a PICK=0
:pickport
set /a PICK+=1
if %PICK% gtr 9 goto portfail
set /a PORT+=1
curl -s -o nul -m 2 --noproxy "*" http://localhost:%PORT%/ >nul 2>nul
if not errorlevel 1 goto pickport
goto startsvr

:startsvr
rem 静默后台启动（无任何弹窗）：网页打开期间服务保持运行；
rem 全部页面关闭且空闲约 1 分钟后自动退出，也可随时运行 stop.bat 手动停止
wscript "%~dp0start-hidden.vbs" %PORT% >nul 2>nul
if errorlevel 1 goto fallback

echo 正在启动服务（首次启动可能需几十秒，请稍候）...
set /a TRIES=25
:poll1
ping -n 3 127.0.0.1 >nul
curl -s -m 5 --noproxy "*" http://localhost:%PORT%/ 2>nul | findstr /C:"PAGE_VERSION" >nul 2>nul
if not errorlevel 1 goto ready
set /a TRIES-=1
if %TRIES% leq 0 goto heal
goto poll1

:fallback
rem 极老系统无 wscript 时退回最小化窗口方式
start "agents-chat-server" /min "%NODE%" "%~dp0app\server.js" --port %PORT%
set /a TRIES=25
:poll2
ping -n 3 127.0.0.1 >nul
curl -s -m 5 --noproxy "*" http://localhost:%PORT%/ 2>nul | findstr /C:"PAGE_VERSION" >nul 2>nul
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
set /a TRIES=15

:poll3
ping -n 3 127.0.0.1 >nul
curl -s -m 5 --noproxy "*" http://localhost:%PORT%/ 2>nul | findstr /C:"PAGE_VERSION" >nul 2>nul
if not errorlevel 1 goto ready
set /a TRIES-=1
if %TRIES% leq 0 goto fail
goto poll3

:wait_no_curl
rem 无 curl 的老系统：启动服务后固定等待几秒直接开页面
wscript "%~dp0start-hidden.vbs" %PORT% >nul 2>nul
ping -n 9 127.0.0.1 >nul
goto ready

:ready
rem 打开浏览器后本窗口自动关闭，无需用户操作
start "" "http://localhost:%PORT%/"
exit /b 0

:portfail
echo.
echo [ERROR] 端口 %PORT% 及相邻端口均被其他程序占用。
echo 可设置系统环境变量 AGENTS_CHAT_PORT 指定一个空闲端口后重新运行 start.bat。
echo.
pause
exit /b 1

:fail
echo.
echo [ERROR] 服务未能在约 90 秒内启动完成。
echo.
echo 排查建议：
echo  1. Windows SmartScreen 可能拦截了 bin\node.exe：
echo     右键 bin\node.exe - 属性 - 勾选「解除锁定」- 确定，再重新运行 start.bat
echo  2. 杀毒软件可能隔离了 bin\node.exe：恢复并加入信任后重试
echo  3. 查看日志文件：.data\server.log
echo.
pause
exit /b 1

:nonode
echo [ERROR] 未找到 Node.js（bin\node.exe 缺失且系统未安装 node）。
echo 请重新下载完整 zip 包。
pause
exit /b 1
