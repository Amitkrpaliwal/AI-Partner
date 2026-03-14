/**
 * Search Configuration API Routes
 *
 * GET  /api/search/providers        - List search providers and their status
 * POST /api/search/providers/config  - Configure a search provider
 * POST /api/search/test              - Test search with a query
 */

import { Router, Request, Response } from 'express';
import { searchProviderManager } from '../search';
import { configManager } from '../services/ConfigManager';

export const searchRoutes = Router();

/**
 * GET /api/search/providers
 * Returns status of all search providers.
 */
searchRoutes.get('/providers', async (_req: Request, res: Response) => {
    try {
        const status = await searchProviderManager.getStatus();
        const config = configManager.getConfig();

        res.json({
            success: true,
            preferred: config.search?.preferred_provider || 'auto',
            providers: status,
            availableCount: status.filter(s => s.available).length,
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/search/providers/config
 * Configure search providers.
 *
 * Body: {
 *   preferred_provider?: 'searxng' | 'brave' | 'duckduckgo' | 'auto',
 *   searxng_endpoint?: string,
 *   brave_api_key?: string
 * }
 */
searchRoutes.post('/providers/config', async (req: Request, res: Response) => {
    try {
        const { preferred_provider, searxng_endpoint, brave_api_key } = req.body;

        const currentConfig = configManager.getConfig();
        const searchConfig = {
            ...currentConfig.search,
            ...(preferred_provider !== undefined && { preferred_provider }),
            ...(searxng_endpoint !== undefined && { searxng_endpoint }),
            ...(brave_api_key !== undefined && { brave_api_key }),
        };

        await configManager.updateConfig({ search: searchConfig } as any);

        // Apply config to providers
        if (searxng_endpoint) {
            searchProviderManager.configureProvider('searxng', { endpoint: searxng_endpoint });
        }

        if (brave_api_key) {
            searchProviderManager.configureProvider('brave', { apiKey: brave_api_key, enabled: true });
        }

        // Apply preferred_provider by setting its priority to 1 and bumping others
        if (preferred_provider && preferred_provider !== 'auto') {
            const priorityMap: Record<string, number> = { searxng: 10, serpapi: 10, brave: 10, duckduckgo: 10 };
            priorityMap[preferred_provider] = 1; // Promote chosen provider to top
            for (const [name, priority] of Object.entries(priorityMap)) {
                searchProviderManager.configureProvider(name, { priority });
            }
        } else if (preferred_provider === 'auto') {
            // Restore default priorities
            searchProviderManager.configureProvider('searxng',   { priority: 1 });
            searchProviderManager.configureProvider('serpapi',   { priority: 5 });
            searchProviderManager.configureProvider('brave',     { priority: 10 });
            searchProviderManager.configureProvider('duckduckgo', { priority: 100 });
        }

        // Get updated status
        const status = await searchProviderManager.getStatus();

        res.json({
            success: true,
            message: 'Search configuration updated',
            config: searchConfig,
            providers: status,
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/search/test
 * Test search with a query.
 *
 * Body: { query: string, limit?: number }
 */
searchRoutes.post('/test', async (req: Request, res: Response) => {
    try {
        const { query, limit } = req.body;

        if (!query) {
            return res.status(400).json({ success: false, error: 'Query is required' });
        }

        const result = await searchProviderManager.search(query, limit || 3);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default searchRoutes;
