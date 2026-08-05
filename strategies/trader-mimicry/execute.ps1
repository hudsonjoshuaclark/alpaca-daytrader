# Trader-mimicry EXECUTE leg (Windows scheduled task, weekdays ~09:40 ET, shortly after
# the 09:30 open so quotes are live). Plain code, no LLM - reads logs/proposal.json
# (written earlier by propose.ps1) and either places one order or does nothing.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

node --env-file=strategies\trader-mimicry\.env.mimicry strategies\trader-mimicry\execute.js *>> strategies\trader-mimicry\logs\execute-stdout.log
