# Trader-mimicry EXIT check (Windows scheduled task, weekdays ~15:50 ET, before the close).
# Multi-day swing hold, so one check per day is enough - closes on profit target, stop,
# or holding-period expiry, whichever comes first.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

node --env-file=strategies\trader-mimicry\.env.mimicry strategies\trader-mimicry\exit.js *>> strategies\trader-mimicry\logs\exit-stdout.log
