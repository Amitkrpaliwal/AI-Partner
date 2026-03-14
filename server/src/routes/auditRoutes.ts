/**
 * Audit Log API Routes
 *
 * GET  /api/audit/logs       - Query audit log entries (paginated)
 * GET  /api/audit/stats      - Aggregate stats by category/severity
 * POST /api/audit/prune      - Delete logs older than N days
 */

import { Router, Request, Response } from 'express';
import { auditLogger, AuditQuery } from '../services/AuditLogger';

export const auditRoutes = Router();

/**
 * GET /api/audit/logs
 * Query audit log entries.
 *
 * Query params: category, severity, userId, action, since, until, limit, offset
 */
auditRoutes.get('/logs', async (req: Request, res: Response) => {
    try {
        const query: AuditQuery = {
            category: req.query.category as any,
            severity: req.query.severity as any,
            userId: req.query.userId as string,
            action: req.query.action as string,
            since: req.query.since as string,
            until: req.query.until as string,
            limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
            offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
        };

        const result = await auditLogger.query(query);
        res.json({ success: true, ...result });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/audit/stats
 * Get aggregate stats.
 *
 * Query params: since (ISO timestamp)
 */
auditRoutes.get('/stats', async (req: Request, res: Response) => {
    try {
        const since = req.query.since as string | undefined;
        const stats = await auditLogger.getStats(since);
        res.json({ success: true, ...stats });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/audit/prune
 * Delete old audit logs.
 *
 * Body: { keepDays?: number } (default: 90)
 */
auditRoutes.post('/prune', async (req: Request, res: Response) => {
    try {
        const keepDays = req.body.keepDays || 90;
        const deleted = await auditLogger.prune(keepDays);
        res.json({ success: true, deleted, keepDays });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default auditRoutes;
