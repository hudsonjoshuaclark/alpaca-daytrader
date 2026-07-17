# Holds the system awake (allows display off, prevents sleep) from launch until 16:45,
# covering market hours plus the 16:30 nightly review. Uses SetThreadExecutionState,
# the same mechanism video players use - no power-plan changes, releases on exit.
# If launched after 16:45 it exits immediately, so the laptop can sleep at night as usual.
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$power = Add-Type -MemberDefinition $sig -Name PowerState -Namespace Win32 -PassThru
$ES_CONTINUOUS = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED = [uint32]'0x00000001'

$until = Get-Date -Hour 16 -Minute 45 -Second 0
if ((Get-Date) -ge $until) {
    Write-Output "past $($until.ToString('HH:mm')) - nothing to hold awake, exiting"
    exit 0
}

$prev = $power::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
if ($prev -eq 0) {
    Write-Error 'SetThreadExecutionState failed'
    exit 1
}
Write-Output "holding system awake until $($until.ToString('HH:mm'))"
while ((Get-Date) -lt $until) {
    Start-Sleep -Seconds 60
}
$power::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
Write-Output 'released - normal sleep policy resumes'
