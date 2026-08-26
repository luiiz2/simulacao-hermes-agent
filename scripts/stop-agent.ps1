# Para o Agent Gateway com gracefully (fecha lock também).
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*agent-gateway*gateway.mjs*" }
if (-not $procs) { Write-Output "Gateway não está rodando."; exit 0 }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Output "Parado pid $($p.ProcessId)"
}
Remove-Item "C:\Users\Dell\agent-gateway\gateway.lock" -Force -ErrorAction SilentlyContinue
