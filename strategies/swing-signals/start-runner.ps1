# Ensures exactly one swing-signals runner is running. Mirrors credit-spread/start-runner.ps1's
# pattern - continuous process, not a scheduled one-shot script, since positions need
# intraday stop-loss/take-profit polling and the signal scan runs on the same loop.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dir = Join-Path $repo 'strategies\swing-signals'

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'swing-signals\\runner\.js' }
foreach ($p in $existing) {
    Write-Output "stopping existing swing-signals runner pid $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 2

Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList "--env-file=$dir\.env.swing", "$dir\runner.js" `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'logs\runner-stdout.log') `
    -RedirectStandardError (Join-Path $dir 'logs\runner-stderr.log')

Start-Sleep -Seconds 5
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'swing-signals\\runner\.js' })
if ($running.Count -ne 1) {
    Write-Error "expected exactly 1 swing-signals runner, found $($running.Count)"
    exit 1
}
Write-Output "swing-signals runner started ok: pid $($running[0].ProcessId)"
