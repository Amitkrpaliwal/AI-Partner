import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Application configuration following the new architecture spec.
 * Stored in ~/.mindful-assistant/config.json
 */
export interface AppConfig {
    user_id: string;
    workspace_dir: string;
    heartbeat: {
        enabled: boolean;
        interval: '15m' | '30m' | '1h' | '24h';
        active_hours: { start: string; end: string };
        checklist_file: string;
        notify: ('in_app' | 'email' | 'desktop' | 'webhook')[];
        preferred_channel?: string;   // 'telegram' | 'discord' | 'slack' | 'web'
        channel_chat_id?: string;     // Telegram chat ID / Discord channel ID to send results to
    };
    llm: {
        provider: 'ollama' | 'lmstudio' | 'openai' | 'anthropic' | 'groq' | 'together' | 'deepseek' | 'mistral';
        model: string;
        temperature: number;
        max_tokens: number;
        api_key_file?: string;
        providers?: Record<string, { api_key: string; base_url: string; default_model: string }>;
        custom_providers?: { name: string; base_url: string; api_key: string; default_model: string }[];
    };
    mcp: {
        enabled: boolean;
    };
    execution: {
        /** Single source of truth for approval behaviour.
         *  'none'   — fully autonomous, no pauses
         *  'script' — pause only to review generated scripts (default)
         *  'all'    — pause before every write_file / run_command / delete
         */
        approval_mode: 'none' | 'script' | 'all';
        /** Seconds to wait for human approval in 'all' mode before auto-denying */
        hitl_timeout_seconds: number;
        // Legacy fields — kept for backwards compat, derived from approval_mode
        autonomous_mode: boolean;
        max_iterations: number;
        require_approval_for_writes: boolean;
        require_docker: boolean;
    };
    search: {
        preferred_provider: 'searxng' | 'brave' | 'duckduckgo' | 'auto';
        searxng_endpoint: string;
        brave_api_key: string;
    };
    container: {
        enabled: boolean;
        image: string;
        memory_limit: string;
        cpu_limit: string;
        idle_timeout_minutes: number;
    };
    embedding: {
        preferred_provider: 'ollama' | 'openai' | 'cohere' | 'local-tfidf' | 'auto';
        ollama_model: string;
        openai_api_key: string;
        openai_model: string;
        openai_base_url: string;
        cohere_api_key: string;
        cohere_model: string;
    };
    /** Persisted local provider URLs — survives Docker restarts via named volume */
    localProviders?: {
        ollama?: { host: string };
        lmstudio?: { baseUrl: string };
    };
}

/**
 * ConfigManager - Manages application configuration
 * 
 * Storage locations:
 * - App data: ~/.mindful-assistant/
 * - Workspace: User-specified directory (default: ~/mindful-assistant/)
 */
export class ConfigManager {
    private appDataDir: string;
    private configPath: string;
    private config: AppConfig;
    private templatesPath: string;

    constructor() {
        // App data directory: env override for Docker, or ~/.mindful-assistant/
        this.appDataDir = process.env.AI_PARTNER_DATA_DIR
            || path.join(os.homedir(), '.mindful-assistant');
        this.configPath = path.join(this.appDataDir, 'config.json');
        this.templatesPath = path.join(__dirname, '../../templates/workspace');

        // Ensure app data directory exists
        this.ensureAppDataDir();

        // Load or create config
        this.config = this.loadConfig();
    }

