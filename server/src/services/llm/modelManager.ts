import { OllamaAdapter, OllamaCloudAdapter } from './ollama';
import { LMStudioAdapter } from './lmstudio';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { AnthropicAdapter } from './anthropic';
import { GeminiAdapter } from './gemini';
import { PerplexityAdapter } from './perplexity';
import { LLMAdapter, Model } from './types';
import { configManager } from '../ConfigManager';
import { secretManager } from '../SecretManager';

export class ModelManager {
    private adapters: Map<string, LLMAdapter> = new Map();
    private activeProvider: string = 'ollama';
    private activeModel: string | null = null;
    private modelsCache: Model[] | null = null;
    private modelsCacheTime: number = 0;
    private static readonly MODELS_CACHE_TTL_MS = 30_000;

    constructor() {
        // Only register local providers in constructor (no env vars needed)
        this.adapters.set('ollama', new OllamaAdapter());
        this.adapters.set('lmstudio', new LMStudioAdapter());
        // Cloud providers registered in initialize() — after SecretManager.loadIntoEnv()
    }

    /**
     * Register cloud LLM providers from environment variables or config.
     * Each provider uses the OpenAI-compatible adapter with different baseURL/key.
     */
    private registerCloudProviders(): void {
        const providers: { name: string; envKey: string; baseURL: string; defaultModel: string; native?: boolean }[] = [
            {
                name: 'openai',
                envKey: 'OPENAI_API_KEY',
                baseURL: 'https://api.openai.com/v1',
                defaultModel: 'gpt-4o-mini'
            },
            {
                name: 'anthropic',
                envKey: 'ANTHROPIC_API_KEY',
                baseURL: 'https://api.anthropic.com/v1',
                defaultModel: 'claude-sonnet-4-20250514',
                native: true  // Uses native SDK, not OpenAI-compatible
            },
            {
                name: 'gemini',
                envKey: 'GOOGLE_API_KEY',
                baseURL: 'https://generativelanguage.googleapis.com/v1beta',
                defaultModel: 'gemini-2.0-flash',
                native: true  // Uses native SDK
            },
            {
                name: 'groq',
                envKey: 'GROQ_API_KEY',
                baseURL: 'https://api.groq.com/openai/v1',
                defaultModel: 'llama-3.3-70b-versatile'
            },
            {
                name: 'together',
                envKey: 'TOGETHER_API_KEY',
                baseURL: 'https://api.together.xyz/v1',
                defaultModel: 'meta-llama/Llama-3-70b-chat-hf'
            },
            {
                name: 'deepseek',
                envKey: 'DEEPSEEK_API_KEY',
                baseURL: 'https://api.deepseek.com/v1',
                defaultModel: 'deepseek-chat'
            },
            {
                name: 'mistral',
                envKey: 'MISTRAL_API_KEY',
                baseURL: 'https://api.mistral.ai/v1',
                defaultModel: 'mistral-large-latest'
            },
            {
                name: 'perplexity',
                envKey: 'PERPLEXITY_API_KEY',
                baseURL: 'https://api.perplexity.ai',
                defaultModel: 'sonar-pro',
                native: true
            },
            // ── Open-access / high-value community providers ──────────────────
            {
                // 100+ models via single key; free tier models available (suffix :free)
                name: 'openrouter',
                envKey: 'OPENROUTER_API_KEY',
                baseURL: 'https://openrouter.ai/api/v1',
                defaultModel: 'meta-llama/llama-3.1-8b-instruct:free'
            },
            {
                // Fastest inference on the internet — Llama 3.3 at ~100k tok/s
                name: 'cerebras',
                envKey: 'CEREBRAS_API_KEY',
                baseURL: 'https://api.cerebras.ai/v1',
                defaultModel: 'llama-3.3-70b'
            },
            {
                // Fast affordable inference for Llama / Mixtral / Qwen models
                name: 'fireworks',
                envKey: 'FIREWORKS_API_KEY',
                baseURL: 'https://api.fireworks.ai/inference/v1',
                defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct'
            },
            {
                // Cohere Command-R family — strong RAG + tool-use
                name: 'cohere',
                envKey: 'COHERE_API_KEY',
                baseURL: 'https://api.cohere.com/compatibility/v1',
                defaultModel: 'command-r-plus-08-2024'
            },
            {
                // LiteLLM local proxy — single key for 100+ providers via self-hosted router
                name: 'litellm',
                envKey: 'LITELLM_API_KEY',
                baseURL: 'http://localhost:4000/v1',
                defaultModel: 'gpt-4o-mini'
            },
            {
                // Ollama Cloud features (Search & Cloud Models)
                name: 'ollama-cloud',
                envKey: 'OLLAMA_API_KEY',
                baseURL: 'https://ollama.com/api',
                defaultModel: 'qwen3-coder:480b-cloud'
            }
        ];

        let savedProviders: any = {};

        // Check config for saved provider API keys (from Settings UI)
        try {
            const config = configManager.getConfig();
            savedProviders = (config as any).llm?.providers || {};
            const toMigrate: { envKey: string; apiKey: string; cfgEntry: any }[] = [];

            for (const [name, cfg] of Object.entries(savedProviders) as [string, any][]) {
                if (cfg?.api_key) {
                    const known = providers.find(p => p.name === name)
                        || ModelManager.KNOWN_PROVIDERS.find(p => p.name === name);
                    const envKey = known?.envKey || `${name.toUpperCase()}_API_KEY`;

                    // Set in process.env immediately (synchronous)
                    if (!process.env[envKey]) process.env[envKey] = cfg.api_key;

                    // Queue migration to SecretManager (async, fire-and-forget)
                    toMigrate.push({ envKey, apiKey: cfg.api_key, cfgEntry: cfg });

                    if (!known && cfg.base_url) {
                        providers.push({
                            name,
                            envKey,
                            baseURL: cfg.base_url,
                            defaultModel: cfg.default_model || 'default'
                        });
                    }
                }
            }

            // Migrate plaintext keys to SecretManager asynchronously
            if (toMigrate.length > 0) {
                Promise.all(toMigrate.map(m => secretManager.setSecret('default', m.envKey, m.apiKey)))
                    .then(() => {
                        toMigrate.forEach(m => delete m.cfgEntry.api_key);
                        return configManager.updateConfig({ llm: { ...config.llm, providers: savedProviders } } as any);
                    })
                    .catch(() => { /* migration failed — keys still in env, will retry next restart */ });
            }

            // Also check legacy custom_providers format
            const customProviders = (config as any).llm?.custom_providers;
            if (Array.isArray(customProviders)) {
                for (const cp of customProviders) {
                    if (cp.name && cp.base_url && cp.api_key) {
                        providers.push({
                            name: cp.name,
                            envKey: '',
                            baseURL: cp.base_url,
                            defaultModel: cp.default_model || 'default'
                        });
                        process.env[`${cp.name.toUpperCase()}_API_KEY`] = cp.api_key;
                    }
                }
            }
        } catch {
            // Config not ready yet, that's fine
        }

        for (const p of providers) {
            const apiKey = process.env[p.envKey] || '';
            if (apiKey) {
                if (p.name === 'ollama-cloud') {
                    // Full inference adapter — fetches cloud models + web search with same key
                    // Restore saved default_model from config (user may have changed it from the UI)
                    const savedDefaultModel = savedProviders['ollama-cloud']?.default_model || p.defaultModel;
                    this.adapters.set('ollama-cloud', new OllamaCloudAdapter(apiKey, savedDefaultModel));
                } else if (p.name === 'anthropic') {
                    this.adapters.set(p.name, new AnthropicAdapter(apiKey, p.defaultModel));
                } else if (p.name === 'gemini') {
                    this.adapters.set(p.name, new GeminiAdapter(apiKey, p.defaultModel));
                } else if (p.name === 'perplexity') {
                    this.adapters.set(p.name, new PerplexityAdapter(apiKey, p.defaultModel));
                } else {
                    this.adapters.set(p.name, new OpenAICompatibleAdapter(
                        p.name, p.baseURL, apiKey, p.defaultModel
                    ));
                }
                console.log(`[ModelManager] Registered cloud provider: ${p.name}`);
            }
        }
    }

