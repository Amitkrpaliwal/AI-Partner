/**
 * DuckDuckGoProvider — Web search via duck-duck-scrape.
 *
 * Pros: Free, no API key, no service required.
 * Cons: Rate-limited, unreliable, scraping-based.
 * Priority: Lowest (fallback only).
 */

import { SearchProvider, SearchProviderConfig, SearchResponse } from './SearchProvider';

export class DuckDuckGoProvider implements SearchProvider {
    readonly name = 'duckduckgo';
    readonly displayName = 'DuckDuckGo';
    readonly requiresApiKey = false;
    readonly requiresService = false;

    private config: SearchProviderConfig = {
        enabled: true,
        priority: 100,  // Lowest priority — fallback
        timeout: 15000,
    };

    configure(config: Partial<SearchProviderConfig>): void {
        Object.assign(this.config, config);
    }

    async isAvailable(): Promise<boolean> {
        if (!this.config.enabled) return false;

        try {
            const dds = await import('duck-duck-scrape');
            return !!(dds.search || dds.default?.search);
        } catch {
            return false;
        }
    }

    async search(query: string, limit: number = 5): Promise<SearchResponse> {
        try {
            const dds = await import('duck-duck-scrape');
            const searchFn = dds.search || dds.default?.search;

            if (!searchFn) {
                return {
                    success: false,
                    query,
                    resultCount: 0,
                    results: [],
                    provider: this.name,
                    error: 'duck-duck-scrape search function not found'
                };
            }

            const results = await searchFn(query, {
                safeSearch: dds.SafeSearchType?.MODERATE ?? 0
            });

            const maxResults = Math.min(limit || 5, 20);
            const items = (results.results || []).slice(0, maxResults).map((r: any) => ({
                title: r.title || '',
                snippet: r.description || r.snippet || '',
                url: r.url || r.link || ''
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
