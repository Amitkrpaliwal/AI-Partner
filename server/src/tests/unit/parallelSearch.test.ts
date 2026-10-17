import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ParallelSearchProvider, PARALLEL_MCP_URL, PARALLEL_USER_AGENT } from '../../search/ParallelSearchProvider';
import { searchProviderManager } from '../../search';
import { WebSearchServer } from '../../mcp/servers/WebSearchServer';
import { searchRoutes } from '../../routes/searchRoutes';
import { ContextBuilder } from '../../agents/goal/ContextBuilder';

// Keep database, model and browser initialization out of this caller test.
// The provider manager, HTTP MCP client, tool dispatcher and consumer are real.
vi.mock('../../mcp/MCPManager', () => ({ mcpManager: {} }));
vi.mock('../../services/llm/modelManager', () => ({ modelManager: {} }));
vi.mock('../../services/llm/modelRouter', () => ({ modelRouter: {} }));
vi.mock('../../services/ConfigManager', () => {
    let config = { search: { preferred_provider: 'auto', brave_api_key: 'saved-key', searxng_endpoint: 'http://search:8888/search' } };
    return { configManager: {
        getConfig: () => config,
        updateConfig: async (next: any) => { config = { ...config, ...next }; },
    } };
});

const resultData = { results: [
    { title: 'Node documentation', url: 'https://nodejs.org/docs', excerpts: ['Current Node.js reference'] },
    { title: null, url: 'https://example.org/source', excerpts: ['Second source'] },
    { title: 'Unsafe', url: 'javascript:alert(1)', excerpts: ['Invalid URL'] },
] };
let calls: Array<{ url: string; headers: Headers; body: any }>;
let toolResult: any;
let sse = false;
let hangSearch = false;

function mockMCP() {
    return vi.fn(async (url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ url: String(url), headers: new Headers(init?.headers), body });
        if (!body?.id && body?.id !== 0) return new Response(null, { status: 202 });
        let result: any;
        switch (body.method) {
            case 'initialize': result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; break;
            case 'tools/list': result = { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] }; break;
            case 'tools/call':
                if (hangSearch) return new Promise<Response>((_resolve, reject) => {
                    const fail = () => reject(new DOMException('Aborted', 'AbortError'));
                    if (init.signal.aborted) fail();
                    else init.signal.addEventListener('abort', fail, { once: true });
                });
                result = toolResult; break;
            default: throw new Error(`Unexpected MCP method ${body.method}`);
        }
        const json = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
        return new Response(sse ? `event: message\ndata: ${json}\n\n` : json, {
            headers: { 'Content-Type': sse ? 'text/event-stream' : 'application/json' },
        });
    });
}

beforeEach(async () => {
    calls = []; sse = false; hangSearch = false;
    toolResult = { content: [{ type: 'text', text: JSON.stringify(resultData) }], structuredContent: resultData };
    vi.stubGlobal('fetch', mockMCP());
    // No environment credentials or local search service are consulted in tests.
    // initialize() also performs status checks, so stub these before initialization.
    vi.spyOn(searchProviderManager, 'getStatus').mockResolvedValue([]);
    await searchProviderManager.initialize();
    searchProviderManager.setParallelPreference('auto');
    for (const name of ['searxng', 'serpapi', 'brave', 'duckduckgo']) {
        vi.spyOn(searchProviderManager.getProvider(name)!, 'isAvailable').mockResolvedValue(false);
    }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function enabled() {
    const provider = new ParallelSearchProvider();
    provider.configure({ enabled: true });
    return provider;
}

it('keeps fresh installations and every incumbent selection off Parallel', async () => {
    const provider = new ParallelSearchProvider();
    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.search('node docs')).success).toBe(false);
    for (const preferred of ['auto', 'searxng', 'brave', 'serpapi', 'duckduckgo']) {
        searchProviderManager.setParallelPreference(preferred);
        await searchProviderManager.search('node docs');
        expect(await searchProviderManager.getProvider('parallel')!.isAvailable()).toBe(false);
    }
    expect(calls).toEqual([]);
});

it('retains the incumbent resolver and explicit disable without contacting Parallel', async () => {
    const incumbent = searchProviderManager.getProvider('searxng')!;
    vi.mocked(incumbent.isAvailable).mockResolvedValue(true);
    vi.spyOn(incumbent, 'search').mockResolvedValue({
        success: true, query: 'node docs', resultCount: 1,
        results: [{ title: 'Existing source', snippet: 'Existing result', url: 'https://example.org' }], provider: 'searxng',
    });
    searchProviderManager.setParallelPreference('auto');
    expect((await searchProviderManager.search('node docs')).provider).toBe('searxng');
    searchProviderManager.setParallelPreference('parallel');
    searchProviderManager.configureProvider('parallel', { enabled: false });
    expect((await searchProviderManager.search('node docs')).provider).toBe('searxng');
    expect(calls).toEqual([]);
});

