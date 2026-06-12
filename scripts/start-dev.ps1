param(
    [int]$FrontendPort = 5777,
    [int]$BackendPort = 5559,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot ".tmp\run"
$RunLogDir = Join-Path $LogDir (Get-Date -Format "yyyyMMdd-HHmmss")
$BackendOutLog = Join-Path $RunLogDir "dev-backend.out.log"
$BackendErrLog = Join-Path $RunLogDir "dev-backend.err.log"
$FrontendOutLog = Join-Path $RunLogDir "dev-frontend.out.log"
$FrontendErrLog = Join-Path $RunLogDir "dev-frontend.err.log"

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

function Stop-DevProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $portOwners = @(
        Get-NetTCPConnection -LocalPort $Ports -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )

    $allProcesses = @(Get-CimInstance Win32_Process)
    $processById = @{}
    $childrenByParentId = @{}
    foreach ($process in $allProcesses) {
        $pidValue = [int]$process.ProcessId
        $parentPid = [int]$process.ParentProcessId
        $processById[$pidValue] = $process
        if (-not $childrenByParentId.ContainsKey($parentPid)) {
            $childrenByParentId[$parentPid] = [System.Collections.Generic.List[int]]::new()
        }
        $childrenByParentId[$parentPid].Add($pidValue)
    }

    $candidateProcessIds = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($processId in $portOwners) {
        if ($processId -and $processId -ne $PID) {
            [void]$candidateProcessIds.Add([int]$processId)
        }
    }

    $matchingProcesses = $allProcesses |
        Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -and
            $_.CommandLine -like "*$RootPath*" -and
            (
                $_.CommandLine -match "dev_api" -or
                $_.CommandLine -match "vite" -or
                $_.CommandLine -match "dev:ui" -or
                $_.CommandLine -match "dev:web"
            )
        }

    foreach ($process in $matchingProcesses) {
        [void]$candidateProcessIds.Add([int]$process.ProcessId)
    }

    $trackedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    foreach ($processId in $candidateProcessIds) {
        $queue.Enqueue($processId)
    }

    while ($queue.Count -gt 0) {
        $currentProcessId = $queue.Dequeue()
        if ($currentProcessId -eq $PID -or $trackedProcessIds.Contains($currentProcessId)) {
            continue
        }

        [void]$trackedProcessIds.Add($currentProcessId)

        if ($childrenByParentId.ContainsKey($currentProcessId)) {
            foreach ($childProcessId in $childrenByParentId[$currentProcessId]) {
                if (-not $trackedProcessIds.Contains($childProcessId)) {
                    $queue.Enqueue($childProcessId)
                }
            }
        }

        if ($processById.ContainsKey($currentProcessId)) {
            $parentProcessId = [int]$processById[$currentProcessId].ParentProcessId
            if ($parentProcessId -gt 0 -and $parentProcessId -ne $PID -and $processById.ContainsKey($parentProcessId)) {
                $parentCommandLine = $processById[$parentProcessId].CommandLine
                if (
                    $parentCommandLine -and
                    (
                        $parentCommandLine -match "dev_api" -or
                        $parentCommandLine -match "vite" -or
                        $parentCommandLine -match "dev:ui" -or
                        $parentCommandLine -match "dev:web" -or
                        $parentCommandLine -match "pnpm" -or
                        $parentCommandLine -match "cargo"
                    )
                ) {
                    $queue.Enqueue($parentProcessId)
                }
            }
        }
    }

    foreach ($processId in (@($trackedProcessIds) | Sort-Object -Descending)) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
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

Stop-DevProcesses -RootPath $RepoRoot -Ports @($FrontendPort, $BackendPort)
Start-Sleep -Seconds 2

$backendProcess = Start-BackgroundCommand `
    -WorkingDirectory $RepoRoot `
    -FilePath $CargoPath `
    -ArgumentList @("run", "--manifest-path", "src-tauri/Cargo.toml", "--example", "dev_api") `
    -StdOutLog $BackendOutLog `
    -StdErrLog $BackendErrLog `
    -Environment @{ PORT = "$BackendPort" }

$frontendProcess = Start-BackgroundCommand `
    -WorkingDirectory $RepoRoot `
    -FilePath $PnpmPath `
    -ArgumentList @("run", "dev:ui", "--", "--host", "127.0.0.1", "--port", "$FrontendPort") `
    -StdOutLog $FrontendOutLog `
    -StdErrLog $FrontendErrLog

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

Write-Host "[OK] Dev frontend started at http://127.0.0.1:$FrontendPort"
Write-Host "[OK] Dev backend started at http://127.0.0.1:$BackendPort"
Write-Host "[INFO] Frontend launcher pid=$($frontendProcess.Id)"
Write-Host "[INFO] Backend launcher pid=$($backendProcess.Id)"
Write-Host "[INFO] Logs=$RunLogDir"
