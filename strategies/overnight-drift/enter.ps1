# Overnight-drift ENTRY leg (Windows scheduled task, weekdays ~15:55 ET, 5 min before the
# 16:00 close). One-shot script, not a continuous poll loop - this strategy only has two
# decision points per day.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

node --env-file=strategies/overnight-drift/.env.overnight strategies/overnight-drift/enter.js *>> strategies/overnight-drift/logs/enter-stdout.log
