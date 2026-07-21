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
Add-Type -MemberDefinition $sig -Namespace Win32 -Name CredManForward -ErrorAction SilentlyContinue
$ptr = [IntPtr]::Zero
if (-not [Win32.CredManForward]::CredRead('Supabase CLI:supabase', 1, 0, [ref]$ptr)) {
  throw 'Supabase CLI credential not found. Run npx supabase login.'
}
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Win32.CredManForward+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[Win32.CredManForward]::CredFree($ptr)
$token = [System.Text.Encoding]::UTF8.GetString($bytes)

$projectRef = 'hgtepblyevdilkudgues'
$sqlFile = Join-Path $PSScriptRoot '..\supabase\migrations\20260721000000_forward_validation.sql'
$sql = [System.IO.File]::ReadAllText(
  [System.IO.Path]::GetFullPath($sqlFile),
  [System.Text.Encoding]::UTF8
)
$uri = "https://api.supabase.com/v1/projects/$projectRef/database/query"
$headers = @{Authorization = "Bearer $token"; 'Content-Type' = 'application/json'}
$body = @{query = $sql} | ConvertTo-Json -Depth 3
$null = Invoke-WebRequest -Method Post -Uri $uri -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($body)) -UseBasicParsing -TimeoutSec 120
Write-Output 'Forward-validation tables deployed.'

$env:SUPABASE_ACCESS_TOKEN = $token
try {
  & npx.cmd supabase functions deploy race-data --project-ref $projectRef
  if ($LASTEXITCODE -ne 0) { throw "Edge Function deploy failed (exit=$LASTEXITCODE)" }
  Write-Output 'race-data Edge Function deployed.'
} finally {
  Remove-Item Env:\SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
}
