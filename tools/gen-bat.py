# -*- coding: utf-8 -*-
"""生成 Windows 批处理启动/停止脚本，以及 Native Messaging 的宿主清单与 VBS 启动器。

为什么要用脚本生成而不是直接用编辑器写：
  1. Windows 批处理 / VBS 必须是 CRLF 行尾，LF 会让 goto 跳转失效、VBS 报语法错；
  2. 中文必须用 GBK（系统代码页 936）编码，UTF-8 在 cmd 里会被解析器吞掉半行；
  3. Native Messaging 的清单 JSON 必须是「UTF-8 无 BOM」，BOM 会让浏览器读不出。
这三点的字节要求互相冲突，用 Python 精确控制最稳。

用法：python tools/gen-bat.py
"""

def compute_ext_id(ext_dir):
    """按扩展目录算出 Chrome 会给它分配的 ID。

    规则：对「加载已解压的扩展」的**绝对路径**做 sha256，取前 16 字节，
    再把每个十六进制字符 0-f 映射成 a-p（0→a, 9→j, a→k, f→p）。

    所以 ID 是跟着路径走的 —— 别人把项目克隆到 D:\\code\\mailhub，ID 就完全
    不是我这个了。以前这里写死一个常量，等于只有我自己这台机器能连上原生消息；
    现在改成按当前目录算，谁克隆谁跑 `python tools/gen-bat.py` 都能对上。
    """
    import hashlib

    digest = hashlib.sha256(ext_dir.encode("utf-16-le")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)

# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #

START = r"""@echo off
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
"""

# --------------------------------------------------------------------------- #
# 停止
# --------------------------------------------------------------------------- #

STOP = r"""@echo off
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
"""

# --------------------------------------------------------------------------- #
# 取消自启
# --------------------------------------------------------------------------- #

UNINSTALL = r"""@echo off
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
"""

# --------------------------------------------------------------------------- #
# VBS：用隐藏窗口拉起守护进程（Run 键不能直接跑 node，否则会闪黑框）
# --------------------------------------------------------------------------- #

VBS = r"""' MailHub - start the local service daemon with no visible console window.
' Safe to copy elsewhere (e.g. into the Startup folder): it first looks for
' daemon.js next to itself, then falls back to the recorded install path.
Option Explicit
Dim fso, sh, base, root, exe, cmd, q
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)

If fso.FileExists(base & "\daemon.js") Then
  root = base
Else
  root = "__MAILHUB_NATIVE__"
End If

exe = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(exe) Then
  exe = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe")
End If
If Not fso.FileExists(exe) Then
  If fso.FileExists("__NODE_EXE__") Then exe = "__NODE_EXE__"
End If
If Not fso.FileExists(exe) Then exe = "node.exe"

cmd = q & exe & q & " " & q & root & "\daemon.js" & q
sh.CurrentDirectory = fso.GetParentFolderName(root)
sh.Run cmd, 0, False
"""

# --------------------------------------------------------------------------- #
# 开机自启：把 VBS 复制一份到「启动」文件夹。
# 相比写注册表 Run 键，这个方式更直白 —— 用户自己也能在文件夹里看到它、
# 想取消就删掉，不需要会改注册表。
# --------------------------------------------------------------------------- #

AUTOSTART = r"""@echo off
chcp 936 >nul
title 设置开机自启
cd /d "%~dp0"
setlocal

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
copy /y "%~dp0native\start-hidden.vbs" "%STARTUP%\MailHub.vbs" >nul
if errorlevel 1 goto FAIL

echo.
echo   [OK] 已设置开机自启。
echo        每次登录 Windows，邮箱助手会在后台自己起来，不弹窗口。
echo.
echo   想取消就双击「取消开机自启.bat」，
echo   或者手动删掉这个文件：
echo     %STARTUP%\MailHub.vbs
echo.
ping -n 4 127.0.0.1 >nul
exit /b 0

:FAIL
echo.
echo   [X] 复制失败，可能没有写权限。
echo.
pause
exit /b 1
"""

# --------------------------------------------------------------------------- #
# Native Messaging 宿主的入口包装。
# 浏览器只会执行「一个可执行文件」，没法带参数，所以用这个 bat 把 node 包一层。
# 这个文件的标准输出会被浏览器当成通信管道，因此里面绝对不能 echo 任何东西。
# --------------------------------------------------------------------------- #

