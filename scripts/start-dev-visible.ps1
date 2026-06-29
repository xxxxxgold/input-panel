param(
    [int]$FrontendPort = 5777,
    [int]$BackendPort = 5559,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot ".tmp\run"
$RunLogDir = Join-Path $LogDir (Get-Date -Format "yyyyMMdd-HHmmss")
$BackendLog = Join-Path $RunLogDir "dev-backend.visible.log"
$FrontendLog = Join-Path $RunLogDir "dev-frontend.visible.log"

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

Stop-DevProcesses -RootPath $RepoRoot -Ports @($FrontendPort, $BackendPort)
Start-Sleep -Seconds 2

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
    "echo [INFO] Starting dev API on http://127.0.0.1:$BackendPort",
    "set PORT=$BackendPort",
    "`"$CargoPath`" run --manifest-path src-tauri/Cargo.toml --example dev_api 1>>`"$BackendLog`" 2>>&1"
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

$frontendWindow = Start-Process `
    -FilePath $CmdPath `
    -ArgumentList @("/k", $frontendCommand) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Normal `
    -PassThru

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

Write-Host "[OK] Dev frontend started at http://127.0.0.1:$FrontendPort"
Write-Host "[OK] Dev backend started at http://127.0.0.1:$BackendPort"
Write-Host "[INFO] Frontend window pid=$($frontendWindow.Id)"
Write-Host "[INFO] Backend window pid=$($backendWindow.Id)"
Write-Host "[INFO] Logs=$RunLogDir"
