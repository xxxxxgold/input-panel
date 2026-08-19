# 统一维护本仓库开发服务的端口租约、进程树和 tmp/run 日志，避免误杀非本任务进程。
if (-not ("DevLifecycleNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DevLifecycleNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    public sealed class ProcessSnapshotEntry
    {
        public int ProcessId;
        public int ParentProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr processHandle, int informationClass, IntPtr processInformation, int processInformationLength, out int returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existingFileName, string newFileName, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 processEntry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 processEntry);

    public static int GetParentProcessId(int processId)
    {
        IntPtr handle = OpenProcess(0x1000, false, processId);
        if (handle == IntPtr.Zero)
        {
            return -1;
        }

        try
        {
            int size = Marshal.SizeOf(typeof(ProcessBasicInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                int returned;
                int status = NtQueryInformationProcess(handle, 0, buffer, size, out returned);
                if (status != 0)
                {
                    return -2;
                }

                ProcessBasicInformation info = (ProcessBasicInformation)Marshal.PtrToStructure(buffer, typeof(ProcessBasicInformation));
                return info.InheritedFromUniqueProcessId.ToInt32();
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static void ReplaceFile(string sourcePath, string destinationPath)
    {
        const uint MoveFileReplaceExisting = 0x1;
        const uint MoveFileWriteThrough = 0x8;
        if (!MoveFileEx(sourcePath, destinationPath, MoveFileReplaceExisting | MoveFileWriteThrough))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "MoveFileEx failed.");
        }
    }

    public static ProcessSnapshotEntry[] GetProcessSnapshot()
    {
        const uint Th32csSnapProcess = 0x00000002;
        const int ErrorNoMoreFiles = 18;
        IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == new IntPtr(-1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateToolhelp32Snapshot failed.");
        }

        try
        {
            var processEntry = new ProcessEntry32();
            processEntry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            if (!Process32First(snapshot, ref processEntry))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Process32First failed.");
            }

            var entries = new List<ProcessSnapshotEntry>();
            do
            {
                if (processEntry.th32ProcessID > 0)
                {
                    entries.Add(new ProcessSnapshotEntry
                    {
                        ProcessId = unchecked((int)processEntry.th32ProcessID),
                        ParentProcessId = unchecked((int)processEntry.th32ParentProcessID)
                    });
                }

                processEntry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            }
            while (Process32Next(snapshot, ref processEntry));

            int error = Marshal.GetLastWin32Error();
            if (error != ErrorNoMoreFiles)
            {
                throw new Win32Exception(error, "Process32Next failed.");
            }

            return entries.ToArray();
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@
}

function Get-DevLeasePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath
    )

    return Join-Path $RootPath "tmp\run\dev-lease.json"
}

function Get-DevLease {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath
    )

    $leasePath = Get-DevLeasePath -RootPath $RootPath
    if (-not (Test-Path -LiteralPath $leasePath)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
    } catch {
        throw "Dev lease file is invalid: $leasePath. Remove it only after confirming no dev process is still running."
    }
}

function Write-DevLease {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease
    )

    $leasePath = [string]$Lease.leasePath
    $Lease.updatedAt = (Get-Date).ToString("o")
    $content = $Lease | ConvertTo-Json -Depth 6
    $temporaryPath = "$leasePath.$PID.tmp"

    [System.IO.File]::WriteAllText(
        $temporaryPath,
        $content,
        [System.Text.UTF8Encoding]::new($false)
    )

    try {
        [DevLifecycleNative]::ReplaceFile($temporaryPath, $leasePath)
    } catch {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        throw "Failed to update dev lease: $leasePath."
    }
}

function Remove-DevLease {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease
    )

    Remove-Item -LiteralPath ([string]$Lease.leasePath) -Force -ErrorAction SilentlyContinue
}

function Get-DevProcessStartToken {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    try {
        $process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
        try {
            return $process.StartTime.ToUniversalTime().Ticks.ToString()
        } finally {
            $process.Dispose()
        }
    } catch {
        return $null
    }
}

