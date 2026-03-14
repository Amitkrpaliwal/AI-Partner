/**
 * Webhook API Routes
 *
 * POST   /api/webhooks/:hookId      - Trigger webhook (external callers)
 * GET    /api/webhooks              - List all webhooks
 * POST   /api/webhooks              - Create a new webhook
 * DELETE /api/webhooks/:id          - Delete a webhook
 * POST   /api/webhooks/:id/enable   - Enable a webhook
 * POST   /api/webhooks/:id/disable  - Disable a webhook
 * GET    /api/webhooks/:id/runs     - Get webhook run history
 */

import { Router, Request, Response } from 'express';
import { webhookManager } from '../services/WebhookManager';

export const webhookRoutes = Router();

/**
 * POST /api/webhooks/:hookId
 * Trigger a webhook (called by external systems).
 * Headers: X-Webhook-Signature (the raw secret for verification)
 */
webhookRoutes.post('/:hookId', async (req: Request, res: Response) => {
    try {
        const { hookId } = req.params;
        const signature = req.headers['x-webhook-signature'] as string | undefined;

        const result = await webhookManager.trigger(hookId, req.body, {
            signature,
            ip: req.ip,
        });

        if (!result.success) {
            return res.status(result.error === 'Webhook not found' ? 404 : 400).json(result);
        }

        res.json(result);
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/webhooks
 * List all webhooks.
 */
webhookRoutes.get('/', async (_req: Request, res: Response) => {
    try {
        const webhooks = await webhookManager.list();
        res.json({ success: true, webhooks });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/webhooks
 * Create a new webhook.
 *
 * Body: { name: string, taskTemplate: string, mode?: 'chat' | 'goal', userId?: string }
 */
webhookRoutes.post('/', async (req: Request, res: Response) => {
    try {
        const { name, taskTemplate, mode, userId } = req.body;

        if (!name || !taskTemplate) {
            return res.status(400).json({
                success: false,
                error: 'name and taskTemplate are required. Use {{payload}} in template for incoming data.',
            });
        }

        const result = await webhookManager.create(name, taskTemplate, { mode, userId });
        res.json({
            success: true,
            ...result,
            message: 'Save the secret — it cannot be retrieved later.',
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/webhooks/:id
 * Delete a webhook.
 */
webhookRoutes.delete('/:id', async (req: Request, res: Response) => {
    try {
        const deleted = await webhookManager.delete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Webhook not found' });
        }
        res.json({ success: true, message: 'Webhook deleted' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/webhooks/:id/enable
 */
webhookRoutes.post('/:id/enable', async (req: Request, res: Response) => {
    try {
        await webhookManager.setEnabled(req.params.id, true);
        res.json({ success: true, message: 'Webhook enabled' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/webhooks/:id/disable
 */
webhookRoutes.post('/:id/disable', async (req: Request, res: Response) => {
    try {
        await webhookManager.setEnabled(req.params.id, false);
        res.json({ success: true, message: 'Webhook disabled' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/webhooks/:id/runs
 * Get webhook trigger history.
 */
webhookRoutes.get('/:id/runs', async (req: Request, res: Response) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
        const runs = await webhookManager.getRuns(req.params.id, limit);
        res.json({ success: true, runs });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default webhookRoutes;
