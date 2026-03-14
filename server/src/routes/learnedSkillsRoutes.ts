/**
 * Learned Skills Routes — REST API for Phase 6 skill management.
 */

import { Router, Request, Response } from 'express';
import { skillLearner } from '../services/SkillLearner';
import { db } from '../database';
import { randomUUID } from 'crypto';

const router = Router();

// GET /api/skills/learned — List all learned skills (latest versions)
router.get('/', async (_req: Request, res: Response) => {
    try {
        const skills = await skillLearner.listSkills();

        // Flag skills ready for promotion (successCount >= 5 AND rate >= 80%)
        const enriched = skills.map((s: any) => {
            const total = (s.successCount || 0) + (s.failureCount || 0);
            const rate = total === 0 ? 0 : (s.successCount / total) * 100;
            return { ...s, readyToPromote: s.successCount >= 5 && rate >= 80 };
        });

        res.json({ skills: enriched });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/skills/learned/:name/versions — Get version history for a skill
router.get('/:name/versions', async (req: Request, res: Response) => {
    try {
        const versions = await skillLearner.getSkillVersions(req.params.name);
        res.json({ versions });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/skills/learned/:name/promote — Promote skill to Tool Marketplace
router.post('/:name/promote', async (req: Request, res: Response) => {
    try {
        const skills = await skillLearner.listSkills();
        const skill = (skills as any[]).find((s: any) => s.id === req.params.name || s.name === req.params.name);
        if (!skill) return res.status(404).json({ error: 'Skill not found' });

        // Get latest script
        const versions = await skillLearner.getSkillVersions(skill.name);
        const latest = (versions as any[])[0];
        if (!latest) return res.status(400).json({ error: 'No versions available to promote' });

        const toolId = randomUUID();

        // Insert into dynamic_tools table (used by ToolMarketplace / DynamicToolRegistry)
        await db.run(
            `INSERT OR REPLACE INTO dynamic_tools
             (id, name, description, runtime, script, parameters, enabled, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 'promoted_skill', datetime('now'))`,
            [
                toolId,
                skill.name,
                skill.description || `Promoted from learned skill: ${skill.name}`,
                skill.runtime || 'node',
                latest.script || '',
                JSON.stringify(skill.parameters || []),
            ]
        );

        res.json({ success: true, toolId, message: `"${skill.name}" promoted to Tool Marketplace` });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/skills/learned/:name — Delete a skill and all versions
router.delete('/:name', async (req: Request, res: Response) => {
    try {
        const deleted = await skillLearner.deleteSkill(req.params.name);
        res.json({ success: deleted });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export const learnedSkillsRoutes = router;
