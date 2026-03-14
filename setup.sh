#!/bin/sh
# ═══════════════════════════════════════════════════════════════════
# AI Partner — Interactive First-Time Setup
#
# Usage:
#   ./setup.sh               First-time interactive install
#   ./setup.sh --update      Pull latest image and restart
#   ./setup.sh --reset       Wipe data and start fresh
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/AmitkrPaiwal/AI-Partner/main/setup.sh | bash
# ═══════════════════════════════════════════════════════════════════
set -e

PORT="${APP_PORT:-3000}"
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

# ── Detect if running via curl pipe (no TTY) ─────────────────────
INTERACTIVE=true
if [ ! -t 0 ]; then
    INTERACTIVE=false
fi

print_banner() {
    printf "\n${CYAN}"
    echo "  █████╗ ██╗    ██████╗  █████╗ ██████╗ ████████╗███╗   ██╗███████╗██████╗ "
    echo " ██╔══██╗██║    ██╔══██╗██╔══██╗██╔══██╗╚══██╔══╝████╗  ██║██╔════╝██╔══██╗"
    echo " ███████║██║    ██████╔╝███████║██████╔╝   ██║   ██╔██╗ ██║█████╗  ██████╔╝"
    echo " ██╔══██║██║    ██╔═══╝ ██╔══██║██╔══██╗   ██║   ██║╚██╗██║██╔══╝  ██╔══██╗"
    echo " ██║  ██║██║    ██║     ██║  ██║██║  ██║   ██║   ██║ ╚████║███████╗██║  ██║"
    echo " ╚═╝  ╚═╝╚═╝    ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝"
    printf "${RESET}\n"
    echo "  Autonomous AI Agent Platform — Self-Hosted, Open Source"
    echo "  ─────────────────────────────────────────────────────────"
    echo ""
}

log_ok()   { printf "  ${GREEN}✓${RESET}  %s\n" "$1"; }
log_warn() { printf "  ${YELLOW}⚠${RESET}  %s\n" "$1"; }
log_err()  { printf "  ${RED}✗${RESET}  %s\n" "$1"; }
log_info() { printf "  ${CYAN}→${RESET}  %s\n" "$1"; }

prompt() {
    # prompt <var_name> <display_label> <default_or_blank>
    var_name="$1"
    label="$2"
    default="$3"

    if [ "$INTERACTIVE" = "true" ]; then
        if [ -n "$default" ]; then
            printf "     ${BOLD}%s${RESET} [%s]: " "$label" "$default"
        else
            printf "     ${BOLD}%s${RESET}: " "$label"
        fi
        read -r input
        if [ -z "$input" ] && [ -n "$default" ]; then
            input="$default"
        fi
    else
        input="$default"
    fi

    eval "$var_name='$input'"
}

prompt_secret() {
    var_name="$1"
    label="$2"

    if [ "$INTERACTIVE" = "true" ]; then
        printf "     ${BOLD}%s${RESET}: " "$label"
        # Try stty -echo for hidden input, fall back to plain read
        if stty -echo 2>/dev/null; then
            read -r input
            stty echo 2>/dev/null
            echo ""
        else
            read -r input
        fi
    else
        input=""
    fi

    eval "$var_name='$input'"
}

# ── Handle flags ──────────────────────────────────────────────────
MODE="install"
if [ "$1" = "--update" ]; then MODE="update"; fi
if [ "$1" = "--reset"  ]; then MODE="reset";  fi

print_banner

# ═══════════════════════════════════════════════════════════════════
# MODE: UPDATE
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "update" ]; then
    log_info "Pulling latest images and restarting..."
    docker compose pull 2>/dev/null || true
    docker compose up -d --build
    log_ok "AI Partner updated. Open http://localhost:${PORT}"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
