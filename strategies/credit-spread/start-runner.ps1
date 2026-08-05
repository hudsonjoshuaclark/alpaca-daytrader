# Ensures exactly one credit-spread runner is running. Mirrors scripts/restart-runner.ps1's
# pattern for the ORB-15 bot - continuous process, not a scheduled one-shot script, since
# 0DTE positions need intraday profit-target/stop polling.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dir = Join-Path $repo 'strategies\credit-spread'

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'credit-spread\\runner\.js' }
foreach ($p in $existing) {
    Write-Output "stopping existing credit-spread runner pid $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 2

Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList "--env-file=$dir\.env.creditspread", "$dir\runner.js" `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'logs\runner-stdout.log') `
    -RedirectStandardError (Join-Path $dir 'logs\runner-stderr.log')

Start-Sleep -Seconds 5
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'credit-spread\\runner\.js' })
if ($running.Count -ne 1) {
    Write-Error "expected exactly 1 credit-spread runner, found $($running.Count)"
    exit 1
}
Write-Output "credit-spread runner started ok: pid $($running[0].ProcessId)"
