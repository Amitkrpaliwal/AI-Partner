# ═══════════════════════════════════════════════════════════════════
# AI Partner — Windows Interactive Installer
#
# Usage (run in PowerShell as normal user — no admin needed):
#   .\install.ps1               First-time interactive install
#   .\install.ps1 -Update       Pull latest and restart
#   .\install.ps1 -Reset        Wipe data and start fresh
#
# One-liner install (paste into PowerShell):
#   iwr -useb https://raw.githubusercontent.com/AmitkrPaiwal/AI-Partner/main/install.ps1 | iex
# ═══════════════════════════════════════════════════════════════════

param(
    [switch]$Update,
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$PORT = if ($env:APP_PORT) { $env:APP_PORT } else { "3000" }

# ── Colors ─────────────────────────────────────────────────────────
function Write-Ok($msg)   { Write-Host "  $([char]0x2713)  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  !  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  X  $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  ->  $msg" -ForegroundColor Cyan }

function Write-Banner {
    Write-Host ""
    Write-Host "  ╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║                                                            ║" -ForegroundColor Cyan
    Write-Host "  ║      AI Partner — Autonomous AI Agent Platform             ║" -ForegroundColor Cyan
    Write-Host "  ║      Self-Hosted  |  Open Source  |  MIT License           ║" -ForegroundColor Cyan
    Write-Host "  ║                                                            ║" -ForegroundColor Cyan
    Write-Host "  ╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Set-EnvValue($file, $key, $value) {
    $content = Get-Content $file -Raw
    $escaped = [regex]::Escape($key)
    if ($content -match "(?m)^${escaped}=") {
        $content = $content -replace "(?m)^${escaped}=.*", "${key}=${value}"
    } else {
        $content += "`n${key}=${value}"
    }
    Set-Content $file $content -NoNewline
}

function Read-Secret($prompt) {
    Write-Host "     " -NoNewline
    Write-Host $prompt -ForegroundColor White -NoNewline
    Write-Host ": " -NoNewline
    $ss = Read-Host -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
}

function Wait-ForHealth($url, $maxSeconds) {
    $elapsed = 0
    $spinners = @('/', '-', '\', '|')
    $i = 0
    while ($elapsed -lt $maxSeconds) {
        try {
            $resp = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { return $true }
        } catch { }
        Write-Host "     $($spinners[$i % 4]) Waiting... ($elapsed s)`r" -NoNewline
        Start-Sleep -Seconds 2
        $elapsed += 2
        $i++
    }
    return $false
}

# ── Main ───────────────────────────────────────────────────────────

Write-Banner

# ── UPDATE mode ────────────────────────────────────────────────────
if ($Update) {
    Write-Info "Pulling latest images and restarting..."
    docker compose pull 2>$null
    docker compose up -d --build
    Write-Ok "AI Partner updated. Open http://localhost:${PORT}"
    exit 0
}

# ── RESET mode ─────────────────────────────────────────────────────
if ($Reset) {
    $confirm = Read-Host "  This will delete ALL data (DB, workspace, memory). Continue? [y/N]"
    if ($confirm -eq 'y' -or $confirm -eq 'Y') {
        docker compose down -v 2>$null
        if (Test-Path ".env") { Remove-Item ".env" }
        Write-Ok "All data wiped. Run .\install.ps1 to start fresh."
    } else {
        Write-Info "Reset cancelled."
    }
    exit 0
}

# ── INSTALL mode ───────────────────────────────────────────────────

# ── Clone repo if running via iwr | iex ────────────────────────────
# When piped through iex the user's CWD won't have the repo files.
# Clone into $HOME\AI-Partner if docker-compose.yml isn't present here.
if (-not (Test-Path "docker-compose.yml")) {
    Write-Info "Cloning AI-Partner repository..."
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err "git is required. Install Git for Windows (https://git-scm.com) and re-run."
        exit 1
    }
    $repoUrl = "https://github.com/AmitkrPaiwal/AI-Partner.git"
    $dest = Join-Path $HOME "AI-Partner"
    if (Test-Path (Join-Path $dest ".git")) {
        Write-Info "Existing clone found at $dest — pulling latest..."
        git -C $dest pull --ff-only 2>$null
    } else {
        git clone $repoUrl $dest
    }
    Set-Location $dest
    Write-Ok "Repository ready at $dest"
}

# ── Step 1: Check Docker ───────────────────────────────────────────
Write-Host "`n  Step 1/4 — Checking requirements" -ForegroundColor White

function Install-DockerWindows {
    # Try winget first (available on Windows 10 1709+ and Windows 11)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Installing Docker Desktop via winget..."
        try {
            winget install Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements
            Write-Ok "Docker Desktop installed."
        } catch {
            Write-Warn "winget install encountered an issue: $_"
        }
    } else {
        Write-Warn "winget not available. Cannot auto-install Docker."
        Write-Host ""
        Write-Host "     Download Docker Desktop from:" -ForegroundColor White
        Write-Host "     https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "     Install it, start Docker Desktop, then re-run this script." -ForegroundColor White
        exit 1
    }

    Write-Host ""
    Write-Warn "Docker Desktop was just installed. You need to:"
    Write-Host "     1. Open Docker Desktop from the Start Menu" -ForegroundColor White
    Write-Host "     2. Accept the license agreement and wait for it to fully start" -ForegroundColor White
    Write-Host "     3. Re-run this installer:  .\install.ps1" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

$dockerOk = $false
try {
    $null = docker version 2>&1
    $dockerOk = $LASTEXITCODE -eq 0
} catch { }

if (-not $dockerOk) {
    Write-Warn "Docker is not running or not installed."
    Write-Host ""
    $doInstall = Read-Host "     Install Docker Desktop automatically via winget? [Y/n]"
    if (-not $doInstall -or $doInstall -eq 'y' -or $doInstall -eq 'Y') {
        Install-DockerWindows
    } else {
        Write-Host ""
        Write-Host "     Download Docker Desktop and start it, then re-run this script:" -ForegroundColor White
        Write-Host "     https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
        exit 1
    }
}
Write-Ok "Docker is running"

# ── Step 2: LLM Provider ───────────────────────────────────────────
Write-Host "`n  Step 2/4 — Choose your AI model provider" -ForegroundColor White
Write-Host ""

$hasKey = $false
$skipProviderSetup = $false

if (Test-Path ".env") {
    $envContent = Get-Content ".env" -Raw
    if ($envContent -match '(?m)^(OPENAI|ANTHROPIC|GROQ|DEEPSEEK|MISTRAL|TOGETHER|GOOGLE)_API_KEY=.+') {
        Write-Ok "Existing .env with LLM keys detected — skipping provider setup"
        Write-Info "To reconfigure, delete .env and run .\install.ps1 again"
        $hasKey = $true
        $skipProviderSetup = $true
    }
}

if (-not $skipProviderSetup) {
    # Check if Ollama is running locally
    $ollamaRunning = $false
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:11434/api/version" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        $ollamaRunning = $true
    } catch { }

    Write-Host "  Pick one (you can add more later via Settings):"
    Write-Host ""
    if ($ollamaRunning) {
        Write-Host "    0) Ollama  — LOCAL models detected running on your machine (FREE)" -ForegroundColor Green
    }
    Write-Host "    1) Groq    — Cloud, FREE tier, very fast (Llama 3.3, Mistral)"
    Write-Host "    2) OpenAI  — GPT-4o, GPT-4o-mini (API key required)"
    Write-Host "    3) Anthropic — Claude 3.5 Sonnet (API key required)"
    Write-Host "    4) DeepSeek — Cheap, strong at coding (API key required)"
    Write-Host "    5) Google  — Gemini 2.0 Flash (API key required)"
    Write-Host "    6) Other   — I'll edit .env manually"
    Write-Host ""
    $choice = Read-Host "     Your choice [1]"
    if (-not $choice) { $choice = "1" }

    # Copy .env.example → .env
    Copy-Item ".env.example" ".env" -Force

    $llmKeyVar = ""
    $llmKeyVal = ""

    switch ($choice) {
        "0" {
            Write-Ok "Using local Ollama — no API key needed"
            Set-EnvValue ".env" "OLLAMA_HOST" "http://host.docker.internal:11434"
            $hasKey = $true
        }
        "1" {
            Write-Host "`n     Get a free Groq key at: https://console.groq.com"
            $llmKeyVal = Read-Secret "Groq API key"
            $llmKeyVar = "GROQ_API_KEY"
            $hasKey = $true
        }
        "2" {
            Write-Host "`n     Get your key at: https://platform.openai.com/api-keys"
            $llmKeyVal = Read-Secret "OpenAI API key"
            $llmKeyVar = "OPENAI_API_KEY"
            $hasKey = $true
        }
        "3" {
            Write-Host "`n     Get your key at: https://console.anthropic.com"
            $llmKeyVal = Read-Secret "Anthropic API key"
            $llmKeyVar = "ANTHROPIC_API_KEY"
            $hasKey = $true
        }
        "4" {
            Write-Host "`n     Get your key at: https://platform.deepseek.com"
            $llmKeyVal = Read-Secret "DeepSeek API key"
            $llmKeyVar = "DEEPSEEK_API_KEY"
            $hasKey = $true
        }
        "5" {
            Write-Host "`n     Get your key at: https://aistudio.google.com/app/apikey"
            $llmKeyVal = Read-Secret "Google API key"
            $llmKeyVar = "GOOGLE_API_KEY"
            $hasKey = $true
        }
        default {
            Write-Warn "Manual mode — add a key to .env before the app will work"
        }
    }

    if ($llmKeyVar -and $llmKeyVal) {
        Set-EnvValue ".env" $llmKeyVar $llmKeyVal
        Write-Ok "Saved $llmKeyVar to .env"
    }
}

