# Install-Autostart.ps1
#
# Installs a per-user autostart hook for the Cursor-OpenAI gateway: a
# shortcut in the current user's Startup folder
# (shell:startup, i.e. %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup)
# that silently runs Gateway-Runner.ps1 at every logon.
#
# Why the Startup folder instead of Task Scheduler: it requires no elevation
# and no stored credentials (Task Scheduler's `/sc onlogon` will refuse to
# register for the current user without an elevated prompt on many systems -
# this is the same "Access is denied" you'd hit trying that route manually),
# it is exactly how most consumer apps (Docker Desktop, Slack, etc.) register
# their own per-user autostart, and it's trivial to inspect/remove by hand
# (shell:startup in the Run dialog) even without these scripts.
#
# Safe to re-run: overwrites its own shortcut idempotently, never touches
# anything else in the Startup folder.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File Install-Autostart.ps1
#   powershell -ExecutionPolicy Bypass -File Install-Autostart.ps1 -SkipImmediateStart

param(
    [switch] $SkipImmediateStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$paths = Get-GatewayPaths
Initialize-GatewayDirs -Paths $paths

Write-Host "Cursor-OpenAI Gateway - install autostart"
Write-Host "Project: $($paths.ProjectRoot)"
Write-Host ""

$node = Get-NodeCommand
if (-not $node) {
    Write-Host "ERROR: node.exe was not found on PATH." -ForegroundColor Red
    Write-Host "Install Node.js 22.13+ from https://nodejs.org, then run this script again."
    exit 1
}
Write-Host "Found Node.js: $($node.Source)"

$runnerScript = Join-Path $PSScriptRoot 'Gateway-Runner.ps1'
if (-not (Test-Path -LiteralPath $runnerScript)) {
    Write-Host "ERROR: Gateway-Runner.ps1 not found next to this script ($runnerScript)." -ForegroundColor Red
    exit 1
}

$shortcutPath = Get-StartupShortcutPath -Paths $paths
$alreadyInstalled = Test-Path -LiteralPath $shortcutPath

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
# Always target the system's Windows PowerShell 5.1 explicitly. Using
# $PSHOME here would break whenever this installer is run from PowerShell
# 7+ (pwsh): its $PSHOME contains pwsh.exe but no powershell.exe, and the
# resulting shortcut would silently do nothing at every logon.
$shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $runnerScript
$shortcut.WorkingDirectory = $paths.ProjectRoot
$shortcut.Description = 'Silently starts the Cursor-OpenAI gateway (local OpenAI-compatible bridge) at logon'
$shortcut.IconLocation = '{0},0' -f $node.Source
$shortcut.WindowStyle = 7  # minimized, belt-and-suspenders alongside -WindowStyle Hidden above
$shortcut.Save()

if ($alreadyInstalled) {
    Write-Host "Autostart was already installed - shortcut refreshed: $shortcutPath"
} else {
    Write-Host "Autostart shortcut installed: $shortcutPath"
}
Write-AutostartLog -Paths $paths -Message "Autostart installed/refreshed by Install-Autostart.ps1 -> $shortcutPath"

# A leftover shortcut under the old ad-hoc name would make TWO runners fire
# at every logon (the race resolution in Gateway-Runner converges them, but
# a duplicate registration should never persist). Same cleanup Uninstall
# does, applied on install too so re-installing always leaves exactly one.
$legacyShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'CursorOpenAIGateway.lnk'
if (Test-Path -LiteralPath $legacyShortcut) {
    Remove-Item -LiteralPath $legacyShortcut -Force
    Write-Host "Removed a leftover legacy autostart shortcut: $legacyShortcut"
    Write-AutostartLog -Paths $paths -Message "Legacy shortcut removed during install."
}

Write-Host ""
Write-Host "It will run silently (no window) the next time you log in to Windows."

if ($SkipImmediateStart) {
    Write-Host "Skipping immediate start (-SkipImmediateStart was passed)."
    exit 0
}

Write-Host ""
Write-Host "Starting the gateway now to verify everything works..."
& $runnerScript
$runnerExit = $LASTEXITCODE
if ($runnerExit -ne 0) {
    Write-Host "Gateway-Runner reported a problem (exit code $runnerExit) - see $($paths.AutostartLog) for the reason." -ForegroundColor Yellow
}

$port = Get-ConfiguredPort -Paths $paths
Start-Sleep -Seconds 1
$health = Test-GatewayHealth -Port $port
if ($health) {
    Write-Host "Gateway is up and healthy: http://localhost:$port (uptimeSeconds=$($health.uptimeSeconds))" -ForegroundColor Green
} else {
    $managed = Get-ManagedGatewayProcess -Paths $paths
    if ($managed) {
        Write-Host "Gateway process is running (PID $($managed.Id)) but did not answer /health on port $port yet." -ForegroundColor Yellow
        Write-Host "It may still be starting, or started on a fallback port - check $($paths.StdOutLog)."
    } else {
        Write-Host "Gateway did not start successfully. Check the logs:" -ForegroundColor Red
        Write-Host "  $($paths.AutostartLog)"
        Write-Host "  $($paths.StdErrLog)"
    }
}

Write-Host ""
Write-Host "Manage it any time with:"
Write-Host "  Status.ps1            - check install + running state"
Write-Host "  Stop-Gateway.ps1       - stop the running gateway"
Write-Host "  Uninstall-Autostart.ps1 - remove the logon autostart hook"
