@echo off
setlocal

pushd "%~dp0" || exit /b 1

set "APP_EXE=%CD%\src-tauri\target\debug\app.exe"
set "PNPM_CMD="

if exist "C:\nvm4w\nodejs\pnpm.cmd" (
  set "PNPM_CMD=C:\nvm4w\nodejs\pnpm.cmd"
)

if not defined PNPM_CMD (
  for %%I in (pnpm.cmd) do set "PNPM_CMD=%%~$PATH:I"
)

if not defined PNPM_CMD (
  echo [ERROR] pnpm.cmd was not found.
  pause
  popd
  exit /b 1
)

for %%I in ("%PNPM_CMD%") do set "PNPM_DIR=%%~dpI"
set "PATH=%PNPM_DIR%;%PATH%"

if exist "%APP_EXE%" (
  echo [INFO] Launching existing desktop app...
  start "" "%APP_EXE%"
  popd
  exit /b 0
)

echo [INFO] Desktop app not found. Building now...
call "%PNPM_CMD%" run build:desktop
if errorlevel 1 (
  echo [ERROR] build:desktop failed.
  pause
  popd
  exit /b 1
)

if not exist "%APP_EXE%" (
  echo [ERROR] Build finished but app.exe was not found.
  pause
  popd
  exit /b 1
)

echo [INFO] Build complete. Launching desktop app...
start "" "%APP_EXE%"
popd
exit /b 0
