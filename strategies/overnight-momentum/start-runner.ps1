# Ensures exactly one overnight-momentum runner is running. Mirrors the other bots'
# start-runner.ps1 pattern - a continuous process rather than scheduled one-shots, because
# overnight-drift's twice-daily scheduled-task design is exactly what silently lost both of
# its runs on 2026-08-11 and 08-12 when the machine was in Modern Standby.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dir = Join-Path $repo 'strategies\overnight-momentum'

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'overnight-momentum\\runner\.js' }
foreach ($p in $existing) {
    Write-Output "stopping existing overnight-momentum runner pid $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 2

Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList "--env-file=$dir\.env.overnightmomentum", "$dir\runner.js" `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'logs\runner-stdout.log') `
    -RedirectStandardError (Join-Path $dir 'logs\runner-stderr.log')

Start-Sleep -Seconds 5
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'overnight-momentum\\runner\.js' })
if ($running.Count -ne 1) {
    Write-Error "expected exactly 1 overnight-momentum runner, found $($running.Count)"
    exit 1
}
Write-Output "overnight-momentum runner started ok: pid $($running[0].ProcessId)"
