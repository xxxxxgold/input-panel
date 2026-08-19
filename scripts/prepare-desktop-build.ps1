# 桌面构建前释放当前仓库 app.exe 的文件锁，避免构建产物被运行实例占用。
param()

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetExes = @(
    (Join-Path $RepoRoot "src-tauri\target\debug\app.exe"),
    (Join-Path $RepoRoot "src-tauri\target\release\app.exe")
)

foreach ($TargetExe in $TargetExes) {
    if (-not (Test-Path $TargetExe)) {
        continue
    }

    $runningTargets = Get-Process | Where-Object {
        $_.Path -eq $TargetExe
    }

    foreach ($process in $runningTargets) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 800

    $probeName = "app.exe.lockprobe"
    $targetDir = Split-Path $TargetExe -Parent
    $probePath = Join-Path $targetDir $probeName
    $released = $false

    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        try {
            Rename-Item -LiteralPath $TargetExe -NewName $probeName -ErrorAction Stop
            Rename-Item -LiteralPath $probePath -NewName "app.exe" -ErrorAction Stop
            $released = $true
            break
        } catch {
            Start-Sleep -Milliseconds 450
        }
    }

    if (-not $released) {
        throw "桌面构建前无法释放 app.exe 文件锁 ($TargetExe), 请先关闭正在运行的桌面窗口后重试。"
    }
}
