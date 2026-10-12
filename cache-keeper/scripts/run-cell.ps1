# Starts one fresh Claude Code session for an experiment cell: the TTL set in
# the environment and an empty working directory. The mod auto-loads from
# ~/.claude/skills; kept anywhere else it is passed with --plugin-dir.
#
#   .\run-cell.ps1 -Ttl 5m
#   .\run-cell.ps1 -Ttl 1h -Model claude-opus-5-5
param(
  [ValidateSet('5m', '1h', 'force5m', 'auto')]
  [string]$Ttl = '5m',
  [string]$Model = '',
  [string]$WorkDir = (Join-Path $HOME 'cache-keeper-bench')
)

$mod = Split-Path -Parent $PSScriptRoot

$claude = $null
$onPath = Get-Command claude -ErrorAction SilentlyContinue
if ($onPath) { $claude = $onPath.Source }
if (-not $claude) {
  # The engine the Claude desktop app ships, newest first.
  $bundled = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages\Claude_*\LocalCache\Roaming\Claude\claude-code') `
    -Recurse -Filter claude.exe -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($bundled) { $claude = $bundled.FullName }
}
if (-not $claude) { throw 'Claude Code was not found on PATH or in the Claude desktop app.' }

New-Item -ItemType Directory -Force $WorkDir | Out-Null
Remove-Item Env:CLAUDE_CODE_PROMPT_CACHE_TTL, Env:FORCE_PROMPT_CACHING_5M -ErrorAction SilentlyContinue
switch ($Ttl) {
  '5m' { $env:CLAUDE_CODE_PROMPT_CACHE_TTL = '5m' }
  '1h' { $env:CLAUDE_CODE_PROMPT_CACHE_TTL = '1h' }
  'force5m' { $env:FORCE_PROMPT_CACHING_5M = '1' }
}

$skills = Join-Path $HOME '.claude\skills'
$arguments = @()
if (-not $mod.StartsWith($skills, [System.StringComparison]::OrdinalIgnoreCase)) {
  $arguments += @('--plugin-dir', $mod)
}
if ($Model) { $arguments += @('--model', $Model) }

Write-Host "Claude Code: $claude"
Write-Host "TTL cell: $Ttl   working directory: $WorkDir"
Write-Host 'In the session: /cache-keeper experiment preflight, then /cache-keeper experiment <plan>'

Push-Location $WorkDir
try { & $claude @arguments } finally { Pop-Location }
