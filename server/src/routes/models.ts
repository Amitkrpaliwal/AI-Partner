import express from 'express';
import { modelManager } from '../services/llm/modelManager';

const router = express.Router();

// GET /api/models - List all available models
router.get('/', async (req, res) => {
    try {
        const models = await modelManager.discoverModels();
        const activeData = modelManager.getActiveModelStatus();

        // Find full model object for active
        const activeModel = models.find(m => m.id === activeData.model && m.provider === activeData.provider)
            || (activeData.model ? { id: activeData.model, provider: activeData.provider, name: activeData.model } : null);

        res.json({
            models,
            active: activeModel,
        });
    } catch (error) {
        res.status(500).json({ error: (error as any).message });
    }
});

// POST /api/models/switch - Switch active model
router.post('/switch', async (req, res) => {
    try {
        const { modelId, provider } = req.body;

        if (!modelId || !provider) {
            return res.status(400).json({ error: 'modelId and provider required' });
        }

        await modelManager.switchModel(modelId, provider);

        res.json({
            success: true,
            activeModel: modelManager.getActiveModelStatus(),
        });
    } catch (error) {
        res.status(500).json({ error: (error as any).message });
    }
});

// GET /api/models/health - Check provider health
router.get('/health', async (req, res) => {
    try {
        const health = await modelManager.healthCheck();
        res.json(health);
    } catch (error) {
        res.status(500).json({ error: (error as any).message });
    }
});

// POST /api/models/refresh - Re-discover models from all registered providers
router.post('/refresh', async (req, res) => {
    try {
        const models = await modelManager.discoverModels();
        const activeData = modelManager.getActiveModelStatus();
        res.json({
            success: true,
            modelCount: models.length,
            models,
            active: activeData,
        });
    } catch (error) {
        res.status(500).json({ error: (error as any).message });
    }
});

export default router;
