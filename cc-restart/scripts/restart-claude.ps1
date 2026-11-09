<#
  cc-restart worker.

  Modes:
    (default)                     wait, stop the Claude desktop, start it, resume every recorded session
    -Detach                       hand the worker to WMI and exit (used by the plugin tool)
    -Discover                     print the Code sessions the desktop launched, as JSON
    -Tail -Transcript <file>      print the last -Bytes bytes of a transcript (UTF-8)
    -Consume -SessionId <id>      remove one entry from pending.json under a lock, as JSON
    -DryRun                       report what would be stopped/started/resumed; change nothing

  Only the MSIX Claude.exe processes are ever stopped. claude.exe under
  %LOCALAPPDATA%\Claude-Data\...\claude-code\...\ is a CLI session; it is
  inspected (to find session ids) but never killed.
#>
[CmdletBinding()]
param(
  [string]$PendingPath = '',
  [string]$LogPath = '',
  [int]$DelaySeconds = 5,
  [switch]$DryRun,
  [switch]$Detach,
  [switch]$NoResume,
  [switch]$Discover,
  [switch]$Consume,
  [switch]$Tail,
  [string]$SessionId = '',
  [string]$Transcript = '',
  [int]$Bytes = 524288
)

$ErrorActionPreference = 'Continue'
# Chinese log lines must survive the console that -DryRun and -Discover write to.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
if (-not $PendingPath) { $PendingPath = Join-Path $env:USERPROFILE '.claude\cc-restart\pending.json' }
if (-not $LogPath) { $LogPath = Join-Path (Split-Path -Parent $PendingPath) 'restart.log' }

$DesktopExePattern = '\\WindowsApps\\Claude_[^\\]+\\app\\Claude\.exe$'
$CliExePattern = '\\Claude-Data\\[^\\]+\\claude-code\\[^\\]+\\[^\\]+\\claude\.exe$'
$MarkerMaxAgeMs = 10 * 60 * 1000

function Write-Log {
  param([string]$Message)
  $line = '{0} [worker pid={1}] {2}' -f (Get-Date).ToString('o'), $PID, $Message
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch { }
  Write-Output $line
}

function Get-ProcessTable {
  $table = @{}
  foreach ($p in @(Get-CimInstance Win32_Process)) { $table[[int]$p.ProcessId] = $p }
  return $table
}

function Get-DesktopMainIds {
  param($Table)
  $ids = @()
  foreach ($p in $Table.Values) {
    if ($p.Name -ne 'claude.exe') { continue }
    if (-not $p.ExecutablePath) { continue }
    if ($p.ExecutablePath -notmatch $DesktopExePattern) { continue }
    if ($p.CommandLine -match '--type=') { continue }
    $ids += [int]$p.ProcessId
  }
  return @($ids)
}

function Test-UnderDesktop {
  param([int]$ProcessId, $Table)
  $p = $Table[[int]$ProcessId]
  if (-not $p) { return $false }
  $parent = $Table[[int]$p.ParentProcessId]
  if (-not $parent) { return $false }
  if (-not $parent.ExecutablePath) { return $false }
  # The direct parent must be the desktop's own process. A CLI whose parent is
  # node (a terminal session or the delegate runner) is not the desktop's.
  return [bool]($parent.ExecutablePath -match $DesktopExePattern)
}

