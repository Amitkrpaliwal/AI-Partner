/**
 * SerpAPIProvider — Web search via SerpAPI (Google Search API).
 *
 * Pros: Reliable Google results, structured data, rich snippets.
 * Cons: Requires API key (free tier: 100 searches/month).
 * Priority: Medium-high (between SearXNG and Brave).
 *
 * Get API key: https://serpapi.com/
 */

import axios from 'axios';
import { SearchProvider, SearchProviderConfig, SearchResponse } from './SearchProvider';

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

export class SerpAPIProvider implements SearchProvider {
    readonly name = 'serpapi';
    readonly displayName = 'SerpAPI (Google)';
    readonly requiresApiKey = true;
    readonly requiresService = false;

    private config: SearchProviderConfig = {
        enabled: false,  // Disabled by default — needs API key
        priority: 5,     // Between SearXNG (1) and Brave (10)
        timeout: 15000,
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
                error: 'SerpAPI key not configured'
            };
        }

        try {
            const response = await axios.get(SERPAPI_ENDPOINT, {
                params: {
                    q: query,
                    api_key: this.config.apiKey,
                    engine: 'google',
                    num: Math.min(limit || 5, 20),
                    hl: 'en',
                    gl: 'us',
                },
                timeout: this.config.timeout || 15000,
            });

            const organicResults = response.data?.organic_results || [];
            const items = organicResults.slice(0, limit).map((r: any) => ({
                title: r.title || '',
                snippet: r.snippet || '',
                url: r.link || ''
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
                error: error.response?.data?.error || error.message
            };
        }
    }
}
