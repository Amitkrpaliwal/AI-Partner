import express from 'express';
import { HeartbeatService } from '../services/HeartbeatService';

export function createHeartbeatRouter(heartbeatService: HeartbeatService) {
    const router = express.Router();

    router.get('/status', (req, res) => {
        res.json(heartbeatService.getStatus());
    });

    router.post('/config', (req, res) => {
        heartbeatService.setConfig(req.body);
        res.json({ success: true, config: heartbeatService.getConfig() });
    });

    router.post('/manual', async (req, res) => {
        try {
            await heartbeatService.tick();
            res.json({ success: true, message: 'Manual tick triggered' });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    router.post('/trigger', async (req, res) => {
        try {
            await heartbeatService.tick();
            res.json({ success: true, message: 'Heartbeat triggered successfully' });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    router.get('/logs', async (req, res) => {
        try {
            const { db } = await import('../database/index');
            const logs = await db.all('SELECT * FROM heartbeat_logs ORDER BY timestamp DESC LIMIT 50');
            res.json(logs);
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    // ── HEARTBEAT.md read / write ─────────────────────────────────────────────

    router.get('/heartbeat-md', (req, res) => {
        try {
            res.json({ content: heartbeatService.readHeartbeatMd() });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    router.put('/heartbeat-md', (req, res) => {
        try {
            const { content } = req.body;
            if (typeof content !== 'string') {
                res.status(400).json({ error: 'content must be a string' });
                return;
            }
            heartbeatService.writeHeartbeatMd(content);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    // ── SOUL.md read / write ──────────────────────────────────────────────────

    router.get('/soul-md', (req, res) => {
        try {
            res.json({ content: heartbeatService.readSoulMd() });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    router.put('/soul-md', (req, res) => {
        try {
            const { content } = req.body;
            if (typeof content !== 'string') {
                res.status(400).json({ error: 'content must be a string' });
                return;
            }
            heartbeatService.writeSoulMd(content);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    return router;
}