# MODE: RESET
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "reset" ]; then
    printf "  ${RED}This will delete ALL data (DB, workspace, memory). Continue? [y/N]:${RESET} "
    read -r confirm
    if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
        docker compose down -v 2>/dev/null || true
        rm -f .env
        log_ok "All data wiped. Run ./setup.sh to start fresh."
    else
        log_info "Reset cancelled."
    fi
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
# MODE: INSTALL
# ═══════════════════════════════════════════════════════════════════

# ── Step 1: Check Docker ─────────────────────────────────────────
echo "${BOLD}Step 1/4 — Checking requirements${RESET}"

install_docker_linux() {
    log_info "Installing Docker Engine via get.docker.com..."
    if ! curl -fsSL https://get.docker.com | sh; then
        log_err "Docker install failed. Please install manually:"
        echo "     https://docs.docker.com/engine/install/"
        exit 1
    fi
    # Add current user to docker group so we don't need sudo for docker commands
    if id -nG "$USER" | grep -qw docker; then
        : # already in group
    else
        sudo usermod -aG docker "$USER" 2>/dev/null || true
    fi
    # Start Docker service
    sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null || true
    log_ok "Docker installed successfully"
    log_warn "You may need to log out and back in for group membership to take effect."
    log_info "Continuing setup in sudo context for this session..."
}

if ! docker version >/dev/null 2>&1; then
    OS_TYPE="$(uname -s)"
    log_warn "Docker is not running or not installed."
    echo ""

    if [ "$OS_TYPE" = "Linux" ]; then
        if [ "$INTERACTIVE" = "true" ]; then
            printf "     ${BOLD}Install Docker automatically now? [Y/n]:${RESET} "
            read -r do_install
            if [ -z "$do_install" ] || [ "$do_install" = "y" ] || [ "$do_install" = "Y" ]; then
                install_docker_linux
            else
                echo ""
                echo "     Install Docker manually, then re-run this script:"
                echo "       https://docs.docker.com/engine/install/"
                exit 1
            fi
        else
            # Non-interactive (curl pipe) — auto-install silently
            install_docker_linux
        fi
    elif [ "$OS_TYPE" = "Darwin" ]; then
        echo "     macOS detected. Options:"
        echo ""
        if command -v brew >/dev/null 2>&1; then
            if [ "$INTERACTIVE" = "true" ]; then
                printf "     ${BOLD}Install Docker Desktop via Homebrew? [Y/n]:${RESET} "
                read -r do_brew
            else
                do_brew="Y"
            fi
            if [ -z "$do_brew" ] || [ "$do_brew" = "y" ] || [ "$do_brew" = "Y" ]; then
                log_info "Running: brew install --cask docker"
                brew install --cask docker
                log_ok "Docker Desktop installed. Please open Docker from Applications and wait for it to start, then re-run this script."
                exit 0
            fi
        fi
        echo "     Download Docker Desktop for Mac and start it, then re-run:"
        echo "     https://www.docker.com/products/docker-desktop/"
        exit 1
    else
        echo "     Install Docker Desktop and start it, then run this script again."
        echo "     Download: https://www.docker.com/products/docker-desktop/"
        exit 1
    fi

    # Re-check after install attempt
    if ! docker version >/dev/null 2>&1; then
        log_err "Docker still not responding. Please start Docker and re-run."
        exit 1
    fi
fi
log_ok "Docker is running"

# ── Step 2: Configure LLM Provider ───────────────────────────────
echo ""
echo "${BOLD}Step 2/4 — Choose your AI model provider${RESET}"
echo ""

if [ -f .env ] && grep -qE "^(OPENAI|ANTHROPIC|GROQ|DEEPSEEK|MISTRAL|TOGETHER|GOOGLE)_API_KEY=.+" .env 2>/dev/null; then
    log_ok "Existing .env detected with LLM keys — skipping provider setup"
    log_info "To reconfigure, delete .env and run ./setup.sh again"
    has_key=1
