import express from 'express';
import { skillManager } from '../services/SkillManager';

const router = express.Router();

/**
 * GET /api/skills
 * List all installed skills
 */
router.get('/', async (req, res) => {
    try {
        const enabledOnly = req.query.enabled === 'true';
        const skills = enabledOnly
            ? await skillManager.getEnabledSkills()
            : await skillManager.getAllSkills();
        res.json({ skills });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * POST /api/skills/sync
 * Sync skills from workspace SKILL.md files
 */
router.post('/sync', async (req, res) => {
    try {
        const result = await skillManager.syncSkills();
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * GET /api/skills/:id
 * Get single skill by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const skill = await skillManager.getSkill(req.params.id);
        if (!skill) {
            return res.status(404).json({ error: 'Skill not found' });
        }
        res.json({ skill });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * POST /api/skills/:id/enable
 * Enable a skill
 */
router.post('/:id/enable', async (req, res) => {
    try {
        const success = await skillManager.enableSkill(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * POST /api/skills/:id/disable
 * Disable a skill
 */
router.post('/:id/disable', async (req, res) => {
    try {
        const success = await skillManager.disableSkill(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * PUT /api/skills/:id/config
 * Update skill configuration
 */
router.put('/:id/config', async (req, res) => {
    try {
        const config = req.body;
        const skill = await skillManager.updateSkillConfig(req.params.id, config);
        if (!skill) {
            return res.status(404).json({ error: 'Skill not found' });
        }
        res.json({ success: true, skill });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

/**
 * DELETE /api/skills/:id
 * Delete a skill
 */
router.delete('/:id', async (req, res) => {
    try {
        const success = await skillManager.deleteSkill(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

export const skillsRouter = router;