function Get-TranscriptPath {
  param([string]$Id)
  if (-not $Id) { Write-Log "Resume-Session called without a session id; skipping"; return $false }
  $projects = Join-Path $env:USERPROFILE '.claude\projects'
  try { $dirs = @(Get-ChildItem -LiteralPath $projects -Directory -ErrorAction Stop) } catch { return "" }
  foreach ($d in $dirs) {
    $p = Join-Path $d.FullName ($Id + ".jsonl")
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return ""
}

function Get-DesktopSessionIndex {
  $root = Join-Path $env:LOCALAPPDATA 'Claude-Data\claude_pzs8sxrjxfjjc\claude-code-sessions'
  $map = @{}
  if (-not (Test-Path -LiteralPath $root)) { return $map }
  foreach ($acc in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
    foreach ($ws in @(Get-ChildItem -LiteralPath $acc.FullName -Directory -ErrorAction SilentlyContinue)) {
      foreach ($file in @(Get-ChildItem -LiteralPath $ws.FullName -Filter 'local_*.json' -File -ErrorAction SilentlyContinue)) {
        try {
          $j = Get-Content -Raw -LiteralPath $file.FullName -Encoding UTF8 | ConvertFrom-Json
          $cli = [string]$j.cliSessionId
          if (-not $cli) { continue }
          $cwd = $j.cwd
          if ($cwd -isnot [string]) { $cwd = $j.originCwd }
          $map[$cli] = [pscustomobject]@{
            LocalId = [string]$j.sessionId
            Title = [string]$j.title
            Cwd = [string]$cwd
            Archived = [bool]$j.isArchived
          }
        } catch { }
      }
    }
  }
  return $map
}

function Get-DesktopSessions {
  $table = Get-ProcessTable
  $index = Get-DesktopSessionIndex
  $sessions = @()
  foreach ($p in $table.Values) {
    if ($p.Name -ne 'claude.exe') { continue }
    if (-not $p.ExecutablePath) { continue }
    if ($p.ExecutablePath -notmatch $CliExePattern) { continue }
    $cmd = [string]$p.CommandLine
    $sid = ''
    $m = [regex]::Match($cmd, '--resume[=\s]+([0-9a-fA-F-]{36})')
    if ($m.Success) { $sid = $m.Groups[1].Value }
    else {
      $m = [regex]::Match($cmd, '--session-id[=\s]+([0-9a-fA-F-]{36})')
      if ($m.Success) { $sid = $m.Groups[1].Value }
    }
    if (-not $sid) { continue }
    if (-not (Test-UnderDesktop -ProcessId ([int]$p.ProcessId) -Table $table)) { continue }
    $known = $index[$sid]
    $sessions += [pscustomobject]@{
      SessionId = $sid
      ProcessId = [int]$p.ProcessId
      ParentProcessId = [int]$p.ParentProcessId
      Transcript = (Get-TranscriptPath $sid)
      LocalId = $(if ($known) { $known.LocalId } else { '' })
      Title = $(if ($known) { $known.Title } else { '' })
      MappedCwd = $(if ($known) { $known.Cwd } else { '' })
      Archived = $(if ($known) { $known.Archived } else { $false })
    }
  }
  return @($sessions)
}

function Get-DesktopProcesses {
  $out = @()
  foreach ($p in @(Get-CimInstance Win32_Process)) {
    if ($p.Name -ne 'claude.exe') { continue }
    if (-not $p.ExecutablePath) { continue }
    if ($p.ExecutablePath -match $DesktopExePattern) { $out += $p }
  }
  return @($out)
}

function Get-MainProcesses {
  param($Processes)
  return @($Processes | Where-Object { $_.CommandLine -notmatch '--type=' })
}

function Read-Marker {
  if (-not (Test-Path -LiteralPath $PendingPath)) { return @() }
  try {
    $parsed = Get-Content -Raw -LiteralPath $PendingPath -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Log "marker unreadable: $($_.Exception.Message)"
    return @()
  }
  if ($null -eq $parsed) { return @() }
  if ($parsed -is [array]) { return @($parsed) }
  return @($parsed)
}

function Get-StartTarget {
  param([string]$ExePath)
  try {
    $app = Get-StartApps | Where-Object { $_.AppID -like 'Claude_*!*' } | Select-Object -First 1
    if ($app) { return "shell:AppsFolder\$($app.AppID)" }
  } catch { }
  return $ExePath
}

function Start-Desktop {
  param([string]$Target, [string]$ExePath)
  if ($Target -like 'shell:AppsFolder\*') {
    Write-Log "starting desktop via $Target"
    Start-Process -FilePath 'explorer.exe' -ArgumentList $Target
    return
  }
  if (-not $ExePath) { throw 'no desktop executable to start' }
  Write-Log "starting desktop via $ExePath"
  Start-Process -FilePath $ExePath
}

function Resume-Session {
  param([string]$Id)
  if (-not $Id) { Write-Log "Resume-Session called without a session id; skipping"; return $false }
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    Write-Log 'claude CLI not found on PATH; reopen the session by hand'
    return $false
  }
  $source = $claude.Source
  Write-Log "resuming session $Id with: $source --desktop --resume $Id"
  if ($source -match '\.ps1$') {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $source, '--desktop', '--resume', $Id) -WindowStyle Hidden
  } elseif ($source -match '\.(cmd|bat)$') {
    $line = '"{0}" --desktop --resume {1}' -f $source, $Id
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $line) -WindowStyle Hidden
  } else {
    Start-Process -FilePath $source -ArgumentList @('--desktop', '--resume', $Id) -WindowStyle Hidden
  }
  return $true
}

