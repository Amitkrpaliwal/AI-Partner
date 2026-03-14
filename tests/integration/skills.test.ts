import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

let mockSkills: any[] = [
    {
        id: 'sk1', name: 'web_scraper', description: 'Scrape web pages',
        pattern: 'scrape, web, extract', template: 'const resp = await fetch("{{URL}}");',
        parameters: [{ name: 'URL', type: 'string', description: 'URL to scrape', required: true }],
        runtime: 'node', version: 1, successCount: 5, failureCount: 1,
        createdAt: '2026-01-01', updatedAt: '2026-01-15', lastUsedAt: '2026-02-10', tags: ['web'],
    },
    {
        id: 'sk2', name: 'csv_parser', description: 'Parse CSV files',
        pattern: 'csv, parse, data', template: 'const data = fs.readFileSync("{{FILE_PATH}}", "utf8");',
        parameters: [{ name: 'FILE_PATH', type: 'path', description: 'Path to CSV', required: true }],
        runtime: 'node', version: 2, successCount: 10, failureCount: 0,
        createdAt: '2026-01-05', updatedAt: '2026-02-01', lastUsedAt: '2026-02-12', tags: ['data'],
    },
];

const app = express();
app.use(express.json());

app.get('/api/skills/learned', (_req, res) => {
    res.json({ skills: mockSkills, count: mockSkills.length });
});

app.get('/api/skills/learned/:name/versions', (req, res) => {
    const versions = mockSkills.filter(s => s.name === req.params.name);
    res.json({ versions });
});

app.delete('/api/skills/learned/:name', (req, res) => {
    const before = mockSkills.length;
    mockSkills = mockSkills.filter(s => s.name !== req.params.name);
    if (mockSkills.length < before) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Skill not found' });
    }
});

describe('Learned Skills API', () => {
    it('GET /api/skills/learned lists skills', async () => {
        const res = await request(app).get('/api/skills/learned');
        expect(res.status).toBe(200);
        expect(res.body.skills.length).toBe(2);
        expect(res.body.skills[0].name).toBe('web_scraper');
    });

    it('skills have parameterized templates', async () => {
        const res = await request(app).get('/api/skills/learned');
        const skill = res.body.skills[0];
        expect(skill.template).toContain('{{URL}}');
        expect(skill.parameters).toHaveLength(1);
        expect(skill.parameters[0].name).toBe('URL');
    });

    it('skills have version tracking', async () => {
        const res = await request(app).get('/api/skills/learned');
        expect(res.body.skills[1].version).toBe(2);
    });

    it('GET /api/skills/learned/:name/versions returns versions', async () => {
        const res = await request(app).get('/api/skills/learned/csv_parser/versions');
        expect(res.status).toBe(200);
        expect(res.body.versions.length).toBe(1);
    });

    it('DELETE /api/skills/learned/:name removes a skill', async () => {
        const res = await request(app).delete('/api/skills/learned/web_scraper');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('DELETE returns 404 for missing skill', async () => {
        const res = await request(app).delete('/api/skills/learned/nonexistent');
        expect(res.status).toBe(404);
    });
});
