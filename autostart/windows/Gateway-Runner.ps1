# Gateway-Runner.ps1
#
# The actual "make it run, hidden, exactly once" logic for the Cursor-OpenAI
# gateway on Windows. This is what the Startup-folder shortcut invokes at
# logon (via `powershell -WindowStyle Hidden -File Gateway-Runner.ps1`), and
# it's also safe to run by hand any time you want to (re)start the gateway
# in the background - it never opens a console window of its own and it
# never prompts for input.
#
# Responsibilities, in order:
#   1. Refuse to run twice - if a gateway process we started (tracked in
#      the PID file, verified by command line) is already alive, do nothing
#      and exit cleanly.
#   2. Port-occupancy guard - if the configured port is already served by a
#      healthy gateway this toolkit wasn't tracking (manual `npm start`,
#      pre-toolkit leftover), adopt it into the PID file instead of
#      starting a duplicate; if the port is held by anything that is NOT
#      answering /health, refuse loudly rather than letting node silently
#      drift onto a fallback port (split-brain: two gateways, one project).
#   3. Verify prerequisites (Node.js on PATH) with a clear, logged error if
#      missing - never hang, never pop a dialog.
#   4. Build the project if this is a first run (no node_modules / no
#      dist/index.js yet), mirroring start.bat/start.sh.
#   5. Rotate the previous run's log to *.log.1 so logs don't grow forever
#      across many reboots.
#   6. Launch `node dist/index.js` completely hidden (no window, detached
#      from this script's process so it keeps running after this script
#      exits) and record its PID.
#   7. Confirm it actually came up by polling /health for up to 20 seconds,
#      detecting an immediate crash and cleaning the PID file if so.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$paths = Get-GatewayPaths
Initialize-GatewayDirs -Paths $paths

function Exit-Runner {
    param([int] $Code)
    exit $Code
}

Write-AutostartLog -Paths $paths -Message 'Gateway-Runner starting.'

# --- 1. Single-instance guard (our own PID file) --------------------------------
$existing = Get-ManagedGatewayProcess -Paths $paths
if ($existing) {
    Write-AutostartLog -Paths $paths -Message "Already running as PID $($existing.Id). Nothing to do."
    Exit-Runner 0
}

# --- 1b. Port-occupancy guard (catches anything the PID file doesn't know about) -
# A PID file only tracks processes *this* script launched. It says nothing
# about a leftover process from a manual `npm start`, an old/removed
# autostart setup, or an unrelated program already bound to the port. If we
# skipped this check and launched anyway, node's own port-fallback behavior
# would silently start a *second*, un-tracked gateway on the next free port
# - two processes for one project, with our PID file and health checks
# quietly pointed at the wrong one. Refuse to get into that state instead.
$configuredPort = Get-ConfiguredPort -Paths $paths
$portListener = Get-PortListener -Port $configuredPort
if ($portListener) {
    $ownerPid = [int]$portListener.OwningProcess
    $health = Test-GatewayHealth -Port $configuredPort
    if ($health -and (Test-ProcessLooksLikeGateway -ProcessId $ownerPid)) {
        # Already a healthy instance of our own gateway that the PID file
        # didn't know about - adopt it rather than starting a duplicate.
        Set-Content -LiteralPath $paths.PidFile -Value $ownerPid -Encoding ascii
        Write-AutostartLog -Paths $paths -Message "Port $configuredPort already served by a healthy gateway (PID $ownerPid, uptimeSeconds=$($health.uptimeSeconds)) not previously tracked - adopted it instead of starting a duplicate."
        Exit-Runner 0
    } elseif ($health) {
        # /health answers, but the listening process is not a directly
        # managed `node ... index.js` (e.g. a Docker-published port or some
        # other supervisor's copy). Adopting its PID would be wrong - our
        # stop/status logic would either mistrust it as stale or kill a
        # process another supervisor owns. Leave it untracked; the goal
        # (exactly one healthy gateway, no duplicate) is already met.
        Write-AutostartLog -Paths $paths -Message "Port $configuredPort is served by a healthy gateway, but PID $ownerPid is not a directly-managed node process (Docker? another supervisor?). Leaving it untracked; not starting a duplicate."
        Exit-Runner 0
    } else {
        Write-AutostartLog -Paths $paths -Message "ERROR: port $configuredPort is already in use by PID $ownerPid and it is not answering /health. Refusing to start a second, conflicting instance. Free the port (e.g. Stop-Process -Id $ownerPid) or change PORT in .env, then retry."
        Exit-Runner 1
    }
}

# --- 2. Prerequisites ----------------------------------------------------------
$node = Get-NodeCommand
if (-not $node) {
    Write-AutostartLog -Paths $paths -Message 'ERROR: node.exe not found on PATH. Install Node.js 22.13+ from https://nodejs.org, then try again.'
    Exit-Runner 1
}

Set-Location -LiteralPath $paths.ProjectRoot

