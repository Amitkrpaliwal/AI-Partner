import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockProviders: Record<string, { connected: boolean; token?: string }> = {
    telegram: { connected: false },
    discord: { connected: false },
    whatsapp: { connected: false },
};

const app = express();
app.use(express.json());

app.get('/api/messaging/status', (_req, res) => {
    res.json({
        providers: Object.entries(mockProviders).map(([name, p]) => ({
            name, connected: p.connected, configured: !!p.token,
        })),
    });
});

app.post('/api/messaging/connect', (req, res) => {
    const { provider, token } = req.body;
    if (!provider || !token) return res.status(400).json({ error: 'provider and token required' });
    if (!mockProviders[provider]) return res.status(404).json({ error: 'Unknown provider' });
    mockProviders[provider] = { connected: true, token };
    res.json({ success: true, provider, connected: true });
});

app.post('/api/messaging/disconnect', (req, res) => {
    const { provider } = req.body;
    if (!provider || !mockProviders[provider]) return res.status(400).json({ error: 'Invalid provider' });
    mockProviders[provider].connected = false;
    res.json({ success: true, provider, connected: false });
});

app.post('/api/messaging/send', (req, res) => {
    const { provider, chatId, text } = req.body;
    if (!provider || !chatId || !text) return res.status(400).json({ error: 'provider, chatId, text required' });
    if (!mockProviders[provider]?.connected) return res.status(400).json({ error: 'Provider not connected' });
    res.json({ success: true, delivered: true });
});

describe('Messaging API', () => {
    it('GET /api/messaging/status returns all providers', async () => {
        const res = await request(app).get('/api/messaging/status');
        expect(res.status).toBe(200);
        expect(res.body.providers).toHaveLength(3);
        expect(res.body.providers.map((p: any) => p.name)).toEqual(['telegram', 'discord', 'whatsapp']);
    });

    it('POST /api/messaging/connect connects a provider', async () => {
        const res = await request(app)
            .post('/api/messaging/connect')
            .send({ provider: 'telegram', token: 'test-token-123' });
        expect(res.status).toBe(200);
        expect(res.body.connected).toBe(true);
    });

    it('POST /api/messaging/connect rejects unknown provider', async () => {
        const res = await request(app)
            .post('/api/messaging/connect')
            .send({ provider: 'slack', token: 'abc' });
        expect(res.status).toBe(404);
    });

    it('POST /api/messaging/send delivers to connected provider', async () => {
        const res = await request(app)
            .post('/api/messaging/send')
            .send({ provider: 'telegram', chatId: '12345', text: 'Hello from test!' });
        expect(res.status).toBe(200);
        expect(res.body.delivered).toBe(true);
    });

    it('POST /api/messaging/send rejects disconnected provider', async () => {
        const res = await request(app)
            .post('/api/messaging/send')
            .send({ provider: 'discord', chatId: '12345', text: 'fail' });
        expect(res.status).toBe(400);
    });

    it('POST /api/messaging/disconnect disconnects a provider', async () => {
        const res = await request(app)
            .post('/api/messaging/disconnect')
            .send({ provider: 'telegram' });
        expect(res.status).toBe(200);
        expect(res.body.connected).toBe(false);
    });
});
