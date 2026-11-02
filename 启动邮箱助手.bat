@echo off
chcp 936 >nul
title MailHub 邮箱助手
cd /d "%~dp0"

echo.
echo   ==========================================
echo      邮箱助手 MailHub
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "server\node_modules" (
  echo   第一次运行，正在安装需要的东西，大概 1 分钟...
  echo.
  call npm --prefix server install --no-audit --no-fund
  if errorlevel 1 goto NPMFAIL
  echo.
)

rem ------------------------------------------------------------------
rem  顺手把「开机自启 + 点图标自动拉起」装好。
rem  重复执行没有任何副作用，所以放在每次启动时都跑一遍，
rem  这样用户换电脑、重装系统之后只要再点一次这个文件就全恢复了。
rem ------------------------------------------------------------------
call :REGISTER

netstat -ano | findstr /C:":8787 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 goto READY

echo   正在启动服务（在后台，不会弹黑窗口）...
start "" wscript.exe "%~dp0native\start-hidden.vbs"

set /a WAITED=0
:WAIT
netstat -ano | findstr /C:":8787 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 goto READY
set /a WAITED+=1
if %WAITED% GEQ 20 goto SLOW
ping -n 1 -w 500 127.0.0.1 >nul
goto WAIT

rem VBS 走不通时的第二条路：直接开一个最小化窗口把守护进程跑起来。
rem 两条路都失败才算真的起不来。
:SLOW
echo   换一种方式再试一次...
start "MailHub Service" /min /d "%~dp0" node native\daemon.js
set /a WAITED=0
:WAIT2
netstat -ano | findstr /C:":8787 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 goto READY
set /a WAITED+=1
if %WAITED% GEQ 20 goto FAILED
ping -n 1 -w 500 127.0.0.1 >nul
goto WAIT2

:FAILED
echo.
echo   [!] 服务没能起来。先看下面这个文件里最后几行写了什么：
echo       server\data\service.log
echo.
echo       最常见的原因是 8787 端口被别的程序占用了，
echo       或者电脑上还没装 Node.js。
echo.
pause
goto :eof

:READY
echo.
echo   [OK] 服务已就绪。
echo.
echo   以后不用再双击这个文件了：
echo     - 开机后服务会自动在后台起来；
echo     - 直接点浏览器右上角的 MailHub 图标就能用；
echo     - 万一服务被关掉了，点图标时插件也会自动把它拉起来。
goto FIRSTTIME

:FIRSTTIME
if exist ".plugin-installed" goto DONE

echo.
echo   ------------------------------------------
echo   还要做一件事：把插件装进浏览器（只做一次）
echo   ------------------------------------------
echo.
echo    1. 地址栏输入 edge://extensions 然后回车
echo       （Chrome 就输入 chrome://extensions）
echo    2. 右上角打开「开发者模式」开关
echo    3. 点左上角「加载已解压的扩展程序」
echo    4. 在选文件夹的窗口里直接按 Ctrl+V，再回车
echo.
echo   插件文件夹的路径已经复制到剪贴板，第 4 步粘贴就行：
echo     %~dp0extension
echo.
echo %~dp0extension| clip
echo   * 装好之后，点浏览器右上角那个蓝色信封图标就能用了。
echo.

:DONE
if not exist ".plugin-installed" echo ok> ".plugin-installed"
echo.
echo   （这个窗口 10 秒后自动关闭，服务在后台继续跑，不用管它）
ping -n 11 127.0.0.1 >nul
goto :eof

rem ------------------------------------------------------------------
rem  注册开机自启 + Native Messaging 宿主（只写 HKCU，不需要管理员）
rem ------------------------------------------------------------------
:REGISTER
rem 先按「当前这个文件夹」重算一遍宿主清单。
rem 清单里的宿主路径是绝对路径，扩展 ID 又是由扩展目录路径算出来的 ——
rem 两样都跟位置绑定。项目被挪到别的目录、或者别人克隆到自己的盘，
rem 旧清单就会对不上，表现是「点图标毫无反应」。这里现算一份，双击一次即修好。
node "%~dp0tools\write-host.js" >nul 2>nul
set "HOSTJSON=%~dp0native\com.mailhub.launcher.json"
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mailhub.launcher" /ve /t REG_SZ /d "%HOSTJSON%" /f >nul 2>nul
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mailhub.launcher" /ve /t REG_SZ /d "%HOSTJSON%" /f >nul 2>nul
rem 开机自启准备两条路：注册表 Run 键最稳；「启动」文件夹里的那份用户能自己看见、自己删
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MailHubService /t REG_SZ /d "wscript.exe \"%~dp0native\start-hidden.vbs\"" /f >nul 2>nul
copy /y "%~dp0native\start-hidden.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MailHub.vbs" >nul 2>nul
goto :eof

:NONODE
echo   [X] 电脑上没装 Node.js
echo.
echo       去 https://nodejs.org 下载 LTS 版本，一路「下一步」装完，
echo       然后关掉这个窗口，重新双击本文件。
echo.
pause
exit /b 1

:NPMFAIL
echo.
echo   [X] 依赖安装失败，多半是网络问题。
echo       再双击一次本文件重试；还不行就换个网络环境。
echo.
pause
exit /b 1
