@echo off
rem VAMP guest setup bootstrap for cmd.exe, served by the host script server on port 8421.
rem   curl.exe -fsSL http://10.0.2.2:8421/setup-win.cmd -o "%TEMP%\setup-win.cmd" && "%TEMP%\setup-win.cmd"
setlocal
if "%VAMP_SCRIPT_BASE_URL%"=="" set "VAMP_SCRIPT_BASE_URL=http://10.0.2.2:8421"
powershell -NoProfile -ExecutionPolicy Unrestricted -Command "irm %VAMP_SCRIPT_BASE_URL%/setup.ps1 | iex"
exit /b %errorlevel%
