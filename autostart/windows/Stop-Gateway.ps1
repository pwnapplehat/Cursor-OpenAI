# Stop-Gateway.ps1
#
# Stops the gateway process that Gateway-Runner.ps1 started (tracked via the
# PID file), without touching anything it didn't start.
#
# Edge cases handled deliberately:
#   - No PID file at all -> say so, exit 0 (nothing to do).
#   - PID file present but stale (process gone / PID recycled by anything
#     that isn't this gateway's node process, verified by command line) ->
#     Get-ManagedGatewayProcess already cleans this up; report it, exit 0.
#   - Something else entirely is listening on the configured port (started
#     manually, e.g. via `npm start` in a terminal) -> explicitly do NOT
#     kill it, since we didn't start it and don't own its lifecycle. Warn
#     the user instead.
#
# Note on -Force: a hidden, console-less process on Windows has no message
# loop / Ctrl+C handler an external script can signal gracefully (there is
# no real SIGTERM on Windows). We therefore hard-kill it. For this gateway
# that only means an in-flight request or two gets dropped locally - no
# different from what already happens on a reboot or sleep, which is the
# scenario this whole toolkit exists to survive.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$paths = Get-GatewayPaths
Initialize-GatewayDirs -Paths $paths

$managed = Get-ManagedGatewayProcess -Paths $paths

if ($managed) {
    Write-Host "Stopping managed gateway process (PID $($managed.Id))..."
    Stop-Process -Id $managed.Id -Force
    Remove-Item -LiteralPath $paths.PidFile -Force -ErrorAction SilentlyContinue
    Write-AutostartLog -Paths $paths -Message "Stopped by Stop-Gateway.ps1 (PID $($managed.Id))."
    Write-Host "Stopped."
    exit 0
}

Write-Host 'No managed gateway process found (PID file absent or stale).'

$port = Get-ConfiguredPort -Paths $paths
$listener = Get-PortListener -Port $port
if ($listener) {
    Write-Host ""
    Write-Host "NOTE: something IS listening on port $port (PID $($listener.OwningProcess)), but it wasn't started by this autostart toolkit (no matching PID file)."
    Write-Host "Leaving it alone - stop it yourself (e.g. the terminal/window that started it, or 'Stop-Process -Id $($listener.OwningProcess)') if you want it down."
}

exit 0