    async initialize(): Promise<void> {
        // Register cloud providers here — SecretManager.loadIntoEnv() has already run,
        // so process.env contains all saved API keys (including OLLAMA_API_KEY etc.)
        this.registerCloudProviders();

        // Connect all providers in parallel — failures are non-fatal
        await Promise.allSettled(
            [...this.adapters.entries()].map(async ([name, adapter]) => {
                try {
                    await adapter.connect();
                } catch {
                    console.warn(`✗ ${name} provider unavailable`);
                }
            })
        );

        // Load saved preference from config
        let preferredProvider: string | null = null;
        let preferredModel: string | null = null;
        try {
            const config = configManager.getConfig();
            preferredProvider = config.llm?.provider;
            preferredModel = config.llm?.model;
        } catch (e) {
            // Config not ready
        }

        // Try to restore user preference first.
        // For cloud providers (all except ollama/lmstudio) trust the saved preference without
        // a network round-trip — isAvailable() can time out at container startup and cause
        // the wrong provider to be auto-selected.
        if (preferredProvider && preferredModel) {
            const prefAdapter = this.adapters.get(preferredProvider);
            if (prefAdapter) {
                const isLocalProvider = preferredProvider === 'ollama' || preferredProvider === 'lmstudio';
                const canRestore = isLocalProvider ? await prefAdapter.isAvailable() : true;
                if (canRestore) {
                    this.activeProvider = preferredProvider;
                    this.activeModel = preferredModel;
                    prefAdapter.setModel(preferredModel);
                    console.log(`[ModelManager] Restored preferred model: ${preferredProvider}/${preferredModel}`);
                    return; // We have an active model, we're done
                }
            }
        }

        // Auto-select first available if preferred is not available or not set
        for (const [name, adapter] of this.adapters) {
            if (await adapter.isAvailable()) {
                const models = await adapter.listModels();
                if (models.length > 0) {
                    this.activeProvider = name;
                    this.activeModel = models[0].id;
                    adapter.setModel(this.activeModel);
                    console.log(`Auto-selected model: ${name}/${this.activeModel}`);
                    break;
                }
            }
        }
    }

