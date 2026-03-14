import { Router } from 'express';
import { mcpManager } from '../mcp/MCPManager';

const router = Router();

// GET /api/mcp/external — list all external MCP servers
router.get('/', async (_req, res) => {
    try {
        const servers = await mcpManager.listExternalServers();
        res.json({ servers });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/mcp/external — connect a new external MCP server
// Body: { name, command, args, env?, description? }
router.post('/', async (req, res) => {
    const { name, command, args, env, description } = req.body;
    if (!name || !command || !Array.isArray(args)) {
        return res.status(400).json({ error: 'name, command, and args[] are required' });
    }
    const result = await mcpManager.connectExternalServer({ name, command, args, env, description });
    if (!result.success) {
        return res.status(422).json(result);
    }
    res.json(result);
});

// DELETE /api/mcp/external/:name — disconnect and remove an external server
router.delete('/:name', async (req, res) => {
    const { name } = req.params;
    const result = await mcpManager.disconnectExternalServer(name);
    if (!result.success) {
        return res.status(404).json({ error: 'Server not found' });
    }
    res.json(result);
});

export { router as externalMCPRoutes };
