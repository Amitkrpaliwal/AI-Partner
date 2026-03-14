import { EventEmitter } from 'events';
import axios from 'axios';
import { isUrlSafe, logSecurityEvent } from '../../utils/security';
import { searchProviderManager } from '../../search';

/**
 * Web Search MCP Tool Server
 *
 * Provides web search and URL fetching capabilities.
 * Search uses multi-provider fallback chain (SearXNG → Brave → DuckDuckGo).
 * Registered as a built-in tool server alongside ShellServer and BrowserServer.
 *
 * Fix 1: Smart HTML extraction — strips nav/footer/aside/header, prefers article/main.
 * Fix 2: web_fetch supports `offset` for chunked pagination; default maxLength 15000.
 * Fix 3: web_search default limit raised from 5 → 10.
 * Fix 6: 5-minute URL-level fetch cache to avoid re-fetching same page within a goal.
 */
export class WebSearchServer extends EventEmitter {

    // Fix 6: simple TTL cache to deduplicate fetch calls within a goal execution
    private fetchCache = new Map<string, { content: string; totalLength: number; timestamp: number }>();
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    getTools() {
        return [
            {
                name: 'web_search',
                description: 'Search the web. Uses best available search engine with automatic fallback. Returns titles, snippets, and URLs.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query'
                        },
                        limit: {
                            type: 'number',
                            // Fix 3: raised default from 5 → 10
                            description: 'Maximum results to return (default: 10, max: 20)'
                        }
                    },
                    required: ['query']
                }
            },
            {
                name: 'web_fetch',
                description: 'Fetch the text content of a URL. Returns extracted text (no HTML tags). Use offset for pagination on long pages.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'URL to fetch content from'
                        },
                        maxLength: {
                            type: 'number',
                            description: 'Maximum text length to return (default: 15000). Raise for long articles.'
                        },
                        // Fix 2: pagination support
                        offset: {
                            type: 'number',
                            description: 'Character offset to start from (default: 0). Use with maxLength to read page 2, 3, etc. of a long article.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'web_search_status',
                description: 'Check status of available search providers',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ];
    }

    async callTool(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'web_search':
                return this.webSearch(args.query, args.limit);
            case 'web_fetch':
                return this.webFetch(args.url, args.maxLength, args.offset);
            case 'web_search_status':
                return this.getSearchStatus();
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    /**
     * Search using multi-provider fallback chain.
     * Fix 3: default limit raised from 5 → 10.
     */
    private async webSearch(query: string, limit: number = 10): Promise<any> {
        try {
            const result = await searchProviderManager.search(query, Math.min(limit, 20));
            return result;
        } catch (error: any) {
            console.error('[WebSearch] Search failed:', error.message);
            return {
                success: false,
                error: error.message,
                query,
                resultCount: 0,
                results: [],
                provider: 'none'
            };
        }
    }

    /**
     * Detects bot-block signals in an HTTP response.
     */
    private detectBlockSignal(status: number, html: string): string | null {
        if (status === 403) return 'http_403';
        if (status === 429) return 'rate_limit';
        if (status === 503) return 'service_unavailable';
        const lower = html.substring(0, 4000).toLowerCase();
        if (lower.includes('cf-browser-verification') || lower.includes('cloudflare') && lower.includes('checking your browser')) return 'cloudflare';
        if (lower.includes('captcha') || lower.includes('recaptcha') || lower.includes('hcaptcha')) return 'captcha';
        if (lower.includes('access denied') && lower.includes('bot')) return 'bot_block';
        if (lower.includes('datadome') || lower.includes('distil_r_captcha')) return 'datadome';
        return null;
    }

    /**
     * Fetch URL content with SSRF protection and block-detection fallback.
     * Fix 2: `offset` parameter for pagination; default maxLength raised to 15000.
     * Fix 6: URL-level cache (5-minute TTL) to avoid redundant fetches.
     */
    private async webFetch(url: string, maxLength: number = 15000, offset: number = 0): Promise<any> {
        // SSRF protection: validate URL before fetching
        const urlCheck = isUrlSafe(url);
        if (!urlCheck.safe) {
            logSecurityEvent('block', 'WebSearchServer', `web_fetch blocked: ${urlCheck.reason}`, { url });
            return { success: false, error: `URL blocked: ${urlCheck.reason}`, url, content: '' };
        }

        const effectiveMax = Math.min(maxLength || 15000, 50000);

        // Fix 6: check cache before fetching (only for offset=0 lookups; paginated reads use cached full text)
        const cacheKey = url;
        const cached = this.fetchCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            const slice = cached.content.substring(offset, offset + effectiveMax);
            return {
                success: true,
                url,
                content: slice,
                contentLength: cached.totalLength,
                offset,
                hasMore: offset + effectiveMax < cached.totalLength,
                truncated: slice.length < cached.totalLength,
                cached: true,
            };
        }

        // --- Layer 1: Direct HTTP fetch ---
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"'
                },
                responseType: 'text',
                validateStatus: () => true  // Don't throw on 4xx/5xx — we inspect and fallback
            });

            const blockType = this.detectBlockSignal(response.status, response.data as string);
            if (!blockType && response.status < 400) {
                const html = response.data as string;
                // Fix 1: semantic extraction
                const fullText = this.extractText(html);

                // Fix 6: store full text in cache
                this.fetchCache.set(cacheKey, { content: fullText, totalLength: fullText.length, timestamp: Date.now() });

                // Fix 2: apply offset + maxLength slice
                const slice = fullText.substring(offset, offset + effectiveMax);
                return {
                    success: true,
                    url,
                    content: slice,
                    contentLength: fullText.length,
                    offset,
                    hasMore: offset + effectiveMax < fullText.length,
                    truncated: fullText.length > effectiveMax + offset,
                };
            }

            // Blocked — fall through to Layer 2
            console.warn(`[WebSearch] web_fetch blocked (${blockType ?? `HTTP ${response.status}`}) for ${url} — trying search fallback`);

            // --- Layer 2: Search-based fallback (find indexed/cached content) ---
            try {
                const domain = new URL(url).hostname;
                const searchQuery = `site:${domain} ${new URL(url).pathname.replace(/\//g, ' ').trim()}`.trim();
                const searchResult = await searchProviderManager.search(searchQuery, 5);
                if (searchResult.success && searchResult.results.length > 0) {
                    const snippets = searchResult.results
                        .map((r: any) => `${r.title}\n${r.snippet || ''}`.trim())
                        .join('\n\n');
                    return {
                        success: true,
                        url,
                        content: snippets.substring(offset, offset + effectiveMax),
                        contentLength: snippets.length,
                        offset,
                        hasMore: offset + effectiveMax < snippets.length,
                        truncated: snippets.length > effectiveMax,
                        fetchMethod: 'search_fallback',
                        blockType
                    };
                }
            } catch {
                // search fallback failed silently
            }

            return {
                success: false,
                error: `Page blocked (${blockType ?? `HTTP ${response.status}`}) and search fallback found no results`,
                blockType,
                url,
                content: ''
            };
        } catch (error: any) {
            console.error('[WebSearch] Fetch failed:', error.message);
            return { success: false, error: error.message, url, content: '' };
        }
    }

    /**
     * Get search provider status.
     */
    private async getSearchStatus(): Promise<any> {
        const status = await searchProviderManager.getStatus();
        return {
            success: true,
            providers: status,
            availableCount: status.filter(s => s.available).length,
            totalCount: status.length,
        };
    }

    /**
     * Fix 1: Semantic HTML → text extraction.
     * Strips non-content structural elements (nav, footer, aside, header),
     * then prefers <article> / <main> body text when present.
     * Falls back to full body stripping if no semantic wrapper found.
     */
    private extractText(html: string): string {
        let text = html;

        // Remove script, style, noscript blocks entirely
        text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
        text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

        // Remove non-content structural blocks
        text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
        text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
        text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
        text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

        // Prefer <article> or <main> content if present (richer semantic signal)
        const articleMatch = text.match(/<(?:article|main)[\s\S]*?>([\s\S]*?)<\/(?:article|main)>/i);
        if (articleMatch) {
            text = articleMatch[1];
        }

        // Convert common block elements to newlines for readability
        text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi, '\n');

        // Strip remaining HTML tags
        text = text.replace(/<[^>]+>/g, '');

        // Decode common HTML entities
        text = text.replace(/&amp;/g, '&');
        text = text.replace(/&lt;/g, '<');
        text = text.replace(/&gt;/g, '>');
        text = text.replace(/&quot;/g, '"');
        text = text.replace(/&#39;/g, "'");
        text = text.replace(/&nbsp;/g, ' ');

        // Normalize whitespace
        text = text.replace(/[ \t]+/g, ' ');
        text = text.replace(/\n\s*\n/g, '\n\n');
        text = text.trim();

        return text;
    }
}

export const webSearchServer = new WebSearchServer();
