# JV-Link から蓄積系データ(RACE)を取得して生レコードをファイルに書き出す
# 必ず 32bit PowerShell で実行すること:
#   C:\WINDOWS\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -File tools\jv-fetch.ps1 -From 20260101000000
#
# 出力: <OutDir>\RA.txt / SE.txt / HR.txt （1行=1レコード、UTF-8）
#       <OutDir>\status.txt に進捗（ポーリング用）
param(
  [Parameter(Mandatory = $true)][string]$From,   # yyyyMMddHHmmss
  [string]$OutDir = "jvdata",
  [int]$Option = 1,                              # 1=通常 / 4=セットアップ(初回ダイアログ承認済み)
  [string]$Types = "RA,SE,HR"                    # 保存するレコード種別
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path
$statusPath = Join-Path $OutDir 'status.txt'
$typeSet = @{}
foreach ($t in $Types.Split(',')) { $typeSet[$t.Trim()] = $true }

function Write-Status([string]$msg) {
  $line = ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg)
  Set-Content -Path $statusPath -Value $line -Encoding UTF8
  Write-Output $line
}

$writers = @{}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Get-Writer([string]$type) {
  if (-not $writers.ContainsKey($type)) {
    $writers[$type] = New-Object System.IO.StreamWriter((Join-Path $OutDir "$type.txt"), $false, $utf8NoBom)
  }
  return $writers[$type]
}

$jv = New-Object -ComObject JVDTLab.JVLink
try {
  $initRet = $jv.JVInit('UNKNOWN')
  if ($initRet -ne 0) { Write-Status "FAILED JVInit=$initRet"; exit 1 }

  [int]$readCount = 0
  [int]$downloadCount = 0
  [string]$lastTimestamp = (' ' * 20)
  $openRet = $jv.JVOpen('RACE', $From, $Option, [ref]$readCount, [ref]$downloadCount, [ref]$lastTimestamp)
  if ($openRet -ne 0) { Write-Status "FAILED JVOpen=$openRet"; exit 1 }
  Write-Status "OPEN files=$readCount download=$downloadCount last=$lastTimestamp"

  $total = 0
  $kept = 0
  $typeCounts = @{}
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    [string]$buf = (' ' * 200000)
    [int]$bufSize = 200000
    [string]$filename = (' ' * 260)
    $ret = $jv.JVRead([ref]$buf, [ref]$bufSize, [ref]$filename)
    if ($ret -eq -3) { Start-Sleep -Milliseconds 300; continue }   # ダウンロード待ち
    if ($ret -eq -1) { continue }                                   # ファイル切替
    if ($ret -eq 0) { break }                                       # 全件終了
    if ($ret -lt 0) { Write-Status "FAILED JVRead=$ret at record $total"; exit 1 }

    $total++
    $len = [Math]::Min($ret, $buf.Length)
    $rec = $buf.Substring(0, $len).TrimEnd("`r", "`n")
    $type = $rec.Substring(0, [Math]::Min(2, $rec.Length))
    if (-not $typeCounts.ContainsKey($type)) { $typeCounts[$type] = 0 }
    $typeCounts[$type]++
    if ($typeSet.ContainsKey($type)) {
      (Get-Writer $type).WriteLine($rec)
      $kept++
    }
    if ($total % 5000 -eq 0) {
      Write-Status ("READING total=$total kept=$kept elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s")
    }
  }
  foreach ($w in $writers.Values) { $w.Flush(); $w.Close() }
  $summary = ($typeCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { $_.Key + '=' + $_.Value }) -join ' '
  Write-Status ("DONE total=$total kept=$kept elapsed=" + [int]$sw.Elapsed.TotalSeconds + "s last=$lastTimestamp types: $summary")
} catch {
  Write-Status ("FAILED exception: " + $_.Exception.Message)
  exit 1
} finally {
  try { foreach ($w in $writers.Values) { $w.Close() } } catch {}
  try { $jv.JVClose() | Out-Null } catch {}
}
