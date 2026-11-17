@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Installs the RPA recorder for the signed-in desktop user.
rem Python 3.11 or newer is required; 3.11, 3.12, 3.13, 3.14 and 3.15+ all work.
rem An existing interpreter is reused and one is installed only when none qualifies.
set "RPAPY="

call :scan
if defined RPAPY goto :run

echo No Python 3.11+ found. Installing Python 3.15 with tkinter...
call :install 3.15
call :scan
if defined RPAPY goto :run

echo winget did not produce Python 3.15. Installing Python 3.12 instead...
call :install 3.12
call :scan
if defined RPAPY goto :run

echo Python 3.11 or newer (3.11 through 3.15+) with tkinter is required.
echo Install it from https://www.python.org/downloads/ and run setup-win.cmd again.
exit /b 1

:run
echo Using "%RPAPY%"
"%RPAPY%" setup-user.py
if errorlevel 1 exit /b 1
exit /b 0

:install
where winget >nul 2>&1
if errorlevel 1 (
  echo winget is not available on this Windows installation.
  exit /b 0
)
winget install --exact --id Python.Python.%1 --scope user --accept-package-agreements --accept-source-agreements
exit /b 0

:scan
rem 1) A usable interpreter already on PATH.
for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined RPAPY call :check "%%P"
rem 2) Per-user and machine-wide python.org installs, newest first.
for %%V in (315 314 313 312 311) do if not defined RPAPY call :check "%LocalAppData%\Programs\Python\Python%%V\python.exe"
for %%V in (315 314 313 312 311) do if not defined RPAPY call :check "%ProgramFiles%\Python\Python%%V\python.exe"
for %%V in (315 314 313 312 311) do if not defined RPAPY call :check "C:\Python%%V\python.exe"
exit /b 0

:check
if defined RPAPY exit /b 0
if not exist "%~1" exit /b 0
rem The Microsoft Store alias opens the Store instead of running scripts.
echo %~1 | find /i "WindowsApps" >nul
if not errorlevel 1 exit /b 0
"%~1" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if errorlevel 1 exit /b 0
set "RPAPY=%~1"
exit /b 0
