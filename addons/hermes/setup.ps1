# setup.ps1 - Hermes Agent addon for the Cursor-OpenAI gateway (Windows).
#
# Configures Hermes Agent (https://hermes-agent.nousresearch.com) to use this
# gateway as a NAMED custom provider ("cursor"), which is what enables live
# /v1/models discovery in Hermes' /model picker (bare "provider: custom"
# deliberately shows only the configured model - verified in Hermes' source,
# hermes_cli/model_switch.py).
#
# Safe by design:
#   - Idempotent: re-running repairs/refreshes, never duplicates.
#   - Backs up Hermes' config.yaml (timestamped) before changing it.
#   - Never grows Hermes' custom_providers list via `hermes config set`
#     (its _set_nested would create a dict where a list belongs, corrupting
#     the config) - appends a fresh block only when the key is absent, and
#     refuses with the exact snippet to paste when a manual merge is needed.
#   - Never auto-runs Hermes' remote installer without -InstallHermes.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -LongRunning
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -NativeVision
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -TelegramToken 123:ABC -TelegramUser 111222333
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -InstallHermes -LongRunning -NativeVision
#
# Exit codes: 0 = fully configured, 1 = prerequisite missing, 2 = partial
# (something needs a manual step; details printed).

param(
    [switch] $LongRunning,
    [switch] $NativeVision,
    [string] $TelegramToken = '',
    [string] $TelegramUser = '',
    [switch] $InstallHermes,
    [string] $Model = 'composer-2.5',
    [string] $AuthKey = ''
)

$ErrorActionPreference = 'Stop'
$script:PartialSetup = $false

function Write-Step { param([string] $Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string] $Text) Write-Host "   $Text" -ForegroundColor Green }
function Write-Note { param([string] $Text) Write-Host "   $Text" -ForegroundColor Yellow }

# --- Locate the repo and resolve the gateway port ------------------------------
# This file lives at <repo>\addons\hermes\setup.ps1.
$addonDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $addonDir)
$repoEnv = Join-Path $repoRoot '.env'
$repoSettings = Join-Path $repoRoot '.cursor-gateway\settings.json'

function Get-GatewayPort {
    # Mirrors the gateway's own precedence: settings.json (dashboard overlay,
    # wins) -> .env PORT (last assignment wins; quotes/comments tolerated) -> 8787.
    if (Test-Path -LiteralPath $repoSettings) {
        try {
            $settings = Get-Content -LiteralPath $repoSettings -Raw | ConvertFrom-Json
            $candidate = 0
            if ($settings -and $settings.PSObject.Properties['port'] -and
                [int]::TryParse([string]$settings.port, [ref] $candidate) -and
                $candidate -ge 1 -and $candidate -le 65535) {
                return $candidate
            }
        } catch { }
    }
    if (Test-Path -LiteralPath $repoEnv) {
        $matches_ = @(Select-String -LiteralPath $repoEnv -Pattern '^\s*PORT\s*=\s*["'']?(\d{1,5})["'']?\s*(#.*)?$' -ErrorAction SilentlyContinue)
        if ($matches_.Count -gt 0) {
            $candidate = [int]$matches_[-1].Matches[0].Groups[1].Value
            if ($candidate -ge 1 -and $candidate -le 65535) { return $candidate }
        }
    }
    return 8787
}

function Test-GatewayHealth {
    param([int] $Port)
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { return $resp.Content | ConvertFrom-Json }
    } catch { return $null }
    return $null
}

$port = Get-GatewayPort
$baseUrl = "http://localhost:$port/v1"
$providerApiKey = if ($AuthKey) { $AuthKey } else { 'no-key-required' }

Write-Host "Hermes Agent addon - Cursor-OpenAI gateway integration" -ForegroundColor White
Write-Host "Repo: $repoRoot"
Write-Host "Gateway endpoint: $baseUrl"

