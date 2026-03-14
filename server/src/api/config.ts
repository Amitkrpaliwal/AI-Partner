import { Router } from 'express';
import { configManager } from '../services/ConfigManager';

export const configRouter = Router();

configRouter.get('/', (req, res) => {
    res.json(configManager.getConfig());
});

configRouter.post('/', async (req, res) => {
    try {
        const updates = req.body;
        const newConfig = await configManager.updateConfig(updates);
        res.json(newConfig);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
