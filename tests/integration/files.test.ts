import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockFiles: any[] = [
    { id: 'f1', filename: 'report.pptx', file_type: 'pptx', file_path: 'report.pptx', file_size: 1024, title: 'Report', user_id: 'default', download_count: 0 },
    { id: 'f2', filename: 'data.xlsx', file_type: 'xlsx', file_path: 'data.xlsx', file_size: 2048, title: 'Data', user_id: 'default', download_count: 3 },
];

const app = express();
app.use(express.json());

app.get('/api/files', (req, res) => {
    const user_id = req.query.user_id || 'default';
    const type = req.query.type;
    let files = mockFiles.filter(f => f.user_id === user_id);
    if (type) files = files.filter(f => f.file_type === type);
    res.json({ files, total: files.length, limit: 50, offset: 0 });
});

app.get('/api/files/stats/summary', (req, res) => {
    const user_id = req.query.user_id || 'default';
    const files = mockFiles.filter(f => f.user_id === user_id);
    res.json({
        total_files: files.length,
        total_size: files.reduce((s, f) => s + f.file_size, 0),
        total_downloads: files.reduce((s, f) => s + f.download_count, 0),
        by_type: [
            { file_type: 'pptx', count: 1, size: 1024 },
            { file_type: 'xlsx', count: 1, size: 2048 },
        ],
    });
});

app.get('/api/files/:id', (req, res) => {
    const file = mockFiles.find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
});

app.delete('/api/files/:id', (req, res) => {
    const idx = mockFiles.findIndex(f => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'File not found' });
    mockFiles.splice(idx, 1);
    res.json({ success: true, message: 'File deleted' });
});

app.post('/api/files/register', (req, res) => {
    const { filename, file_type, file_path } = req.body;
    if (!filename || !file_type || !file_path) {
        return res.status(400).json({ error: 'Missing required fields: filename, file_type, file_path' });
    }
    const file = { id: `f_${Date.now()}`, filename, file_type, file_path, file_size: 0, title: filename, user_id: 'default', download_count: 0 };
    mockFiles.push(file);
    res.json({ success: true, file });
});

describe('Files API', () => {
    it('GET /api/files lists files', async () => {
        const res = await request(app).get('/api/files');
        expect(res.status).toBe(200);
        expect(res.body.files.length).toBeGreaterThanOrEqual(1);
        expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/files?type=pptx filters by type', async () => {
        const res = await request(app).get('/api/files?type=pptx');
        expect(res.status).toBe(200);
        expect(res.body.files.every((f: any) => f.file_type === 'pptx')).toBe(true);
    });

    it('GET /api/files/stats/summary returns statistics', async () => {
        const res = await request(app).get('/api/files/stats/summary');
        expect(res.status).toBe(200);
        expect(res.body.total_files).toBeGreaterThanOrEqual(1);
        expect(res.body.by_type).toBeDefined();
    });

    it('GET /api/files/:id returns file metadata', async () => {
        const res = await request(app).get('/api/files/f1');
        expect(res.status).toBe(200);
        expect(res.body.filename).toBe('report.pptx');
    });

    it('GET /api/files/:id returns 404 for missing file', async () => {
        const res = await request(app).get('/api/files/nonexistent');
        expect(res.status).toBe(404);
    });

    it('POST /api/files/register creates file entry', async () => {
        const res = await request(app)
            .post('/api/files/register')
            .send({ filename: 'new.docx', file_type: 'docx', file_path: 'new.docx' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.file.filename).toBe('new.docx');
    });

    it('POST /api/files/register rejects missing fields', async () => {
        const res = await request(app)
            .post('/api/files/register')
            .send({ filename: 'missing.txt' });
        expect(res.status).toBe(400);
    });
});
