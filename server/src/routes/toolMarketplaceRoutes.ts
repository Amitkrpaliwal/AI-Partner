/**
 * Tool Marketplace Routes — REST API for managing dynamic tools.
 * 
 * GET  /api/tools/marketplace       — List all dynamic tools
 * GET  /api/tools/marketplace/:name — Get tool details
 * POST /api/tools/marketplace       — Create/update a tool
 * DELETE /api/tools/marketplace/:name — Delete a tool
 * POST /api/tools/marketplace/:name/test — Test-execute a tool
 * POST /api/tools/share             — Export tool as JSON
 * POST /api/tools/import            — Import tool from JSON
 */

import { Router, Request, Response } from 'express';
import { dynamicToolRegistry, CreateToolSchema } from '../mcp/DynamicToolRegistry';

const router = Router();

// ============================================================================
// GET /api/tools/marketplace — List all dynamic tools
// ============================================================================
router.get('/', async (_req: Request, res: Response) => {
    try {
        await dynamicToolRegistry.initialize();
        const tools = dynamicToolRegistry.listTools().map(t => ({
            id: t.id,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            version: t.version,
            usageCount: t.usageCount,
            successCount: t.successCount,
            successRate: t.usageCount > 0 ? Math.round((t.successCount / t.usageCount) * 100) : 0,
            tags: t.tags,
            createdBy: t.createdBy,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
        }));
        res.json({ tools, count: tools.length });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// GET /api/tools/marketplace/search?q=query — Search tools
// ============================================================================
router.get('/search', async (req: Request, res: Response) => {
    try {
        await dynamicToolRegistry.initialize();
        const query = (req.query.q as string) || '';
        const tools = dynamicToolRegistry.searchTools(query).map(t => ({
            name: t.name,
            description: t.description,
            tags: t.tags,
            version: t.version,
            usageCount: t.usageCount,
        }));
        res.json({ tools, query });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// GET /api/tools/marketplace/export — Export all tools as JSON
// NOTE: Must be before /:name route
// ============================================================================
router.get('/export', async (_req: Request, res: Response) => {
    try {
        await dynamicToolRegistry.initialize();
        const tools = dynamicToolRegistry.listTools().map(t => dynamicToolRegistry.exportTool(t.name)).filter(Boolean);
        res.json({ tools, count: tools.length });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// GET /api/tools/marketplace/:name — Get tool details
// ============================================================================
router.get('/:name', async (req: Request, res: Response) => {
    try {
        await dynamicToolRegistry.initialize();
        const tool = dynamicToolRegistry.getTool(req.params.name);
        if (!tool) {
            return res.status(404).json({ error: `Tool "${req.params.name}" not found` });
        }
        res.json({ tool });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/tools/marketplace — Create/update a tool
// ============================================================================
router.post('/', async (req: Request, res: Response) => {
    try {
        // Validate input
        const parsed = CreateToolSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'Invalid tool definition',
                details: parsed.error.issues
            });
        }

        const { name, description, code, inputSchema, tags, persistAcrossSessions } = parsed.data;

        const tool = await dynamicToolRegistry.registerTool(name, description, code, {
            inputSchema,
            createdBy: 'user',
            tags,
            persistAcrossSessions,
        });

        res.json({
            success: true,
            tool: { name: tool.name, id: tool.id, version: tool.version }
        });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

// ============================================================================
// DELETE /api/tools/marketplace/:name — Delete a tool
// ============================================================================
router.delete('/:name', async (req: Request, res: Response) => {
    try {
        const deleted = await dynamicToolRegistry.deleteTool(req.params.name);
        if (deleted) {
            res.json({ success: true, message: 'Tool deleted' });
        } else {
            res.status(404).json({ error: 'Tool not found' });
        }
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/tools/marketplace/:name/test — Test-execute a tool
// ============================================================================
router.post('/:name/test', async (req: Request, res: Response) => {
    try {
        const { args } = req.body;
        const result = await dynamicToolRegistry.executeTool(req.params.name, args || {});
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/tools/share — Export a tool as JSON
// ============================================================================
router.post('/share', (req: Request, res: Response) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Missing tool name' });
        }
        const exported = dynamicToolRegistry.exportTool(name);
        if (!exported) {
            return res.status(404).json({ error: 'Tool not found' });
        }
        res.json({ success: true, tool: exported });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/tools/import — Import a tool from JSON
// ============================================================================
router.post('/import', async (req: Request, res: Response) => {
    try {
        const { tool: toolData } = req.body;
        if (!toolData) {
            return res.status(400).json({ error: 'Missing tool data' });
        }
        const tool = await dynamicToolRegistry.importTool(toolData, 'import');
        res.json({
            success: true,
            tool: { name: tool.name, id: tool.id, version: tool.version }
        });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

export const toolMarketplaceRoutes = router;
