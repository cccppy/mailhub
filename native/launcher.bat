@echo off
setlocal
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not exist "%NODE%" if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
"%NODE%" "%~dp0launcher.js"
