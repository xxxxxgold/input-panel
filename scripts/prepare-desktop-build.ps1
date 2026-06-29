param()

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetExe = Join-Path $RepoRoot "src-tauri\target\debug\app.exe"

if (-not (Test-Path $TargetExe)) {
    exit 0
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
    throw "桌面构建前无法释放 app.exe 文件锁, 请先关闭正在运行的桌面窗口后重试。"
}
