#!/bin/sh
set -e

echo "╔═══════════════════════════════════════╗"
echo "║        AI Partner — Starting          ║"
echo "╚═══════════════════════════════════════╝"

# Create data directories
mkdir -p /data/logs /data/credentials /data/cache
mkdir -p /workspace/output/deliverables

# Build sandbox image if Docker socket is available
if [ -S /var/run/docker.sock ]; then
    echo "[entrypoint] Docker socket detected"
    # Build the sandbox image if not already present
    if ! docker image inspect aipartner-sandbox >/dev/null 2>&1; then
        echo "[entrypoint] Building sandbox image (first run)..."
        docker build -t aipartner-sandbox -f /app/docker/Dockerfile.sandbox /app/docker/ 2>/dev/null || \
            echo "[entrypoint] Sandbox build skipped — will use node:20-slim fallback"
    else
        echo "[entrypoint] Sandbox image already exists"
    fi
    # Pull lightweight images for ContainerSandbox (Python/JS inline execution)
    for img in python:3.11-alpine node:20-alpine; do
        if ! docker image inspect "$img" >/dev/null 2>&1; then
            echo "[entrypoint] Pulling $img..."
            docker pull "$img" 2>/dev/null || echo "[entrypoint] Pull $img skipped"
        fi
    done
else
    echo "[entrypoint] No Docker socket — sandbox execution disabled"
fi

# Check Ollama connectivity
if [ -n "$OLLAMA_HOST" ]; then
    if curl -sf "$OLLAMA_HOST/api/version" >/dev/null 2>&1; then
        echo "[entrypoint] Ollama reachable at $OLLAMA_HOST"
    else
        echo "[entrypoint] WARNING: Ollama not reachable at $OLLAMA_HOST"
    fi
fi

echo "[entrypoint] Starting AI Partner server..."
exec node --import tsx "$@"
