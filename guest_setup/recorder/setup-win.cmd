@echo off
setlocal
cd /d "%~dp0"
set "RPAPY=%LocalAppData%\Programs\Python\Python312\python.exe"
if not exist "%RPAPY%" (
  winget install --exact --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
  if errorlevel 1 exit /b 1
)
"%RPAPY%" setup-user.py
if errorlevel 1 exit /b 1
exit /b 0