it('dispatches an opted-in web_search and consumes sources in actual agent context', async () => {
    searchProviderManager.setParallelPreference('parallel'); // same restoration path as startup
    const result = await new WebSearchServer().callTool('web_search', { query: 'node reference documentation', limit: 1 });
    expect(result).toMatchObject({ success: true, provider: 'parallel', resultCount: 1 });
    expect(result.results[0]).toEqual({ title: 'Node documentation', snippet: 'Current Node.js reference', url: 'https://nodejs.org/docs' });
    const context = ContextBuilder.buildRecentActionsContext({ completed_actions: [
        { tool_used: 'web_search', args: { query: result.query }, success: true, result },
    ] } as any);
    expect(context).toContain('Current Node.js reference');
    expect(context).toContain('https://nodejs.org/docs');
    expect(calls.map(c => c.body?.method).filter(Boolean)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    for (const call of calls) {
        expect(call.url).toBe(PARALLEL_MCP_URL);
        expect(call.headers.get('user-agent')).toBe(PARALLEL_USER_AGENT);
        expect(call.headers.has('authorization')).toBe(false);
    }
    expect(calls.at(-1)!.body.params).toEqual({ name: 'web_search', arguments: {
        objective: 'node reference documentation', search_queries: ['node reference documentation'],
    } });
});

it('supports SSE text results, limits output and filters unsafe source URLs', async () => {
    sse = true;
    delete toolResult.structuredContent;
    const result = await enabled().search('node docs', 20);
    expect(result.resultCount).toBe(2);
    expect(result.results[1].title).toBe('https://example.org/source');
});

it('persists selection through the settings API and disables it when switched away', async () => {
    const app = express(); app.use(express.json()); app.use('/search', searchRoutes);
    const select = await request(app).post('/search/providers/config').send({ preferred_provider: 'parallel' });
    expect(select.status).toBe(200);
    expect(select.body.config).toMatchObject({ preferred_provider: 'parallel', brave_api_key: 'saved-key' });
    expect(await searchProviderManager.getProvider('parallel')!.isAvailable()).toBe(true);
    // Restore a saved choice using the exact startup method.
    searchProviderManager.setParallelPreference(select.body.config.preferred_provider);
    expect((await searchProviderManager.search('node docs')).provider).toBe('parallel');
    await request(app).post('/search/providers/config').send({ preferred_provider: 'auto' });
    expect(await searchProviderManager.getProvider('parallel')!.isAvailable()).toBe(false);
    expect((await request(app).post('/search/providers/config').send({ preferred_provider: 'unknown' })).status).toBe(400);
});

it.each([
    { isError: true, content: [{ type: 'text', text: 'Quota exhausted' }] },
    { content: [{ type: 'text', text: 'malformed JSON' }] },
    { content: [{ type: 'text', text: '{}' }] },
])('returns MCP or parsing errors without silent fallback', async response => {
    toolResult = response;
    searchProviderManager.setParallelPreference('parallel');
    const fallback = vi.spyOn(searchProviderManager.getProvider('duckduckgo')!, 'search');
    const result = await new WebSearchServer().callTool('web_search', { query: 'node docs' });
    expect(result.success).toBe(false);
    expect(result.provider).toBe('parallel');
    expect(result.error).toBeTruthy();
    expect(fallback).not.toHaveBeenCalled();
});

it('handles empty results and HTTP errors', async () => {
    toolResult = { content: [], structuredContent: { results: [] } };
    expect((await enabled().search('node docs')).resultCount).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Service unavailable', { status: 503 })));
    expect((await enabled().search('node docs')).success).toBe(false);
});

it('cancels before any request and during dispatcher execution', async () => {
    const controller = new AbortController(); controller.abort();
    expect((await enabled().search('node docs', 5, { signal: controller.signal })).error).toBe('Search cancelled');
    expect(calls).toEqual([]);
    hangSearch = true;
    searchProviderManager.setParallelPreference('parallel');
    const active = new AbortController();
    const pending = new WebSearchServer().callTool('web_search', { query: 'node docs' }, { signal: active.signal });
    await vi.waitFor(() => expect(calls.some(c => c.body?.method === 'tools/call')).toBe(true));
    active.abort();
    expect((await pending).error).toBe('Search cancelled');
});

it('enforces a deadline across the HTTP search', async () => {
    hangSearch = true;
    const provider = enabled(); provider.configure({ timeout: 30 });
    expect((await provider.search('node docs')).error).toContain('timed out');
});

it('uses only the existing web_search capability and preserves fetch URL protection', async () => {
    const server = new WebSearchServer();
    expect(server.getTools().map(tool => tool.name)).toEqual(['web_search', 'web_fetch', 'web_search_status']);
    const result = await server.callTool('web_fetch', { url: 'http://169.254.169.254/latest/meta-data' });
    expect(result.success).toBe(false);
    expect(calls).toEqual([]);
});

// Run explicitly with PARALLEL_SEARCH_LIVE=1 to exercise the anonymous endpoint.
// Ordinary unit runs never send network requests.
it.skipIf(process.env.PARALLEL_SEARCH_LIVE !== '1')('performs a live anonymous search through the built-in dispatcher', async () => {
    vi.unstubAllGlobals();
    const nativeFetch = globalThis.fetch;
    const observed: Array<{ url: string; userAgent: string | null; authorization: boolean }> = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
        const headers = new Headers(init?.headers);
        observed.push({ url: String(url), userAgent: headers.get('user-agent'), authorization: headers.has('authorization') });
        return nativeFetch(url, init);
    });
    searchProviderManager.setParallelPreference('parallel');
    const result = await new WebSearchServer().callTool('web_search', { query: 'Node.js official documentation', limit: 2 });
    console.log('LIVE_PARALLEL_RESULT', JSON.stringify({ result, observed }));
    expect(result.success).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    const context = ContextBuilder.buildRecentActionsContext({ completed_actions: [
        { tool_used: 'web_search', args: { query: result.query }, success: true, result },
    ] } as any);
    expect(context).toContain(result.results[0].url);
    expect(observed.length).toBeGreaterThanOrEqual(4);
    for (const call of observed) {
        expect(call.url).toBe(PARALLEL_MCP_URL);
        expect(call.userAgent).toBe(PARALLEL_USER_AGENT);
        expect(call.authorization).toBe(false);
    }
});
