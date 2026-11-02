@echo off
chcp 936 >nul
title 停止邮箱助手
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo.
echo   正在停止邮箱助手...

rem 先立个「别重启」的牌子，守护进程看到它就不会再把服务拉起来
if not exist "server\data" mkdir "server\data"
echo stop> "server\data\stop.flag"

rem 先停守护进程，再停服务本体，顺序反了会被守护进程立刻拉回来
if exist "server\data\daemon.pid" (
  set /p DPID=<"server\data\daemon.pid"
  taskkill /PID !DPID! /F >nul 2>nul
  del "server\data\daemon.pid" >nul 2>nul
)

if exist "server\data\server.pid" (
  set /p SPID=<"server\data\server.pid"
  taskkill /PID !SPID! /F >nul 2>nul
  del "server\data\server.pid" >nul 2>nul
)

taskkill /FI "WINDOWTITLE eq MailHub Service*" /F >nul 2>nul

echo   已停止。
echo.
echo   注意：「开机自启」还留着，下次开机服务照样会自己起来。
echo   想彻底不再自动启动，双击「取消开机自启.bat」。
echo.
ping -n 3 127.0.0.1 >nul
exit /b 0