# --- 3. First-run build safety net ---------------------------------------------
if (-not (Test-Path -LiteralPath $paths.NodeModules)) {
    Write-AutostartLog -Paths $paths -Message 'node_modules missing - running "npm install" (first run only, this can take a minute)...'
    $installLog = Join-Path $paths.LogDir 'autostart-npm-install.log'
    & cmd.exe /c "npm install > `"$installLog`" 2>&1"
    if ($LASTEXITCODE -ne 0) {
        Write-AutostartLog -Paths $paths -Message "ERROR: npm install failed (exit $LASTEXITCODE). See $installLog for details."
        Exit-Runner 1
    }
}

if (-not (Test-Path -LiteralPath $paths.DistEntry)) {
    Write-AutostartLog -Paths $paths -Message 'dist/index.js missing - running "npm run build" (first run only)...'
    $buildLog = Join-Path $paths.LogDir 'autostart-npm-build.log'
    & cmd.exe /c "npm run build > `"$buildLog`" 2>&1"
    if ($LASTEXITCODE -ne 0) {
        Write-AutostartLog -Paths $paths -Message "ERROR: npm run build failed (exit $LASTEXITCODE). See $buildLog for details."
        Exit-Runner 1
    }
}

# --- 4. Log rotation (keep one previous run, never grow unbounded) -------------
foreach ($log in @($paths.StdOutLog, $paths.StdErrLog)) {
    if (Test-Path -LiteralPath $log) {
        $rotated = "$log.1"
        Move-Item -LiteralPath $log -Destination $rotated -Force -ErrorAction SilentlyContinue
    }
}

# --- 5. Launch, hidden and detached ---------------------------------------------
# The gateway auto-opens the dashboard in a browser on every boot when
# AUTO_OPEN_BROWSER is unset (it defaults to true, for interactive
# start.bat first-runs). For a hidden logon autostart that would mean a
# browser tab popping up at every login - so unless the user has made an
# explicit choice in .env, suppress it via the child's environment (dotenv
# never overrides variables that are already set, and the project's own
# Dockerfile establishes this same convention for non-interactive runs).
$envSetsAutoOpen = $false
if (Test-Path -LiteralPath $paths.EnvFile) {
    $envSetsAutoOpen = [bool](Select-String -LiteralPath $paths.EnvFile -Pattern '^\s*AUTO_OPEN_BROWSER\s*=' -Quiet)
}
if (-not $envSetsAutoOpen) {
    $env:AUTO_OPEN_BROWSER = 'false'
}

try {
    $process = Start-Process -FilePath $node.Source `
        -ArgumentList @('dist/index.js') `
        -WorkingDirectory $paths.ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $paths.StdOutLog `
        -RedirectStandardError $paths.StdErrLog `
        -PassThru
} catch {
    Write-AutostartLog -Paths $paths -Message "ERROR: failed to launch node.exe: $($_.Exception.Message)"
    Exit-Runner 1
}

Set-Content -LiteralPath $paths.PidFile -Value $process.Id -Encoding ascii
Write-AutostartLog -Paths $paths -Message "Launched node dist/index.js as PID $($process.Id)."

# --- 6. Confirm it actually came up ---------------------------------------------
$port = $configuredPort
$deadline = (Get-Date).AddSeconds(20)
$healthy = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        Write-AutostartLog -Paths $paths -Message "ERROR: process exited before becoming healthy. Check $($paths.StdErrLog)."
        Remove-Item -LiteralPath $paths.PidFile -Force -ErrorAction SilentlyContinue
        Exit-Runner 1
    }
    $healthy = Test-GatewayHealth -Port $port
    if ($healthy) { break }
}

if ($healthy) {
    # Startup-race resolution. The pre-launch port check (section 1b) is not
    # atomic with the launch: two runners firing at once (double logon event,
    # overlapping manual + scheduled starts) can BOTH see the port free, and
    # the loser's gateway silently falls back to the next port up - leaving
    # two gateways for one repo, with the PID file pointing at the wrong one
    # (observed in practice, not hypothetical). If the configured port's
    # healthy listener is a gateway process that ISN'T the child we just
    # launched, we lost the race: kill our own child (ours to kill - it's on
    # a fallback port nobody is configured to use) and adopt the winner.
    $portOwner = Get-PortListener -Port $port
    if ($portOwner -and [int]$portOwner.OwningProcess -ne $process.Id -and (Test-ProcessLooksLikeGateway -ProcessId ([int]$portOwner.OwningProcess))) {
        Write-AutostartLog -Paths $paths -Message "Lost a startup race: port $port is served by PID $($portOwner.OwningProcess), not our child $($process.Id). Stopping our duplicate and adopting the winner."
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Set-Content -LiteralPath $paths.PidFile -Value ([int]$portOwner.OwningProcess) -Encoding ascii
        Exit-Runner 0
    }
    Write-AutostartLog -Paths $paths -Message "Healthy on port $port (uptimeSeconds=$($healthy.uptimeSeconds))."
    Exit-Runner 0
} else {
    Write-AutostartLog -Paths $paths -Message "WARNING: process is running (PID $($process.Id)) but did not answer /health on port $port within 20s. It may have started on a fallback port (see $($paths.StdOutLog)) - this is not necessarily an error."
    Exit-Runner 0
}
