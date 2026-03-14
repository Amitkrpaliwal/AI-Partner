import type { EmbeddingProvider } from './EmbeddingProvider';
import { OllamaEmbedding } from './providers/OllamaEmbedding';
import { OpenAIEmbedding } from './providers/OpenAIEmbedding';
import { CohereEmbedding } from './providers/CohereEmbedding';
import { LocalTFIDFEmbedding } from './providers/LocalTFIDFEmbedding';

/**
 * EmbeddingManager — Provider chain with automatic fallback (Phase 16.6)
 *
 * Chain: Ollama → OpenAI → Cohere → LocalTF-IDF
 * The first available provider is used. If it fails, the next is tried.
 * LocalTF-IDF is always available as the last resort.
 *
 * Tracks which provider is currently active so VectorMemory knows
 * the dimension of embeddings being produced.
 */

export interface EmbeddingManagerStatus {
    activeProvider: string | null;
    activeDimensions: number;
    providers: { name: string; available: boolean; dimensions: number }[];
}

export class EmbeddingManager {
    private providers: EmbeddingProvider[] = [];
    private activeProvider: EmbeddingProvider | null = null;
    private initialized = false;

    constructor() {
        // Build default provider chain
        this.providers = [
            new OllamaEmbedding(),
            new OpenAIEmbedding(),
            new CohereEmbedding(),
            new LocalTFIDFEmbedding(),
        ];
    }

    /**
     * Configure the provider chain from config.
     * Call this after ConfigManager is ready to override defaults.
     */
    configure(config: {
        preferred?: string;
        ollama_model?: string;
        ollama_dimensions?: number;
        openai_api_key?: string;
        openai_model?: string;
        openai_dimensions?: number;
        openai_base_url?: string;
        cohere_api_key?: string;
        cohere_model?: string;
        cohere_dimensions?: number;
        tfidf_dimensions?: number;
    }): void {
        const providers: EmbeddingProvider[] = [];

        // Build providers with custom config
        const ollama = new OllamaEmbedding(
            config.ollama_model || 'nomic-embed-text',
            config.ollama_dimensions || 768
        );
        const openai = new OpenAIEmbedding(
            config.openai_model || 'text-embedding-3-small',
            config.openai_dimensions || 1536,
            config.openai_api_key,
            config.openai_base_url
        );
        const cohere = new CohereEmbedding(
            config.cohere_model || 'embed-english-v3.0',
            config.cohere_dimensions || 1024,
            config.cohere_api_key
        );
        const tfidf = new LocalTFIDFEmbedding(config.tfidf_dimensions || 256);

        // Order by preference
        if (config.preferred) {
            const preferred = config.preferred.toLowerCase();
            const all = { ollama, openai, cohere, 'local-tfidf': tfidf } as Record<string, EmbeddingProvider>;
            if (all[preferred]) {
                providers.push(all[preferred]);
            }
            // Add remaining in default order
            for (const [name, provider] of Object.entries(all)) {
                if (name !== preferred) providers.push(provider);
            }
        } else {
            providers.push(ollama, openai, cohere, tfidf);
        }

        this.providers = providers;
        this.activeProvider = null;
        this.initialized = false;
        console.log(`[EmbeddingManager] Configured chain: ${providers.map(p => p.name).join(' → ')}`);
    }

    /**
     * Initialize — find the first available provider
     */
    async initialize(): Promise<EmbeddingProvider | null> {
        if (this.initialized && this.activeProvider) return this.activeProvider;

        for (const provider of this.providers) {
            try {
                const available = await provider.isAvailable();
                if (available) {
                    this.activeProvider = provider;
                    this.initialized = true;
                    console.log(`[EmbeddingManager] Active provider: ${provider.name} (${provider.dimensions}d)`);
                    return provider;
                }
            } catch (e) {
                console.warn(`[EmbeddingManager] Provider ${provider.name} check failed:`, e);
            }
        }

        console.warn('[EmbeddingManager] No embedding provider available');
        this.initialized = true;
        return null;
    }

    /**
     * Get the currently active provider (or initialize if not yet done)
     */
    async getActiveProvider(): Promise<EmbeddingProvider | null> {
        if (!this.initialized) return this.initialize();
        return this.activeProvider;
    }

    /**
     * Get the dimensions of the active provider
     */
    getActiveDimensions(): number {
        return this.activeProvider?.dimensions ?? 0;
    }

    /**
     * Get the active provider name
     */
    getActiveProviderName(): string {
        return this.activeProvider?.name ?? 'none';
    }

    /**
     * Embed a single text using the active provider (with fallback)
     */
    async embed(text: string): Promise<Float32Array | null> {
        const provider = await this.getActiveProvider();
        if (!provider) return null;

        const result = await provider.embed(text);
        if (result) return result;

        // Active provider failed — try remaining providers
        return this.fallbackEmbed(text, provider);
    }

    /**
     * Embed multiple texts using the active provider (with fallback)
     */
    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        const provider = await this.getActiveProvider();
        if (!provider) return texts.map(() => null);

        const results = await provider.embedBatch(texts);
        // If all failed, try fallback
        if (results.every(r => r === null)) {
            return this.fallbackEmbedBatch(texts, provider);
        }
        return results;
    }

    /**
     * Check if embeddings are available at all
     */
    async isAvailable(): Promise<boolean> {
        const provider = await this.getActiveProvider();
        return provider !== null;
    }

    /**
     * Get status of all providers
     */
    async getStatus(): Promise<EmbeddingManagerStatus> {
        const statuses = await Promise.all(
            this.providers.map(async (p) => {
                let available = false;
                try {
                    available = await p.isAvailable();
                } catch { /* not available */ }
                return { name: p.name, available, dimensions: p.dimensions };
            })
        );

        return {
            activeProvider: this.activeProvider?.name ?? null,
            activeDimensions: this.activeProvider?.dimensions ?? 0,
            providers: statuses,
        };
    }

    /**
     * Try remaining providers after active provider failed
     */
    private async fallbackEmbed(text: string, failed: EmbeddingProvider): Promise<Float32Array | null> {
        for (const provider of this.providers) {
            if (provider === failed) continue;
            try {
                const available = await provider.isAvailable();
                if (!available) continue;
                const result = await provider.embed(text);
                if (result) {
                    // Switch active provider
                    console.warn(`[EmbeddingManager] Switched from ${failed.name} to ${provider.name}`);
                    this.activeProvider = provider;
                    return result;
                }
            } catch { /* try next */ }
        }
        return null;
    }

    private async fallbackEmbedBatch(texts: string[], failed: EmbeddingProvider): Promise<(Float32Array | null)[]> {
        for (const provider of this.providers) {
            if (provider === failed) continue;
            try {
                const available = await provider.isAvailable();
                if (!available) continue;
                const results = await provider.embedBatch(texts);
                if (results.some(r => r !== null)) {
                    console.warn(`[EmbeddingManager] Switched from ${failed.name} to ${provider.name}`);
                    this.activeProvider = provider;
                    return results;
                }
            } catch { /* try next */ }
        }
        return texts.map(() => null);
    }
}

// Singleton
export const embeddingManager = new EmbeddingManager();
