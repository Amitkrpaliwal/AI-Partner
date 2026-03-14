/**
 * BraveSearchProvider — Web search via Brave Search API.
 *
 * Pros: Reliable, fast, independent index.
 * Cons: Requires API key (free tier: 2000 queries/month).
 * Priority: Medium.
 *
 * Get API key: https://brave.com/search/api/
 */

import axios from 'axios';
import { SearchProvider, SearchProviderConfig, SearchResponse } from './SearchProvider';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export class BraveSearchProvider implements SearchProvider {
    readonly name = 'brave';
    readonly displayName = 'Brave Search';
    readonly requiresApiKey = true;
    readonly requiresService = false;

    private config: SearchProviderConfig = {
        enabled: false,  // Disabled by default — needs API key
        priority: 10,
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
                error: 'Brave Search API key not configured'
            };
        }

        try {
            const response = await axios.get(BRAVE_ENDPOINT, {
                params: {
                    q: query,
                    count: Math.min(limit || 5, 20),
                },
                headers: {
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip',
                    'X-Subscription-Token': this.config.apiKey,
                },
                timeout: this.config.timeout || 10000,
            });

            const webResults = response.data?.web?.results || [];
            const items = webResults.map((r: any) => ({
                title: r.title || '',
                snippet: r.description || '',
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
