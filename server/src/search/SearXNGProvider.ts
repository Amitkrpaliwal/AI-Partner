/**
 * SearXNGProvider — Web search via self-hosted SearXNG instance.
 *
 * Pros: Private, no rate limits, aggregates multiple engines.
 * Cons: Requires Docker service running.
 * Priority: Highest (preferred provider).
 *
 * Start SearXNG:
 *   docker-compose -f docker-compose.searxng.yml up -d
 *
 * Default endpoint: http://localhost:8888/search
 */

import axios from 'axios';
import { SearchProvider, SearchProviderConfig, SearchResponse } from './SearchProvider';

const DEFAULT_BASE = process.env.SEARXNG_ENDPOINT || 'http://localhost:8888';
const DEFAULT_ENDPOINT = `${DEFAULT_BASE}/search`;

export class SearXNGProvider implements SearchProvider {
    readonly name = 'searxng';
    readonly displayName = 'SearXNG (Self-Hosted)';
    readonly requiresApiKey = false;
    readonly requiresService = true;

    private config: SearchProviderConfig = {
        enabled: true,
        priority: 1,  // Highest priority — preferred
        endpoint: DEFAULT_ENDPOINT,
        timeout: 10000,
    };

    private available: boolean | null = null; // Cache availability check

    configure(config: Partial<SearchProviderConfig>): void {
        Object.assign(this.config, config);
        this.available = null; // Reset cache on config change
    }

    async isAvailable(): Promise<boolean> {
        if (!this.config.enabled) return false;

        // Use cached result
        if (this.available !== null) return this.available;

        try {
            // Lightweight ping: GET the SearXNG home page — responds in <1s, no search needed
            const endpoint = this.config.endpoint || DEFAULT_ENDPOINT;
            const base = endpoint.replace(/\/search$/, '');
            await axios.get(base, { timeout: 5000 });

            this.available = true;
            setTimeout(() => { this.available = null; }, 60000);
            return true;
        } catch {
            this.available = false;
            setTimeout(() => { this.available = null; }, 30000);
            return false;
        }
    }

    async search(query: string, limit: number = 5): Promise<SearchResponse> {
        const endpoint = this.config.endpoint || DEFAULT_ENDPOINT;
        const timeout = this.config.timeout || 10000;

        try {
            const response = await axios.get(endpoint, {
                params: {
                    q: query,
                    format: 'json',
                    categories: 'general',
                    language: 'en',
                    pageno: 1,
                },
                timeout,
            });

            if (response.status !== 200 || !response.data?.results) {
                return {
                    success: false,
                    query,
                    resultCount: 0,
                    results: [],
                    provider: this.name,
                    error: `SearXNG returned status ${response.status}`
                };
            }

            const maxResults = Math.min(limit || 5, 20);
            const items = response.data.results.slice(0, maxResults).map((r: any) => ({
                title: r.title || '',
                snippet: r.content || '',
                url: r.url || ''
            }));

            return {
                success: true,
                query,
                resultCount: items.length,
                results: items,
                provider: this.name
            };
        } catch (error: any) {
            // Mark as unavailable on connection errors
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                this.available = false;
            }

            return {
                success: false,
                query,
                resultCount: 0,
                results: [],
                provider: this.name,
                error: error.message
            };
        }
    }
}
