# 按保留期清理 ctx-mod 的会话目录。
# 默认只列出将被删除的目录（dry run）；加 -Apply 才真正删除。
# 只处理数据根目录下、名字是 GUID 的子目录，且其中最新文件的写入时间早于保留期。
# 根目录下的散文件（costly.json、probe-*.jsonl）不动。
param(
  [string]$Root = (Join-Path $env:USERPROFILE '.claude\ctx-mod'),
  [int]$Days = 30,
  [switch]$Apply
)

$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$cut = (Get-Date).AddDays(-$Days)

if (-not (Test-Path $Root)) { Write-Output "数据根目录不存在：$Root"; exit 0 }

$targets = foreach ($dir in Get-ChildItem $Root -Directory) {
  if ($dir.Name -notmatch $guid) { continue }
  $newest = (Get-ChildItem $dir.FullName -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object LastWriteTime -Maximum).Maximum
  if ($null -eq $newest) { $newest = $dir.LastWriteTime }
  if ($newest -lt $cut) {
    [pscustomobject]@{ Path = $dir.FullName; Newest = $newest }
  }
}

$targets = @($targets)
Write-Output ("保留期 {0} 天，截止 {1:yyyy-MM-dd HH:mm}，待清理 {2} 个目录" -f $Days, $cut, $targets.Count)
$targets | ForEach-Object { Write-Output ("  {0}  最后写入 {1:yyyy-MM-dd HH:mm}" -f $_.Path, $_.Newest) }

if (-not $Apply) {
  if ($targets.Count -gt 0) { Write-Output "dry run：未删除任何内容。加 -Apply 才会删除。" }
  exit 0
}

$failed = 0
foreach ($t in $targets) {
  try {
    Remove-Item -LiteralPath $t.Path -Recurse -Force -ErrorAction Stop
  } catch {
    $failed++
    Write-Output "删除失败：$($t.Path) - $($_.Exception.Message)"
  }
}
Write-Output ("已删除 {0} 个，失败 {1} 个" -f ($targets.Count - $failed), $failed)
