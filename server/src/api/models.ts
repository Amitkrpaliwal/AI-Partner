import { Router } from 'express';
import { modelManager } from '../services/llm/modelManager';
import { modelRouter } from '../services/llm/modelRouter';

export const modelsRouter = Router();

modelsRouter.get('/', async (req, res) => {
    try {
        const models = await modelManager.discoverModels();
        const active = modelManager.getActiveModelStatus();
        res.json({ models, active });
    } catch (e) {
        console.error('Failed to list models:', e);
        res.status(500).json({ error: String(e) });
    }
});

modelsRouter.post('/switch', async (req, res) => {
    try {
        const { modelId, provider } = req.body;
        if (!modelId || !provider) {
            return res.status(400).json({ error: 'Missing modelId or provider' });
        }
        await modelManager.switchModel(modelId, provider);
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to switch model:', e);
        res.status(500).json({ error: String(e) });
    }
});

// Provider management
modelsRouter.get('/providers', (req, res) => {
    try {
        const providers = modelManager.getProviderNames();
        const active = modelManager.getActiveModelStatus();
        res.json({
            providers,
            active_provider: active.provider,
            active_model: active.model
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Provider configurations (with keys masked)
modelsRouter.get('/providers/configs', (req, res) => {
    try {
        const configs = modelManager.getProviderConfigs();
        res.json({ providers: configs });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Register or update a provider with API key
modelsRouter.post('/providers/configure', async (req, res) => {
    try {
        const { name, apiKey, baseURL, defaultModel } = req.body;
        if (!name || !apiKey) {
            return res.status(400).json({ error: 'name and apiKey are required' });
        }
        const result = await modelManager.registerProvider(name, apiKey, baseURL, defaultModel);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('Failed to configure provider:', e);
        res.status(500).json({ error: String(e) });
    }
});

// Update local provider URL (Ollama host or LM Studio base URL) — persisted to config.json
modelsRouter.put('/providers/local', async (req, res) => {
    try {
        const { name, baseURL } = req.body;
        if (!name || !baseURL) {
            return res.status(400).json({ error: 'name and baseURL are required' });
        }
        if (name !== 'ollama' && name !== 'lmstudio') {
            return res.status(400).json({ error: 'name must be "ollama" or "lmstudio"' });
        }
        await modelManager.updateLocalProvider(name, baseURL);
        res.json({ success: true, name, baseURL });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Remove a provider
modelsRouter.delete('/providers/:name', async (req, res) => {
    try {
        await modelManager.removeProvider(req.params.name);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Refresh: re-discover models from all providers
modelsRouter.post('/refresh', async (req, res) => {
    try {
        await modelManager.initialize();
        const models = await modelManager.discoverModels();
        const active = modelManager.getActiveModelStatus();
        res.json({ success: true, models, active });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Smart routing info
modelsRouter.get('/routing', (req, res) => {
    try {
        const { query } = req.query;
        if (query && typeof query === 'string') {
            const { taskType } = modelRouter.route(query);
            res.json({ query, classified_as: taskType });
        } else {
            res.json({
                task_types: ['classification', 'code_generation', 'reasoning', 'embedding', 'simple_qa', 'json_generation'],
                description: 'Send ?query=your+prompt to see how it would be classified'
            });
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
