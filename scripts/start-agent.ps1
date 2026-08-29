# Inicia o Agent Gateway em background (janela oculta) com log.
$root = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $root "logs"
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*gateway.mjs*" }
if ($existing) { Write-Output "Gateway já rodando (pid $(($existing | Select-Object -First 1).ProcessId))"; exit 0 }
Start-Process node -ArgumentList "`"$root\src\gateway.mjs`"" -WindowStyle Hidden `
  -WorkingDirectory $root `
  -RedirectStandardOutput "$logsDir\stdout.log" `
  -RedirectStandardError "$logsDir\stderr.log"
Write-Output "Gateway iniciado."
