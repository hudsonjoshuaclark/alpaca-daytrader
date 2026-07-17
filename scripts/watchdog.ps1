# Market-hours watchdog. Runs every 15 minutes on weekdays 9:15-16:10 ET.
# Tier 1 (free, instant): if the runner is dead/duplicated or the heartbeat is stale,
#   restart it with restart-runner.ps1 and re-check.
# Tier 2 (AI, rate-limited): if the restart does not restore health, invoke the Sonnet
#   troubleshooting agent (AGENT-TROUBLESHOOT.md). Max 1 agent run per 45 min, 3 per day.
# All actions append to logs\watchdog.log; agent transcripts go to logs\watchdog\.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$wdLog = Join-Path $repo 'logs\watchdog.log'
$stateFile = Join-Path $repo 'logs\watchdog-state.json'
New-Item -ItemType Directory -Force (Join-Path $repo 'logs\watchdog') | Out-Null

function Log($msg) {
    "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $msg" | Out-File $wdLog -Append -Encoding utf8
}

# gate: weekdays, market session only (machine runs Eastern time)
$now = Get-Date
if ($now.DayOfWeek -eq 'Saturday' -or $now.DayOfWeek -eq 'Sunday') { exit 0 }
$hm = $now.ToString('HH:mm')
if ($hm -lt '09:15' -or $hm -gt '16:10') { exit 0 }

function Get-Health {
    $runners = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'runner\.js' })
    $hbAge = 9999
    $hbFile = Join-Path $repo 'logs\heartbeat.json'
    if (Test-Path $hbFile) {
        try {
            $ts = (Get-Content $hbFile -Raw | ConvertFrom-Json).ts
            $hbAge = ((Get-Date) - ([DateTimeOffset]::Parse($ts)).LocalDateTime).TotalSeconds
        } catch {}
    }
    # recent ERROR events (last 15 minutes) in the trade log
    $errCount = 0
    $tradeLog = Join-Path $repo 'logs\trade-log.jsonl'
    if (Test-Path $tradeLog) {
        $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-15)
        foreach ($line in (Get-Content $tradeLog -Tail 60)) {
            if ($line -notmatch '"event":"ERROR"') { continue }
            if ($line -match '"ts":"([^"]+)"') {
                try {
                    if (([DateTimeOffset]::Parse($Matches[1])).UtcDateTime -gt $cutoff) { $errCount++ }
                } catch {}
            }
        }
    }
    $healthy = ($runners.Count -eq 1) -and ($hbAge -lt 120) -and ($errCount -lt 10)
    return [PSCustomObject]@{ Healthy = $healthy; Runners = $runners.Count; HeartbeatAge = [int]$hbAge; RecentErrors = $errCount }
}

$h = Get-Health
if ($h.Healthy) { exit 0 }
Log "UNHEALTHY: runners=$($h.Runners) heartbeatAge=$($h.HeartbeatAge)s recentErrors=$($h.RecentErrors)"

# ---- tier 1: deterministic restart ----
Log 'tier1: running restart-runner.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\restart-runner.ps1') 2>&1 | Out-File $wdLog -Append -Encoding utf8
Start-Sleep -Seconds 45
$h2 = Get-Health
if ($h2.Healthy) {
    Log "tier1 SUCCESS: runner healthy after restart (heartbeatAge=$($h2.HeartbeatAge)s)"
    exit 0
}
Log "tier1 failed: runners=$($h2.Runners) heartbeatAge=$($h2.HeartbeatAge)s recentErrors=$($h2.RecentErrors)"

# ---- tier 2: AI troubleshooter, rate-limited ----
$state = @{ date = ''; agentRunsToday = 0; lastAgentRun = '2000-01-01T00:00:00' }
if (Test-Path $stateFile) {
    try {
        $s = Get-Content $stateFile -Raw | ConvertFrom-Json
        $state = @{ date = $s.date; agentRunsToday = $s.agentRunsToday; lastAgentRun = $s.lastAgentRun }
    } catch {}
}
$today = (Get-Date).ToString('yyyy-MM-dd')
if ($state.date -ne $today) { $state.date = $today; $state.agentRunsToday = 0 }
$sinceLast = ((Get-Date) - [datetime]$state.lastAgentRun).TotalMinutes
if ($state.agentRunsToday -ge 3) {
    Log 'tier2 SKIPPED: 3 agent runs already today. Manual attention needed.'
    exit 1
}
if ($sinceLast -lt 45) {
    Log "tier2 SKIPPED: last agent run was $([int]$sinceLast) min ago (45 min cooldown; may still be working)."
    exit 1
}
$state.agentRunsToday++
$state.lastAgentRun = (Get-Date).ToString('s')
$state | ConvertTo-Json | Out-File $stateFile -Encoding utf8

$stamp = (Get-Date).ToString('yyyy-MM-dd-HHmm')
$transcript = Join-Path $repo "logs\watchdog\$stamp-transcript.txt"
Log "tier2: invoking troubleshooting agent (run $($state.agentRunsToday)/3 today) -> $transcript"
$null | & claude -p (Get-Content (Join-Path $repo 'AGENT-TROUBLESHOOT.md') -Raw) `
    --model claude-sonnet-5 `
    --permission-mode acceptEdits `
    --allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Bash(node:*)" "Bash(git:*)" "Bash(powershell:*)" `
    --max-turns 60 `
    *> $transcript

# enforce risk caps no matter what the agent did
node --env-file=.env (Join-Path $repo 'scripts\guard-config.js') 2>&1 | Out-File $wdLog -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    Log 'guard reverted config after agent run - restarting runner with restored file'
    powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\restart-runner.ps1') 2>&1 | Out-File $wdLog -Append -Encoding utf8
}

$h3 = Get-Health
Log "tier2 done: healthy=$($h3.Healthy) runners=$($h3.Runners) heartbeatAge=$($h3.HeartbeatAge)s"