# ---------------------------------------------------------------- helpers
if ($Discover) {
  $sessions = @(Get-DesktopSessions)
  $out = @()
  foreach ($s in $sessions) {
    $out += [pscustomobject]@{
      sessionId = $s.SessionId
      pid = $s.ProcessId
      transcript = $s.Transcript
      localId = $s.LocalId
      title = $s.Title
      cwd = $s.MappedCwd
      archived = $s.Archived
    }
  }
  if ($out.Count -eq 0) { Write-Output '[]' }
  else { Write-Output (ConvertTo-Json -InputObject $out -Compress -Depth 4) }
  exit 0
}

if ($Tail) {
  if (-not $Transcript -or -not (Test-Path -LiteralPath $Transcript)) {
    Write-Log "tail: transcript not found: $Transcript"
    exit 2
  }
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $fs = [System.IO.File]::Open($Transcript, 'Open', 'Read', $share)
  $buf = $null
  $read = 0
  try {
    $len = $fs.Length
    $max = [Math]::Min($len, [int64]$Bytes)
    [void]$fs.Seek($len - $max, "Begin")
    $buf = New-Object byte[] $max
    while ($read -lt $max) {
      $n = $fs.Read($buf, $read, [int]($max - $read))
      if ($n -le 0) { break }
      $read += $n
    }
  } finally { $fs.Close() }
  $stream = [Console]::OpenStandardOutput()
  $stream.Write($buf, 0, $read)
  $stream.Flush()
  exit 0
}

if ($Consume) {
  $removed = $false
  $remaining = 0
  $mutex = New-Object System.Threading.Mutex($false, 'Local\cc-restart-pending')
  $taken = $false
  try {
    try { $taken = $mutex.WaitOne(5000) } catch { $taken = $false }
    if ($SessionId -and (Test-Path -LiteralPath $PendingPath)) {
      $items = @(Read-Marker)
      $kept = @($items | Where-Object { [string]$_.sessionId -ne $SessionId })
      $remaining = $kept.Count
      $removed = $kept.Count -lt $items.Count
      if ($kept.Count -eq 0) {
        Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
      } else {
        $json = ConvertTo-Json -InputObject $kept -Depth 8
        $tmp = $PendingPath + ".tmp-" + $PID
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $PendingPath -Force
      }
    }
  } finally {
    if ($taken) { try { [void]$mutex.ReleaseMutex() } catch { } }
    $mutex.Dispose()
  }
  Write-Output (ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ removed = $removed; remaining = $remaining }))
  exit 0
}

# ---------------------------------------------------------------- detach step
if ($Detach) {
  $self = $PSCommandPath
  $powershell = (Get-Process -Id $PID).Path
  $quote = { param($s) '"' + $s + '"' }
  $command = '{0} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File {1} -PendingPath {2} -LogPath {3} -DelaySeconds {4}' -f (& $quote $powershell), (& $quote $self), (& $quote $PendingPath), (& $quote $LogPath), $DelaySeconds
  if ($NoResume) { $command += ' -NoResume' }
  try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }
    if ($result.ReturnValue -eq 0) {
      Write-Log "detached worker started by WMI: pid=$($result.ProcessId)"
      exit 0
    }
    Write-Log "WMI create failed: returnValue=$($result.ReturnValue); falling back to Start-Process"
  } catch {
    Write-Log "WMI create threw: $($_.Exception.Message); falling back to Start-Process"
  }
  Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $self, '-PendingPath', $PendingPath, '-LogPath', $LogPath, '-DelaySeconds', $DelaySeconds) -WindowStyle Hidden
  Write-Log 'detached worker started by Start-Process'
  exit 0
}

# ---------------------------------------------------------------- main worker
Write-Log "=== cc-restart begin: DryRun=$DryRun DelaySeconds=$DelaySeconds NoResume=$NoResume ==="
Write-Log "marker: $PendingPath"

