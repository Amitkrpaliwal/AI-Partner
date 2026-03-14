/**
 * SearchProviderManager — Multi-provider search with automatic fallback.
 *
 * Fallback chain (by priority):
 *   1. SearXNG (self-hosted, private, no rate limits)
 *   2. SerpAPI (Google results via API key)
 *   3. Brave Search (API key, reliable)
 *   4. DuckDuckGo (free, no key, but unreliable)
 *
 * If the primary provider fails, it automatically falls through to the next.
 *
 * Health tracking (Phase 12B.3):
 *   After 3 consecutive failures, a provider is marked unhealthy and skipped
 *   for a cooldown period (60s). It's automatically retried after cooldown.
 */

import { EventEmitter } from 'events';
import { SearchProvider, SearchProviderConfig, SearchResponse } from './SearchProvider';
import { SearXNGProvider } from './SearXNGProvider';
import { BraveSearchProvider } from './BraveSearchProvider';
import { DuckDuckGoProvider } from './DuckDuckGoProvider';
import { SerpAPIProvider } from './SerpAPIProvider';

interface ProviderHealth {
    consecutiveFailures: number;
    lastFailure: number;    // timestamp
    unhealthySince: number; // timestamp, 0 = healthy
    totalSearches: number;
    totalFailures: number;
}

const MAX_CONSECUTIVE_FAILURES = 3;
const UNHEALTHY_COOLDOWN_MS = 60_000; // 60 seconds

export class SearchProviderManager extends EventEmitter {
    private providers: SearchProvider[] = [];
    private health: Map<string, ProviderHealth> = new Map();
    private initialized = false;

    constructor() {
        super();
    }

    /**
     * Initialize with default providers (can be overridden by config).
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        // Register default providers in priority order
        this.providers = [
            new SearXNGProvider(),
            new SerpAPIProvider(),
            new BraveSearchProvider(),
            new DuckDuckGoProvider(),
        ];

        // Initialize health tracking for each provider
        for (const p of this.providers) {
            this.health.set(p.name, {
                consecutiveFailures: 0,
                lastFailure: 0,
                unhealthySince: 0,
                totalSearches: 0,
                totalFailures: 0,
            });
        }

        this.initialized = true;

        // Check availability of each provider
        const status = await this.getStatus();
        console.log('[SearchProviderManager] Initialized. Available providers:',
            status.filter(s => s.available).map(s => s.name).join(', ') || 'none'
        );
    }

    /**
     * Configure a specific provider by name.
     */
    configureProvider(name: string, config: Partial<SearchProviderConfig>): void {
        const provider = this.providers.find(p => p.name === name);
        if (provider) {
            provider.configure(config);
            // Reset health when reconfigured
            this.health.set(name, {
                consecutiveFailures: 0,
                lastFailure: 0,
                unhealthySince: 0,
                totalSearches: 0,
                totalFailures: 0,
            });
            console.log(`[SearchProviderManager] Configured ${name}:`, { enabled: config.enabled, hasKey: !!config.apiKey });
        }
    }

    /**
     * Check if a provider is currently healthy (not in cooldown).
     */
    private isHealthy(name: string): boolean {
        const h = this.health.get(name);
        if (!h) return true;

        if (h.unhealthySince === 0) return true;

        // Check if cooldown has elapsed
        const now = Date.now();
        if (now - h.unhealthySince >= UNHEALTHY_COOLDOWN_MS) {
            // Cooldown elapsed — give it another chance
            h.unhealthySince = 0;
            h.consecutiveFailures = 0;
            console.log(`[SearchProviderManager] ${name} cooldown elapsed, marking healthy for retry`);
            return true;
        }

        return false;
    }

    /**
     * Record a search success for a provider.
     */
    private recordSuccess(name: string): void {
        const h = this.health.get(name);
        if (!h) return;
        h.consecutiveFailures = 0;
        h.unhealthySince = 0;
        h.totalSearches++;
    }

