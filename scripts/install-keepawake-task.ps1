<#
.SYNOPSIS
Registers scripts\keep-awake.ps1 as a scheduled task so the machine stays awake, which is
what keeps the phone dashboard answering outside market hours.

.DESCRIPTION
Named 'Alpaca Keep Awake' so it matches the 'Alpaca*' filter the dashboard's scheduled-task
panel already uses.

Three settings here are the difference between this working and silently not working on a
laptop, and none of them is the default:

  * ExecutionTimeLimit 0. Task Scheduler stops a task after three days unless told
    otherwise, which would end an indefinite hold mid-week with nothing to show why.
  * AllowStartIfOnBatteries and DontStopIfGoingOnBatteries. By default a task refuses to
    start on battery and is stopped when the machine unplugs - exactly the moment a laptop
    is about to sleep and take the tunnel with it.
  * RestartCount. If the hold dies, the machine silently becomes free to sleep again, so it
    is restarted rather than left down.

.PARAMETER Until
Hold until this time each day, as HH:mm. Ignored when -Forever is set.

.PARAMETER Forever
Hold indefinitely. This is the setting that keeps the phone dashboard reachable overnight.

.EXAMPLE
.\install-keepawake-task.ps1 -Forever

.EXAMPLE
.\install-keepawake-task.ps1 -Until 23:30
Awake through the evening, asleep overnight.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^([01]?\d|2[0-3]):[0-5]\d$')]
    [string]$Until = '23:30',
    [switch]$Forever
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'keep-awake.ps1'
$taskName = 'Alpaca Keep Awake'

if (-not (Test-Path $script)) { throw "keep-awake script not found at $script" }

$scriptArgs = if ($Forever) { '-Forever' } else { "-Until $Until" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" $scriptArgs" `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

# An older hand-made task holding the machine awake on the original 16:45 schedule would sit
# alongside this one and make it unclear which is in force.
$existing = Get-ScheduledTask -TaskName 'Alpaca*' -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -ne $taskName -and ($_.Actions.Arguments -join ' ') -match 'keep-awake' }
foreach ($t in $existing) {
    Write-Warning "another task also runs keep-awake.ps1: '$($t.TaskName)'. Two holds do no harm, but disable it to keep this unambiguous:  Disable-ScheduledTask -TaskName '$($t.TaskName)'"
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "replaced existing task '$taskName'"
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Holds the machine awake so the bots and the phone dashboard stay reachable.' | Out-Null

Write-Output "registered '$taskName'  ($scriptArgs)"
Write-Output "start it now with:  Start-ScheduledTask -TaskName '$taskName'"

# SetThreadExecutionState holds off the idle sleep timer. It does not override the lid
# switch, which is a separate power action - so on a laptop the machine still sleeps the
# moment the lid shuts, tunnel and all, no matter what this task is doing.
Write-Output ''
Write-Warning 'Closing the lid still sleeps the machine - that is a separate power setting this cannot override.'
Write-Output 'To keep it awake on mains with the lid shut (needs an elevated prompt):'
Write-Output '    powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0'
Write-Output '    powercfg /setactive SCHEME_CURRENT'
Write-Output 'Undo that with LIDACTION 1 (sleep).'
