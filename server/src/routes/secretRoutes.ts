/**
 * Secret Management API Routes
 *
 * All routes require authentication (JWT or API key).
 *
 * GET    /api/secrets         — List secret names (no values)
 * PUT    /api/secrets/:name   — Create or update a secret
 * DELETE /api/secrets/:name   — Delete a secret
 * GET    /api/secrets/:name/check — Check if a secret exists
 */

import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { secretManager } from '../services/SecretManager';
import { auditLogger } from '../services/AuditLogger';

export const secretRoutes = Router();

/**
 * GET /api/secrets
 * List all secret names for the authenticated user (never returns values).
 */
secretRoutes.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId || 'default';
        const secrets = await secretManager.listSecrets(userId);
        res.json({ success: true, secrets });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/secrets/:name
 * Create or update a secret.
 * Body: { value: string }
 */
secretRoutes.put('/:name', async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId || 'default';
        const { name } = req.params;
        const { value } = req.body;

        if (!value || typeof value !== 'string') {
            return res.status(400).json({ error: 'Secret value is required and must be a string' });
        }

        if (!name || name.length > 128) {
            return res.status(400).json({ error: 'Secret name must be 1-128 characters' });
        }

        // Validate name format (alphanumeric, underscores, dashes, dots)
        if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) {
            return res.status(400).json({ error: 'Secret name must contain only alphanumeric characters, underscores, dashes, and dots' });
        }

        const existed = await secretManager.hasSecret(userId, name);
        await secretManager.setSecret(userId, name, value);

        // Apply immediately to process.env so integrations pick it up without restart
        process.env[name] = value;

        // If this looks like an LLM API key, hot-reload cloud providers so the
        // provider appears in the model list without restarting the server.
        if (name.endsWith('_API_KEY') || name.endsWith('_KEY')) {
            import('../services/llm/modelManager')
                .then(m => m.modelManager.refreshProviders())
                .catch(() => { /* non-fatal */ });
        }

        auditLogger.logAuth(existed ? 'secret_updated' : 'secret_created', { name }, { userId, ip: req.ip });

        res.json({
            success: true,
            message: existed ? `Secret "${name}" updated` : `Secret "${name}" created`,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/secrets/:name
 * Delete a secret.
 */
secretRoutes.delete('/:name', async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId || 'default';
        const { name } = req.params;

        const deleted = await secretManager.deleteSecret(userId, name);
        if (!deleted) {
            return res.status(404).json({ error: `Secret "${name}" not found` });
        }

        auditLogger.logAuth('secret_deleted', { name }, { userId, ip: req.ip });

        res.json({ success: true, message: `Secret "${name}" deleted` });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/secrets/:name/check
 * Check if a secret exists (without revealing its value).
 */
secretRoutes.get('/:name/check', async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId || 'default';
        const { name } = req.params;

        const exists = await secretManager.hasSecret(userId, name);
        res.json({ success: true, exists });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/secrets
 * Bulk-delete secrets by name list.
 * Body: { names: string[] }
 */
secretRoutes.delete('/', async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId || 'default';
        const { names } = req.body;
        if (!Array.isArray(names) || names.length === 0) {
            return res.status(400).json({ error: 'names[] array required' });
        }
        const results: Record<string, boolean> = {};
        for (const name of names) {
            results[name] = await secretManager.deleteSecret(userId, name);
            if (results[name]) delete process.env[name];
        }
        auditLogger.logAuth('secrets_bulk_deleted', { names }, { userId, ip: req.ip });
        res.json({ success: true, results });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default secretRoutes;
