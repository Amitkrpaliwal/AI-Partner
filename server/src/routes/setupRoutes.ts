/**
 * Setup Routes — powers the first-run onboarding wizard.
 *
 * GET  /api/setup/status          — is setup complete?
 * GET  /api/setup/llm-test        — test if an LLM key works
 * POST /api/setup/complete        — write .env and restart
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { secretManager } from '../services/SecretManager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// ── Resolve the .env file location ───────────────────────────────────────────
// In Docker: /app/.env (project root)
// Native: project root (3 levels up from server/src/routes/)
function getEnvPath(): string {
    const candidates = [
        path.join(__dirname, '../../../.env'),   // native: repo root
        '/app/.env',                              // docker
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0]; // default to repo root even if not yet created
}

function readEnv(): Record<string, string> {
    const envPath = getEnvPath();
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        result[key] = val;
    }
    return result;
}

function writeEnv(vars: Record<string, string>): void {
    const envPath = getEnvPath();
    const existing = readEnv();
    const merged = { ...existing, ...vars };

    // Filter out empty-string values from vars (keep existing non-empty ones)
    for (const [k, v] of Object.entries(vars)) {
        if (v === '') {
            // Only remove if it was already empty (don't wipe real keys)
            if (!existing[k]) delete merged[k];
            else merged[k] = existing[k];
        }
    }

    let content = '';
    for (const [k, v] of Object.entries(merged)) {
        content += `${k}=${v}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf-8');
}

// ── GET /api/setup/llm-test ───────────────────────────────────────────────────
// Quick connectivity test — called from the wizard before saving.
// Uses lightweight probe calls (models list or tags) — no token usage.
router.get('/llm-test', async (req: Request, res: Response) => {
    const { provider, apiKey, ollamaHost } = req.query as Record<string, string>;
    if (!provider) return res.status(400).json({ ok: false, error: 'Missing provider' });

    const friendly = (e: unknown, providerName: string, host?: string): string => {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid_api_key') || msg.includes('incorrect api key'))
            return 'Invalid API key — double-check it at the provider dashboard';
        if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit'))
            return 'Rate limit or quota exceeded — try again in a moment';
        if (msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network') || msg.includes('enotfound'))
            return `Cannot connect to ${providerName === 'ollama' ? (host || 'Ollama') : providerName} — is it reachable?`;
        return (e instanceof Error ? e.message : String(e)).substring(0, 120);
    };

    try {
        if (provider === 'ollama') {
            const host = (ollamaHost || 'http://localhost:11434').replace(/\/$/, '');
            const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
            if (!r.ok) return res.json({ ok: false, error: `Ollama returned ${r.status}` });
            return res.json({ ok: true });
        }

        if (provider === 'anthropic') {
            const r = await fetch('https://api.anthropic.com/v1/models', {
                headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                signal: AbortSignal.timeout(8000),
            });
            if (!r.ok) {
                const body = await r.json().catch(() => ({})) as Record<string, any>;
                return res.json({ ok: false, error: friendly(new Error(body?.error?.message || String(r.status)), provider) });
            }
            return res.json({ ok: true });
        }

        if (provider === 'google') {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
                signal: AbortSignal.timeout(8000),
            });
            if (!r.ok) {
                const body = await r.json().catch(() => ({})) as Record<string, any>;
                return res.json({ ok: false, error: friendly(new Error(body?.error?.message || String(r.status)), provider) });
            }
            return res.json({ ok: true });
        }

        // OpenAI-compatible: openai, groq, deepseek, mistral, perplexity, together
        const BASE_URL: Record<string, string> = {
            openai: 'https://api.openai.com/v1',
            groq: 'https://api.groq.com/openai/v1',
            deepseek: 'https://api.deepseek.com/v1',
            mistral: 'https://api.mistral.ai/v1',
            perplexity: 'https://api.perplexity.ai',
            together: 'https://api.together.xyz/v1',
        };
        const base = BASE_URL[provider] || 'https://api.openai.com/v1';
        const r = await fetch(`${base}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
            const body = await r.json().catch(() => ({})) as Record<string, any>;
            return res.json({ ok: false, error: friendly(new Error(body?.error?.message || String(r.status)), provider) });
        }
        return res.json({ ok: true });
    } catch (e: unknown) {
        return res.json({ ok: false, error: friendly(e, provider, ollamaHost) });
    }
});

// ── GET /api/setup/status ─────────────────────────────────────────────────────
router.get('/status', (_req: Request, res: Response) => {
    // ✅ Check process.env — SecretManager loads persisted keys here at startup.
    // Do NOT read the .env file: inside Docker it's ephemeral and lost on restart.
    const llmProviders = [
        'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
        'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY',
        'TOGETHER_API_KEY', 'PERPLEXITY_API_KEY',
    ];
    const hasLLMKey = llmProviders.some(k => (process.env[k] || '').trim().length > 5);

    // OLLAMA_HOST is pre-set in docker-compose.yml, so don't use it alone as "setup done".
    // Only count Ollama if no cloud key exists AND user explicitly picked it
    // (indicated by AI_PARTNER_PERSONALITY being set, which the wizard always writes).
    const hasPersona = !!(process.env.AI_PARTNER_PERSONALITY || process.env.AI_PARTNER_USER_NAME);
    const isOllamaExplicit = hasPersona && (process.env.OLLAMA_HOST || '').trim().length > 0 && !hasLLMKey;

    res.json({
        setupComplete: hasLLMKey || isOllamaExplicit,
        hasLLMKey,
        hasOllama: !!(process.env.OLLAMA_HOST || '').trim(),
        runMode: process.env.RUN_MODE || 'native',
        existingConfig: {
            llmProvider: hasLLMKey
                ? llmProviders.find(k => (process.env[k] || '').trim().length > 5)?.replace('_API_KEY', '').toLowerCase()
                : isOllamaExplicit ? 'ollama' : null,
            telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
            discordConfigured: !!(process.env.DISCORD_BOT_TOKEN || '').trim(),
            workspaceConfigured: !!(process.env.HOST_WORKSPACE || '').trim(),
        }
    });
});

// ── POST /api/setup/complete ──────────────────────────────────────────────────
router.post('/complete', async (req: Request, res: Response) => {
    try {
        const { llm, integrations, workspace, persona } = req.body as {
            llm: { provider: string; apiKey: string; ollamaHost?: string };
            integrations: Record<string, string>;
            workspace: { hostPath?: string };
            persona: { userName: string; agentPersonality: string; customPrompt?: string };
        };

        const envVars: Record<string, string> = {};

        // ── LLM ──
        const providerKeyMap: Record<string, string> = {
            openai: 'OPENAI_API_KEY',
            anthropic: 'ANTHROPIC_API_KEY',
            google: 'GOOGLE_API_KEY',
            groq: 'GROQ_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
            mistral: 'MISTRAL_API_KEY',
            perplexity: 'PERPLEXITY_API_KEY',
            together: 'TOGETHER_API_KEY',
        };
        if (llm.provider === 'ollama') {
            envVars['OLLAMA_HOST'] = llm.ollamaHost || 'http://localhost:11434';
        } else {
            const envKey = providerKeyMap[llm.provider];
            if (envKey && llm.apiKey) envVars[envKey] = llm.apiKey;
        }

        // ── Integrations ──
        const integrationKeyMap: Record<string, string> = {
            telegram: 'TELEGRAM_BOT_TOKEN',
            discord: 'DISCORD_BOT_TOKEN',
            github: 'GITHUB_TOKEN',
            notion: 'NOTION_API_KEY',
            brave: 'BRAVE_API_KEY',
            serpapi: 'SERPAPI_API_KEY',
        };
        for (const [service, val] of Object.entries(integrations)) {
            const k = integrationKeyMap[service];
            if (k && val) envVars[k] = val;
        }

        // ── Workspace ──
        if (workspace.hostPath) {
            envVars['HOST_WORKSPACE'] = workspace.hostPath;
        }

        // ── Persona ──
        if (persona.userName) envVars['AI_PARTNER_USER_NAME'] = persona.userName;
        if (persona.agentPersonality) envVars['AI_PARTNER_PERSONALITY'] = persona.agentPersonality;

        // Save to .env file (persists within container layer)
        writeEnv(envVars);

        // ALSO save to SecretManager (encrypted, survives container recreation)
        await Promise.all(
            Object.entries(envVars)
                .filter(([, v]) => v)
                .map(([k, v]) => secretManager.setSecret('default', k, v))
        );

        // Set in current process immediately so status check works right away
        for (const [k, v] of Object.entries(envVars)) {
            if (v) process.env[k] = v;
        }

        res.json({ success: true, message: 'Configuration saved. Reload the app to apply.' });

        // Graceful restart after short delay (so response is sent first)
        setTimeout(() => {
            console.log('[Setup] Configuration updated — scheduled restart');
            process.exit(0); // Docker/pm2 will restart the process
        }, 1500);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/setup/factory-reset ────────────────────────────────────────────
router.post('/factory-reset', async (req: Request, res: Response) => {
    try {
        const wipeWorkspace: boolean = req.body?.wipeWorkspace === true;

        // Wipe all sensitive env keys (keep infrastructure vars)
        const env = readEnv();
        const KEEP = new Set([
            'NODE_ENV', 'RUN_MODE', 'AI_PARTNER_DATA_DIR', 'AI_PARTNER_WORKSPACE_DIR',
            'SEARXNG_ENDPOINT', 'OLLAMA_HOST',
            'AI_PARTNER_JWT_SECRET', 'AI_PARTNER_AUTH_ENABLED', 'AI_PARTNER_MASTER_KEY',
        ]);
        const stripped: Record<string, string> = {};
        for (const [k, v] of Object.entries(env)) {
            stripped[k] = KEEP.has(k) ? v : '';
        }
        writeEnv(stripped);

        // Wipe all user data from the database — use actual table names from migrations
        const { db } = await import('../database/index.js');
        const WIPE_TABLES = [
            // Conversations & messages
            'conversations', 'messages',
            // Memory — correct table names (MemoryConsolidator creates user_preferences inline)
            'episodic_memory', 'biographic_facts', 'core_memory', 'persona',
            'user_preferences',
            // Goals & executions
            'goal_executions', 'autonomous_executions', 'goal_outcomes', 'goal_outcome_tags',
            'paused_ooda_states',
            // Files
            'generated_files',
            // Skills & tools
            'installed_skills', 'learned_skills', 'dynamic_tools',
            // Tasks
            'scheduled_tasks', 'scheduler_run_history',
            // Agents & config
            'agent_profiles', 'chat_adapter_configs',
            // Logs & secrets
            'heartbeat_logs', 'audit_log', 'secrets',
        ];
        for (const table of WIPE_TABLES) {
            await db.run(`DELETE FROM ${table}`).catch(() => { /* table may not exist yet */ });
        }

        // Optionally wipe workspace files on disk
        if (wipeWorkspace) {
            const { configManager } = await import('../services/ConfigManager.js');
            const workspaceDir = configManager.getWorkspaceDir();
            if (workspaceDir && fs.existsSync(workspaceDir)) {
                // Preserve essential config files — these contain user-authored content
                const PRESERVE = new Set([
                    'SOUL.md', 'HEARTBEAT.md', 'AGENTS.md',
                    'README.md', 'config-repo', 'skills', 'schemas',
                ]);
                for (const entry of fs.readdirSync(workspaceDir)) {
                    if (PRESERVE.has(entry)) continue;
                    const fullPath = path.join(workspaceDir, entry);
                    try {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                    } catch { /* ignore individual file errors */ }
                }
                console.log(`[Setup] Workspace wiped (preserved: ${[...PRESERVE].join(', ')}): ${workspaceDir}`);
            }
        }

        res.json({ success: true, message: 'Factory reset complete. Restarting...' });
        setTimeout(() => {
            console.log('[Setup] Factory reset — restarting');
            process.exit(0);
        }, 1500);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export const setupRoutes = router;

