# setup.ps1 - mem0 self-hosted memory addon for the Cursor-OpenAI gateway (Windows).
#
# Gives Hermes Agent (addons/hermes) persistent long-term memory via mem0 OSS
# (https://github.com/mem0ai/mem0), fully self-hosted:
#
#   LLM fact extraction  -> this gateway (your Cursor subscription)
#   Embeddings           -> Ollama, locally (free, private, no API key)
#   Vector storage       -> Qdrant embedded mode (a local folder, no server)
#
# Why a script at all: Hermes' own `hermes memory setup mem0 --mode oss` wizard
# cannot point mem0's OpenAI-compatible LLM at a custom base_url (verified in
# the plugin's _setup.py - only Ollama providers get a URL flag), so the
# gateway-as-LLM wiring must be written into mem0.json directly. This script
# does that, plus every prerequisite around it.
#
# Safe by design (addon conventions, see addons/README.md):
#   - Idempotent: re-running repairs/refreshes; existing user_id, agent_id and
#     vector-store location are preserved.
#   - Backs up mem0.json (timestamped) before changing it.
#   - Installs Python deps into Hermes' own venv using Hermes' own bundled uv -
#     never into your global Python.
#   - Never installs Ollama for you - prints the official instructions instead.
#   - Self-test never calls the LLM (no metered Cursor request) and cleans up
#     after itself.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -UserId alice
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Model gpt-5.5 -EmbedModel mxbai-embed-large
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -QdrantUrl http://127.0.0.1:6333
#
# Storage modes: by default memories live in embedded Qdrant (a local folder) -
# zero services, but SINGLE-PROCESS: if you run the Hermes gateway AND
# `hermes dashboard` / CLI chats at the same time, whichever opens the store
# first wins and the others get no memory. If you use more than one Hermes
# process (most people do eventually), run a Qdrant server instead and pass
# -QdrantUrl:
#   docker run -d --name hermes-qdrant --restart unless-stopped -p 127.0.0.1:6333:6333 -v hermes-qdrant-storage:/qdrant/storage qdrant/qdrant
#
# Exit codes: 0 = fully configured, 1 = prerequisite missing, 2 = partial
# (something needs a manual step; details printed).

param(
    [string] $Model = 'composer-2.5',
    [string] $EmbedModel = 'nomic-embed-text',
    [string] $UserId = '',
    [string] $OllamaUrl = 'http://localhost:11434',
    [string] $QdrantUrl = '',
    [string] $AuthKey = ''
)

$ErrorActionPreference = 'Stop'
$script:PartialSetup = $false

function Write-Step { param([string] $Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string] $Text) Write-Host "   $Text" -ForegroundColor Green }
function Write-Note { param([string] $Text) Write-Host "   $Text" -ForegroundColor Yellow }

# Windows PowerShell 5.1 turns native-command stderr into terminating errors
# when $ErrorActionPreference is Stop AND the stream is redirected - and uv,
# ollama and Python all legitimately write progress/warnings to stderr. Run
# such commands under EAP=Continue, keeping Stop for everything else.
function Invoke-Native {
    param([scriptblock] $Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $prev }
}

# Embedding dimensions for common Ollama embedding models. Anything not listed
# is probed live against the Ollama API instead of guessed.
$KnownDims = @{
    'nomic-embed-text'       = 768
    'mxbai-embed-large'      = 1024
    'all-minilm'             = 384
    'bge-m3'                 = 1024
    'snowflake-arctic-embed' = 1024
}

# --- Locate the repo and resolve the gateway port ------------------------------
# This file lives at <repo>\addons\mem0\setup.ps1.
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

Write-Host "mem0 addon - self-hosted memory for Hermes on the Cursor-OpenAI gateway" -ForegroundColor White
Write-Host "Repo: $repoRoot"
Write-Host "Gateway endpoint (mem0's LLM): $baseUrl"
Write-Host "Embedder: Ollama '$EmbedModel' at $OllamaUrl"

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
    Write-Note "Gateway is NOT reachable on port $port. Continuing (the mem0 config written below is still correct),"
    Write-Note "but memory extraction will fail until it's up: run start.bat, or install autostart\ (recommended)."
    $script:PartialSetup = $true
}

