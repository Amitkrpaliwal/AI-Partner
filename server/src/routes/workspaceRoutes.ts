/**
 * Workspace File Operation Routes
 *
 * Provides direct filesystem operations on the workspace directory.
 * All paths are relative to the configured workspace root and are validated
 * to prevent path traversal attacks.
 *
 * GET    /api/workspace/files?path=subdir     — list directory (recursive depth-limited)
 * GET    /api/workspace/download?path=file    — download file content
 * DELETE /api/workspace/file?path=file        — delete file or empty directory
 * POST   /api/workspace/rename                — rename / move file {from, to}
 * POST   /api/workspace/copy                  — copy file {from, to}
 * POST   /api/workspace/mkdir                 — create directory {path}
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { configManager } from '../services/ConfigManager';

export const workspaceRoutes = Router();

// ─── Multer Config ────────────────────────────────────────────────────────────

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// ─── Path Safety ──────────────────────────────────────────────────────────────

function resolveWorkspacePath(rel: string): string {
    const workspace = configManager.getWorkspaceDir();
    // Normalize and resolve relative path inside workspace
    const resolved = path.resolve(workspace, rel.replace(/^[/\\]+/, ''));
    // Prevent path traversal
    if (!resolved.startsWith(workspace)) {
        throw new Error('Path traversal not allowed');
    }
    return resolved;
}

function getWorkspace(): string {
    return configManager.getWorkspaceDir();
}

// ─── List Directory ───────────────────────────────────────────────────────────

/**
 * GET /api/workspace/files?path=subdir&depth=1
 * Lists files and subdirectories at the given relative path.
 * depth: how many levels to recurse (default 1, max 4)
 */
