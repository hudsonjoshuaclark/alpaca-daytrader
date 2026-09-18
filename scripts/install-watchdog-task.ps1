<#
.SYNOPSIS
Registers scripts\watchdog-tunnel.ps1 as a scheduled task that runs every 5 minutes.

.DESCRIPTION
Named 'Alpaca Watchdog' so it matches the 'Alpaca*' filter the dashboard's scheduled-task
panel already uses, and shows up there with the rest of the bots' tasks.

Runs as the current user at logon, then repeats indefinitely. That needs no administrator
rights, but it does mean the task only runs while you are logged in - which is also the only
time the bots themselves run, so it costs nothing in practice.

Re-running this is safe; an existing task of the same name is replaced.

.PARAMETER IntervalMinutes
How often to check. Default 5.
#>
[CmdletBinding()]
param(
    [int]$IntervalMinutes = 5
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $PSScriptRoot 'watchdog-tunnel.ps1'
$taskName = 'Alpaca Watchdog'

if (-not (Test-Path $watchdog)) { throw "watchdog script not found at $watchdog" }

# A scheduled task gets a fresh environment, so a domain exported only in the shell you are
# typing in now will not be there when the task fires. start-ngrok-tunnel.ps1 throws without
# it and the failure is invisible unless you go reading the task's last result.
$domain = [Environment]::GetEnvironmentVariable('NGROK_DOMAIN', 'User')
if (-not $domain) { $domain = [Environment]::GetEnvironmentVariable('NGROK_DOMAIN', 'Machine') }
if (-not $domain) {
    Write-Warning 'NGROK_DOMAIN is not set persistently for your account or the machine.'
    Write-Warning 'The watchdog will keep the dashboard alive but cannot start the tunnel.'
    Write-Warning 'Fix it with:  setx NGROK_DOMAIN "your-domain.ngrok-free.dev"  then sign out and back in.'
} else {
    Write-Output "NGROK_DOMAIN resolves to: $domain"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`"" `
    -WorkingDirectory $repo

# One trigger at logon carrying an indefinite repetition, rather than a separate repeating
# trigger, so the first run happens as soon as you are logged in rather than up to an
# interval later.
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

# StartWhenAvailable is what makes this recover after the laptop wakes: a run missed while
# asleep fires as soon as it can instead of waiting for the next slot. The battery settings
# matter for the same reason - by default Task Scheduler refuses to start on battery and
# stops a running task when the machine unplugs, which is precisely when a laptop sleeps and
# the tunnel dies.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "replaced existing task '$taskName'"
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Restarts the status dashboard and ngrok tunnel if either stops answering.' | Out-Null

Write-Output "registered '$taskName', every $IntervalMinutes minute(s)"
Write-Output "run it once now with:  Start-ScheduledTask -TaskName '$taskName'"
Write-Output "watch what it does in: logs\watchdog.log"