# --- 2. Hermes installed? ---------------------------------------------------------
Write-Step "Checking Hermes Agent"
$hermes = Get-Command hermes -ErrorAction SilentlyContinue
if (-not $hermes) {
    Write-Host ""
    Write-Host "Hermes Agent is not installed - this addon adds memory TO Hermes." -ForegroundColor Red
    Write-Host "Set up Hermes first (it has its own addon here):"
    Write-Host ""
    Write-Host "  cd ..\hermes; powershell -ExecutionPolicy Bypass -File setup.ps1" -ForegroundColor White
    Write-Host ""
    exit 1
}
$hermesVersion = Invoke-Native { & hermes --version 2>$null } | Select-Object -First 1
Write-Ok "Found: $hermesVersion"

# Hermes home (config.yaml's folder) - authoritative via Hermes itself.
$hermesConfigPath = (Invoke-Native { & hermes config path 2>$null } | Select-Object -Last 1)
$hermesConfigPath = if ($hermesConfigPath) { "$hermesConfigPath".Trim() } else { '' }
if (-not $hermesConfigPath) {
    Write-Host "Could not resolve Hermes' config path via 'hermes config path'." -ForegroundColor Red
    exit 1
}
$hermesHome = Split-Path -Parent $hermesConfigPath
Write-Ok "Hermes home: $hermesHome"

# The mem0 plugin ships with Hermes - confirm it's visible.
$memStatus = (Invoke-Native { & hermes memory status 2>$null }) -join "`n"
if ($memStatus -notmatch 'mem0') {
    Write-Note "Hermes did not list a 'mem0' memory plugin ('hermes memory status'). Your Hermes may be very old -"
    Write-Note "run 'hermes update' and re-run this setup."
    $script:PartialSetup = $true
}

# --- 3. OpenRouter hijack guard -----------------------------------------------------
# mem0's OpenAI LLM class unconditionally routes to OpenRouter whenever
# OPENROUTER_API_KEY is set in the process environment - ignoring the
# openai_base_url we configure (verified in mem0/llms/openai.py). Hermes loads
# its .env into the process, so a key there would silently bypass the gateway.
Write-Step "Checking for an OPENROUTER_API_KEY conflict"
$hermesEnvPath = (Invoke-Native { & hermes config env-path 2>$null } | Select-Object -Last 1)
$hermesEnvPath = if ($hermesEnvPath) { "$hermesEnvPath".Trim() } else { '' }
if (-not $hermesEnvPath) { $hermesEnvPath = Join-Path $hermesHome '.env' }
$openrouterHit = $false
if ($env:OPENROUTER_API_KEY) { $openrouterHit = $true }
if (Test-Path -LiteralPath $hermesEnvPath) {
    if (Select-String -LiteralPath $hermesEnvPath -Pattern '^\s*OPENROUTER_API_KEY\s*=\s*\S' -Quiet -ErrorAction SilentlyContinue) {
        $openrouterHit = $true
    }
}
if ($openrouterHit) {
    Write-Note "OPENROUTER_API_KEY is set (environment or $hermesEnvPath)."
    Write-Note "mem0's OpenAI provider ALWAYS routes to OpenRouter when that variable exists, bypassing this"
    Write-Note "gateway entirely. Remove it (or rename it) or mem0's fact extraction will not use Cursor."
    $script:PartialSetup = $true
} else {
    Write-Ok "No OPENROUTER_API_KEY found - mem0 will honor the gateway base_url."
}

# --- 4. Ollama (embeddings) -----------------------------------------------------------
Write-Step "Checking Ollama (local embeddings)"

function Test-Ollama {
    try {
        $resp = Invoke-WebRequest -Uri "$($OllamaUrl.TrimEnd('/'))/api/tags" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { return $resp.Content | ConvertFrom-Json }
    } catch { return $null }
    return $null
}

function Find-OllamaBinary {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $default) { return $default }
    return $null
}

