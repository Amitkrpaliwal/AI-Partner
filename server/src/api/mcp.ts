import express from 'express';
import { mcpManager } from '../mcp/MCPManager';

const router = express.Router();

router.get('/servers', async (req, res) => {
    try {
        const servers = await mcpManager.getServers();
        res.json({ servers });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

router.get('/tools', async (req, res) => {
    try {
        const tools = await mcpManager.listTools();
        res.json({ tools });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

router.post('/tool/call', async (req, res) => {
    try {
        const { server, tool, args } = req.body;
        if (!server || !tool) {
            return res.status(400).json({ error: 'Missing server or tool name' });
        }
        const result = await mcpManager.callTool(server, tool, args || {});
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

export const mcpRouter = router;