# --- 1. Gateway up? -------------------------------------------------------------
Write-Step "Checking the gateway"
$health = Test-GatewayHealth -Port $port
if (-not $health) {
    $runner = Join-Path $repoRoot 'autostart\windows\Gateway-Runner.ps1'
    if (Test-Path -LiteralPath $runner) {
        Write-Note "Gateway not responding on port $port - starting it via the autostart toolkit..."
        & powershell -NoProfile -ExecutionPolicy Bypass -File $runner
        Start-Sleep -Seconds 2
        $health = Test-GatewayHealth -Port $port
    }
}
if ($health) {
    Write-Ok "Gateway healthy on port $port (uptimeSeconds=$($health.uptimeSeconds))."
} else {
    Write-Note "Gateway is NOT reachable on port $port. Continuing (the Hermes config written below is still correct),"
    Write-Note "but start the gateway before using Hermes: run start.bat, or install autostart\ (recommended)."
    $script:PartialSetup = $true
}

# --- 2. Hermes installed? ---------------------------------------------------------
Write-Step "Checking Hermes Agent"
$hermes = Get-Command hermes -ErrorAction SilentlyContinue
if (-not $hermes) {
    if ($InstallHermes) {
        Write-Note "Hermes not found - running the official installer (you passed -InstallHermes)..."
        Invoke-Expression (Invoke-RestMethod https://hermes-agent.nousresearch.com/install.ps1)
        # Refresh PATH view for this session, then re-check.
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        $hermes = Get-Command hermes -ErrorAction SilentlyContinue
    }
    if (-not $hermes) {
        Write-Host ""
        Write-Host "Hermes Agent is not installed." -ForegroundColor Red
        Write-Host "Install it with the official one-liner, then re-run this script:"
        Write-Host ""
        Write-Host "  iex (irm https://hermes-agent.nousresearch.com/install.ps1)" -ForegroundColor White
        Write-Host ""
        Write-Host "(or re-run this script with -InstallHermes to consent to running that for you)"
        exit 1
    }
}
$hermesVersion = (& hermes --version 2>$null | Select-Object -First 1)
Write-Ok "Found: $hermesVersion"

# --- 3. Locate + back up Hermes' config ---------------------------------------------
Write-Step "Backing up Hermes config"
$hermesConfigPath = (& hermes config path 2>$null | Select-Object -Last 1).Trim()
if (-not $hermesConfigPath) {
    Write-Host "Could not resolve Hermes' config path via 'hermes config path'." -ForegroundColor Red
    exit 1
}
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
if (Test-Path -LiteralPath $hermesConfigPath) {
    $backupPath = "$hermesConfigPath.bak-cursor-addon-$stamp"
    Copy-Item -LiteralPath $hermesConfigPath -Destination $backupPath
    Write-Ok "Backed up $hermesConfigPath -> $backupPath"
} else {
    Write-Note "No existing config.yaml yet (fresh Hermes install) - it will be created."
}

# --- 4. Named custom provider ("cursor") ----------------------------------------------
Write-Step "Registering the gateway as named provider 'cursor'"

# Scalar model.* keys are safe through `hermes config set` (creates the file
# if needed). Do these first.
& hermes config set model.provider "custom:cursor" | Out-Null
& hermes config set model.base_url $baseUrl | Out-Null
& hermes config set model.api_key $providerApiKey | Out-Null
& hermes config set model.default $Model | Out-Null
Write-Ok "model: provider=custom:cursor, base_url=$baseUrl, default=$Model"

# Belt-and-suspenders: Hermes' /model switches and dashboard "reset to auto"
# rewrite the model: block and strip base_url/api_key from it (observed
# repeatedly on v0.18). The named custom_providers entry below covers normal
# chat, but Hermes ALSO honors CUSTOM_BASE_URL / CUSTOM_API_KEY env fallbacks
# (hermes_cli/runtime_provider.py) on every custom-provider code path -
# including the bare "custom" label the stripped states degrade to. Pin them
# in Hermes' .env, which no UI action ever rewrites, so endpoint resolution
# survives any config.yaml mangling permanently.
$hermesEnvPath0 = (& hermes config env-path 2>$null | Select-Object -Last 1)
$hermesEnvPath0 = if ($hermesEnvPath0) { "$hermesEnvPath0".Trim() } else { '' }
if (-not $hermesEnvPath0) { $hermesEnvPath0 = Join-Path (Split-Path -Parent $hermesConfigPath) '.env' }
$envText0 = if (Test-Path -LiteralPath $hermesEnvPath0) { Get-Content -LiteralPath $hermesEnvPath0 -Raw } else { '' }
foreach ($pair in @(@('CUSTOM_BASE_URL', $baseUrl), @('CUSTOM_API_KEY', $providerApiKey))) {
    $name = $pair[0]; $value = $pair[1]
    if ($envText0 -match "(?m)^\s*$name\s*=") {
        $envText0 = $envText0 -replace "(?m)^\s*$name\s*=.*$", "$name=$value"
    } else {
        if ($envText0.Length -gt 0 -and -not $envText0.EndsWith("`n")) { $envText0 += "`n" }
        $envText0 += "$name=$value`n"
    }
}
Set-Content -LiteralPath $hermesEnvPath0 -Value $envText0 -Encoding utf8 -NoNewline
Write-Ok "CUSTOM_BASE_URL / CUSTOM_API_KEY pinned in Hermes' .env (survives /model-switch config stripping)"

# custom_providers needs care: `hermes config set` can navigate into an
# EXISTING list index but cannot create/grow the list (it would create a
# dict keyed '0' instead - a corrupt shape its own loaders reject).
$configText = if (Test-Path -LiteralPath $hermesConfigPath) { Get-Content -LiteralPath $hermesConfigPath -Raw } else { '' }

# Minimal scan of the custom_providers block: entry indices + the index of
# the entry named 'cursor', if any. Matches the YAML shape Hermes itself
# writes (top-level key, two-space list items).
$cursorIndex = -1
$blockExists = $false
$entryIndex = -1
$inBlock = $false
foreach ($line in ($configText -split "`r?`n")) {
    if ($line -match '^custom_providers\s*:') { $inBlock = $true; $blockExists = $true; continue }
    if ($inBlock) {
        if ($line -match '^\S') { $inBlock = $false; continue }   # next top-level key
        if ($line -match '^\s*-\s') { $entryIndex++ }
        if ($line -match '^\s*-?\s*name\s*:\s*(\S+)\s*$' -and $Matches[1].Trim("'`"") -eq 'cursor') {
            $cursorIndex = $entryIndex
        }
    }
}

if ($cursorIndex -ge 0) {
    & hermes config set "custom_providers.$cursorIndex.base_url" $baseUrl | Out-Null
    & hermes config set "custom_providers.$cursorIndex.api_key" $providerApiKey | Out-Null
    Write-Ok "custom_providers[$cursorIndex] 'cursor' already present - refreshed base_url/api_key."
} elseif (-not $blockExists) {
    $snippet = @"
custom_providers:
  - name: cursor
    base_url: $baseUrl
    api_key: $providerApiKey
"@
    if ($configText.Length -gt 0 -and -not $configText.EndsWith("`n")) { $snippet = "`n" + $snippet }
    Add-Content -LiteralPath $hermesConfigPath -Value $snippet -Encoding utf8
    Write-Ok "Added custom_providers block with the 'cursor' entry."
} else {
    # custom_providers exists but has no 'cursor' entry, and there is no safe
    # non-interactive way to append a list item through Hermes' CLI. Refuse
    # to guess at YAML surgery on a block the user hand-wrote.
    Write-Note "You already have a custom_providers list without a 'cursor' entry."
    Write-Note "Add this entry to it manually in ${hermesConfigPath}:"
    Write-Host ""
    Write-Host "  - name: cursor" -ForegroundColor White
    Write-Host "    base_url: $baseUrl" -ForegroundColor White
    Write-Host "    api_key: $providerApiKey" -ForegroundColor White
    Write-Host ""
    $script:PartialSetup = $true
}

# --- 5. Long-running session profile (optional) --------------------------------------
if ($LongRunning) {
    Write-Step "Applying the long-running session profile"
    & hermes config set session_reset.mode none | Out-Null
    & hermes config set agent.max_turns 300 | Out-Null
    # Pin the compression summarizer to the NAMED provider, not the "main"
    # label. "main" is resolved through Hermes' runtime provider label, which
    # inside its messaging gateway is bare "custom" - a path with no endpoint
    # credentials of its own, so summaries silently die and compression drops
    # middle turns unsummarized (observed live). The named entry always
    # carries its base_url/api_key.
    & hermes config set auxiliary.compression.provider "custom:cursor" | Out-Null
    & hermes config set auxiliary.compression.model $Model | Out-Null
    # Pin Hermes' other automatic housekeeping calls too. Each of these fires
    # as its own SEPARATE metered gateway request and defaults to the MAIN
    # model ("auto" = inherit the main runtime): background skill review every
    # skills.creation_nudge_interval tool iterations (the big one on long
    # tool-heavy tasks), session title generation on the first exchange, and
    # the LLM command-approval guard on flagged shell commands. Pinning them
    # to the summarizer model keeps long-running housekeeping off the primary
    # (usually more expensive) model without disabling the features.
    & hermes config set auxiliary.background_review.provider "custom:cursor" | Out-Null
    & hermes config set auxiliary.background_review.model $Model | Out-Null
    & hermes config set auxiliary.title_generation.provider "custom:cursor" | Out-Null
    & hermes config set auxiliary.title_generation.model $Model | Out-Null
    & hermes config set auxiliary.approval.provider "custom:cursor" | Out-Null
    & hermes config set auxiliary.approval.model $Model | Out-Null
    Write-Ok "Hermes: session_reset.mode=none, agent.max_turns=300"
    Write-Ok "Hermes: auxiliary compression/background_review/title_generation/approval = custom:cursor/$Model"

    # Gateway side. Prefer the admin API (applies live + persists to
    # settings.json, which outranks .env); fall back to editing .env when the
    # gateway is down.
    $applied = $false
    if ($health) {
        try {
            $headers = @{}
            if ($AuthKey) { $headers['Authorization'] = "Bearer $AuthKey" }
            $body = '{"requestTimeoutMs":1800000,"sessionTtlMs":86400000}'
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/admin/config" -Method Patch `
                -ContentType 'application/json' -Body $body -Headers $headers -UseBasicParsing -TimeoutSec 10 | Out-Null
            Write-Ok "Gateway (live via admin API): requestTimeoutMs=1800000 (30 min), sessionTtlMs=86400000 (24 h)"
            $applied = $true
        } catch {
            Write-Note "Admin API update failed ($($_.Exception.Message)) - falling back to .env."
        }
    }
    if (-not $applied) {
        if (Test-Path -LiteralPath $repoEnv) {
            Copy-Item -LiteralPath $repoEnv -Destination "$repoEnv.bak-cursor-addon-$stamp"
            $envText = Get-Content -LiteralPath $repoEnv -Raw
            foreach ($pair in @(@('REQUEST_TIMEOUT_MS', '1800000'), @('SESSION_TTL_MS', '86400000'))) {
                $name = $pair[0]; $value = $pair[1]
                if ($envText -match "(?m)^\s*$name\s*=") {
                    $envText = $envText -replace "(?m)^\s*$name\s*=.*$", "$name=$value"
                } else {
                    if (-not $envText.EndsWith("`n")) { $envText += "`n" }
                    $envText += "$name=$value`n"
                }
            }
            Set-Content -LiteralPath $repoEnv -Value $envText -Encoding utf8 -NoNewline
            Write-Ok "Gateway .env updated (backup: .env.bak-cursor-addon-$stamp)."
            Write-Note "Restart the gateway for these to take effect (autostart\windows\Gateway-Runner.ps1 after Stop-Gateway.ps1, or start.bat)."
        } else {
            Write-Note "No repo .env found (gateway not configured yet?) - set REQUEST_TIMEOUT_MS=1800000 and SESSION_TTL_MS=86400000 once it exists."
            $script:PartialSetup = $true
        }
    }
}

# --- 6. Native vision (optional) --------------------------------------------------------
if ($NativeVision) {
    Write-Step "Enabling native vision (images attach directly to the main model)"
    # Hermes can't detect vision capability for custom-provider models (its
    # capability DB doesn't cover custom routes), so without this override
    # every image is relayed through a separate auxiliary vision model as a
    # text description - one extra metered call per image. With it, images
    # (computer_use/browser screenshots, Telegram photos, vision_analyze)
    # ride the main model's context; the gateway forwards tool-result images
    # as native image blocks inside the same held run. Only enable this when
    # the default model is actually vision-capable - that's why it's opt-in.
    & hermes config set model.supports_vision true | Out-Null
    & hermes config set agent.image_input_mode native | Out-Null
    Write-Ok "Hermes: model.supports_vision=true, agent.image_input_mode=native"
    Write-Note "Only keep this on while your active model is vision-capable (Claude/GPT-5/Gemini/Grok etc)."
}

# --- 7. Telegram (optional) ------------------------------------------------------------
if ($TelegramToken -or $TelegramUser) {
    Write-Step "Configuring Telegram"
    if ($TelegramToken) {
        # Routes to Hermes' .env automatically (its config-set recognizes *_TOKEN keys).
        & hermes config set TELEGRAM_BOT_TOKEN $TelegramToken | Out-Null
        Write-Ok "TELEGRAM_BOT_TOKEN set."
    }
    if ($TelegramUser) {
        $hermesEnvPath = (& hermes config env-path 2>$null | Select-Object -Last 1).Trim()
        if ($hermesEnvPath) {
            $envText = if (Test-Path -LiteralPath $hermesEnvPath) { Get-Content -LiteralPath $hermesEnvPath -Raw } else { '' }
            if ($envText -match '(?m)^\s*TELEGRAM_ALLOWED_USERS\s*=') {
                $envText = $envText -replace '(?m)^\s*TELEGRAM_ALLOWED_USERS\s*=.*$', "TELEGRAM_ALLOWED_USERS=$TelegramUser"
            } else {
                if ($envText.Length -gt 0 -and -not $envText.EndsWith("`n")) { $envText += "`n" }
                $envText += "TELEGRAM_ALLOWED_USERS=$TelegramUser`n"
            }
            Set-Content -LiteralPath $hermesEnvPath -Value $envText -Encoding utf8 -NoNewline
            Write-Ok "TELEGRAM_ALLOWED_USERS=$TelegramUser (in $hermesEnvPath)"
        } else {
            Write-Note "Could not resolve Hermes' .env path - add TELEGRAM_ALLOWED_USERS=$TelegramUser manually."
            $script:PartialSetup = $true
        }
    }
}

# --- 8. Restart Hermes' gateway if it's running ---------------------------------------------
Write-Step "Applying to a running Hermes gateway"
$gwStatus = (& hermes gateway status 2>$null) -join "`n"
if ($gwStatus -match 'running') {
    Write-Note "Hermes gateway is running - restarting it to load the new config..."
    & hermes gateway restart 2>$null | Out-Null
    Write-Ok "Restarted."
} else {
    Write-Ok "Hermes gateway not currently running - nothing to restart. (Start it with: hermes gateway)"
}

# --- 9. Verify ---------------------------------------------------------------------------------
Write-Step "Verification"
$finalConfig = Get-Content -LiteralPath $hermesConfigPath -Raw
if ($finalConfig -match '(?m)^\s*provider\s*:\s*custom:cursor\s*$') {
    Write-Ok "model.provider = custom:cursor"
} else {
    Write-Note "model.provider does not read back as custom:cursor - inspect $hermesConfigPath"
    $script:PartialSetup = $true
}
if ($health) {
    try {
        $headers = @{}
        if ($AuthKey) { $headers['Authorization'] = "Bearer $AuthKey" }
        $models = (Invoke-WebRequest -Uri "$baseUrl/models" -Headers $headers -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
        Write-Ok "Gateway model catalog reachable: $($models.data.Count) models (Hermes' /model picker will show these)."
    } catch {
        Write-Note "Could not list models from the gateway: $($_.Exception.Message)"
        $script:PartialSetup = $true
    }
}

Write-Host ""
if ($script:PartialSetup) {
    Write-Host "Setup finished with manual steps remaining - see the notes above." -ForegroundColor Yellow
    exit 2
}
Write-Host "Done. Try it:" -ForegroundColor Green
Write-Host "  hermes                    # chat in the terminal"
Write-Host "  hermes gateway            # run the messaging gateway (Telegram etc.)"
Write-Host "  hermes gateway install    # ...or install it as a background service"
Write-Host "  /model (in chat)          # switch between all the gateway's models"
exit 0
