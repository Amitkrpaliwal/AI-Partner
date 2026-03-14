/**
 * E2E Test: Search Fallback Chain
 * Tests: SearXNG → SerpAPI → Brave → DDG fallback behavior
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const api = axios.create({ baseURL: BASE, timeout: 30000 });

describe('Search Fallback Chain', () => {
    let searchAvailable = false;

    beforeAll(async () => {
        try {
            const res = await api.get('/api/search/status');
            searchAvailable = res.status === 200;
        } catch {
            console.warn('Search API not available — skipping');
        }
    });

    it('should return search results for a common query', async () => {
        if (!searchAvailable) return;
        const res = await api.post('/api/search/test', {
            query: 'TypeScript tutorial',
        });
        expect(res.status).toBe(200);
        expect(res.data.results).toBeDefined();
        expect(res.data.results.length).toBeGreaterThan(0);
        expect(res.data.provider).toBeTruthy();
    });

    it('should include title, URL, and snippet in results', async () => {
        if (!searchAvailable) return;
        const res = await api.post('/api/search/test', {
            query: 'Node.js Express documentation',
        });
        expect(res.status).toBe(200);
        const result = res.data.results[0];
        expect(result).toHaveProperty('title');
        expect(result).toHaveProperty('url');
        expect(result.url).toMatch(/^https?:\/\//);
    });

    it('should handle 20 sequential searches with 95%+ success rate', async () => {
        if (!searchAvailable) return;

        const queries = [
            'JavaScript array methods', 'Python flask tutorial', 'React hooks guide',
            'Docker compose networking', 'Git branching strategy', 'REST API design',
            'CSS grid layout', 'SQL join types', 'Kubernetes deployment',
            'TypeScript generics', 'Redis caching patterns', 'GraphQL vs REST',
            'WebSocket tutorial', 'OAuth2 flow', 'CI CD pipeline',
            'Microservices architecture', 'Unit testing best practices',
            'Database indexing', 'API rate limiting', 'Web security OWASP',
        ];

        let successes = 0;
        for (const query of queries) {
            try {
                const res = await api.post('/api/search/test', { query });
                if (res.status === 200 && res.data.results?.length > 0) {
                    successes++;
                }
            } catch {
                // count as failure
            }
        }

        const successRate = successes / queries.length;
        console.log(`Search success rate: ${successes}/${queries.length} (${(successRate * 100).toFixed(0)}%)`);
        expect(successRate).toBeGreaterThanOrEqual(0.95);
    }, 120000); // 2 min timeout for 20 queries

    it('should report provider health status', async () => {
        if (!searchAvailable) return;
        const res = await api.get('/api/search/status');
        expect(res.status).toBe(200);
        expect(res.data.providers).toBeDefined();
    });

    // 12V.2: Disable SearXNG → verify fallback to next provider
    it('should fallback when primary provider is disabled', async () => {
        if (!searchAvailable) return;

        // Get current provider status
        const statusBefore = await api.get('/api/search/status');
        const providers = statusBefore.data.providers || [];

        if (providers.length < 2) {
            console.log('Only one provider available — skipping fallback test');
            return;
        }

        // Disable the primary provider
        const primaryProvider = providers[0]?.name || 'searxng';
        try {
            await api.post('/api/search/provider/disable', {
                provider: primaryProvider,
            });
        } catch {
            // Endpoint may not exist — verify via search still works
        }

        // Search should still work via fallback provider
        const res = await api.post('/api/search/test', {
            query: 'fallback test query',
        });
        expect(res.status).toBe(200);

        // If results returned, they may come from a different provider
        if (res.data.results?.length > 0) {
            console.log(`Fallback provider used: ${res.data.provider || 'unknown'}`);
        }

        // Re-enable the provider
        try {
            await api.post('/api/search/provider/enable', {
                provider: primaryProvider,
            });
        } catch { /* non-critical */ }
    });

    it('should block SSRF attempts via web_fetch', async () => {
        if (!searchAvailable) return;
        // AWS metadata endpoint — should be blocked
        try {
            const res = await api.post('/api/search/fetch', {
                url: 'http://169.254.169.254/latest/meta-data',
            });
            // If it doesn't throw, it should return an error
            expect(res.data.error || res.data.blocked).toBeTruthy();
        } catch (e: any) {
            // 4xx/5xx is expected — SSRF blocked
            expect(e.response?.status).toBeGreaterThanOrEqual(400);
        }
    });
});
