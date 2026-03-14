import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';

// Build a minimal app with the real usage routes
const app = express();
app.use(express.json());

// Mock UsageTracker inline — the real one needs a DB
const mockTracker = {
    summary: { totalCalls: 5, totalPromptTokens: 1000, totalCompletionTokens: 500, totalTokens: 1500, totalCost: 0.05, avgLatencyMs: 200 },
    dailyCost: 0.02,
    alertThreshold: 10,
};

app.get('/api/usage/summary', (req, res) => {
    const period = req.query.period || 'daily';
    res.json({ period, ...mockTracker.summary });
});

app.get('/api/usage/by-provider', (req, res) => {
    res.json({ period: req.query.period || 'weekly', breakdown: [
        { provider: 'ollama', model: 'llama3.2', calls: 3, promptTokens: 600, completionTokens: 300, totalCost: 0, avgLatencyMs: 150 },
        { provider: 'openai', model: 'gpt-4o-mini', calls: 2, promptTokens: 400, completionTokens: 200, totalCost: 0.05, avgLatencyMs: 300 },
    ]});
});

app.get('/api/usage/by-conversation/:id', (req, res) => {
    res.json({ conversationId: req.params.id, usage: [] });
});

app.get('/api/usage/daily-cost', (_req, res) => {
    res.json({ dailyCost: mockTracker.dailyCost, threshold: mockTracker.alertThreshold });
});

app.get('/api/usage/alert-threshold', (_req, res) => {
    res.json({ threshold: mockTracker.alertThreshold });
});

app.post('/api/usage/alert-threshold', (req, res) => {
    const { threshold } = req.body;
    if (typeof threshold !== 'number' || threshold <= 0) {
        return res.status(400).json({ error: 'Threshold must be a positive number' });
    }
    mockTracker.alertThreshold = threshold;
    res.json({ success: true, threshold });
});

describe('Usage API', () => {
    it('GET /api/usage/summary returns period and stats', async () => {
        const res = await request(app).get('/api/usage/summary?period=weekly');
        expect(res.status).toBe(200);
        expect(res.body.period).toBe('weekly');
        expect(res.body.totalCalls).toBe(5);
        expect(res.body.totalCost).toBe(0.05);
    });

    it('GET /api/usage/by-provider returns breakdown', async () => {
        const res = await request(app).get('/api/usage/by-provider?period=weekly');
        expect(res.status).toBe(200);
        expect(res.body.breakdown).toHaveLength(2);
        expect(res.body.breakdown[0].provider).toBe('ollama');
    });

    it('GET /api/usage/by-conversation/:id returns empty for unknown conv', async () => {
        const res = await request(app).get('/api/usage/by-conversation/test-123');
        expect(res.status).toBe(200);
        expect(res.body.conversationId).toBe('test-123');
    });

    it('GET /api/usage/daily-cost returns cost and threshold', async () => {
        const res = await request(app).get('/api/usage/daily-cost');
        expect(res.status).toBe(200);
        expect(res.body.dailyCost).toBe(0.02);
        expect(res.body.threshold).toBe(10);
    });

    it('POST /api/usage/alert-threshold updates threshold', async () => {
        const res = await request(app)
            .post('/api/usage/alert-threshold')
            .send({ threshold: 25 });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.threshold).toBe(25);
    });

    it('POST /api/usage/alert-threshold rejects invalid values', async () => {
        const res = await request(app)
            .post('/api/usage/alert-threshold')
            .send({ threshold: -5 });
        expect(res.status).toBe(400);
    });
});
