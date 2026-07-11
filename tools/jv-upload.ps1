# jv-import.js が生成した verify_rows.json を Supabase の verify_results へ一括投入する。
# 既存行は保持（ON CONFLICT DO NOTHING 相当）。ただし特徴量なしの旧行
# （axis_odds IS NULL）だけは JV 版で更新して品質を上げる。
# 認証: Supabase CLI の管理トークン（Windows資格情報マネージャー）を使用。
param(
  [string]$RowsFile = "jvdata2\verify_rows.json",
  [int]$BatchSize = 400
)
$ErrorActionPreference = 'Stop'

$sig = @'
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
'@
Add-Type -MemberDefinition $sig -Namespace Win32 -Name CredManUp -ErrorAction SilentlyContinue
$ptr = [IntPtr]::Zero
if (-not [Win32.CredManUp]::CredRead('Supabase CLI:supabase', 1, 0, [ref]$ptr)) { throw 'Supabase CLIのトークンが見つかりません（supabase loginが必要）' }
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Win32.CredManUp+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[Win32.CredManUp]::CredFree($ptr)
$token = [System.Text.Encoding]::UTF8.GetString($bytes)

$rows = Get-Content -Raw -Encoding UTF8 $RowsFile | ConvertFrom-Json
Write-Output ("投入対象: " + $rows.Count + "行")

function Sql-Str($v) { if ($null -eq $v) { return 'null' } "'" + ($v -replace "'", "''") + "'" }
function Sql-Num($v) { if ($null -eq $v) { return 'null' } [string]$v }

$uri = "https://api.supabase.com/v1/projects/hgtepblyevdilkudgues/database/query"
$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }
$done = 0
for ($i = 0; $i -lt $rows.Count; $i += $BatchSize) {
  $batch = $rows[$i..([Math]::Min($i + $BatchSize - 1, $rows.Count - 1))]
  $values = ($batch | ForEach-Object {
    $perBet = ($_.per_bet | ConvertTo-Json -Compress -Depth 5) -replace "'", "''"
    "(" + (Sql-Str $_.race_id) + "," + (Sql-Str $_.date) + "," + (Sql-Str $_.venue) + "," + (Sql-Num $_.num) + "," +
      (Sql-Num $_.field) + "," + (Sql-Str $_.surface) + "," + (Sql-Num $_.distance) + "," +
      (Sql-Num $_.axis_odds) + "," + (Sql-Num $_.axis_ninki) + "," + (Sql-Num $_.score_gap) + ",'" + $perBet + "'::jsonb)"
  }) -join ",`n"
  $sql = @"
insert into public.verify_results (race_id, date, venue, num, field, surface, distance, axis_odds, axis_ninki, score_gap, per_bet)
values
$values
on conflict (race_id) do update set
  field = excluded.field, surface = excluded.surface, distance = excluded.distance,
  axis_odds = excluded.axis_odds, axis_ninki = excluded.axis_ninki, score_gap = excluded.score_gap,
  per_bet = excluded.per_bet
where verify_results.axis_odds is null;
"@
  $body = @{ query = $sql } | ConvertTo-Json -Depth 3
  $null = Invoke-WebRequest -Method Post -Uri $uri -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -UseBasicParsing -TimeoutSec 120
  $done += $batch.Count
  Write-Output ("進捗: $done / " + $rows.Count)
}
Write-Output "投入完了"
