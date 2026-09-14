# Ensures exactly one ngrok tunnel is running, publishing the status dashboard
# (http://localhost:4321) at the reserved ngrok domain given in $env:NGROK_DOMAIN
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$domain = if ($env:NGROK_DOMAIN) { $env:NGROK_DOMAIN } else { throw 'Set NGROK_DOMAIN to your reserved ngrok domain.' }
# Start-Process resolves -FilePath via the real PATH, not the App Execution Alias winget
# creates, so 'ngrok' alone isn't found — use the resolved binary path directly. This is
# the winget alias target (kept current by ngrok's own self-update); it's Defender-excluded
# (2026-07-24, after the self-updated binary was flagged Trojan:Win32/Kepavll!rfn and
# quarantined — a known false-positive pattern for ngrok — and restored).
$ngrokExe = if ($env:NGROK_EXE) { $env:NGROK_EXE } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ngrok.exe' }

$existing = Get-CimInstance Win32_Process -Filter "Name='ngrok.exe'"
foreach ($p in $existing) {
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 1

Start-Process -FilePath $ngrokExe -ArgumentList "http --url=$domain 4321" `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $repo 'logs\ngrok-stdout.log') `
    -RedirectStandardError (Join-Path $repo 'logs\ngrok-stderr.log')
Start-Sleep -Seconds 3
Write-Output "ngrok tunnel started: https://$domain"
