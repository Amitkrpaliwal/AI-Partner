/**
 * Container Session API Routes
 *
 * GET    /api/containers/status          - Docker availability and session status
 * POST   /api/containers/exec            - Execute command in container
 * POST   /api/containers/sessions        - Create/get a session
 * DELETE /api/containers/sessions/:id    - Destroy a session
 * GET    /api/containers/sessions        - List all sessions
 */

import { Router, Request, Response } from 'express';
import { containerSessionManager } from '../execution/ContainerSession';
import { configManager } from '../services/ConfigManager';

export const containerRoutes = Router();

/**
 * GET /api/containers/status
 * Check Docker availability and container session status.
 */
containerRoutes.get('/status', async (_req: Request, res: Response) => {
    try {
        const dockerAvailable = await containerSessionManager.isDockerAvailable();
        const sessions = await containerSessionManager.getAllStatus();
        const config = configManager.getConfig();

        res.json({
            success: true,
            dockerAvailable,
            enabled: config.container?.enabled ?? true,
            config: {
                image: config.container?.image || 'node:20-slim',
                memoryLimit: config.container?.memory_limit || '512m',
                cpuLimit: config.container?.cpu_limit || '1.0',
                idleTimeoutMinutes: config.container?.idle_timeout_minutes || 30,
            },
            sessions,
            sessionCount: sessions.length,
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/containers/exec
 * Execute a command in a container session.
 *
 * Body: {
 *   sessionId: string,
 *   command: string,
 *   timeout?: number,
 *   cwd?: string
 * }
 */
containerRoutes.post('/exec', async (req: Request, res: Response) => {
    try {
        const { sessionId, command, timeout, cwd } = req.body;

        if (!sessionId || !command) {
            return res.status(400).json({ success: false, error: 'sessionId and command are required' });
        }

        const config = configManager.getConfig();
        const result = await containerSessionManager.exec(sessionId, command, {
            timeout: timeout || 60000,
            cwd,
            config: {
                image: config.container?.image || 'node:20-slim',
                memoryLimit: config.container?.memory_limit || '512m',
                cpuLimit: config.container?.cpu_limit || '1.0',
                idleTimeoutMs: (config.container?.idle_timeout_minutes || 30) * 60 * 1000,
            },
        });

        res.json({
            success: result.exitCode === 0,
            ...result,
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/containers/sessions
 * List all active container sessions.
 */
containerRoutes.get('/sessions', async (_req: Request, res: Response) => {
    try {
        const sessions = await containerSessionManager.getAllStatus();
        res.json({
            success: true,
            sessions,
            count: sessions.length,
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/containers/sessions/:id
 * Destroy a container session.
 */
containerRoutes.delete('/sessions/:id', async (req: Request, res: Response) => {
    try {
        await containerSessionManager.destroySession(req.params.id);
        res.json({ success: true, message: `Session ${req.params.id} destroyed` });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default containerRoutes;
