@echo off
title Agents Chat - Stop
echo Stopping Agents Chat server...
taskkill /fi "WINDOWTITLE eq agents-chat-server*" >nul 2>nul
echo Done.
echo If the browser page is still open, just close it.
pause
