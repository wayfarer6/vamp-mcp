@echo off
setlocal
set "TARGET=C:\ProgramData\RPA-Recorder-Setup"
if not exist "%TARGET%" mkdir "%TARGET%"
xcopy /e /i /y "%~dp0*" "%TARGET%\" >nul
if errorlevel 1 exit /b 1
rem Install for vboxuser on its first desktop login, never in the SYSTEM profile.
set "STARTUP=C:\Users\vboxuser\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
if not exist "%STARTUP%" mkdir "%STARTUP%"
(echo @call "C:\ProgramData\RPA-Recorder-Setup\setup-win.cmd") > "%STARTUP%\RPA-Recorder-Setup.cmd"