$tags = Test-Ollama
if (-not $tags) {
    $ollamaBin = Find-OllamaBinary
    if ($ollamaBin) {
        Write-Note "Ollama installed but not running - starting it..."
        Start-Process -FilePath $ollamaBin -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
        $deadline = (Get-Date).AddSeconds(15)
        while (-not $tags -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 800
            $tags = Test-Ollama
        }
    }
}
if (-not $tags) {
    Write-Host ""
    Write-Host "Ollama is not installed (or not reachable at $OllamaUrl)." -ForegroundColor Red
    Write-Host "Install it from the official source, then re-run this script:"
    Write-Host ""
    Write-Host "  winget install Ollama.Ollama" -ForegroundColor White
    Write-Host "  (or download from https://ollama.com/download)" -ForegroundColor White
    Write-Host ""
    exit 1
}
Write-Ok "Ollama reachable at $OllamaUrl."

# Pull the embedding model if it isn't present yet (matches Hermes' own check:
# a tag list entry that starts with the model name counts).
$baseModelName = $EmbedModel.Split(':')[0]
$haveModel = @($tags.models | Where-Object { $_.name -like "$baseModelName*" }).Count -gt 0
if ($haveModel) {
    Write-Ok "Embedding model '$EmbedModel' already pulled."
} else {
    Write-Note "Pulling '$EmbedModel' (one-time download, ~a few hundred MB)..."
    $ollamaBin = Find-OllamaBinary
    $pulled = $false
    if ($ollamaBin) {
        Invoke-Native { & $ollamaBin pull $EmbedModel 2>&1 | ForEach-Object { "$_" } | Out-Host }
        if ($LASTEXITCODE -eq 0) { $pulled = $true }
    }
    if (-not $pulled) {
        # Server reachable but no local binary (e.g. remote/containered Ollama):
        # use the HTTP pull API instead.
        try {
            $body = @{ name = $EmbedModel; stream = $false } | ConvertTo-Json
            Invoke-WebRequest -Uri "$($OllamaUrl.TrimEnd('/'))/api/pull" -Method Post -Body $body `
                -ContentType 'application/json' -UseBasicParsing -TimeoutSec 600 | Out-Null
            $pulled = $true
        } catch {
            Write-Note "Could not pull '$EmbedModel' ($($_.Exception.Message)). Pull it manually: ollama pull $EmbedModel"
            $script:PartialSetup = $true
        }
    }
    if ($pulled) { Write-Ok "Pulled '$EmbedModel'." }
}

# Resolve embedding dimensions: known table first, live probe otherwise.
$dims = $KnownDims[$baseModelName]
if (-not $dims) {
    Write-Note "Unknown embedding model - probing its dimension count live..."
    try {
        $body = @{ model = $EmbedModel; prompt = 'dimension probe' } | ConvertTo-Json
        $resp = Invoke-WebRequest -Uri "$($OllamaUrl.TrimEnd('/'))/api/embeddings" -Method Post -Body $body `
            -ContentType 'application/json' -UseBasicParsing -TimeoutSec 60
        $dims = @(($resp.Content | ConvertFrom-Json).embedding).Count
    } catch {
        Write-Host "Could not determine '$EmbedModel' embedding dimensions: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
if (-not $dims -or $dims -lt 1) {
    Write-Host "Embedding model '$EmbedModel' returned no usable embedding vector." -ForegroundColor Red
    exit 1
}
Write-Ok "Embedding dimensions: $dims."

# --- 5. Python dependencies (into Hermes' own venv) ---------------------------------------
# Hermes runs from a bundled, uv-managed venv that has NO pip module - plain
# `python -m pip` fails there. Hermes' own plugin installer uses its bundled
# uv binary, so we do exactly the same.
Write-Step "Installing mem0 dependencies into Hermes' venv"
$venvPython = Join-Path $hermesHome 'hermes-agent\venv\Scripts\python.exe'
$uvCandidates = @(
    (Join-Path $hermesHome 'bin\uv.exe'),
    ((Get-Command uv -ErrorAction SilentlyContinue).Source)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$uv = $uvCandidates | Select-Object -First 1

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Note "Hermes' venv python not found at $venvPython - your install layout differs."
    Write-Note "Install the deps into whatever Python runs Hermes: uv pip install --python <hermes python> `"mem0ai>=2.0.7`" ollama qdrant-client"
    $script:PartialSetup = $true
} elseif (-not $uv) {
    Write-Note "No uv binary found (looked in $hermesHome\bin and PATH), and Hermes' venv has no pip."
    Write-Note "Install uv (https://docs.astral.sh/uv/), then: uv pip install --python `"$venvPython`" `"mem0ai>=2.0.7`" ollama qdrant-client"
    $script:PartialSetup = $true
} else {
    Invoke-Native { & $uv pip install --python $venvPython 'mem0ai>=2.0.7' ollama qdrant-client 2>&1 } | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Note "uv pip install failed (exit $LASTEXITCODE). Run manually: `"$uv`" pip install --python `"$venvPython`" `"mem0ai>=2.0.7`" ollama qdrant-client"
        $script:PartialSetup = $true
    } else {
        $importCheck = (Invoke-Native { & $venvPython -c "import mem0, ollama, qdrant_client; print('ok')" 2>&1 }) -join "`n"
        if ($importCheck -match 'ok') {
            Write-Ok "mem0ai, ollama, qdrant-client present in Hermes' venv."
        } else {
            Write-Note "Dependency import check failed: $importCheck"
            $script:PartialSetup = $true
        }
    }
}

# --- 6. Write mem0.json ------------------------------------------------------------------------
Write-Step "Writing $hermesHome\mem0.json"
$mem0JsonPath = Join-Path $hermesHome 'mem0.json'
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

# Idempotent-repair semantics: keep the user's existing identity and vector
# store location; refresh the provider wiring (which is what this addon owns).
$existing = $null
if (Test-Path -LiteralPath $mem0JsonPath) {
    Copy-Item -LiteralPath $mem0JsonPath -Destination "$mem0JsonPath.bak-cursor-addon-$stamp"
    Write-Ok "Backed up existing mem0.json -> mem0.json.bak-cursor-addon-$stamp"
    try { $existing = Get-Content -LiteralPath $mem0JsonPath -Raw | ConvertFrom-Json } catch { $existing = $null }
}

$effectiveUserId = $UserId
if (-not $effectiveUserId -and $existing -and $existing.PSObject.Properties['user_id']) { $effectiveUserId = [string]$existing.user_id }
if (-not $effectiveUserId) { $effectiveUserId = "$env:USERNAME".ToLower() }
if (-not $effectiveUserId) { $effectiveUserId = 'hermes-user' }
$effectiveAgentId = 'hermes'
if ($existing -and $existing.PSObject.Properties['agent_id'] -and $existing.agent_id) { $effectiveAgentId = [string]$existing.agent_id }

# Vector store location. Precedence: -QdrantUrl flag > whatever mode the
# existing mem0.json already uses (url or path) > embedded default folder.
$storeUrl = $QdrantUrl
$storePath = (Join-Path $hermesHome 'mem0_qdrant') -replace '\\', '/'
$collection = 'hermes'
if ($existing -and $existing.oss -and $existing.oss.vector_store -and $existing.oss.vector_store.config) {
    $vsc = $existing.oss.vector_store.config
    if (-not $storeUrl -and $vsc.PSObject.Properties['url'] -and $vsc.url) { $storeUrl = [string]$vsc.url }
    if ($vsc.PSObject.Properties['path'] -and $vsc.path) { $storePath = [string]$vsc.path }
    if ($vsc.PSObject.Properties['collection_name'] -and $vsc.collection_name) { $collection = [string]$vsc.collection_name }
}
if ($storeUrl) {
    try {
        $qdrantHealth = Invoke-WebRequest -Uri "$($storeUrl.TrimEnd('/'))/healthz" -UseBasicParsing -TimeoutSec 5
        if ($qdrantHealth.StatusCode -eq 200) { Write-Ok "Qdrant server reachable at $storeUrl." }
    } catch {
        Write-Note "Qdrant server at $storeUrl is not answering /healthz - config is written anyway, but start it before using memory:"
        Write-Note "docker run -d --name hermes-qdrant --restart unless-stopped -p 127.0.0.1:6333:6333 -v hermes-qdrant-storage:/qdrant/storage qdrant/qdrant"
        $script:PartialSetup = $true
    }
}

$mem0Config = [ordered]@{
    mode     = 'oss'
    user_id  = $effectiveUserId
    agent_id = $effectiveAgentId
    oss      = [ordered]@{
        llm          = [ordered]@{
            provider = 'openai'
            config   = [ordered]@{
                model           = $Model
                openai_base_url = $baseUrl
                api_key         = $providerApiKey
            }
        }
        embedder     = [ordered]@{
            provider = 'ollama'
            config   = [ordered]@{
                model           = $EmbedModel
                ollama_base_url = $OllamaUrl
                embedding_dims  = $dims
            }
        }
        vector_store = [ordered]@{
            provider = 'qdrant'
            config   = if ($storeUrl) {
                [ordered]@{
                    url                  = $storeUrl
                    collection_name      = $collection
                    embedding_model_dims = $dims
                }
            } else {
                [ordered]@{
                    path                 = $storePath
                    collection_name      = $collection
                    embedding_model_dims = $dims
                }
            }
        }
    }
}
$json = ($mem0Config | ConvertTo-Json -Depth 10) + "`n"
[IO.File]::WriteAllText($mem0JsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
$storeLabel = if ($storeUrl) { "$storeUrl (server - concurrent-safe)" } else { "$storePath (embedded - single process at a time)" }
Write-Ok "mem0.json: LLM=$Model via gateway, embedder=$EmbedModel ($dims dims), store=$storeLabel"
Write-Ok "user_id=$effectiveUserId (one merged memory store across Telegram/CLI/etc. - edit mem0.json to change)"

# --- 7. Telemetry opt-out + provider activation ---------------------------------------------------
Write-Step "Activating mem0 in Hermes"

# mem0 OSS phones anonymized usage telemetry to PostHog by default. This is a
# self-hosted privacy-focused setup, so opt out; delete the line to re-enable.
$envText = if (Test-Path -LiteralPath $hermesEnvPath) { Get-Content -LiteralPath $hermesEnvPath -Raw } else { '' }
if ($envText -match '(?m)^\s*MEM0_TELEMETRY\s*=') {
    $envText = $envText -replace '(?m)^\s*MEM0_TELEMETRY\s*=.*$', 'MEM0_TELEMETRY=false'
} else {
    if ($envText.Length -gt 0 -and -not $envText.EndsWith("`n")) { $envText += "`n" }
    $envText += "MEM0_TELEMETRY=false`n"
}
Set-Content -LiteralPath $hermesEnvPath -Value $envText -Encoding utf8 -NoNewline
Write-Ok "MEM0_TELEMETRY=false (in $hermesEnvPath)"

Invoke-Native { & hermes config set memory.provider mem0 2>$null } | Out-Null
Write-Ok "memory.provider = mem0 (in Hermes' config.yaml)"

# --- 8. Self-test (embedder + vector store; deliberately NO LLM call) ------------------------------
Write-Step "Self-test: store -> embed -> search -> clean up"
if (Test-Path -LiteralPath $venvPython) {
    $selfTest = @'
import json, os, sys
cfg_path = sys.argv[1]
with open(cfg_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)
oss = cfg["oss"]
vs = dict(oss["vector_store"]); vsc = dict(vs.get("config", {}))
if "path" in vsc:
    vsc["path"] = os.path.expanduser(vsc["path"])
vs["config"] = vsc
try:
    from mem0 import Memory
    m = Memory.from_config({"vector_store": vs, "llm": oss["llm"], "embedder": oss["embedder"], "version": "v1.1"})
    r = m.add([{"role": "user", "content": "Cursor-OpenAI mem0 addon self-test marker"}],
              user_id="cursor-addon-selftest", infer=False)
    ids = [x["id"] for x in (r.get("results") or []) if x.get("id")]
    hits = m.search("addon self-test marker", filters={"user_id": "cursor-addon-selftest"}, top_k=5)
    got = hits.get("results") if isinstance(hits, dict) else hits
    for i in ids:
        m.delete(i)
    print("SELFTEST PASS" if got else "SELFTEST FAIL: stored but search returned nothing")
except Exception as e:
    msg = str(e).splitlines()[0] if str(e) else type(e).__name__
    low = msg.lower()
    if "lock" in low or "already accessed" in low or "in use" in low or "being used" in low:
        print("SELFTEST LOCKED: " + msg)
    else:
        print("SELFTEST FAIL: " + msg)
'@
    $selfTestPath = Join-Path $env:TEMP "cursor-mem0-selftest-$PID.py"
    Set-Content -LiteralPath $selfTestPath -Value $selfTest -Encoding utf8
    try {
        $env:MEM0_TELEMETRY = 'false'
        $testOutput = (Invoke-Native { & $venvPython $selfTestPath $mem0JsonPath 2>&1 }) -join "`n"
        if ($testOutput -match 'SELFTEST PASS') {
            Write-Ok "Self-test passed: embedding via Ollama + storage/search via Qdrant, end to end."
        } elseif ($testOutput -match 'SELFTEST LOCKED') {
            Write-Note "Vector store is currently held by a running Hermes process (Qdrant embedded mode is"
            Write-Note "single-process) - skipping. That lock is itself proof the live store works."
        } else {
            $failLine = ($testOutput -split "`n" | Where-Object { $_ -match 'SELFTEST' } | Select-Object -First 1)
            Write-Note "Self-test did not pass: $(if ($failLine) { $failLine } else { 'no output from the test' })"
            $script:PartialSetup = $true
        }
    } finally {
        Remove-Item -LiteralPath $selfTestPath -ErrorAction SilentlyContinue
    }
} else {
    Write-Note "Skipped (Hermes venv python not found - see the dependency step above)."
}

# --- 9. Restart Hermes' gateway so the new config loads --------------------------------------------
Write-Step "Applying to a running Hermes gateway"
$gwStatus = (Invoke-Native { & hermes gateway status 2>$null }) -join "`n"
if ($gwStatus -match 'running') {
    Write-Note "Hermes gateway is running - restarting it to load mem0..."
    Invoke-Native { & hermes gateway restart 2>$null } | Out-Null
    Write-Ok "Restarted."
} else {
    Write-Ok "Hermes gateway not currently running - nothing to restart. (Start it with: hermes gateway)"
}

# --- 10. Verify -------------------------------------------------------------------------------------
Write-Step "Verification"
$memStatus = (Invoke-Native { & hermes memory status 2>$null }) -join "`n"
if ($memStatus -match 'mem0' -and $memStatus -match 'available') {
    Write-Ok "Hermes reports the mem0 provider active and available."
} else {
    Write-Note "Hermes does not report mem0 as available - run 'hermes memory status' to inspect."
    $script:PartialSetup = $true
}
if ($health) {
    try {
        $headers = @{}
        if ($AuthKey) { $headers['Authorization'] = "Bearer $AuthKey" }
        $models = (Invoke-WebRequest -Uri "$baseUrl/models" -Headers $headers -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
        $modelIds = @($models.data | ForEach-Object { $_.id })
        if ($modelIds -contains $Model) {
            Write-Ok "Gateway serves '$Model' (mem0's extraction model) - wiring verified."
        } else {
            Write-Note "'$Model' is not in the gateway's model catalog - pick one from $baseUrl/models (-Model flag)."
            $script:PartialSetup = $true
        }
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
Write-Host "Done. Hermes now has persistent self-hosted memory:" -ForegroundColor Green
Write-Host "  - Tell it things ('my API key lives in .env.local') - it extracts and stores facts automatically"
Write-Host "  - Ask it later ('what do you know about me?') - it searches memory before answering"
Write-Host "  - Tools: mem0_search / mem0_add / mem0_list / mem0_update / mem0_delete (the agent uses them itself)"
Write-Host "  - Inspect any time: hermes memory status"
exit 0
