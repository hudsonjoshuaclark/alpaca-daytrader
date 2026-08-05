# Overnight-drift EXIT leg (Windows scheduled task, weekdays ~09:35 ET, 5 min after the
# 09:30 open - gives the opening auction a moment to settle before market-closing).
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

node --env-file=strategies/overnight-drift/.env.overnight strategies/overnight-drift/exit.js *>> strategies/overnight-drift/logs/exit-stdout.log
