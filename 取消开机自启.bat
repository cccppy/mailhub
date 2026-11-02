@echo off
chcp 936 >nul
title 取消开机自启
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo.
echo   正在取消开机自启...

rem 1. 去掉「启动」文件夹里的自启脚本
set "AUTO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MailHub.vbs"
if exist "%AUTO%" del "%AUTO%" >nul 2>nul
rem 早期版本可能写成注册表 Run 键，一并清掉
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MailHubService /f >nul 2>nul

rem 2. 去掉「点图标自动拉起服务」的通道
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mailhub.launcher" /f >nul 2>nul
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mailhub.launcher" /f >nul 2>nul

rem 3. 顺手把正在跑的服务也停掉
if not exist "server\data" mkdir "server\data"
echo stop> "server\data\stop.flag"

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

echo.
echo   已取消。以后开机会自动启动这件事不会再发生了。
echo   想恢复的话，双击一次「启动邮箱助手.bat」就会重新装回来。
echo.
ping -n 4 127.0.0.1 >nul
exit /b 0