    /**
     * Hot-reload cloud providers after a new API key is saved at runtime.
     * Called by secretRoutes when a *_API_KEY secret is saved — no server restart needed.
     */
    async refreshProviders(): Promise<void> {
        this.registerCloudProviders();
        // Connect any adapters that were just registered for the first time (parallel)
        await Promise.allSettled(
            [...this.adapters.values()].map(adapter => adapter.connect().catch(() => {}))
        );
        this.modelsCache = null; // invalidate cache after provider refresh
        console.log('[ModelManager] Cloud providers refreshed');
    }

    async discoverModels(): Promise<Model[]> {
        // Return cached result if still fresh (avoids hammering providers on every UI poll)
        if (this.modelsCache && Date.now() - this.modelsCacheTime < ModelManager.MODELS_CACHE_TTL_MS) {
            return this.modelsCache;
        }

        // Query all providers in parallel; each gets a 5s timeout via their isAvailable() impl
        const results = await Promise.allSettled(
            [...this.adapters.entries()].map(async ([providerName, adapter]) => {
                if (await adapter.isAvailable()) {
                    return adapter.listModels();
                }
                return [] as Model[];
            })
        );

        const allModels: Model[] = [];
        for (const r of results) {
            if (r.status === 'fulfilled') allModels.push(...r.value);
        }

        this.modelsCache = allModels;
        this.modelsCacheTime = Date.now();
        return allModels;
    }

    async switchModel(modelId: string, provider: string): Promise<void> {
        const adapter = this.adapters.get(provider);
        if (!adapter) {
            throw new Error(`Unknown provider: ${provider}. Available: ${[...this.adapters.keys()].join(', ')}`);
        }

        if (!(await adapter.isAvailable())) {
            throw new Error(`Provider ${provider} is not available`);
        }

        adapter.setModel(modelId);
        this.activeProvider = provider;
        this.activeModel = modelId;

        // Persist the user's explicit selection
        try {
            const config = configManager.getConfig();
            await configManager.updateConfig({
                llm: { ...config.llm, provider: provider as any, model: modelId }
            });
            console.log(`[ModelManager] Persisted active model to config: ${provider}/${modelId}`);
        } catch (e) {
            console.warn(`[ModelManager] Failed to persist active model: ${e}`);
        }

        console.log(`✓ Switched to ${provider}/${modelId}`);
    }

