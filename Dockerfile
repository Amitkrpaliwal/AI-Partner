# ══════════════════════════════════════════════════════════
# AI Partner — Multi-stage Docker Build
# ══════════════════════════════════════════════════════════
# Usage:
#   docker compose build        (recommended)
#   docker build -t aipartner .
# ══════════════════════════════════════════════════════════

# ── Stage 1: Build the React client ──────────────────────
# Using slim (Debian) instead of Alpine to avoid rollup native binding issues
FROM node:20-slim AS client-builder

WORKDIR /build

# Copy workspace root + all package.json files for npm workspace resolution
COPY package.json package-lock.json* ./
COPY shared/package.json shared/package.json
COPY shared/tsconfig.json shared/tsconfig.json
COPY shared/index.ts shared/index.ts
COPY server/package.json server/package.json
COPY client/package.json client/package.json

# Install only client + shared workspace deps
# Note: npm workspace install may skip platform-specific optional deps from lock file
RUN npm install -w client -w shared --legacy-peer-deps && \
    npm install @rollup/rollup-linux-x64-gnu --legacy-peer-deps 2>/dev/null || true && \
    # Ensure typescript devDep is available for shared build
    npm install -w shared typescript --save-dev --legacy-peer-deps 2>/dev/null || true

# Build shared types (client may reference them)
RUN npm run build -w shared || true

# Copy client source
COPY client/ client/

# Build client — skip tsc type-checking, just run Vite bundler
RUN cd client && npx vite build


# ── Stage 2: Production runtime ──────────────────────────
FROM node:20-slim AS runtime

# Install runtime system dependencies
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    curl \
    python3 \
    # Browser / Playwright dependencies
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libnspr4 \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI only (for ContainerSession docker exec commands + entrypoint)
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends ca-certificates gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json* ./

# Copy all workspace packages' package.json
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json

# Install all dependencies (server needs native modules like sqlite3)
RUN npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps

# Install tsx globally for TypeScript execution
RUN npm install -g tsx

# Install Playwright Chromium using the EXACT version from package.json.
# Must run AFTER npm ci so the binary version matches the installed package.
# PLAYWRIGHT_BROWSERS_PATH tells playwright where to store the browser binary.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright && \
    node_modules/.bin/playwright install chromium --with-deps && \
    chmod -R 777 /ms-playwright

# Copy shared source + build it
COPY shared/ shared/
RUN npm run build -w shared

# Copy server source (tsx runs TypeScript directly)
COPY server/src/ server/src/
COPY server/tsconfig.json server/tsconfig.json
COPY server/templates/ server/templates/
# Copy server config/prompt/skill directories (editable without code change)
COPY server/config/ server/config/
COPY server/prompts/ server/prompts/
COPY server/skills/ server/skills/

# Copy built React client from builder stage
COPY --from=client-builder /build/client/dist/ client/dist/

# Copy Docker support files (entrypoint, Dockerfile.sandbox)
COPY docker/ docker/
# Fix Windows CRLF line endings and make executable
RUN sed -i 's/\r$//' docker/docker-entrypoint.sh && chmod +x docker/docker-entrypoint.sh

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -m appuser

# Create data and workspace directories
RUN mkdir -p /data /workspace && chown -R appuser:appuser /data /workspace

# Environment
ENV NODE_ENV=production
ENV AI_PARTNER_DATA_DIR=/data
ENV AI_PARTNER_WORKSPACE_DIR=/workspace

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
    CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/app/docker/docker-entrypoint.sh"]
CMD ["/app/server/src/index.ts"]
