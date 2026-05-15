/**
 * TavilyProvider — Web search via Tavily Search API.
 *
 * Pros: Designed for LLMs, high-quality results, includes relevance scores.
 * Cons: Requires API key (free tier: 1000 credits/month).
 * Priority: Between SearXNG (1) and SerpAPI (5).
 *
 * Get API key: https://app.tavily.com/
 */

import { tavily } from '@tavily/core';
import { SearchProvider, SearchProviderConfig, SearchResponse } from './SearchProvider';

export class TavilyProvider implements SearchProvider {
    readonly name = 'tavily';
    readonly displayName = 'Tavily';
    readonly requiresApiKey = true;
    readonly requiresService = false;

    private config: SearchProviderConfig = {
        enabled: false,  // Disabled by default — needs API key
        priority: 3,     // Between SearXNG (1) and SerpAPI (5)
        timeout: 10000,
    };

    configure(config: Partial<SearchProviderConfig>): void {
        Object.assign(this.config, config);
    }

    async isAvailable(): Promise<boolean> {
        return this.config.enabled && !!this.config.apiKey;
    }

    async search(query: string, limit: number = 5): Promise<SearchResponse> {
        if (!this.config.apiKey) {
            return {
                success: false,
                query,
                resultCount: 0,
                results: [],
                provider: this.name,
                error: 'Tavily API key not configured'
            };
        }

        try {
            const client = tavily({ apiKey: this.config.apiKey });
            const response = await client.search(query, {
                maxResults: Math.min(limit || 5, 20),
                searchDepth: 'basic',
                includeAnswer: false,
            });

            const items = (response.results || []).map((r: any) => ({
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
