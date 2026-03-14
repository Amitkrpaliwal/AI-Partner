import { Router } from 'express';
import { db } from '../database';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { configManager } from '../services/ConfigManager';
import { fileUploadService, UploadedFile } from '../services/FileUploadService';

const router = Router();

// ============================================================================
// MULTER CONFIG — 25MB per file, max 10 files
// ============================================================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024, // 25MB per file
        files: 10,                    // max 10 files per request
    },
    fileFilter: (_req, file, cb) => {
        // Block executables
        const blocked = ['.exe', '.bat', '.cmd', '.msi', '.scr', '.pif', '.com'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (blocked.includes(ext)) {
            cb(new Error(`File type ${ext} is not allowed`));
            return;
        }
        cb(null, true);
    },
});

// ============================================================================
// POST /api/files/upload — Upload files to a conversation
// Accepts: multipart/form-data with 'files' field + 'conversationId' field
// Returns: array of processed file results with extracted text
// ============================================================================
router.post('/upload', upload.array('files', 10) as any, async (req: any, res: any) => {
    try {
        const files = req.files as Express.Multer.File[];
        const conversationId = req.body.conversationId || 'default';

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files provided' });
        }

        const results: UploadedFile[] = [];
        const errors: string[] = [];

        for (const file of files) {
            const result = await fileUploadService.processUpload(
                file.buffer,
                file.originalname,
                file.mimetype,
                conversationId
            );

            if (result.success && result.file) {
                results.push(result.file);
            } else {
                errors.push(`${file.originalname}: ${result.error}`);
            }
        }

        res.json({
            success: true,
            uploaded: results.length,
            total: files.length,
            files: results,
            errors: errors.length > 0 ? errors : undefined,
        });
    } catch (error: any) {
        console.error('[FileRoutes] Upload error:', error);
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large (max 25MB)' });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(413).json({ error: 'Too many files (max 10)' });
        }
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// GET /api/files/uploads/:conversationId — List uploaded files for a conversation
// ============================================================================
router.get('/uploads/:conversationId', (req, res) => {
    try {
        const { conversationId } = req.params;
        const files = fileUploadService.listFiles(conversationId);

        res.json({
            conversationId,
            files: files.map(f => ({
                path: f,
                name: path.basename(f),
                size: fs.existsSync(f) ? fs.statSync(f).size : 0,
            })),
        });
    } catch (error: any) {
        console.error('[FileRoutes] Error listing uploads:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// GET /api/files/uploads/:conversationId/:fileId — Serve an uploaded file
// ============================================================================
router.get('/uploads/:conversationId/:fileId', (req, res) => {
    try {
        const { conversationId, fileId } = req.params;
        const filePath = fileUploadService.getFileById(conversationId, fileId);

        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.sendFile(filePath);
    } catch (error: any) {
        console.error('[FileRoutes] Error serving upload:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get output directory
function getOutputDir(): string {
    const workspaceDir = configManager.getWorkspaceDir();
    const outputDir = path.join(workspaceDir, 'output', 'deliverables');

    // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    return outputDir;
}

// MIME type mapping
const MIME_TYPES: Record<string, string> = {
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pdf': 'application/pdf',
    'html': 'text/html',
    'json': 'application/json',
    'txt': 'text/plain',
    'md': 'text/markdown'
};

// ============================================================================
// GET /api/files - List generated files
// ============================================================================
router.get('/', async (req, res) => {
    try {
        const { type, limit = 50, offset = 0 } = req.query;
        const user_id = (req as any).userId || 'default';

        let query = 'SELECT * FROM generated_files WHERE user_id = ?';
        const params: any[] = [user_id];

        if (type) {
            query += ' AND file_type = ?';
            params.push(type);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(Number(limit), Number(offset));

        const files = await db.all(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM generated_files WHERE user_id = ?';
        const countParams: any[] = [user_id];
        if (type) {
            countQuery += ' AND file_type = ?';
            countParams.push(type);
        }
        const countResult = await db.get(countQuery, countParams);

        res.json({
            files,
            total: countResult?.total || 0,
            limit: Number(limit),
            offset: Number(offset)
        });
    } catch (e) {
        console.error('[FileRoutes] Error listing files:', e);
        res.status(500).json({ error: String(e) });
    }
});

// ============================================================================
// GET /api/files/stats/summary - Get file statistics
// NOTE: Must be before /:id to avoid Express matching "stats" as an ID
// ============================================================================
router.get('/stats/summary', async (req, res) => {
    try {
        const user_id = (req as any).userId || 'default';

        const stats = await db.get(`
            SELECT
                COUNT(*) as total_files,
                SUM(file_size) as total_size,
                SUM(download_count) as total_downloads
            FROM generated_files
            WHERE user_id = ?
        `, [user_id]);

        const byType = await db.all(`
            SELECT
                file_type,
                COUNT(*) as count,
                SUM(file_size) as size
            FROM generated_files
            WHERE user_id = ?
            GROUP BY file_type
        `, [user_id]);

        res.json({
            ...stats,
            by_type: byType
        });
    } catch (e) {
        console.error('[FileRoutes] Error getting stats:', e);
        res.status(500).json({ error: String(e) });
    }
});

// ============================================================================
// GET /api/files/:id - Get file metadata
// ============================================================================
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const file = await db.get('SELECT * FROM generated_files WHERE id = ?', [id]);

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.json(file);
    } catch (e) {
        console.error('[FileRoutes] Error getting file:', e);
        res.status(500).json({ error: String(e) });
    }
});

// ============================================================================
// GET /api/files/:id/download - Download file
// ============================================================================
router.get('/:id/download', async (req, res) => {
    try {
        const { id } = req.params;
        const file = await db.get('SELECT * FROM generated_files WHERE id = ?', [id]);

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Build full path
        const outputDir = getOutputDir();
        const fullPath = path.join(outputDir, file.file_path);

        // Check file exists on disk
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({
                error: 'File not found on disk',
                path: file.file_path
            });
        }

        // Update download count
        await db.run(
            'UPDATE generated_files SET download_count = download_count + 1 WHERE id = ?',
            [id]
        );

        // Set headers for download
        const mimeType = file.mime_type || MIME_TYPES[file.file_type] || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);

        // Stream file
        const fileStream = fs.createReadStream(fullPath);
        fileStream.pipe(res);

    } catch (e) {
        console.error('[FileRoutes] Error downloading file:', e);
        res.status(500).json({ error: String(e) });
    }
});

// ============================================================================
// DELETE /api/files/:id - Delete file
// ============================================================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const file = await db.get('SELECT * FROM generated_files WHERE id = ?', [id]);

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Delete from disk
        const outputDir = getOutputDir();
        const fullPath = path.join(outputDir, file.file_path);

        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }

        // Delete from database
        await db.run('DELETE FROM generated_files WHERE id = ?', [id]);

        res.json({ success: true, message: 'File deleted' });
    } catch (e) {
        console.error('[FileRoutes] Error deleting file:', e);
        res.status(500).json({ error: String(e) });
    }
});

// ============================================================================
// POST /api/files/register - Register a generated file (internal use)
// ============================================================================
router.post('/register', async (req, res) => {
    try {
        const {
            filename,
            file_type,
            file_path,
            title,
            description,
            execution_id,
            conversation_id,
            metadata
        } = req.body;
        const user_id = (req as any).userId || 'default';

        if (!filename || !file_type || !file_path) {
            return res.status(400).json({
                error: 'Missing required fields: filename, file_type, file_path'
            });
        }

        const id = uuidv4();
        const outputDir = getOutputDir();
        const fullPath = path.join(outputDir, file_path);

        // Get file size if exists
        let file_size = 0;
        if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            file_size = stats.size;
        }

        const mime_type = MIME_TYPES[file_type] || 'application/octet-stream';

        await db.run(
            `INSERT INTO generated_files
             (id, filename, file_type, file_path, file_size, mime_type, title, description,
              user_id, execution_id, conversation_id, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id, filename, file_type, file_path, file_size, mime_type,
                title || filename, description || '',
                user_id, execution_id || null, conversation_id || null,
                JSON.stringify(metadata || {})
            ]
        );

        const file = await db.get('SELECT * FROM generated_files WHERE id = ?', [id]);
        res.json({ success: true, file });

    } catch (e) {
        console.error('[FileRoutes] Error registering file:', e);
        res.status(500).json({ error: String(e) });
    }
});

export const fileRoutes = router;
