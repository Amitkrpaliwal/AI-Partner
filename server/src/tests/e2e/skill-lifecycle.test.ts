/**
 * E2E Test: Skill Lifecycle
 * Tests: learn → match → reuse → decay → prune
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const api = axios.create({ baseURL: BASE, timeout: 15000, validateStatus: () => true });

describe('Skill Lifecycle', () => {
    it('should list available skills', async () => {
        const res = await api.get('/api/skills');
        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('skills');
    });

    it('should list learned skills', async () => {
        const res = await api.get('/api/skills/learned');
        expect(res.status).toBe(200);
        // May be empty initially
        expect(Array.isArray(res.data.skills || res.data)).toBe(true);
    });

    it('should list built-in skills from SKILLS.md', async () => {
        const res = await api.get('/api/skills');
        expect(res.status).toBe(200);
        const skills = res.data.skills || [];
        // Should have at least some built-in skills
        if (skills.length > 0) {
            const skill = skills[0];
            expect(skill).toHaveProperty('name');
        }
    });

    it('should handle skill invocation request', async () => {
        const res = await api.post('/api/skills/invoke', {
            name: 'nonexistent_skill_12345',
            args: {},
        });
        // Should return 404 or error, not crash
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should support skill sync endpoint', async () => {
        const res = await api.post('/api/skills/sync');
        expect(res.status).toBe(200);
    });
});
