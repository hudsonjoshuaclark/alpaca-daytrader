# Nightly review entrypoint (Windows scheduled task, weekdays 16:30 ET).
# Runs the Sonnet review agent under the AGENT-REVIEW.md protocol, then enforces the
# risk-cap guard. If the guard reverts a bad config, the runner is restarted so the
# reverted file is what's actually loaded in memory.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$date = Get-Date -Format 'yyyy-MM-dd'
New-Item -ItemType Directory -Force (Join-Path $repo 'logs\reviews') | Out-Null
$transcript = Join-Path $repo "logs\reviews\$date-transcript.txt"

# Weekend/holiday cheap-skip: if today's trade log has no DAY_END and no ENTRY_ORDER,
# there was no session worth reviewing (runner idles on non-trading days).
$log = Join-Path $repo 'logs\trade-log.jsonl'
$todayUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$todayEvents = @()
if (Test-Path $log) {
    $todayEvents = @(Get-Content $log | Where-Object { $_ -match ('"ts":"' + $todayUtc) })
}
if (-not ($todayEvents -match '"event":"(DAY_END|ENTRY_ORDER|ERROR)"')) {
    "No trading activity or errors dated $todayUtc — skipping review." | Out-File $transcript -Encoding utf8
    exit 0
}

& claude -p (Get-Content (Join-Path $repo 'AGENT-REVIEW.md') -Raw) `
    --model claude-sonnet-5 `
    --permission-mode acceptEdits `
    --allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Bash(node:*)" "Bash(git:*)" "Bash(powershell:*)" "Bash(Get-*)" `
    --max-turns 100 `
    *> $transcript

# Enforce risk caps regardless of what the agent did.
node --env-file=.env scripts\guard-config.js *>> $transcript
if ($LASTEXITCODE -ne 0) {
    "guard reverted config — restarting runner with restored file" | Out-File $transcript -Append -Encoding utf8
    powershell -NoProfile -File (Join-Path $repo 'scripts\restart-runner.ps1') *>> $transcript
}