# ── Step 3: Optional messaging ─────────────────────────────────────
Write-Host "`n  Step 3/4 — Messaging (optional — press Enter to skip)" -ForegroundColor White
Write-Host ""
Write-Host "  AI Partner can send results to Telegram, Discord, and Slack."
Write-Host ""
$setupMsg = Read-Host "     Set up messaging now? [y/N]"

if ($setupMsg -eq 'y' -or $setupMsg -eq 'Y') {
    Write-Host ""
    Write-Host "  Press Enter to skip any platform."
    Write-Host ""

    $tgToken = Read-Secret "Telegram bot token (get from @BotFather)"
    if ($tgToken) { Set-EnvValue ".env" "TELEGRAM_BOT_TOKEN" $tgToken; Write-Ok "Telegram token saved" }

    $dcToken = Read-Secret "Discord bot token"
    if ($dcToken) { Set-EnvValue ".env" "DISCORD_BOT_TOKEN" $dcToken; Write-Ok "Discord token saved" }

    $slBot = Read-Secret "Slack bot token (xoxb-...)"
    if ($slBot) { Set-EnvValue ".env" "SLACK_BOT_TOKEN" $slBot; Write-Ok "Slack bot token saved" }

    $slApp = Read-Secret "Slack app token (xapp-...)"
    if ($slApp) { Set-EnvValue ".env" "SLACK_APP_TOKEN" $slApp; Write-Ok "Slack app token saved" }
}