LAUNCHER_BAT = r"""@echo off
setlocal
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not exist "%NODE%" if exist "__NODE_EXE__" set "NODE=__NODE_EXE__"
"%NODE%" "%~dp0launcher.js"
"""

# --------------------------------------------------------------------------- #
# Native Messaging 宿主清单（UTF-8 无 BOM）
# --------------------------------------------------------------------------- #

HOST_MANIFEST = {
    "name": "com.mailhub.launcher",
    "description": "MailHub local service launcher",
    "path": "",  # 运行时按实际路径填
    "type": "stdio",
    "allowed_origins": [],  # 运行时填入本机扩展 ID
}


def write_crlf_bytes(path, text, encoding):
    body = text.replace("\r\n", "\n").replace("\n", "\r\n")
    with open(path, "wb") as f:
        f.write(body.encode(encoding))
    return body


def find_node():
    """找这台机器上真正的 node.exe。

    不能直接用 shutil.which("node")：如果这个生成脚本运行在一个自带了
    node 的环境里（比如某些 IDE 内置的运行时），which 会返回那个临时路径，
    写进启动脚本后一旦那个环境被清理，开机自启就再也起不来了。
    所以这里优先按「系统/用户 PATH + 常见安装目录」去找。
    """
    import os
    import shutil

    cands = []
    for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"):
        base = os.environ.get(env)
        if not base:
            continue
        cands.append(os.path.join(base, "nodejs", "node.exe"))
        cands.append(os.path.join(base, "Programs", "nodejs", "node.exe"))

    try:
        import winreg

        for hive, key, name in (
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "Path"),
            (winreg.HKEY_CURRENT_USER, r"Environment", "Path"),
        ):
            try:
                with winreg.OpenKey(hive, key) as k:
                    val, _ = winreg.QueryValueEx(k, name)
                for part in str(val).split(";"):
                    part = part.strip()
                    if part:
                        cands.append(os.path.join(part, "node.exe"))
            except OSError:
                continue
    except ImportError:
        pass

    for c in cands:
        if c and os.path.isfile(c):
            return c
    return shutil.which("node") or ""


def main():
    import json
    import os

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    native = os.path.join(root, "native")
    os.makedirs(native, exist_ok=True)

    # 生成脚本的这台机器上 node 在哪，就顺手记下来当兜底 ——
    # 万一以后 PATH 变了（换用户、装到别的盘），启动器还能找到它。
    node_exe = find_node()

    def fill(text):
        return text.replace("__MAILHUB_NATIVE__", native).replace("__NODE_EXE__", node_exe)

    targets = [
        (os.path.join(root, "启动邮箱助手.bat"), START, "gbk"),
        (os.path.join(root, "停止邮箱助手.bat"), STOP, "gbk"),
        (os.path.join(root, "取消开机自启.bat"), UNINSTALL, "gbk"),
        # VBS 里要把「被复制到启动文件夹之后该去哪儿找 daemon.js」写死一份，
        # 否则用户一开机就找不到项目了
        (os.path.join(native, "start-hidden.vbs"), fill(VBS), "ascii"),
        (os.path.join(native, "launcher.bat"), fill(LAUNCHER_BAT), "ascii"),
    ]

    for path, text, enc in targets:
        write_crlf_bytes(path, text, enc)
        raw = open(path, "rb").read()
        crlf = raw.count(b"\r\n")
        bare = raw.count(b"\n") - crlf
        print(f"{os.path.basename(path):24s} bytes={len(raw):6d} CRLF={crlf:4d} bareLF={bare}")

    manifest = dict(HOST_MANIFEST)
    manifest["path"] = os.path.join(native, "launcher.bat")
    ext_id = compute_ext_id(os.path.join(root, "extension"))
    manifest["allowed_origins"] = [f"chrome-extension://{ext_id}/"]
    mpath = os.path.join(native, "com.mailhub.launcher.json")
    # ensure_ascii=True 保证纯 ASCII，绝对不会有 BOM 或编码歧义；
    # path 里的反斜杠由 json.dump 正常转义成 \\。
    with open(mpath, "w", encoding="utf-8", newline="\r\n") as f:
        json.dump(manifest, f, ensure_ascii=True, indent=2)
        f.write("\n")
    print(f"{os.path.basename(mpath):24s} bytes={os.path.getsize(mpath)}")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
