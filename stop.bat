@echo off
title Agents Chat - Stop
echo Stopping Agents Chat server...

rem 优先按命令行特征结束本程序的 node 进程（静默启动无窗口标题）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node' -and $_.CommandLine -like '*app\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

rem 兜底：老版最小化窗口方式启动的进程
taskkill /fi "WINDOWTITLE eq agents-chat-server*" >nul 2>nul

echo Done.
echo If the browser page is still open, just close it.
pause