# ── Step 4: Start services ─────────────────────────────────────────
Write-Host "`n  Step 4/4 — Starting AI Partner" -ForegroundColor White
Write-Host ""
Write-Info "Building and starting services (first run takes 2-4 minutes)..."
Write-Host ""

docker compose up -d --build

Write-Host ""
Write-Info "Waiting for AI Partner to become healthy..."

$healthUrl = "http://localhost:${PORT}/api/health"
$healthy = Wait-ForHealth $healthUrl 120

if (-not $healthy) {
    Write-Host ""
    Write-Err "Health check timed out after 120s"
    Write-Host ""
    Write-Host "     Check what went wrong:"
    Write-Host "       docker compose logs app"
    exit 1
}

# ── Auto-open browser ──────────────────────────────────────────────
$url = "http://localhost:${PORT}"
Start-Process $url

# ── Done ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║                                                              ║" -ForegroundColor Green
Write-Host "  ║   AI Partner is running!                                     ║" -ForegroundColor Green
Write-Host "  ║                                                              ║" -ForegroundColor Green
Write-Host "  ║   Open:    http://localhost:$PORT                              ║" -ForegroundColor Green
Write-Host "  ║                                                              ║" -ForegroundColor Green
Write-Host "  ║   Logs:    docker compose logs -f app                       ║" -ForegroundColor Green
Write-Host "  ║   Stop:    docker compose down                              ║" -ForegroundColor Green
Write-Host "  ║   Update:  .\install.ps1 -Update                            ║" -ForegroundColor Green
Write-Host "  ║   Reset:   .\install.ps1 -Reset                             ║" -ForegroundColor Green
Write-Host "  ║                                                              ║" -ForegroundColor Green
Write-Host "  ║   Docs:    https://github.com/AmitkrPaiwal/AI-Partner      ║" -ForegroundColor Green
Write-Host "  ║                                                              ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

if (-not $hasKey) {
    Write-Warn "No LLM key was set. Open .env, add an API key, then run:"
    Write-Host "       docker compose restart app"
    Write-Host ""
}