    /**
     * Update a local provider's base URL at runtime and persist to config.json.
     * Effective immediately — no server restart needed.
     */
    async updateLocalProvider(name: 'ollama' | 'lmstudio', baseURL: string): Promise<void> {
        if (name === 'ollama') {
            const adapter = this.adapters.get('ollama') as any;
            if (adapter?.updateHost) adapter.updateHost(baseURL);
        } else if (name === 'lmstudio') {
            const adapter = this.adapters.get('lmstudio') as any;
            if (adapter?.updateBaseUrl) adapter.updateBaseUrl(baseURL);
        }
        // Persist to config.json (stored in Docker named volume /data)
        try {
            const config = configManager.getConfig();
            const local = config.localProviders || {};
            if (name === 'ollama') local.ollama = { host: baseURL };
            else local.lmstudio = { baseUrl: baseURL };
            await configManager.updateConfig({ localProviders: local } as any);
            console.log(`[ModelManager] Persisted ${name} URL to config: ${baseURL}`);
        } catch (e) {
            console.warn(`[ModelManager] Failed to persist local provider config: ${e}`);
        }
    }

    getActiveAdapter(): LLMAdapter {
        const adapter = this.adapters.get(this.activeProvider);
        if (!adapter) {
            // Failover: try other available adapters
            return this.getFailoverAdapter();
        }
        return adapter;
    }

    /**
     * Model failover: if the active adapter is unavailable, try others.
     * Priority: cloud providers first, then local.
     */
    private getFailoverAdapter(): LLMAdapter {
        // Try cloud providers first, then local
        const priority = ['openai', 'anthropic', 'gemini', 'groq', 'cerebras', 'openrouter', 'fireworks', 'perplexity', 'deepseek', 'mistral', 'cohere', 'together', 'litellm', 'ollama', 'lmstudio'];
        for (const name of priority) {
            const adapter = this.adapters.get(name);
            if (adapter) {
                console.warn(`[ModelManager] Failover: using ${name} instead of ${this.activeProvider}`);
                this.activeProvider = name;
                return adapter;
            }
        }
        // Ultimate fallback — return ollama even if null
        return this.adapters.get('ollama')!;
    }

    /**
     * Get a specific provider's adapter (useful for model routing)
     */
    getAdapter(providerName: string): LLMAdapter | undefined {
        return this.adapters.get(providerName);
    }

    /**
     * Get the next best adapter for small-model escalation.
     * Returns the first cloud adapter available (these are large/capable by default),
     * or null if no alternative exists.
     */
    getFallbackAdapter(): LLMAdapter | null {
        const LARGE_PROVIDERS = ['openai', 'anthropic', 'gemini', 'groq', 'cerebras',
                                  'openrouter', 'fireworks', 'perplexity', 'deepseek'];
        for (const name of LARGE_PROVIDERS) {
            if (name !== this.activeProvider) {
                const adapter = this.adapters.get(name);
                if (adapter) return adapter;
            }
        }
        return null;
    }

    /**
     * Get list of all registered provider names
     */
    getProviderNames(): string[] {
        return [...this.adapters.keys()];
    }

    getActiveModelStatus(): { provider: string; model: string | null } {
        return {
            provider: this.activeProvider,
            model: this.activeModel,
        };
    }

    async healthCheck(): Promise<Record<string, boolean>> {
        // Run all availability checks in parallel
        const entries = [...this.adapters.entries()];
        const results = await Promise.allSettled(
            entries.map(([, adapter]) => adapter.isAvailable())
        );

        const health: Record<string, boolean> = {};
        for (let i = 0; i < entries.length; i++) {
            const r = results[i];
            health[entries[i][0]] = r.status === 'fulfilled' ? r.value : false;
        }
        return health;
    }

