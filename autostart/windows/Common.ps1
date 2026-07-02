# Shared helpers for the Cursor-OpenAI gateway autostart scripts (Windows).
# Dot-sourced by Gateway-Runner.ps1, Install-Autostart.ps1, Uninstall-Autostart.ps1,
# Status.ps1 and Stop-Gateway.ps1 - keep this file free of side effects (no auto-run
# code at the bottom) so it is safe to import from any of them.

$ErrorActionPreference = 'Stop'

function Get-ProjectRoot {
    # This file lives at <ProjectRoot>\autostart\windows\Common.ps1
    $windowsDir = Split-Path -Parent $PSCommandPath
    $autostartDir = Split-Path -Parent $windowsDir
    return Split-Path -Parent $autostartDir
}

function Get-GatewayPaths {
    $projectRoot = Get-ProjectRoot
    $stateDir = Join-Path $projectRoot '.cursor-gateway'
    $logDir = Join-Path $projectRoot 'logs'

    return [pscustomobject]@{
        ProjectRoot   = $projectRoot
        StateDir      = $stateDir
        LogDir        = $logDir
        PidFile       = Join-Path $stateDir 'autostart.pid'
        SettingsFile  = Join-Path $stateDir 'settings.json'
        AutostartLog  = Join-Path $logDir 'autostart.log'
        StdOutLog     = Join-Path $logDir 'gateway.log'
        StdErrLog     = Join-Path $logDir 'gateway.err.log'
        EnvFile       = Join-Path $projectRoot '.env'
        DistEntry     = Join-Path $projectRoot 'dist\index.js'
        NodeModules   = Join-Path $projectRoot 'node_modules'
        ShortcutName  = 'Cursor-OpenAI-Gateway-Autostart.lnk'
    }
}

function Initialize-GatewayDirs {
    param([Parameter(Mandatory)] $Paths)
    foreach ($dir in @($Paths.StateDir, $Paths.LogDir)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
}

function Write-AutostartLog {
    param(
        [Parameter(Mandatory)] [string] $Message,
        [Parameter(Mandatory)] $Paths
    )
    Initialize-GatewayDirs -Paths $Paths
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'), $Message
    Add-Content -LiteralPath $Paths.AutostartLog -Value $line -Encoding utf8
}

function Get-ConfiguredPort {
    # Port resolution mirrors the gateway's own precedence exactly
    # (src/config.ts loadConfig + src/configStore.ts applyPersistedOverlay):
    #   1. .cursor-gateway/settings.json - the dashboard-persisted overlay,
    #      written by the gateway as a full AppConfig dump with a top-level
    #      numeric "port". Applied over the environment at every boot, so it
    #      WINS over .env when both exist.
    #   2. .env's PORT - last assignment wins (dotenv semantics: later keys
    #      in the file overwrite earlier ones), quoted values and inline
    #      comments tolerated.
    #   3. The built-in default, 8787.
    # Getting this wrong is not cosmetic: launching against the wrong port
    # defeats the port-occupancy guard and can silently produce a second
    # gateway on a fallback port.
    param([Parameter(Mandatory)] $Paths)

    if (Test-Path -LiteralPath $Paths.SettingsFile) {
        try {
            $settings = Get-Content -LiteralPath $Paths.SettingsFile -Raw -ErrorAction Stop | ConvertFrom-Json
            $candidate = 0
            if ($settings -and $settings.PSObject.Properties['port'] -and
                [int]::TryParse([string]$settings.port, [ref] $candidate) -and
                $candidate -ge 1 -and $candidate -le 65535) {
                return $candidate
            }
        } catch {
            # Malformed settings.json - the gateway itself ignores it and
            # falls back to the environment, so we do the same.
        }
    }

    if (Test-Path -LiteralPath $Paths.EnvFile) {
        $envPortMatches = @(Select-String -LiteralPath $Paths.EnvFile -Pattern '^\s*PORT\s*=\s*["'']?(\d{1,5})["'']?\s*(#.*)?$' -ErrorAction SilentlyContinue)
        if ($envPortMatches.Count -gt 0) {
            $candidate = [int]$envPortMatches[-1].Matches[0].Groups[1].Value
            if ($candidate -ge 1 -and $candidate -le 65535) {
                return $candidate
            }
        }
    }

    return 8787
}

function Get-NodeCommand {
    return Get-Command node.exe -ErrorAction SilentlyContinue
}

function Test-ProcessLooksLikeGateway {
    # True when $ProcessId is a live node.exe whose command line references
    # index.js (matching how every launcher in this toolkit and the project
    # itself starts the gateway: `node dist/index.js` or an absolute-path
    # variant). Used before adopting or stopping a PID so a recycled PID -
    # or an unrelated node.exe such as an editor's bundled tsserver helper,
    # which is also literally named node.exe - is never mistaken for the
    # gateway and force-killed by Stop-Gateway.ps1.
    #
    # If the command line can't be read at all (rare - access denied), the
    # check stays permissive on the name-only match rather than declaring a
    # possibly-live gateway stale.
    param([Parameter(Mandatory)] [int] $ProcessId)

    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne 'node') {
        return $false
    }

    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($cim -and $cim.CommandLine) {
        return ($cim.CommandLine -like '*index.js*')
    }
    return $true
}

function Get-ManagedGatewayProcess {
    # Resolves the PID file to a live Process object, or $null. Cleans up a
    # stale PID file (process exited, or the PID was recycled by anything
    # that isn't this gateway's node process - verified by command line,
    # not just process name) so callers never have to special-case that.
    param([Parameter(Mandatory)] $Paths)

    if (-not (Test-Path -LiteralPath $Paths.PidFile)) {
        return $null
    }

    $rawPid = (Get-Content -LiteralPath $Paths.PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $parsedPid = 0
    if (-not [int]::TryParse($rawPid, [ref] $parsedPid)) {
        Remove-Item -LiteralPath $Paths.PidFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    if (-not (Test-ProcessLooksLikeGateway -ProcessId $parsedPid)) {
        Remove-Item -LiteralPath $Paths.PidFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    return Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
}

function Test-GatewayHealth {
    param(
        [Parameter(Mandatory)] [int] $Port,
        [int] $TimeoutSeconds = 3
    )
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec $TimeoutSeconds
        if ($response.StatusCode -eq 200) {
            return $response.Content | ConvertFrom-Json
        }
    } catch {
        return $null
    }
    return $null
}

function Get-PortListener {
    # Returns the first LISTEN-state TCP connection on $Port, or $null.
    # Used to detect "something is already on this port" independent of
    # whether it's a process we're tracking via the PID file - a PID file
    # only tells us about processes *we* launched; a leftover/orphaned
    # instance from a previous manual run, an old removed setup, or a
    # completely unrelated program can all be listening without ever
    # appearing there.
    param([Parameter(Mandatory)] [int] $Port)
    return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-StartupShortcutPath {
    param([Parameter(Mandatory)] $Paths)
    $startupDir = [Environment]::GetFolderPath('Startup')
    return Join-Path $startupDir $Paths.ShortcutName
}
