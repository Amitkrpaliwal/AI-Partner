import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SearchProvider, SearchProviderConfig, SearchResponse, SearchOptions } from './SearchProvider';

export const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp';
export const PARALLEL_USER_AGENT = 'AI-Partner/1.0.0 (+https://github.com/Amitkrpaliwal/AI-Partner)';

/** Anonymous Search MCP, enabled only by an explicit provider selection. */
export class ParallelSearchProvider implements SearchProvider {
    readonly name = 'parallel';
    readonly displayName = 'Parallel (free, no API key)';
    readonly requiresApiKey = false;
    readonly requiresService = false;

    private config: SearchProviderConfig = { enabled: false, priority: 1, timeout: 15000 };

    configure(config: Partial<SearchProviderConfig>): void {
        Object.assign(this.config, config);
    }

    async isAvailable(): Promise<boolean> {
        // Status checks must not connect or consume the anonymous search quota.
        return this.config.enabled;
    }

    async search(query: string, limit = 5, options: SearchOptions = {}): Promise<SearchResponse> {
        const failure = (error: string): SearchResponse => ({
            success: false, query, resultCount: 0, results: [], provider: this.name, error,
        });
        if (!this.config.enabled) return failure('Parallel search is disabled');
        if (!query?.trim()) return failure('Search query is required');
        if (options.signal?.aborted) return failure('Search cancelled');

        const controller = new AbortController();
        const cancel = () => controller.abort();
        options.signal?.addEventListener('abort', cancel, { once: true });
        const timeout = this.config.timeout || 15000;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
        const client = new Client({ name: 'AI-Partner', version: '1.0.0' }, { capabilities: {} });
        // Bind our signal and identity to every HTTP request, including discovery.
        const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_MCP_URL), {
            requestInit: { headers: { 'User-Agent': PARALLEL_USER_AGENT } },
            fetch: (url, init) => fetch(url, {
                ...init,
                signal: init?.signal
                    ? AbortSignal.any([init.signal, controller.signal])
                    : controller.signal,
            }),
        });
        try {
            await client.connect(transport);
            const tools = await client.listTools({}, { signal: controller.signal, timeout });
            if (!tools.tools.some(tool => tool.name === 'web_search')) {
                throw new Error('Parallel MCP does not advertise web_search');
            }
            const result = await client.callTool({
                name: 'web_search',
                arguments: { objective: query, search_queries: [query] },
            }, undefined, { signal: controller.signal, timeout });
            if (result.isError) {
                const message = Array.isArray(result.content)
                    ? result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
                    : 'Parallel MCP search failed';
                throw new Error(message);
            }
            const text = Array.isArray(result.content)
                ? result.content.find(block => block.type === 'text')?.text
                : undefined;
            const data = result.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : null);
            if (!data || !Array.isArray(data.results)) throw new Error('Invalid Parallel search response');
            const maxResults = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 20)) : 5;
            const results = data.results.filter((item: any) => {
                if (typeof item?.url !== 'string' || !Array.isArray(item.excerpts)) return false;
                try { return ['http:', 'https:'].includes(new URL(item.url).protocol); } catch { return false; }
            }).slice(0, maxResults).map((item: any) => ({
                title: typeof item.title === 'string' ? item.title : item.url,
                snippet: item.excerpts.filter((excerpt: unknown) => typeof excerpt === 'string').join('\n').slice(0, 400),
                url: item.url,
            }));
            return { success: true, query, resultCount: results.length, results, provider: this.name };
        } catch (error: any) {
            return failure(timedOut ? 'Parallel search timed out' : options.signal?.aborted
                ? 'Search cancelled' : error.message || 'Parallel search failed');
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', cancel);
            await client.close().catch(() => { });
        }
    }
}