workspaceRoutes.get('/files', (req: Request, res: Response) => {
    try {
        const rel = (req.query.path as string) || '';
        const depth = Math.min(parseInt((req.query.depth as string) || '1', 10), 4);
        const dirPath = rel ? resolveWorkspacePath(rel) : getWorkspace();

        if (!fs.existsSync(dirPath)) {
            return res.status(404).json({ error: 'Directory not found' });
        }

        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) {
            return res.status(400).json({ error: 'Path is not a directory' });
        }

        const entries = readDirRecursive(dirPath, getWorkspace(), depth);
        res.json({ success: true, path: rel || '/', entries });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

function readDirRecursive(dirPath: string, workspaceRoot: string, depth: number): FileEntry[] {
    const entries: FileEntry[] = [];
    let items: fs.Dirent[];
    try {
        items = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return entries;
    }

    for (const item of items) {
        // Skip hidden files and system dirs
        if (item.name.startsWith('.') && item.name !== '.gitignore') continue;
        if (item.name === 'node_modules' || item.name === '__pycache__') continue;

        const fullPath = path.join(dirPath, item.name);
        const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
        const isDir = item.isDirectory();

        let stat: fs.Stats | null = null;
        try { stat = fs.statSync(fullPath); } catch { continue; }

        const entry: FileEntry = {
            name: item.name,
            path: relPath,
            type: isDir ? 'directory' : 'file',
            size: isDir ? null : stat.size,
            modified: stat.mtime.toISOString(),
        };

        if (isDir && depth > 1) {
            entry.children = readDirRecursive(fullPath, workspaceRoot, depth - 1);
        }

        entries.push(entry);
    }

    // Directories first, then files, both alphabetical
    return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

interface FileEntry {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size: number | null;
    modified: string;
    children?: FileEntry[];
}

// ─── Download File ────────────────────────────────────────────────────────────

/**
 * GET /api/workspace/download?path=subdir/file.txt
 * Streams the file to the browser for download.
 */
workspaceRoutes.get('/download', (req: Request, res: Response) => {
    try {
        const rel = req.query.path as string;
        if (!rel) return res.status(400).json({ error: 'path query param required' });

        const filePath = resolveWorkspacePath(rel);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return res.status(400).json({ error: 'Path is not a file' });
        }

        const filename = path.basename(filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(filePath).pipe(res);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// ─── Read File Content ────────────────────────────────────────────────────────

/**
 * GET /api/workspace/content?path=file.txt
 * Returns file content as text (max 500KB).
 */
workspaceRoutes.get('/content', (req: Request, res: Response) => {
    try {
        const rel = req.query.path as string;
        if (!rel) return res.status(400).json({ error: 'path query param required' });

        const filePath = resolveWorkspacePath(rel);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return res.status(400).json({ error: 'Path is not a file' });
        }
        if (stat.size > 512 * 1024) {
            return res.status(413).json({ error: 'File too large to preview (max 512KB)' });
        }

        const ext = rel.toLowerCase().split('.').pop() || '';
        const binaryFormats = ['pdf', 'xlsx', 'docx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip'];
        if (binaryFormats.includes(ext)) {
            return res.json({ success: true, path: rel, content: null, binary: true, ext, size: stat.size, message: `Binary file (.${ext}) — download to view or ask the agent to read it.` });
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        res.json({ success: true, path: rel, content, size: stat.size });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// ─── Delete File / Directory ──────────────────────────────────────────────────

/**
 * DELETE /api/workspace/file?path=subdir/file.txt
 * Deletes a file. For directories, only deletes if empty (safe).
 * Pass ?recursive=true to delete non-empty directories (use with caution).
 */
workspaceRoutes.delete('/file', (req: Request, res: Response) => {
    try {
        const rel = req.query.path as string;
        if (!rel) return res.status(400).json({ error: 'path query param required' });

        const filePath = resolveWorkspacePath(rel);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            const recursive = req.query.recursive === 'true';
            if (recursive) {
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.rmdirSync(filePath); // Only works if empty
            }
        } else {
            fs.unlinkSync(filePath);
        }

        res.json({ success: true, message: `Deleted: ${rel}` });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// ─── Rename / Move File ───────────────────────────────────────────────────────

/**
 * POST /api/workspace/rename
 * Body: { from: "old/path.txt", to: "new/path.txt" }
 */
workspaceRoutes.post('/rename', (req: Request, res: Response) => {
    try {
        const { from, to } = req.body;
        if (!from || !to) return res.status(400).json({ error: '"from" and "to" are required' });

        const srcPath = resolveWorkspacePath(from);
        const dstPath = resolveWorkspacePath(to);

        if (!fs.existsSync(srcPath)) {
            return res.status(404).json({ error: 'Source file not found' });
        }
        if (fs.existsSync(dstPath)) {
            return res.status(409).json({ error: 'Destination already exists' });
        }

        // Ensure destination parent directory exists
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.renameSync(srcPath, dstPath);

        res.json({ success: true, message: `Moved "${from}" → "${to}"` });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// ─── Copy File ────────────────────────────────────────────────────────────────

/**
 * POST /api/workspace/copy
 * Body: { from: "source.txt", to: "copy.txt" }
 */
workspaceRoutes.post('/copy', (req: Request, res: Response) => {
    try {
        const { from, to } = req.body;
        if (!from || !to) return res.status(400).json({ error: '"from" and "to" are required' });

        const srcPath = resolveWorkspacePath(from);
        const dstPath = resolveWorkspacePath(to);

        if (!fs.existsSync(srcPath)) {
            return res.status(404).json({ error: 'Source file not found' });
        }
        if (fs.existsSync(dstPath)) {
            return res.status(409).json({ error: 'Destination already exists' });
        }

        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);

        res.json({ success: true, message: `Copied "${from}" → "${to}"` });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// ─── Create Directory ─────────────────────────────────────────────────────────

/**
 * POST /api/workspace/mkdir
 * Body: { path: "new/folder" }
 */
workspaceRoutes.post('/mkdir', (req: Request, res: Response) => {
    try {
        const { path: rel } = req.body;
        if (!rel) return res.status(400).json({ error: '"path" is required' });

        const dirPath = resolveWorkspacePath(rel);
        if (fs.existsSync(dirPath)) {
            return res.status(409).json({ error: 'Directory already exists' });
        }

        fs.mkdirSync(dirPath, { recursive: true });
        res.json({ success: true, message: `Created directory: ${rel}` });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// ─── Upload File ──────────────────────────────────────────────────────────────

/**
 * POST /api/workspace/upload
 * multipart/form-data:
 *   - file: (binary)
 *   - path: "subdir/filename.ext" (relative path including filename)
 *   OR
 *   - path: "subdir/" (directory) + file.originalname is used
 */
workspaceRoutes.post('/upload', upload.any(), (req: Request, res: Response) => {
    try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        // 'path' can be a directory (ends with /) or a full filepath (if 1 file)
        // If multiple files, 'path' is treated as the destination directory.
        const destParam = req.body.path || '';
        const isDirTarget = destParam.endsWith('/') || destParam === '' || files.length > 1;

        const uploadedPaths: string[] = [];

        for (const file of files) {
            let relativePath: string;

            if (isDirTarget) {
                // Determine filename: check if client sent 'filepath' (e.g. from recursive folder upload)
                // otherwise use originalname
                // When uploading folders, the client might send "src/components/Sidebar.tsx" as the file path
                // We should respect that structure if provided in a separate field, or encoded in originalname?
                // Standard HTML5 upload just gives name.
                // Our frontend recursive logic will likely post one file at a time or use a naming convention.
                // Let's assume the client sends the full relative path in `req.body.path` if it's a single file upload per request.
                // Or if `req.body.filepath` is provided for that specific file.
                
                // For simplicity v1: The endpoint accepts one file per request ideally for complex paths,
                // or we use the `destParam` as the base folder and `file.originalname` as the name.
                // Let's support `req.body.filepath` if the client sends it (common pattern).
                const specificPath = req.body.filepath || file.originalname;
                relativePath = path.join(destParam, specificPath);
            } else {
                relativePath = destParam;
            }

            const fullPath = resolveWorkspacePath(relativePath);
            
            // Ensure parent directory exists
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            
            // Write file
            fs.writeFileSync(fullPath, file.buffer);
            uploadedPaths.push(relativePath);
        }

        res.json({ success: true, uploaded: uploadedPaths });
    } catch (err: any) {
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

export default workspaceRoutes;
