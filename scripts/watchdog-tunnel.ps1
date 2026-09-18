<#
.SYNOPSIS
Keeps the status dashboard and its ngrok tunnel alive. Run it every few minutes from Task
Scheduler (scripts\install-watchdog-task.ps1 registers it).

.DESCRIPTION
The phone dashboard is only reachable while two things are up: node serving port 4321, and
an ngrok agent with a live session for the reserved domain. Both die quietly - the laptop
sleeps, Defender quarantines ngrok.exe again, the free tier drops the agent session - and
nothing notices until you are away from the desk and the app shows ERR_NGROK_3200.

This restarts whichever half is down, using the same start scripts you would run by hand.

Health is checked by behaviour, not by process list. A node process can be alive and wedged;
an ngrok process can be running with no session at all after a wake from sleep. So the
dashboard is tested by asking it for a page, and the tunnel by asking ngrok's own local API
whether a session for the domain actually exists.

.PARAMETER Port
Port the status dashboard listens on. Default 4321, matching status-server.js.

.PARAMETER Domain
Reserved ngrok domain. Defaults to $env:NGROK_DOMAIN, which is what the start script reads.
#>
[CmdletBinding()]
param(
    [int]$Port = 4321,
    [string]$Domain = $env:NGROK_DOMAIN
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'watchdog.log'

function Write-Log([string]$message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -Path $logFile -Value $line
    Write-Output $line
}

# Any HTTP reply at all means node is answering. A 401 is the dashboard's basic auth working
# exactly as intended - treating it as "down" would restart a perfectly healthy server every
# five minutes forever. Only a refused or timed-out connection counts as down.
function Test-Dashboard {
    try {
        Invoke-WebRequest -Uri "http://localhost:$Port/phone" -TimeoutSec 8 -UseBasicParsing | Out-Null
        return $true
    } catch {
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

# ngrok's local agent API knows whether a session is actually established, which is the thing
# that matters and the thing a process check cannot see.
function Test-Tunnel {
    try {
        $api = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 8
    } catch {
        return $false
    }
    if (-not $api.tunnels) { return $false }
    # With no domain to compare against, an established tunnel is the best signal available.
    if ([string]::IsNullOrWhiteSpace($Domain)) { return $true }
    return [bool]($api.tunnels | Where-Object { $_.public_url -like "*$Domain*" })
}

# Runs every few minutes forever, so a line per healthy check would be thousands of lines of
# nothing a week. Only actions and faults are recorded.
$dashboardUp = Test-Dashboard
if (-not $dashboardUp) {
    Write-Log "dashboard not answering on localhost:$Port - restarting"
    try {
        & (Join-Path $PSScriptRoot 'start-status-server.ps1') | Out-Null
        Start-Sleep -Seconds 3
        if (Test-Dashboard) { Write-Log 'dashboard back up' }
        else { Write-Log 'dashboard STILL down after restart - check logs\status-server-stderr.log' }
    } catch {
        Write-Log "dashboard restart failed: $($_.Exception.Message)"
    }
}

# Checked after the dashboard, because the tunnel is only worth anything pointed at a live
# server. ngrok reconnects to a restarted backend on its own, so a dashboard restart alone
# does not require touching the tunnel.
if (-not (Test-Tunnel)) {
    if ([string]::IsNullOrWhiteSpace($Domain)) {
        # The scheduled-task environment is the usual reason this is empty, and the failure is
        # otherwise silent: start-ngrok-tunnel.ps1 throws and the task just reports an error.
        Write-Log 'NGROK_DOMAIN is not set for this process, so the tunnel cannot be started. Set it for your account with:  setx NGROK_DOMAIN "your-domain.ngrok-free.dev"  then sign out and back in.'
    } else {
        Write-Log "no ngrok session for $Domain - restarting the tunnel"
        try {
            # The start script reads the environment variable rather than a parameter, so a
            # -Domain passed only on the command line has to be put where it will look.
            $env:NGROK_DOMAIN = $Domain
            & (Join-Path $PSScriptRoot 'start-ngrok-tunnel.ps1') | Out-Null
            Start-Sleep -Seconds 4
            if (Test-Tunnel) { Write-Log 'tunnel back up' }
            else { Write-Log 'tunnel STILL down after restart - check logs\ngrok-stderr.log (Defender quarantine and the free tier one-session limit are the usual causes)' }
        } catch {
            Write-Log "tunnel restart failed: $($_.Exception.Message)"
        }
    }
}

# Keeps the log from growing without bound on a machine that runs this every five minutes.
try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 512KB) {
        $keep = Get-Content $logFile -Tail 2000
        Set-Content -Path $logFile -Value $keep
    }
} catch { }
