/**
 * Messaging Routes — Configure and manage messaging integrations.
 */

import { Router, Request, Response } from 'express';
import { messagingGateway } from '../services/MessagingGateway';

const router = Router();

// GET /api/messaging/status — Get all provider statuses
router.get('/status', (_req: Request, res: Response) => {
    res.json({
        providers: messagingGateway.getStatus(),
        available: messagingGateway.getProviderNames()
    });
});

// POST /api/messaging/connect — Connect a provider
router.post('/connect', async (req: Request, res: Response) => {
    try {
        const { provider, config } = req.body;
        if (!provider) {
            return res.status(400).json({ error: 'Missing provider name' });
        }
        await messagingGateway.connectProvider(provider, { enabled: true, ...config });
        res.json({ success: true, message: `${provider} connected` });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

// POST /api/messaging/disconnect — Disconnect a provider
router.post('/disconnect', async (req: Request, res: Response) => {
    try {
        const { provider } = req.body;
        if (!provider) {
            return res.status(400).json({ error: 'Missing provider name' });
        }
        await messagingGateway.disconnectProvider(provider);
        res.json({ success: true, message: `${provider} disconnected` });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/messaging/send — Send a message through a provider
router.post('/send', async (req: Request, res: Response) => {
    try {
        const { provider, chatId, text } = req.body;
        if (!provider || !chatId || !text) {
            return res.status(400).json({ error: 'Missing provider, chatId, or text' });
        }
        await messagingGateway.sendMessage(provider, chatId, text);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export const messagingRoutes = router;
