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
echo ==============================================
echo   Agents Chat  -  pi agents group chat
echo   URL : http://localhost:%PORT%
echo ==============================================
echo.
echo Starting server, please wait...

start "agents-chat-server" /min "%NODE%" "%~dp0app\server.js" --port %PORT%

where curl >nul 2>nul
if errorlevel 1 goto wait_plain

set /a TRIES=30
:waitloop
ping -n 2 127.0.0.1 >nul
curl -s -o nul http://localhost:%PORT%/api/health
if not errorlevel 1 goto ready
set /a TRIES-=1
if %TRIES% leq 0 goto fail
goto waitloop

:wait_plain
ping -n 9 127.0.0.1 >nul
goto ready

:ready
echo.
echo Server ready. Opening browser...
start "" http://localhost:%PORT%
echo.
echo OK. You can close this window now.
echo The server runs in the minimized "agents-chat-server" window.
echo To stop: run stop.bat  (log: .data\server.log)
echo.
pause
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
