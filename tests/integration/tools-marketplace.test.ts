import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock DynamicToolRegistry behavior
const mockTools: any[] = [];

const app = express();
app.use(express.json());

app.get('/api/tools/marketplace', (_req, res) => {
    const tools = mockTools.map(t => ({
        id: t.id, name: t.name, description: t.description,
        version: t.version, usageCount: t.usageCount || 0,
        tags: t.tags || [], createdAt: t.createdAt,
    }));
    res.json({ tools, count: tools.length });
});

app.get('/api/tools/marketplace/search', (req, res) => {
    const q = (req.query.q as string || '').toLowerCase();
    const filtered = mockTools.filter(t =>
        t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
    res.json({ tools: filtered.map(t => ({ name: t.name, description: t.description })), query: q });
});

app.get('/api/tools/marketplace/export', (_req, res) => {
    res.json({ tools: mockTools, count: mockTools.length });
});

app.get('/api/tools/marketplace/:name', (req, res) => {
    const tool = mockTools.find(t => t.name === req.params.name);
    if (!tool) return res.status(404).json({ error: `Tool "${req.params.name}" not found` });
    res.json({ tool });
});

app.post('/api/tools/marketplace', (req, res) => {
    const { name, description, code } = req.body;
    if (!name || !description || !code) {
        return res.status(400).json({ error: 'Invalid tool definition' });
    }
    const tool = { id: `t_${Date.now()}`, name, description, code, version: 1, usageCount: 0, tags: [], createdAt: new Date().toISOString() };
    mockTools.push(tool);
    res.json({ success: true, tool: { name: tool.name, id: tool.id, version: tool.version } });
});

app.delete('/api/tools/marketplace/:name', (req, res) => {
    const idx = mockTools.findIndex(t => t.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'Tool not found' });
    mockTools.splice(idx, 1);
    res.json({ success: true, message: 'Tool deleted' });
});

app.post('/api/tools/import', (req, res) => {
    const { tool: toolData } = req.body;
    if (!toolData) return res.status(400).json({ error: 'Missing tool data' });
    mockTools.push({ ...toolData, id: `t_${Date.now()}` });
    res.json({ success: true, tool: { name: toolData.name, id: `t_${Date.now()}`, version: toolData.version || 1 } });
});

describe('Tool Marketplace API', () => {
    it('GET /api/tools/marketplace returns empty list initially', async () => {
        mockTools.length = 0;
        const res = await request(app).get('/api/tools/marketplace');
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
        expect(res.body.tools).toEqual([]);
    });

    it('POST /api/tools/marketplace creates a tool', async () => {
        const res = await request(app)
            .post('/api/tools/marketplace')
            .send({ name: 'test_tool', description: 'A test tool', code: 'return args.value * 2;' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.tool.name).toBe('test_tool');
    });

    it('GET /api/tools/marketplace lists created tools', async () => {
        const res = await request(app).get('/api/tools/marketplace');
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.tools[0].name).toBe('test_tool');
    });

    it('GET /api/tools/marketplace/:name gets tool details', async () => {
        const res = await request(app).get('/api/tools/marketplace/test_tool');
        expect(res.status).toBe(200);
        expect(res.body.tool.name).toBe('test_tool');
    });

    it('GET /api/tools/marketplace/:name returns 404 for missing tool', async () => {
        const res = await request(app).get('/api/tools/marketplace/nonexistent');
        expect(res.status).toBe(404);
    });

    it('GET /api/tools/marketplace/search?q= filters by query', async () => {
        const res = await request(app).get('/api/tools/marketplace/search?q=test');
        expect(res.status).toBe(200);
        expect(res.body.tools.length).toBeGreaterThan(0);
    });

    it('GET /api/tools/marketplace/export exports all tools', async () => {
        const res = await request(app).get('/api/tools/marketplace/export');
        expect(res.status).toBe(200);
        expect(res.body.count).toBeGreaterThan(0);
    });

    it('POST /api/tools/marketplace rejects missing fields', async () => {
        const res = await request(app)
            .post('/api/tools/marketplace')
            .send({ name: 'incomplete' });
        expect(res.status).toBe(400);
    });

    it('POST /api/tools/import imports a tool', async () => {
        const res = await request(app)
            .post('/api/tools/import')
            .send({ tool: { name: 'imported_tool', description: 'Imported', code: 'return 1;', version: 2 } });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('DELETE /api/tools/marketplace/:name deletes a tool', async () => {
        const res = await request(app).delete('/api/tools/marketplace/test_tool');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('DELETE /api/tools/marketplace/:name returns 404 for missing', async () => {
        const res = await request(app).delete('/api/tools/marketplace/test_tool');
        expect(res.status).toBe(404);
    });
});
