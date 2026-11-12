@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\apk\build.ps1" %*
exit /b %errorlevel%
