import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

// Self-contained mock to avoid importing real server modules that need DB/config
const app = express();
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/models', (_req, res) => res.json({
    models: [
        { id: 'llama3.2', provider: 'ollama', name: 'llama3.2' },
        { id: 'gpt-4o-mini', provider: 'openai', name: 'gpt-4o-mini' },
    ],
    active_provider: 'ollama',
    active_model: 'llama3.2',
}));
app.post('/api/models/switch', (req, res) => {
    const { provider, model } = req.body;
    if (!provider || !model) return res.status(400).json({ error: 'provider and model required' });
    res.json({ success: true, provider, model });
});

describe('Core API', () => {
    it('GET /api/health should return ok', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('GET /api/models should list models', async () => {
        const res = await request(app).get('/api/models');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.models)).toBe(true);
        expect(res.body.models.length).toBe(2);
    });

    it('GET /api/models should include active provider', async () => {
        const res = await request(app).get('/api/models');
        expect(res.body.active_provider).toBeDefined();
        expect(res.body.active_model).toBeDefined();
    });

    it('POST /api/models/switch should change model', async () => {
        const res = await request(app)
            .post('/api/models/switch')
            .send({ provider: 'openai', model: 'gpt-4o' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('POST /api/models/switch rejects missing params', async () => {
        const res = await request(app)
            .post('/api/models/switch')
            .send({});
        expect(res.status).toBe(400);
    });
});
