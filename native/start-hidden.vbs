' MailHub - start the local service daemon with no visible console window.
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
  root = "D:\email-hub\native"
End If

exe = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(exe) Then
  exe = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe")
End If
If Not fso.FileExists(exe) Then
  If fso.FileExists("D:\nodejs\node.exe") Then exe = "D:\nodejs\node.exe"
End If
If Not fso.FileExists(exe) Then exe = "node.exe"

cmd = q & exe & q & " " & q & root & "\daemon.js" & q
sh.CurrentDirectory = fso.GetParentFolderName(root)
sh.Run cmd, 0, False
