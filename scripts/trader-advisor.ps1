# Trader-attention advisory (Windows scheduled task, weekdays, two triggers on the same
# task: 09:00 ET pre-market — so there's a same-day snapshot on the dashboard before the
# bot's 09:45-11:30 entry window — and 16:00 ET post-close, 30 min before the 16:30 nightly
# review, so that report reflects how the day's sentiment/news actually played out. Each
# run overwrites the same logs/reviews/<date>-advisory.md, which is the point: the file
# always holds the most relevant version for whoever's reading it at the time.
# Gathers free StockTwits attention/sentiment signals for the bot's universe, then has a
# Sonnet research agent (AGENT-ADVISOR.md) turn them into a short written report. Advisory
# only — this agent cannot edit code or place trades; it only writes the report file for a
# human or the nightly review agent to read.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$date = Get-Date -Format 'yyyy-MM-dd'
New-Item -ItemType Directory -Force (Join-Path $repo 'logs\reviews') | Out-Null
$transcript = Join-Path $repo "logs\reviews\$date-advisor-transcript.txt"

node --env-file=.env scripts\trader-advisor.js *> $transcript
if ($LASTEXITCODE -ne 0) {
    "trader-advisor.js failed - skipping advisory report." | Out-File $transcript -Append -Encoding utf8
    exit 0
}

# Same stdin-close trick as nightly-review.ps1 to avoid claude's headless stdin wait.
$null | & claude -p (Get-Content (Join-Path $repo 'AGENT-ADVISOR.md') -Raw) `
    --model claude-sonnet-5 `
    --permission-mode acceptEdits `
    --allowedTools "Read" "Glob" "Grep" "Write" "WebSearch" "WebFetch" "Bash(node:*)" `
    --max-turns 40 `
    *>> $transcript