else
    # Check if Ollama is already running locally
    OLLAMA_RUNNING=false
    if curl -sf "http://localhost:11434/api/version" >/dev/null 2>&1; then
        OLLAMA_RUNNING=true
    fi

    echo "  Pick one (you can add more later via Settings):"
    echo ""
    if [ "$OLLAMA_RUNNING" = "true" ]; then
        echo "    0) Ollama — LOCAL models detected running on your machine (FREE)"
    fi
    echo "    1) Groq   — Cloud, FREE tier, very fast (Llama 3.3, Mistral)"
    echo "    2) OpenAI — GPT-4o, GPT-4o-mini (API key required)"
    echo "    3) Anthropic — Claude 3.5 Sonnet (API key required)"
    echo "    4) DeepSeek — Cheap, strong at coding (API key required)"
    echo "    5) Google  — Gemini 2.0 Flash (API key required)"
    echo "    6) Other / I'll edit .env manually"
    echo ""

    prompt PROVIDER_CHOICE "Your choice" "1"

    LLM_KEY_VAR=""
    LLM_KEY_VAL=""
    OLLAMA_HOST_VAL=""

    case "$PROVIDER_CHOICE" in
        0)
            log_ok "Using local Ollama — no API key needed"
            OLLAMA_HOST_VAL="http://host.docker.internal:11434"
            has_key=1
            ;;
        1)
            echo ""
            echo "     Get a free Groq key at: https://console.groq.com"
            prompt_secret LLM_KEY_VAL "Groq API key"
            LLM_KEY_VAR="GROQ_API_KEY"
            has_key=1
            ;;
        2)
            echo ""
            echo "     Get your key at: https://platform.openai.com/api-keys"
            prompt_secret LLM_KEY_VAL "OpenAI API key"
            LLM_KEY_VAR="OPENAI_API_KEY"
            has_key=1
            ;;
        3)
            echo ""
            echo "     Get your key at: https://console.anthropic.com"
            prompt_secret LLM_KEY_VAL "Anthropic API key"
            LLM_KEY_VAR="ANTHROPIC_API_KEY"
            has_key=1
            ;;
        4)
            echo ""
            echo "     Get your key at: https://platform.deepseek.com"
            prompt_secret LLM_KEY_VAL "DeepSeek API key"
            LLM_KEY_VAR="DEEPSEEK_API_KEY"
            has_key=1
            ;;
        5)
            echo ""
            echo "     Get your key at: https://aistudio.google.com/app/apikey"
            prompt_secret LLM_KEY_VAL "Google API key"
            LLM_KEY_VAR="GOOGLE_API_KEY"
            has_key=1
            ;;
        6)
            log_warn "Manual mode — you'll need to add a key to .env before the app will work"
            has_key=0
            ;;
        *)
            log_warn "Invalid choice — defaulting to manual mode"
            has_key=0
            ;;
    esac

    # ── Write .env ───────────────────────────────────────────────
    cp .env.example .env

    if [ -n "$LLM_KEY_VAR" ] && [ -n "$LLM_KEY_VAL" ]; then
        # Replace the placeholder line with the real key
        # Use a temp file for portability (sed -i differs on Mac vs Linux)
        sed "s|^${LLM_KEY_VAR}=.*|${LLM_KEY_VAR}=${LLM_KEY_VAL}|" .env > .env.tmp && mv .env.tmp .env
        log_ok "Saved ${LLM_KEY_VAR} to .env"
    fi

    if [ -n "$OLLAMA_HOST_VAL" ]; then
        sed "s|^OLLAMA_HOST=.*|OLLAMA_HOST=${OLLAMA_HOST_VAL}|" .env > .env.tmp && mv .env.tmp .env
        log_ok "Ollama host set to ${OLLAMA_HOST_VAL}"
    fi
fi

# ── Step 3: Optional messaging setup ────────────────────────────
echo ""
echo "${BOLD}Step 3/4 — Messaging (optional — press Enter to skip)${RESET}"
echo ""
echo "  AI Partner can send results to Telegram, Discord, and Slack."
echo "  Skip this now and configure later via the Settings page."
echo ""

prompt SETUP_MESSAGING "Set up messaging now? [y/N]" "N"