$entries = @(Read-Marker)
if ($entries.Count -gt 0) {
  foreach ($e in $entries) {
    Write-Log "pending entry session=$($e.sessionId) wake=$($e.wake) state=$($e.state) reason=$($e.reason)"
  }
} else {
  Write-Log 'no pending entry: the desktop will be restarted but no session is resumed'
}

if (-not $DryRun -and $DelaySeconds -gt 0) {
  Write-Log "waiting $DelaySeconds s"
  Start-Sleep -Seconds $DelaySeconds
}

$processes = @(Get-DesktopProcesses)
$main = @(Get-MainProcesses -Processes $processes)
$exePath = $null
if ($main.Count -gt 0) { $exePath = $main[0].ExecutablePath }
elseif ($processes.Count -gt 0) { $exePath = $processes[0].ExecutablePath }
$target = Get-StartTarget -ExePath $exePath

if ($DryRun) {
  Write-Log "DRY RUN: $($processes.Count) Claude desktop process(es) would be stopped, $($main.Count) main"
  foreach ($p in $processes) {
    Write-Log ("DRY RUN: would kill pid={0} parent={1} path={2}" -f $p.ProcessId, $p.ParentProcessId, $p.ExecutablePath)
  }
  if ($processes.Count -eq 0) { Write-Log 'DRY RUN: no Claude desktop process is running; nothing to kill' }
  Write-Log "DRY RUN: would start target: $target"
  if ($exePath) { Write-Log "DRY RUN: desktop executable: $exePath" }
  $initiator = $null
  foreach ($e in $entries) { if ($e.initiator -eq $true) { $initiator = $e; break } }
  if (-not $initiator -and $entries.Count -gt 0) { $initiator = $entries[0] }
  if ($initiator -and $initiator.sessionId) {
    Write-Log "DRY RUN: would resume initiator session $($initiator.sessionId) (wake=$($initiator.wake), state=$($initiator.state))"
  } else { Write-Log 'DRY RUN: would not resume any session' }
  $others = @()
  if ($initiator -and $initiator.others) { $others = @($initiator.others) }
  Write-Log "DRY RUN: other sessions the initiator would message: $($others.Count)"
  foreach ($o in $others) {
    Write-Log "DRY RUN:   - cli=$($o.cliSessionId) local=$($o.localId) wake=$($o.wake) cwd=$($o.cwd) title=$($o.title)"
    Write-Log "DRY RUN:     reason: $($o.reason)"
  }
  Write-Log 'DRY RUN: no process was stopped and none was started'
  exit 0
}

$stopped = 0
foreach ($p in $main) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    $stopped++
    Write-Log "stopped main pid=$($p.ProcessId)"
  } catch {
    Write-Log "could not stop pid=$($p.ProcessId): $($_.Exception.Message)"
  }
}

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $left = @(Get-DesktopProcesses)
  if ($left.Count -eq 0) { break }
  foreach ($p in $left) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
  }
  Start-Sleep -Milliseconds 500
}
$left = @(Get-DesktopProcesses)
if ($left.Count -gt 0) { Write-Log "warning: $($left.Count) desktop process(es) still alive" }
else { Write-Log "desktop stopped ($stopped main process(es) signalled)" }

Start-Sleep -Milliseconds 800

try {
  Start-Desktop -Target $target -ExePath $exePath
} catch {
  Write-Log "start failed: $($_.Exception.Message)"
  exit 1
}

$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  $nowMain = @(Get-MainProcesses -Processes (Get-DesktopProcesses))
  if ($nowMain.Count -gt 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if ($ready) { Write-Log 'desktop main process is up' } else { Write-Log 'warning: desktop main process did not appear within 90 s' }
Start-Sleep -Seconds 5

$initiator = $null
foreach ($e in $entries) { if ($e.initiator -eq $true) { $initiator = $e; break } }
if (-not $initiator -and $entries.Count -gt 0) { $initiator = $entries[0] }

if ($initiator -and $initiator.sessionId -and -not $NoResume) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $age = $now - [int64]$initiator.ts
  if ($age -gt $MarkerMaxAgeMs) {
    Write-Log "initiator $($initiator.sessionId) is stale (age=$age ms); not resuming"
  } else {
    [void](Resume-Session -Id ([string]$initiator.sessionId))
  }
} else {
  Write-Log 'no session to resume'
}

Write-Log '=== cc-restart done ==='
exit 0