function Test-DevProcessIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [Parameter(Mandatory = $true)]
        [string]$StartToken
    )

    if ([string]::IsNullOrWhiteSpace($StartToken)) {
        return $false
    }

    $actualStartToken = Get-DevProcessStartToken -ProcessId $ProcessId
    return $actualStartToken -eq $StartToken
}

function Test-DevLeaseProcess {
    param(
        [Parameter(Mandatory = $true)]
        [object]$ProcessRecord
    )

    return Test-DevProcessIdentity `
        -ProcessId ([int]$ProcessRecord.pid) `
        -StartToken ([string]$ProcessRecord.startToken)
}

function Test-DevLeaseLauncher {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease
    )

    if ($null -eq $Lease.launcher) {
        return $false
    }

    return Test-DevLeaseProcess -ProcessRecord $Lease.launcher
}

function Get-DevLeaseLiveRoots {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease
    )

    return @($Lease.processes | Where-Object { Test-DevLeaseProcess -ProcessRecord $_ })
}

function Get-DevLeaseProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease
    )

    $liveRoots = @(Get-DevLeaseLiveRoots -Lease $Lease)
    if ($liveRoots.Count -eq 0) {
        return @()
    }

    $queue = [System.Collections.Generic.Queue[object]]::new()
    $tracked = @{}
    $childrenByParentId = @{}

    foreach ($process in [DevLifecycleNative]::GetProcessSnapshot()) {
        $processId = $process.ProcessId
        $parentProcessId = $process.ParentProcessId
        if ($parentProcessId -le 0) {
            continue
        }

        if (-not $childrenByParentId.ContainsKey($parentProcessId)) {
            $childrenByParentId[$parentProcessId] = [System.Collections.Generic.List[int]]::new()
        }
        $childrenByParentId[$parentProcessId].Add($processId)
    }

    foreach ($root in $liveRoots) {
        $queue.Enqueue([pscustomobject]@{
            ProcessId = [int]$root.pid
            StartToken = [string]$root.startToken
            Depth = 0
        })
    }

    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        if ($tracked.ContainsKey($current.ProcessId) -or -not (Test-DevProcessIdentity -ProcessId $current.ProcessId -StartToken $current.StartToken)) {
            continue
        }

        $tracked[$current.ProcessId] = $current

        if (-not $childrenByParentId.ContainsKey($current.ProcessId)) {
            continue
        }

        foreach ($childProcessId in $childrenByParentId[$current.ProcessId]) {
            if ($tracked.ContainsKey($childProcessId)) {
                continue
            }

            $childStartToken = Get-DevProcessStartToken -ProcessId $childProcessId
            if ($childStartToken -and [DevLifecycleNative]::GetParentProcessId($childProcessId) -eq $current.ProcessId) {
                $queue.Enqueue([pscustomobject]@{
                    ProcessId = [int]$childProcessId
                    StartToken = $childStartToken
                    Depth = $current.Depth + 1
                })
            }
        }
    }

    return @($tracked.Values)
}

function Stop-DevLeaseProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease,
        [int]$TimeoutSeconds = 15
    )

    $processTree = @(Get-DevLeaseProcessTree -Lease $Lease)
    foreach ($entry in ($processTree | Sort-Object Depth -Descending)) {
        if (Test-DevProcessIdentity -ProcessId $entry.ProcessId -StartToken $entry.StartToken) {
            Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(
            $processTree |
                Where-Object { Test-DevProcessIdentity -ProcessId $_.ProcessId -StartToken $_.StartToken }
        )
        if ($remaining.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    $remainingIds = ($remaining.ProcessId | Sort-Object) -join ", "
    throw "Owned dev processes did not exit in time: $remainingIds"
}

function Assert-DevPortsAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $requestedPorts = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($port in $Ports) {
        [void]$requestedPorts.Add($port)
    }

    $listeners = @()
    foreach ($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp)) {
        if ($line -notmatch "^\s*TCP\s+(.+?)\s+.+?\s+(?:LISTENING|侦听)\s+(\d+)\s*$") {
            continue
        }

        $localEndpoint = $Matches[1]
        $ownerProcessId = [int]$Matches[2]
        if ($localEndpoint -notmatch ":(\d+)$") {
            continue
        }

        $port = [int]$Matches[1]
        if (-not $requestedPorts.Contains($port)) {
            continue
        }

        $listeners += [pscustomobject]@{
            LocalPort = $port
            OwningProcess = $ownerProcessId
        }
    }

    if ($listeners.Count -eq 0) {
        return
    }

    $details = @(
        $listeners |
            Sort-Object LocalPort, OwningProcess |
            ForEach-Object { "port $($_.LocalPort) (PID $($_.OwningProcess))" }
    ) -join ", "

    throw "Dev ports are already occupied by a process not owned by this launcher: $details"
}

