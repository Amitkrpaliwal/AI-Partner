/**
 * SearchProvider — Abstract interface for web search backends.
 *
 * Implementations: DuckDuckGoProvider, SearXNGProvider, BraveProvider, SerpAPIProvider
 * Used by: SearchProviderManager (multi-provider fallback chain)
 */

export interface SearchResult {
    title: string;
    snippet: string;
    url: string;
}

export interface SearchResponse {
    success: boolean;
    query: string;
    resultCount: number;
    results: SearchResult[];
    provider: string;
    error?: string;
}

export interface SearchProviderConfig {
    enabled: boolean;
    priority: number;       // Lower = tried first
    apiKey?: string;
    endpoint?: string;
    timeout?: number;       // ms, default 10000
}

/**
 * All search providers must implement this interface.
 */
export interface SearchProvider {
    /** Unique provider name (e.g., 'searxng', 'duckduckgo', 'brave') */
    readonly name: string;

    /** Human-readable display name */
    readonly displayName: string;

    /** Whether this provider requires an API key */
    readonly requiresApiKey: boolean;

    /** Whether this provider requires a running service (e.g., Docker) */
    readonly requiresService: boolean;

    /**
     * Check if the provider is available and configured.
     * Returns true if ready to handle search requests.
     */
    isAvailable(): Promise<boolean>;

    /**
     * Perform a web search.
     * @param query - Search query string
     * @param limit - Max results to return
     * @returns SearchResponse with results or error
     */
    search(query: string, limit?: number): Promise<SearchResponse>;

    /**
     * Configure the provider at runtime.
     */
    configure(config: Partial<SearchProviderConfig>): void;
}
