# 在后台启动本地 API 与 Vite，并通过开发租约记录进程和 tmp/run 下的可再生日志。
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
$BackendOutLog = Join-Path $RunLogDir "dev-backend.out.log"
$BackendErrLog = Join-Path $RunLogDir "dev-backend.err.log"
$FrontendOutLog = Join-Path $RunLogDir "dev-frontend.out.log"
$FrontendErrLog = Join-Path $RunLogDir "dev-frontend.err.log"

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

function Start-BackgroundCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)]
        [string]$StdOutLog,
        [Parameter(Mandatory = $true)]
        [string]$StdErrLog,
        [Parameter(Mandatory = $false)]
        [hashtable]$Environment = @{}
    )

    $previousEnvironmentValues = @{}
    foreach ($entry in $Environment.GetEnumerator()) {
        $previousEnvironmentValues[$entry.Key] = [System.Environment]::GetEnvironmentVariable($entry.Key, "Process")
        [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }

    try {
        Start-Process `
            -FilePath $FilePath `
            -ArgumentList $ArgumentList `
            -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden `
            -RedirectStandardOutput $StdOutLog `
            -RedirectStandardError $StdErrLog `
            -PassThru
    } finally {
        foreach ($entry in $Environment.GetEnumerator()) {
            [System.Environment]::SetEnvironmentVariable($entry.Key, $previousEnvironmentValues[$entry.Key], "Process")
        }
    }
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

function Show-LogsAndThrow {
    param([string]$Message)

    Write-Host "[ERROR] $Message"
    foreach ($logPath in @($BackendOutLog, $BackendErrLog, $FrontendOutLog, $FrontendErrLog)) {
        if (Test-Path $logPath) {
            Write-Host "--- $([System.IO.Path]::GetFileName($logPath)) ---"
            Get-Content $logPath -Tail 120
        }
    }

    throw $Message
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $RunLogDir | Out-Null

$PnpmPath = Resolve-Executable -PreferredPath "C:\nvm4w\nodejs\pnpm.cmd" -CommandName "pnpm.cmd"
$CargoPath = Resolve-Executable -PreferredPath "$env:USERPROFILE\.cargo\bin\cargo.exe" -CommandName "cargo.exe"

$lease = $null
$started = $false
try {
    $lease = Enter-DevLease `
        -RootPath $RepoRoot `
        -Mode "hidden" `
        -FrontendPort $FrontendPort `
        -BackendPort $BackendPort `
        -Restart:$Restart
    Assert-DevPortsAvailable -Ports @($FrontendPort, $BackendPort)

    $backendProcess = Start-BackgroundCommand `
        -WorkingDirectory $RepoRoot `
        -FilePath $CargoPath `
        -ArgumentList @("run", "--manifest-path", "src-tauri/Cargo.toml", "--example", "inputApi") `
        -StdOutLog $BackendOutLog `
        -StdErrLog $BackendErrLog `
        -Environment @{ PORT = "$BackendPort" }
    Add-DevLeaseProcess -Lease $lease -Role "backend" -Process $backendProcess

    $frontendProcess = Start-BackgroundCommand `
        -WorkingDirectory $RepoRoot `
        -FilePath $PnpmPath `
        -ArgumentList @("run", "dev:ui", "--", "--host", "127.0.0.1", "--port", "$FrontendPort") `
        -StdOutLog $FrontendOutLog `
        -StdErrLog $FrontendErrLog
    Add-DevLeaseProcess -Lease $lease -Role "frontend" -Process $frontendProcess

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

        if ($backendProcess.HasExited -and -not $backendReady) {
            Show-LogsAndThrow "Backend process exited before health check passed."
        }

        if ($frontendProcess.HasExited -and -not $frontendReady) {
            Show-LogsAndThrow "Frontend process exited before readiness check passed."
        }

        if ($frontendReady -and $backendReady) {
            break
        }
    }

    if (-not ($frontendReady -and $backendReady)) {
        Show-LogsAndThrow "Frontend/backend failed to become healthy within $TimeoutSeconds seconds."
    }

    Set-DevLeaseState -Lease $lease -State "running"
    $started = $true
    Write-Host "[OK] Dev frontend started at http://127.0.0.1:$FrontendPort"
    Write-Host "[OK] Dev backend started at http://127.0.0.1:$BackendPort"
    Write-Host "[INFO] Frontend launcher pid=$($frontendProcess.Id)"
    Write-Host "[INFO] Backend launcher pid=$($backendProcess.Id)"
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
