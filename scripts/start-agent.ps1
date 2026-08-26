# Inicia o Agent Gateway em background (janela oculta) com log.
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
}
$existing = Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*agent-gateway*gateway.mjs*" }
if ($existing) { Write-Output "Gateway já rodando (pid $($existing.Id))"; exit 0 }
Start-Process node -ArgumentList "`"$root\src\gateway.mjs`"" -WindowStyle Hidden `
  -WorkingDirectory $root `
  -RedirectStandardOutput "$root\logs\stdout.log" `
  -RedirectStandardError "$root\logs\stderr.log"
Write-Output "Gateway iniciado."
