# Trader-mimicry PROPOSE leg (Windows scheduled task, weekdays ~08:30 ET, well before the
# 09:30 open). Gathers real SEC Form 4 insider-buy + StockTwits signals, then a Sonnet
# agent (AGENT-TRADER-MIMICRY.md) reviews them and writes AT MOST one trade proposal to
# logs/proposal.json. The agent has NO order-placing tool access - allowedTools below is
# read-only plus WebSearch/WebFetch, deliberately excluding Edit/Bash(order placement)/git.
# execute.ps1 (a separate, plain-code script) is the only thing that ever places an order.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

$date = Get-Date -Format 'yyyy-MM-dd'
$dir = 'strategies\trader-mimicry'
$transcript = Join-Path $repo "$dir\logs\$date-propose-transcript.txt"

node --env-file=$dir\.env.mimicry $dir\propose.js *> $transcript
if ($LASTEXITCODE -ne 0) {
    "propose.js signal-gathering failed - skipping agent review, no proposal today." | Out-File $transcript -Append -Encoding utf8
    exit 0
}

$null | & claude -p (Get-Content (Join-Path $repo "$dir\AGENT-TRADER-MIMICRY.md") -Raw) `
    --model claude-sonnet-5 `
    --permission-mode acceptEdits `
    --allowedTools "Read" "Glob" "Grep" "Write" "WebSearch" "WebFetch" `
    --max-turns 40 `
    *>> $transcript
