@echo off
setlocal

pushd "%~dp0" || exit /b 1

set "PWSH_EXE="
set "START_SCRIPT=%~dp0scripts\start-dev-visible.ps1"

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

if not exist "%START_SCRIPT%" (
  echo [ERROR] scripts\start-dev.ps1 was not found.
  pause
  popd
  exit /b 1
)

echo [INFO] Restarting dev frontend and backend for this repo...
"%PWSH_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%START_SCRIPT%" -Restart
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Failed to restart dev frontend/backend.
  pause
)

popd
exit /b %EXIT_CODE%
