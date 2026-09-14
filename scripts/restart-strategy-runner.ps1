# Safely restart one strategy bot's continuous runner (credit-spread or swing-signals),
# with the same discipline scripts/restart-runner.ps1 applies to ORB-15: kill every matching
# process, start exactly one, verify it stayed up and wrote a fresh heartbeat.
#
# These two bots previously had NO restart script at all - restarting them meant matching
# processes by hand, which is exactly the operation you least want to improvise, since a
# too-broad match kills the other live bots. The process filter here is anchored to the
# strategy's own runner path so it can never select ORB-15's root runner.js or a sibling
# strategy.
#
# Usage: powershell -File scripts\restart-strategy-runner.ps1 -Strategy credit-spread
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('credit-spread', 'overnight-momentum', 'swing-signals')]
    [string]$Strategy
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# swing-signals is RETIRED (2026-08-14, no demonstrated edge - see its config.js). It is kept
# here so the script still works if someone deliberately restarts it, but its scheduled task
# is disabled and overnight-momentum now runs on that account.
$envFile = switch ($Strategy) {
    'credit-spread'      { "strategies\credit-spread\.env.creditspread" }
    'overnight-momentum' { "strategies\overnight-momentum\.env.overnightmomentum" }
    'swing-signals'      { "strategies\swing-signals\.env.swing" }
}
$runnerRel = "strategies\$Strategy\runner.js"
$runnerAbs = Join-Path $repo $runnerRel
$logs = Join-Path $repo "strategies\$Strategy\logs"

if (-not (Test-Path $runnerAbs)) { Write-Error "no runner at $runnerAbs"; exit 1 }
if (-not (Test-Path (Join-Path $repo $envFile))) { Write-Error "no env file at $envFile"; exit 1 }

# Fail fast on a syntax error rather than killing a working bot and failing to start it.
& "C:\Program Files\nodejs\node.exe" --check $runnerAbs
if ($LASTEXITCODE -ne 0) { Write-Error "$runnerRel failed node --check - not restarting"; exit 1 }

# Match on this strategy's own path only. Backslashes are regex-escaped so 'credit-spread'
# can't accidentally match another bot's command line.
$pattern = [regex]::Escape("strategies\$Strategy\runner.js")
$existing = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match $pattern })
foreach ($p in $existing) {
    Write-Output "stopping $Strategy runner pid $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 2

$stdout = Join-Path $logs 'runner-stdout.log'
$stderr = Join-Path $logs 'runner-stderr.log'
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList "--env-file=$envFile", $runnerRel `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Start-Sleep -Seconds 8

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match $pattern })
if ($running.Count -ne 1) {
    Write-Error "expected exactly 1 $Strategy runner after restart, found $($running.Count)"
    exit 1
}
$err = Get-Content $stderr -ErrorAction SilentlyContinue
if ($err) {
    Write-Error "$Strategy runner emitted stderr on startup: $err"
    exit 1
}

# A live process that never ticks is still a dead bot - require a heartbeat it wrote itself.
$hbFile = Join-Path $logs 'heartbeat.json'
if (Test-Path $hbFile) {
    $hb = (Get-Content $hbFile -Raw | ConvertFrom-Json).ts
    $ageSec = [int]((Get-Date).ToUniversalTime() - [datetime]::Parse($hb).ToUniversalTime()).TotalSeconds
    if ($ageSec -gt 60) { Write-Error "$Strategy heartbeat is ${ageSec}s stale after restart"; exit 1 }
    Write-Output "$Strategy restarted ok: pid $($running[0].ProcessId), heartbeat ${ageSec}s old"
} else {
    Write-Error "$Strategy wrote no heartbeat after restart"
    exit 1
}