if [ "$SETUP_MESSAGING" = "y" ] || [ "$SETUP_MESSAGING" = "Y" ]; then
    echo ""
    echo "  Which platforms? (press Enter to skip each)"
    echo ""

    prompt_secret TG_TOKEN "Telegram bot token (get from @BotFather)"
    if [ -n "$TG_TOKEN" ]; then
        sed "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TG_TOKEN}|" .env > .env.tmp && mv .env.tmp .env
        log_ok "Telegram token saved"
    fi

    prompt_secret DC_TOKEN "Discord bot token"
    if [ -n "$DC_TOKEN" ]; then
        sed "s|^DISCORD_BOT_TOKEN=.*|DISCORD_BOT_TOKEN=${DC_TOKEN}|" .env > .env.tmp && mv .env.tmp .env
        log_ok "Discord token saved"
    fi

    prompt_secret SL_BOT "Slack bot token (xoxb-...)"
    if [ -n "$SL_BOT" ]; then
        sed "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=${SL_BOT}|" .env > .env.tmp && mv .env.tmp .env
        log_ok "Slack bot token saved"
    fi

    prompt_secret SL_APP "Slack app token (xapp-...)"
    if [ -n "$SL_APP" ]; then
        sed "s|^SLACK_APP_TOKEN=.*|SLACK_APP_TOKEN=${SL_APP}|" .env > .env.tmp && mv .env.tmp .env
        log_ok "Slack app token saved"
    fi
fi

# ── Step 4: Start services ────────────────────────────────────────
echo ""
echo "${BOLD}Step 4/4 — Starting AI Partner${RESET}"
echo ""
log_info "Building and starting services (first run takes 3-5 minutes)..."
echo ""

docker compose up -d --build

# Pre-build the Python sandbox image so agents don't install tools at runtime.
# Runs in background — app is already starting, this just gets the sandbox ready.
log_info "Pre-building Python execution sandbox (background)..."
docker compose --profile setup up sandbox-builder 2>/dev/null || \
    docker build -t aipartner-sandbox -f docker/Dockerfile.sandbox . 2>/dev/null &

echo ""
log_info "Waiting for AI Partner to become healthy..."
attempts=0
max_attempts=40  # 2 minutes max
until curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ $attempts -ge $max_attempts ]; then
        echo ""
        log_err "Health check timed out after $((max_attempts * 3))s"
        echo ""
        echo "     Check what went wrong:"
        echo "       docker compose logs app"
        exit 1
    fi
    printf "     ⣾\r"
    sleep 1
    printf "     ⣽\r"
    sleep 1
    printf "     ⣻\r"
    sleep 1
done

# ── Auto-open browser ────────────────────────────────────────────
URL="http://localhost:${PORT}"
if [ "$INTERACTIVE" = "true" ]; then
    if command -v open >/dev/null 2>&1; then       # macOS
        open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then  # Linux
        xdg-open "$URL" >/dev/null 2>&1 &
    fi
fi

# ── Done ─────────────────────────────────────────────────────────
echo ""
printf "${GREEN}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║                                                          ║"
echo "  ║   AI Partner is running!                                 ║"
printf "  ║                                                          ║\n"
printf "  ║   Open:    ${CYAN}http://localhost:%-5s${GREEN}                       ║\n" "${PORT}"
echo "  ║                                                          ║"
echo "  ║   Logs:    docker compose logs -f app                   ║"
echo "  ║   Stop:    docker compose down                          ║"
echo "  ║   Update:  ./setup.sh --update                          ║"
echo "  ║   Reset:   ./setup.sh --reset                           ║"
echo "  ║                                                          ║"
echo "  ║   Docs:    https://github.com/AmitkrPaiwal/AI-Partner  ║"
echo "  ║                                                          ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
printf "${RESET}\n"

if [ "$has_key" = "0" ]; then
    echo ""
    log_warn "No LLM key was set. Open .env, add an API key, then run:"
    echo "       docker compose restart app"
    echo ""
fi
