# 在可见命令窗口启动本地 API 与 Vite，并通过开发租约统一管理端口和运行日志。
param(
    [int]$FrontendPort = 5777,
    [int]$BackendPort = 5559,
    [int]$TimeoutSeconds = 90,
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot "tmp\run"
$RunLogDir = Join-Path $LogDir (Get-Date -Format "yyyyMMdd-HHmmss")
$BackendLog = Join-Path $RunLogDir "dev-backend.visible.log"
$FrontendLog = Join-Path $RunLogDir "dev-frontend.visible.log"

. (Join-Path $PSScriptRoot "dev-lifecycle.ps1")

function Resolve-Executable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PreferredPath,
        [Parameter(Mandatory = $true)]
        [string]$CommandName
    )

    if (Test-Path $PreferredPath) {
        return $PreferredPath
    }

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw "$CommandName was not found."
}

function Test-FrontendReady {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port" -UseBasicParsing -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Test-BackendReady {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $RunLogDir | Out-Null

$CmdPath = Resolve-Executable -PreferredPath "$env:SystemRoot\System32\cmd.exe" -CommandName "cmd.exe"
$PnpmPath = Resolve-Executable -PreferredPath "C:\nvm4w\nodejs\pnpm.cmd" -CommandName "pnpm.cmd"
$CargoPath = Resolve-Executable -PreferredPath "$env:USERPROFILE\.cargo\bin\cargo.exe" -CommandName "cargo.exe"

$lease = $null
$started = $false
try {
    $lease = Enter-DevLease `
        -RootPath $RepoRoot `
        -Mode "visible" `
        -FrontendPort $FrontendPort `
        -BackendPort $BackendPort `
        -Restart:$Restart
    Assert-DevPortsAvailable -Ports @($FrontendPort, $BackendPort)

    $backendTitle = "api_token backend :$BackendPort"
    $frontendTitle = "api_token frontend :$FrontendPort"
    $backendCommand = @(
        "title $backendTitle",
        "chcp 65001>nul",
        "set NO_COLOR=1",
        "set FORCE_COLOR=0",
        "set CI=1",
        "set TERM=dumb",
        "cd /d `"$RepoRoot`"",
        "echo [INFO] Backend window attached to $RepoRoot",
        "echo [INFO] Backend log: $BackendLog",
        "echo [INFO] Starting inputApi on http://127.0.0.1:$BackendPort",
        "set PORT=$BackendPort",
        "`"$CargoPath`" run --manifest-path src-tauri/Cargo.toml --example inputApi 1>>`"$BackendLog`" 2>>&1"
    ) -join " && "

    $frontendCommand = @(
        "title $frontendTitle",
        "chcp 65001>nul",
        "set NO_COLOR=1",
        "set FORCE_COLOR=0",
        "set CI=1",
        "set TERM=dumb",
        "cd /d `"$RepoRoot`"",
        "echo [INFO] Frontend window attached to $RepoRoot",
        "echo [INFO] Frontend log: $FrontendLog",
        "echo [INFO] Starting Vite on http://127.0.0.1:$FrontendPort",
        "`"$PnpmPath`" run dev:ui -- --host 127.0.0.1 --port $FrontendPort 1>>`"$FrontendLog`" 2>>&1"
    ) -join " && "

    $backendWindow = Start-Process `
        -FilePath $CmdPath `
        -ArgumentList @("/k", $backendCommand) `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Normal `
        -PassThru
    Add-DevLeaseProcess -Lease $lease -Role "backend" -Process $backendWindow

    $frontendWindow = Start-Process `
        -FilePath $CmdPath `
        -ArgumentList @("/k", $frontendCommand) `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Normal `
        -PassThru
    Add-DevLeaseProcess -Lease $lease -Role "frontend" -Process $frontendWindow

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $frontendReady = $false
    $backendReady = $false

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2

        if (-not $backendReady) {
            $backendReady = Test-BackendReady -Port $BackendPort
        }

        if (-not $frontendReady) {
            $frontendReady = Test-FrontendReady -Port $FrontendPort
        }

        if ($frontendReady -and $backendReady) {
            break
        }
    }

    if (-not ($frontendReady -and $backendReady)) {
        throw "Frontend/backend failed to become healthy within $TimeoutSeconds seconds. Check the visible backend/frontend windows."
    }

    Set-DevLeaseState -Lease $lease -State "running"
    $started = $true
    Write-Host "[OK] Dev frontend started at http://127.0.0.1:$FrontendPort"
    Write-Host "[OK] Dev backend started at http://127.0.0.1:$BackendPort"
    Write-Host "[INFO] Frontend window pid=$($frontendWindow.Id)"
    Write-Host "[INFO] Backend window pid=$($backendWindow.Id)"
    Write-Host "[INFO] Logs=$RunLogDir"
} finally {
    if ($lease -and -not $started) {
        try {
            Stop-DevLeaseProcesses -Lease $lease
        } catch {
            Write-Warning $_.Exception.Message
        }
        Remove-DevLease -Lease $lease
    }
}
