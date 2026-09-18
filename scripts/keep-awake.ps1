<#
.SYNOPSIS
Holds the system awake (allows display off, prevents sleep) until a given time.

.DESCRIPTION
Uses SetThreadExecutionState, the same mechanism video players use - no power-plan changes,
releases on exit.

The default holds until 16:45, covering market hours plus the 16:30 nightly review, and then
lets the laptop sleep at night as usual. If launched after that time it exits immediately.

That default is also why the phone dashboard is unreachable in the evening: when the machine
sleeps, the status server and the ngrok tunnel go with it, and the app shows ERR_NGROK_3200.
If you want to check the bots from your phone after hours - reasonable, since two strategies
hold positions overnight - run this with -Forever, or with a later -Until, from whatever
starts it. The cost is a machine that does not sleep, so it is left as a choice.

.PARAMETER Until
Local time to hold until, as HH:mm. Default 16:45.

.PARAMETER Forever
Hold indefinitely, until the process is stopped. Overrides -Until.

.EXAMPLE
.\keep-awake.ps1
Original behaviour: hold until 16:45.

.EXAMPLE
.\keep-awake.ps1 -Until 23:30
Keeps the dashboard reachable from the phone through the evening.

.EXAMPLE
.\keep-awake.ps1 -Forever
Never sleeps while this runs.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^([01]?\d|2[0-3]):[0-5]\d$')]
    [string]$Until = '16:45',
    [switch]$Forever
)

$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$power = Add-Type -MemberDefinition $sig -Name PowerState -Namespace Win32 -PassThru
$ES_CONTINUOUS = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED = [uint32]'0x00000001'

$parts = $Until.Split(':')
$until = Get-Date -Hour ([int]$parts[0]) -Minute ([int]$parts[1]) -Second 0

if (-not $Forever -and (Get-Date) -ge $until) {
    Write-Output "past $($until.ToString('HH:mm')) - nothing to hold awake, exiting"
    exit 0
}

$prev = $power::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
if ($prev -eq 0) {
    Write-Error 'SetThreadExecutionState failed'
    exit 1
}

# The release has to happen on the way out however that happens, or a stopped script leaves
# the machine permanently unable to sleep with nothing on screen to explain why.
try {
    if ($Forever) {
        Write-Output 'holding system awake indefinitely - stop this process to release'
        while ($true) { Start-Sleep -Seconds 60 }
    } else {
        Write-Output "holding system awake until $($until.ToString('HH:mm'))"
        while ((Get-Date) -lt $until) { Start-Sleep -Seconds 60 }
    }
} finally {
    $power::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    Write-Output 'released - normal sleep policy resumes'
}