    /**
     * Record a search failure for a provider.
     */
    private recordFailure(name: string): void {
        const h = this.health.get(name);
        if (!h) return;
        h.consecutiveFailures++;
        h.lastFailure = Date.now();
        h.totalSearches++;
        h.totalFailures++;

        if (h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && h.unhealthySince === 0) {
            h.unhealthySince = Date.now();
            console.warn(`[SearchProviderManager] ${name} marked UNHEALTHY after ${MAX_CONSECUTIVE_FAILURES} consecutive failures (cooldown: ${UNHEALTHY_COOLDOWN_MS / 1000}s)`);
            this.emit('provider:unhealthy', { provider: name, failures: h.consecutiveFailures });
        }
    }

    /**
     * Search using the fallback chain.
     * Tries each enabled provider in priority order until one succeeds.
     * Skips unhealthy providers (unless cooldown elapsed).
     */
    async search(query: string, limit: number = 5): Promise<SearchResponse> {
        await this.initialize();

        const errors: string[] = [];

        // Sort providers by priority (lower = first)
        const sorted = [...this.providers].sort((a, b) => {
            const aPriority = (a as any).config?.priority ?? 50;
            const bPriority = (b as any).config?.priority ?? 50;
            return aPriority - bPriority;
        });

        for (const provider of sorted) {
            // Skip unhealthy providers
            if (!this.isHealthy(provider.name)) {
                errors.push(`${provider.name}: unhealthy (cooldown)`);
                continue;
            }

            const available = await provider.isAvailable();
            if (!available) continue;

            console.log(`[SearchProviderManager] Trying ${provider.name} for: "${query}"`);
            const result = await provider.search(query, limit);

            if (result.success && result.resultCount > 0) {
                this.recordSuccess(provider.name);
                this.emit('search:success', { provider: provider.name, query, resultCount: result.resultCount });
                return result;
            }

            // Provider returned but no results or error — try next
            this.recordFailure(provider.name);
            if (result.error) {
                errors.push(`${provider.name}: ${result.error}`);
                console.warn(`[SearchProviderManager] ${provider.name} failed: ${result.error}`);
            }
        }

        // All providers failed
        this.emit('search:allFailed', { query, errors });
        return {
            success: false,
            query,
            resultCount: 0,
            results: [],
            provider: 'none',
            error: `All search providers failed: ${errors.join('; ')}`
        };
    }

    /**
     * Get status of all providers (including health info).
     */
    async getStatus(): Promise<Array<{
        name: string;
        displayName: string;
        available: boolean;
        requiresApiKey: boolean;
        requiresService: boolean;
        healthy: boolean;
        consecutiveFailures: number;
        totalSearches: number;
        totalFailures: number;
    }>> {
        await this.initialize();

        const statuses = await Promise.all(
            this.providers.map(async (p) => {
                const h = this.health.get(p.name);
                return {
                    name: p.name,
                    displayName: p.displayName,
                    available: await p.isAvailable(),
                    requiresApiKey: p.requiresApiKey,
                    requiresService: p.requiresService,
                    healthy: this.isHealthy(p.name),
                    consecutiveFailures: h?.consecutiveFailures || 0,
                    totalSearches: h?.totalSearches || 0,
                    totalFailures: h?.totalFailures || 0,
                };
            })
        );

        return statuses;
    }

    /**
     * Get provider by name.
     */
    getProvider(name: string): SearchProvider | undefined {
        return this.providers.find(p => p.name === name);
    }

    /**
     * List all registered provider names.
     */
    listProviders(): string[] {
        return this.providers.map(p => p.name);
    }

    /**
     * Manually reset health status for a provider.
     */
    resetHealth(name: string): void {
        const h = this.health.get(name);
        if (h) {
            h.consecutiveFailures = 0;
            h.unhealthySince = 0;
            console.log(`[SearchProviderManager] Health reset for ${name}`);
        }
    }
}

/** Singleton instance */
export const searchProviderManager = new SearchProviderManager();
