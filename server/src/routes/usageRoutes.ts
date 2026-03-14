/**
 * Usage Tracking Routes — REST API for LLM cost & usage analytics (Phase 8).
 */

import { Router, Request, Response } from 'express';
import { usageTracker } from '../services/UsageTracker';

const router = Router();

// GET /api/usage/summary?period=daily|weekly|monthly
router.get('/summary', async (req: Request, res: Response) => {
    try {
        const period = (req.query.period as 'daily' | 'weekly' | 'monthly') || 'daily';
        const summary = await usageTracker.getSummary(period);
        res.json({ period, ...summary });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/by-provider?period=weekly
router.get('/by-provider', async (req: Request, res: Response) => {
    try {
        const period = (req.query.period as 'daily' | 'weekly' | 'monthly') || 'weekly';
        const breakdown = await usageTracker.getByProvider(period);
        res.json({ period, breakdown });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/by-conversation/:id
router.get('/by-conversation/:id', async (req: Request, res: Response) => {
    try {
        const usage = await usageTracker.getByConversation(req.params.id);
        res.json({ conversationId: req.params.id, usage });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/daily-cost
router.get('/daily-cost', async (_req: Request, res: Response) => {
    try {
        const cost = await usageTracker.getDailyCost();
        res.json({ dailyCost: Math.round(cost * 10000) / 10000, threshold: usageTracker.getDailyCostAlert() });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/alert-threshold
router.get('/alert-threshold', (_req: Request, res: Response) => {
    res.json({ threshold: usageTracker.getDailyCostAlert() });
});

// POST /api/usage/alert-threshold
router.post('/alert-threshold', (req: Request, res: Response) => {
    const { threshold } = req.body;
    if (typeof threshold !== 'number' || threshold <= 0) {
        return res.status(400).json({ error: 'Threshold must be a positive number' });
    }
    usageTracker.setDailyCostAlert(threshold);
    res.json({ success: true, threshold });
});

export const usageRoutes = router;
