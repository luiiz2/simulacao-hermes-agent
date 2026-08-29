# Para o Agent Gateway gracefully (fecha lock também).
$root = Split-Path -Parent $PSScriptRoot
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*gateway.mjs*" }
if (-not $procs) { Write-Output "Gateway não está rodando."; exit 0 }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Output "Parado pid $($p.ProcessId)"
}
Remove-Item (Join-Path $root "gateway.lock") -Force -ErrorAction SilentlyContinue
