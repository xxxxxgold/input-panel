@echo off
setlocal

pushd "%~dp0" || exit /b 1

set "PWSH_EXE="

if exist "C:\Program Files\PowerShell\7\pwsh.exe" (
  set "PWSH_EXE=C:\Program Files\PowerShell\7\pwsh.exe"
) else (
  for %%I in (pwsh.exe) do set "PWSH_EXE=%%~$PATH:I"
)

if not defined PWSH_EXE (
  echo [ERROR] pwsh.exe was not found.
  pause
  popd
  exit /b 1
)

"%PWSH_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dev.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  pause
)

popd
exit /b %EXIT_CODE%
