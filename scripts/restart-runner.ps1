# Safely restart the trading runner: kill ALL existing runner.js processes, start
# exactly one, verify it stays up. Used by the nightly review agent after code changes.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'runner\.js' }
foreach ($p in $existing) {
    Write-Output "stopping runner pid $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 2

Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList '--env-file=.env', 'runner.js' `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $repo 'logs\runner-stdout-new.log') `
    -RedirectStandardError (Join-Path $repo 'logs\runner-stderr-new.log')

Start-Sleep -Seconds 8
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'runner\.js' })
if ($running.Count -ne 1) {
    Write-Error "expected exactly 1 runner after restart, found $($running.Count)"
    exit 1
}
$err = Get-Content (Join-Path $repo 'logs\runner-stderr-new.log') -ErrorAction SilentlyContinue
if ($err) {
    Write-Error "runner emitted stderr on startup: $err"
    exit 1
}
Write-Output "runner restarted ok: pid $($running[0].ProcessId)"