function Enter-DevLease {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,
        [Parameter(Mandatory = $true)]
        [string]$Mode,
        [Parameter(Mandatory = $true)]
        [int]$FrontendPort,
        [Parameter(Mandatory = $true)]
        [int]$BackendPort,
        [switch]$Restart
    )

    $normalizedRootPath = [System.IO.Path]::GetFullPath($RootPath)
    $existingLease = Get-DevLease -RootPath $normalizedRootPath
    if ($existingLease) {
        $existingRootPath = [string]$existingLease.rootPath
        if (-not [string]::Equals($existingRootPath, $normalizedRootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Dev lease belongs to a different repository: $existingRootPath"
        }

        if (Test-DevLeaseLauncher -Lease $existingLease) {
            throw "A dev launcher is still acquiring this repository lease. Wait for it to finish before starting or restarting again."
        }

        $liveRoots = @(Get-DevLeaseLiveRoots -Lease $existingLease)
        if ($liveRoots.Count -gt 0) {
            if (-not $Restart) {
                throw "A dev launcher is already running for this repository. Use the explicit restart entry point to replace it."
            }

            Stop-DevLeaseProcesses -Lease $existingLease
        }

        Remove-DevLease -Lease $existingLease
    }

    $leasePath = Get-DevLeasePath -RootPath $normalizedRootPath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $leasePath) | Out-Null

    $launcherStartToken = Get-DevProcessStartToken -ProcessId $PID
    if (-not $launcherStartToken) {
        throw "The current launcher process could not be recorded in the dev lease."
    }

    $lease = [pscustomobject]@{
        version = 2
        leasePath = $leasePath
        rootPath = $normalizedRootPath
        mode = $Mode
        frontendPort = $FrontendPort
        backendPort = $BackendPort
        state = "starting"
        createdAt = (Get-Date).ToString("o")
        updatedAt = (Get-Date).ToString("o")
        launcher = [pscustomobject]@{
            pid = $PID
            startToken = $launcherStartToken
        }
        processes = @()
    }

    $content = $lease | ConvertTo-Json -Depth 6
    try {
        $stream = [System.IO.File]::Open(
            $leasePath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::Read
        )
    } catch [System.IO.IOException] {
        throw "Another dev launcher is acquiring the lease. Try again after it finishes."
    }

    try {
        $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
        try {
            $writer.Write($content)
        } finally {
            $writer.Dispose()
        }
    } finally {
        $stream.Dispose()
    }

    return $lease
}

function Add-DevLeaseProcess {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease,
        [Parameter(Mandatory = $true)]
        [string]$Role,
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process
    )

    $startToken = Get-DevProcessStartToken -ProcessId $Process.Id
    if (-not $startToken) {
        throw "$Role launcher exited before it could be recorded in the dev lease."
    }

    $Lease.processes = @(
        $Lease.processes + [pscustomobject]@{
            role = $Role
            pid = $Process.Id
            startToken = $startToken
        }
    )
    Write-DevLease -Lease $Lease
}

function Set-DevLeaseState {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Lease,
        [Parameter(Mandatory = $true)]
        [string]$State
    )

    $Lease.state = $State
    Write-DevLease -Lease $Lease
}