    /**
     * Ensure app data directory structure exists
     */
    private ensureAppDataDir(): void {
        const dirs = [
            this.appDataDir,
            path.join(this.appDataDir, 'logs'),
            path.join(this.appDataDir, 'credentials'),
            path.join(this.appDataDir, 'cache')
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`[ConfigManager] Created directory: ${dir}`);
            }
        }
    }

    /**
     * Load config from file or create defaults
     */
    private loadConfig(): AppConfig {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf-8');
                const loaded = JSON.parse(raw);
                const defaults = this.defaults();
                // Deep-merge nested objects so new sub-fields get their defaults
                // even when loading an older config that predates them.
                const merged: AppConfig = {
                    ...defaults,
                    ...loaded,
                    execution: { ...defaults.execution, ...(loaded.execution || {}) },
                    heartbeat:  { ...defaults.heartbeat,  ...(loaded.heartbeat  || {}) },
                    llm:        { ...defaults.llm,        ...(loaded.llm        || {}) },
                    search:     { ...defaults.search,     ...(loaded.search     || {}) },
                    container:  { ...defaults.container,  ...(loaded.container  || {}) },
                    embedding:  { ...defaults.embedding,  ...(loaded.embedding  || {}) },
                    mcp:        { ...defaults.mcp,        ...(loaded.mcp        || {}) },
                };
                // Resolve approval_mode for configs that pre-date the field
                merged.execution = ConfigManager.resolveApprovalMode(merged.execution);
                return merged;
            }
        } catch (e) {
            console.error('[ConfigManager] Failed to load config, using defaults:', e);
        }

        const defaultConfig = this.defaults();
        this.saveConfig(defaultConfig);
        return defaultConfig;
    }

    /**
     * Bidirectional derivation between approval_mode (new) and the legacy
     * autonomous_mode / require_approval_for_writes booleans.
     * Called on load and on every updateConfig() so both representations
     * are always in sync regardless of which field the caller wrote.
     */
    private static resolveApprovalMode(
        exec: AppConfig['execution']
    ): AppConfig['execution'] {
        const result = { ...exec };

        if (result.approval_mode !== undefined) {
            // New field present — derive legacy fields from it
            result.autonomous_mode = result.approval_mode !== 'all';
            result.require_approval_for_writes = result.approval_mode !== 'none';
        } else if (result.autonomous_mode !== undefined || result.require_approval_for_writes !== undefined) {
            // Only legacy fields present — derive approval_mode from them
            const isAuto = result.autonomous_mode ?? false;
            const requiresApproval = result.require_approval_for_writes ?? true;
            result.approval_mode = isAuto && !requiresApproval ? 'none'
                : isAuto && requiresApproval  ? 'script'
                : 'all';
        } else {
            // Nothing set (brand-new install) — safe default
            result.approval_mode = 'script';
            result.autonomous_mode = true;
            result.require_approval_for_writes = true;
        }

        return result;
    }

    /**
     * Default configuration
     */
    private defaults(): AppConfig {
        const defaultWorkspace = process.env.AI_PARTNER_WORKSPACE_DIR
            || path.join(os.homedir(), 'mindful-assistant');

        return {
            user_id: 'default',
            workspace_dir: defaultWorkspace,
            heartbeat: {
                enabled: true,
                interval: '30m',
                active_hours: { start: '00:00', end: '23:59' },  // ProactiveAgenda handles quiet hours in IST
                checklist_file: 'HEARTBEAT.md',
                notify: ['in_app']
            },
            llm: {
                provider: 'ollama',
                model: 'llama3',
                temperature: 0.7,
                max_tokens: 4096
            },
            mcp: {
                enabled: true
            },
            execution: {
                approval_mode: 'script',            // Safest non-annoying default
                hitl_timeout_seconds: 60,           // Auto-deny after 60s in 'all' mode
                autonomous_mode: true,              // Legacy — derived from approval_mode
                max_iterations: 50,
                require_approval_for_writes: true,  // Legacy — derived from approval_mode
                require_docker: true,
            },
            search: {
                preferred_provider: 'auto',  // Auto-detect best available
                searxng_endpoint: process.env.SEARXNG_ENDPOINT
                    ? `${process.env.SEARXNG_ENDPOINT}/search`
                    : 'http://localhost:8888/search',
                brave_api_key: '',
            },
            container: {
                enabled: true,
                image: 'node:20-slim',
                memory_limit: '512m',
                cpu_limit: '1.0',
                idle_timeout_minutes: 30,
            },
            embedding: {
                preferred_provider: 'auto',
                ollama_model: 'nomic-embed-text',
                openai_api_key: '',
                openai_model: 'text-embedding-3-small',
                openai_base_url: '',
                cohere_api_key: '',
                cohere_model: 'embed-english-v3.0',
            },
            localProviders: {
                ollama: { host: '' },
                lmstudio: { baseUrl: '' },
            },
        };
    }

    /**
     * Get current configuration
     */
    getConfig(): AppConfig {
        return { ...this.config };
    }

    /**
     * Get app data directory path
     */
    getAppDataDir(): string {
        return this.appDataDir;
    }

    /**
     * Get workspace directory path
     */
    getWorkspaceDir(): string {
        return this.config.workspace_dir;
    }

    /**
     * Get database path
     */
    getDatabasePath(): string {
        return path.join(this.appDataDir, 'memory.db');
    }

    /**
     * Update configuration
     */
    async updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
        this.config = {
            ...this.config,
            ...updates,
            // Deep-merge execution so callers can pass partial execution objects
            ...(updates.execution ? {
                execution: ConfigManager.resolveApprovalMode({
                    ...this.config.execution,
                    ...updates.execution,
                })
            } : {})
        };
        await this.saveConfig(this.config);
        return this.config;
    }

    /**
     * Save configuration to file
     */
    private async saveConfig(config: AppConfig): Promise<void> {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
            console.log(`[ConfigManager] Saved config to ${this.configPath}`);
        } catch (e) {
            console.error('[ConfigManager] Failed to save config:', e);
        }
    }

    /**
     * Initialize workspace directory with template files
     */
    async initializeWorkspace(workspacePath?: string): Promise<boolean> {
        const targetDir = workspacePath || this.config.workspace_dir;

        try {
            // Create workspace directory if it doesn't exist
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // Copy template files if they don't exist
            const templateFiles = [
                'AGENTS.md',
                'SOUL.md',
                'USER.md',
                'TOOLS.md',
                'HEARTBEAT.md'
            ];

            for (const file of templateFiles) {
                const targetPath = path.join(targetDir, file);
                const templatePath = path.join(this.templatesPath, file);

                if (!fs.existsSync(targetPath) && fs.existsSync(templatePath)) {
                    fs.copyFileSync(templatePath, targetPath);
                    console.log(`[ConfigManager] Created ${file} in workspace`);
                }
            }

            // Copy skills directory
            const skillsTemplateDir = path.join(this.templatesPath, 'skills');
            const skillsTargetDir = path.join(targetDir, 'skills');

            if (!fs.existsSync(skillsTargetDir) && fs.existsSync(skillsTemplateDir)) {
                this.copyDirectory(skillsTemplateDir, skillsTargetDir);
                console.log('[ConfigManager] Created skills/ directory in workspace');
            }

            // Update config with workspace path
            if (workspacePath && workspacePath !== this.config.workspace_dir) {
                await this.updateConfig({ workspace_dir: workspacePath });
            }

            console.log(`[ConfigManager] Workspace initialized at: ${targetDir}`);
            return true;
        } catch (e) {
            console.error('[ConfigManager] Failed to initialize workspace:', e);
            return false;
        }
    }

    /**
     * Recursively copy a directory
     */
    private copyDirectory(src: string, dest: string): void {
        fs.mkdirSync(dest, { recursive: true });

        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            if (entry.isDirectory()) {
                this.copyDirectory(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    /**
     * Check if workspace is initialized
     */
    isWorkspaceInitialized(): boolean {
        const requiredFiles = ['AGENTS.md', 'SOUL.md'];

        for (const file of requiredFiles) {
            if (!fs.existsSync(path.join(this.config.workspace_dir, file))) {
                return false;
            }
        }

        return true;
    }
}

// Singleton instance
export const configManager = new ConfigManager();
