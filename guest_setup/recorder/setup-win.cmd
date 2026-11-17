@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "%~dp0setup.ps1"
exit /b %ERRORLEVEL%