    /**
     * Known cloud provider definitions (for UI display)
     */
    static readonly KNOWN_PROVIDERS = [
        { name: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', envKey: 'OPENAI_API_KEY' },
        { name: 'anthropic', label: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-20250514', envKey: 'ANTHROPIC_API_KEY' },
        { name: 'gemini', label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.0-flash', envKey: 'GOOGLE_API_KEY' },
        { name: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', envKey: 'GROQ_API_KEY' },
        { name: 'together', label: 'Together AI', baseURL: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3-70b-chat-hf', envKey: 'TOGETHER_API_KEY' },
        { name: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', envKey: 'DEEPSEEK_API_KEY' },
        { name: 'mistral', label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest', envKey: 'MISTRAL_API_KEY' },
        { name: 'perplexity', label: 'Perplexity', baseURL: 'https://api.perplexity.ai', defaultModel: 'sonar-pro', envKey: 'PERPLEXITY_API_KEY' },
        { name: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.1-8b-instruct:free', envKey: 'OPENROUTER_API_KEY', description: '100+ models via one key. Free tier: add :free suffix. See openrouter.ai/models' },
        { name: 'cerebras', label: 'Cerebras', baseURL: 'https://api.cerebras.ai/v1', defaultModel: 'llama-3.3-70b', envKey: 'CEREBRAS_API_KEY', description: 'World\'s fastest inference — ~100k tokens/s on Llama 3.3-70b. Free tier available.' },
        { name: 'fireworks', label: 'Fireworks AI', baseURL: 'https://api.fireworks.ai/inference/v1', defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', envKey: 'FIREWORKS_API_KEY', description: 'Fast affordable inference for Llama, Mixtral, Qwen open-source models.' },
        { name: 'cohere', label: 'Cohere', baseURL: 'https://api.cohere.com/compatibility/v1', defaultModel: 'command-r-plus-08-2024', envKey: 'COHERE_API_KEY', description: 'Command-R+ — strong RAG, tool-use, and long-context tasks.' },
        { name: 'litellm', label: 'LiteLLM Proxy', baseURL: 'http://localhost:4000/v1', defaultModel: 'gpt-4o-mini', envKey: 'LITELLM_API_KEY', description: 'Self-hosted proxy that routes to 100+ providers. Run: litellm --config config.yaml. See docs.litellm.ai' },
        {
            name: 'ollama-cloud',
            label: 'Ollama Cloud (Web Search)',
            baseURL: 'https://ollama.com/api',
            defaultModel: 'web-search',
            envKey: 'OLLAMA_API_KEY',
            description: 'Enables native web search for the local Ollama provider. Get key at ollama.com → Account Settings → API Keys.'
        },
    ];

    /**
     * Register or re-register a cloud provider at runtime with an API key.
     * Also persists the key to config so it survives restarts.
     */
    async registerProvider(name: string, apiKey: string, baseURL?: string, defaultModel?: string): Promise<{ success: boolean; models: Model[] }> {
        // Ollama Cloud: full inference + web search provider
        if (name === 'ollama-cloud') {
            process.env.OLLAMA_API_KEY = apiKey;
            try {
                // Store key encrypted, save only non-sensitive config
                await secretManager.setSecret('default', 'OLLAMA_API_KEY', apiKey);
                const config = configManager.getConfig();
                const providers = (config as any).llm?.providers || {};
                providers['ollama-cloud'] = { default_model: defaultModel || 'qwen3-coder:480b-cloud' };
                await configManager.updateConfig({ llm: { ...config.llm, providers } } as any);
            } catch (e) {
                console.warn(`[ModelManager] Failed to persist ollama-cloud key: ${e}`);
            }
            const known = ModelManager.KNOWN_PROVIDERS.find(p => p.name === 'ollama-cloud');
            const adapter = new OllamaCloudAdapter(apiKey, defaultModel || known?.defaultModel);
            this.adapters.set('ollama-cloud', adapter);
            await adapter.connect();
            const models = await adapter.listModels();
            console.log(`[ModelManager] Ollama Cloud registered — ${models.length} models available`);
            return { success: true, models };
        }

        // Find known provider definition
        const known = ModelManager.KNOWN_PROVIDERS.find(p => p.name === name);
        const url = baseURL || known?.baseURL;
        const model = defaultModel || known?.defaultModel || 'default';

        if (!url && name !== 'anthropic' && name !== 'gemini') {
            throw new Error(`Unknown provider "${name}" and no baseURL provided`);
        }

        // Create and register the adapter — use native adapters where appropriate
        let adapter: LLMAdapter;
        if (name === 'anthropic') {
            adapter = new AnthropicAdapter(apiKey, model);
        } else if (name === 'gemini') {
            adapter = new GeminiAdapter(apiKey, model);
        } else if (name === 'perplexity') {
            adapter = new PerplexityAdapter(apiKey, model);
        } else {
            adapter = new OpenAICompatibleAdapter(name, url!, apiKey, model);
        }
        this.adapters.set(name, adapter);

        // Try to connect
        await adapter.connect();
        const available = await adapter.isAvailable();
        const models = available ? await adapter.listModels() : [];

        // Persist: key → SecretManager (encrypted), non-sensitive config → config.json
        try {
            const envKey = known?.envKey || `${name.toUpperCase()}_API_KEY`;
            await secretManager.setSecret('default', envKey, apiKey);
            process.env[envKey] = apiKey; // make available in current process immediately
            const config = configManager.getConfig();
            const providers = (config as any).llm?.providers || {};
            providers[name] = { base_url: url, default_model: model }; // no api_key
            await configManager.updateConfig({ llm: { ...config.llm, providers } } as any);
        } catch (e) {
            console.warn(`[ModelManager] Failed to persist provider config: ${e}`);
        }

        console.log(`[ModelManager] Registered provider: ${name} (${available ? 'connected' : 'unavailable'}, ${models.length} models)`);
        return { success: available, models };
    }

    /**
     * Remove a provider
     */
    async removeProvider(name: string): Promise<void> {
        if (name === 'ollama' || name === 'lmstudio') {
            throw new Error('Cannot remove built-in local providers');
        }
        const adapter = this.adapters.get(name);
        if (adapter) {
            await adapter.disconnect();
            this.adapters.delete(name);
        }

        // Remove from config
        try {
            const config = configManager.getConfig();
            const providers = (config as any).llm?.providers || {};
            delete providers[name];
            await configManager.updateConfig({ llm: { ...config.llm, providers } } as any);
        } catch (e) {
            console.warn(`[ModelManager] Failed to remove provider from config: ${e}`);
        }
    }

    /**
     * Get provider configurations (with keys masked for security)
     */
    getProviderConfigs(): { name: string; label: string; baseURL: string; defaultModel: string; configured: boolean; connected: boolean; keyMasked: string }[] {
        const configs: any[] = [];

        // Local providers
        configs.push({
            name: 'ollama', label: 'Ollama (Local)', baseURL: 'http://localhost:11434',
            defaultModel: 'llama3.2', configured: true, connected: this.adapters.has('ollama'), keyMasked: 'N/A (local)'
        });
        configs.push({
            name: 'lmstudio', label: 'LM Studio (Local)', baseURL: 'http://localhost:1234/v1',
            defaultModel: 'local-model', configured: true, connected: this.adapters.has('lmstudio'), keyMasked: 'N/A (local)'
        });

        // Cloud providers (including ollama-cloud which is a feature key, not an inference provider)
        for (const known of ModelManager.KNOWN_PROVIDERS) {
            let keyMasked = '';
            const envVal = process.env[known.envKey];
            if (envVal) {
                keyMasked = envVal.substring(0, 4) + '...' + envVal.substring(envVal.length - 4);
            }

            // Check config for saved keys
            try {
                const config = configManager.getConfig();
                const savedProviders = (config as any).llm?.providers || {};
                if (savedProviders[known.name]?.api_key) {
                    const key = savedProviders[known.name].api_key;
                    keyMasked = key.substring(0, 4) + '...' + key.substring(key.length - 4);
                }
            } catch { /* ignore */ }

            if (false) {
                // (ollama-cloud now handled by the generic path below)
            } else {
                const hasAdapter = this.adapters.has(known.name);
                configs.push({
                    name: known.name,
                    label: known.label,
                    baseURL: known.baseURL,
                    defaultModel: known.defaultModel,
                    configured: hasAdapter && !!keyMasked,
                    connected: hasAdapter,
                    keyMasked: keyMasked || 'Not configured'
                });
            }
        }

        return configs;
    }
}

export const modelManager = new ModelManager(); // Singleton instance
