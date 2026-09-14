# Ensures exactly one status-server is running (dashboard at http://localhost:4321).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'status-server\.js' }
foreach ($p in $existing) {
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 1

Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList '--env-file=.env', '--env-file=strategies\overnight-drift\.env.overnight', '--env-file=strategies\credit-spread\.env.creditspread', '--env-file=strategies\overnight-momentum\.env.overnightmomentum', 'status-server.js' `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $repo 'logs\status-server-stdout.log') `
    -RedirectStandardError (Join-Path $repo 'logs\status-server-stderr.log')
Start-Sleep -Seconds 3
Write-Output 'status server started: http://localhost:4321'
