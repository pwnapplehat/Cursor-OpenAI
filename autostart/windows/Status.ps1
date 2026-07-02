# Status.ps1
#
# One-shot, read-only report of:
#   - whether the logon autostart hook is installed
#   - whether a gateway process this toolkit manages is currently running
#   - whether it's actually answering health checks
# Never modifies anything.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$paths = Get-GatewayPaths

Write-Host "Cursor-OpenAI Gateway - autostart status"
Write-Host "Project: $($paths.ProjectRoot)"
Write-Host ""

$shortcutPath = Get-StartupShortcutPath -Paths $paths
if (Test-Path -LiteralPath $shortcutPath) {
    Write-Host "Autostart:  INSTALLED" -ForegroundColor Green
    Write-Host "  $shortcutPath"
} else {
    Write-Host "Autostart:  NOT installed"
}

Write-Host ""

$managed = Get-ManagedGatewayProcess -Paths $paths
$port = Get-ConfiguredPort -Paths $paths

if ($managed) {
    $uptime = (Get-Date) - $managed.StartTime
    Write-Host "Process:    RUNNING (PID $($managed.Id), started $($managed.StartTime), up $([int]$uptime.TotalMinutes)m)" -ForegroundColor Green
} else {
    Write-Host "Process:    NOT running (no valid PID file at $($paths.PidFile))"
}

$health = Test-GatewayHealth -Port $port
if ($health) {
    Write-Host "Health:     OK  (http://localhost:$port/health, uptimeSeconds=$($health.uptimeSeconds), cachedAgents=$($health.sessions.cachedAgents))" -ForegroundColor Green
} else {
    $listener = Get-PortListener -Port $port
    if ($listener -and (-not $managed -or $listener.OwningProcess -ne $managed.Id)) {
        Write-Host "Health:     no response on port $port, but PID $($listener.OwningProcess) IS listening there (started outside this toolkit? run Gateway-Runner.ps1 to have it detected/adopted)" -ForegroundColor Yellow
    } else {
        Write-Host "Health:     no response on port $port"
    }
}

Write-Host ""
Write-Host "Logs:"
Write-Host "  Autostart events:  $($paths.AutostartLog)"
Write-Host "  Gateway stdout:    $($paths.StdOutLog)"
Write-Host "  Gateway stderr:    $($paths.StdErrLog)"
