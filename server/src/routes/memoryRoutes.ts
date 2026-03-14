import { Router } from 'express';
import { memoryConsolidator } from '../memory/MemoryConsolidator';
import { db } from '../database';

const router = Router();

// GET /api/memory/consolidation/summaries — list summaries
router.get('/consolidation/summaries', async (req, res) => {
    try {
        const userId = (req as any).userId || 'default';
        const type = req.query.type as 'daily' | 'weekly' | undefined;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
        const summaries = await memoryConsolidator.getSummaries(userId, type, limit);
        res.json({ summaries });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// GET /api/memory/consolidation/stats — archive stats
router.get('/consolidation/stats', async (req, res) => {
    try {
        const userId = (req as any).userId || 'default';
        const stats = await memoryConsolidator.getArchiveStats(userId);
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// GET /api/memory/preferences — list preferences
router.get('/preferences', async (req, res) => {
    try {
        const userId = (req as any).userId || 'default';
        const prefs = await memoryConsolidator.getPreferences(userId);
        res.json({ preferences: prefs });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// POST /api/memory/consolidation/daily — trigger daily consolidation
router.post('/consolidation/daily', async (req, res) => {
    try {
        const userId = (req as any).userId || 'default';
        const result = await memoryConsolidator.consolidateDaily(userId);
        res.json({ success: true, summary: result });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// POST /api/memory/consolidation/weekly — trigger weekly consolidation
router.post('/consolidation/weekly', async (req, res) => {
    try {
        const userId = (req as any).userId || 'default';
        const result = await memoryConsolidator.consolidateWeekly(userId);
        res.json({ success: true, summary: result });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// POST /api/memory/consolidation/archive — trigger archiving
router.post('/consolidation/archive', async (req, res) => {
    try {
        const userId = (req as any).userId || 'default';
        const days = req.body.days || 7;
        const archived = await memoryConsolidator.archiveOldEvents(userId, days);
        res.json({ success: true, archived });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// DELETE /api/memory/preferences/:id — remove a learned preference
router.delete('/preferences/:id', async (req, res) => {
    try {
        await db.run('DELETE FROM user_preferences WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// DELETE /api/memory/summaries/:id — remove a memory summary
router.delete('/consolidation/summaries/:id', async (req, res) => {
    try {
        await db.run('DELETE FROM memory_summaries WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

export { router as memoryConsolidationRoutes };
