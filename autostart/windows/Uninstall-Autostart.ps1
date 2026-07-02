# Uninstall-Autostart.ps1
#
# Removes the per-user Startup-folder autostart hook installed by
# Install-Autostart.ps1. By design this ONLY affects whether the gateway
# launches automatically at your next logon - it does NOT touch a gateway
# that is currently running, since "don't autostart anymore" and "stop it
# right now" are two different, independent decisions. Pass -StopRunning
# if you also want the currently-running managed instance stopped.
#
# Safe to run even if nothing was ever installed (no-op, exits 0).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File Uninstall-Autostart.ps1
#   powershell -ExecutionPolicy Bypass -File Uninstall-Autostart.ps1 -StopRunning

param(
    [switch] $StopRunning
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$paths = Get-GatewayPaths
Initialize-GatewayDirs -Paths $paths

$shortcutPath = Get-StartupShortcutPath -Paths $paths

if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Removed autostart shortcut: $shortcutPath"
    Write-AutostartLog -Paths $paths -Message "Autostart shortcut removed by Uninstall-Autostart.ps1."
} else {
    Write-Host "No autostart shortcut was installed (nothing to remove)."
}

# Clean up a known older/legacy shortcut name from a previous ad-hoc setup,
# if present, so re-running this script always leaves a clean Startup folder.
$legacyShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'CursorOpenAIGateway.lnk'
if (Test-Path -LiteralPath $legacyShortcut) {
    Remove-Item -LiteralPath $legacyShortcut -Force
    Write-Host "Removed legacy shortcut: $legacyShortcut"
    Write-AutostartLog -Paths $paths -Message "Legacy shortcut removed by Uninstall-Autostart.ps1."
}

if ($StopRunning) {
    $stopScript = Join-Path $PSScriptRoot 'Stop-Gateway.ps1'
    Write-Host ""
    Write-Host "Stopping the currently-running gateway (-StopRunning was passed)..."
    & $stopScript
} else {
    $managed = Get-ManagedGatewayProcess -Paths $paths
    if ($managed) {
        Write-Host ""
        Write-Host "Note: the gateway is still running right now (PID $($managed.Id)) - it just won't restart automatically at your next logon."
        Write-Host "Run Stop-Gateway.ps1, or this script with -StopRunning, if you want it stopped too."
    }
}

Write-Host ""
Write-Host "Autostart uninstalled."
