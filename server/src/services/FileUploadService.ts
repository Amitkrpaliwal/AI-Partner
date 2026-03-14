/**
 * FileUploadService — Handles user file uploads with text extraction.
 *
 * Supports: images, PDFs, text/code files, documents.
 * - Images: stored as-is, path passed for vision-capable LLMs
 * - PDFs: text extracted via pdf-parse
 * - Text/Code: read directly as UTF-8
 * - Documents: basic text extraction
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { configManager } from './ConfigManager';

// ============================================================================
// TYPES
// ============================================================================

export interface UploadedFile {
    id: string;
    originalName: string;
    storedName: string;
    mimeType: string;
    size: number;
    storedPath: string;          // absolute path on disk
    relativePath: string;        // relative to uploads dir
    extractedText: string | null;
    type: 'image' | 'pdf' | 'code' | 'text' | 'document' | 'audio' | 'video' | 'other';
    conversationId: string;
    uploadedAt: Date;
}

export interface FileUploadResult {
    success: boolean;
    file?: UploadedFile;
    error?: string;
}

// ============================================================================
// MIME TYPE MAPPINGS
// ============================================================================

const IMAGE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/svg+xml', 'image/bmp', 'image/tiff'
]);

const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h',
    '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.sql', '.graphql', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.json', '.xml', '.html', '.css', '.scss', '.sass', '.less',
    '.vue', '.svelte', '.astro', '.mdx', '.r', '.m', '.lua',
    '.dockerfile', '.makefile', '.cmake',
]);

const TEXT_MIMES = new Set([
    'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
    'text/html', 'text/css', 'text/javascript', 'text/xml',
    'application/json', 'application/xml', 'application/javascript',
    'application/x-yaml', 'application/toml',
]);

const AUDIO_MIMES = new Set([
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm',
    'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-m4a',
]);

const VIDEO_MIMES = new Set([
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
]);

// ============================================================================
// FILE UPLOAD SERVICE
// ============================================================================

export class FileUploadService {
    private uploadsBaseDir: string;

    constructor() {
        const appDir = configManager.getAppDataDir();
        this.uploadsBaseDir = path.join(appDir, 'uploads');
        if (!fs.existsSync(this.uploadsBaseDir)) {
            fs.mkdirSync(this.uploadsBaseDir, { recursive: true });
        }
    }

    /**
     * Get the uploads directory for a specific conversation.
     */
    private getConversationDir(conversationId: string): string {
        const dir = path.join(this.uploadsBaseDir, conversationId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    /**
     * Process an uploaded file — store it, extract text if possible.
     */
    async processUpload(
        fileBuffer: Buffer,
        originalName: string,
        mimeType: string,
        conversationId: string
    ): Promise<FileUploadResult> {
        try {
            const id = uuidv4();
            const ext = path.extname(originalName) || this.guessExtension(mimeType);
            const storedName = `${id}${ext}`;
            const convDir = this.getConversationDir(conversationId);
            const storedPath = path.join(convDir, storedName);
            const relativePath = path.join(conversationId, storedName);

            // Write file to disk
            fs.writeFileSync(storedPath, fileBuffer);

            // Determine file type
            const fileType = this.classifyFile(mimeType, originalName);

            // Extract text content when possible
            let extractedText: string | null = null;
            try {
                extractedText = await this.extractText(storedPath, mimeType, originalName, fileType);
            } catch (e) {
                console.warn(`[FileUploadService] Text extraction failed for ${originalName}:`, e);
            }

            const uploadedFile: UploadedFile = {
                id,
                originalName,
                storedName,
                mimeType,
                size: fileBuffer.length,
                storedPath,
                relativePath,
                extractedText,
                type: fileType,
                conversationId,
                uploadedAt: new Date(),
            };

            console.log(`[FileUploadService] Processed: ${originalName} (${fileType}, ${this.formatSize(fileBuffer.length)})`);

            return { success: true, file: uploadedFile };
        } catch (error: any) {
            console.error(`[FileUploadService] Upload failed for ${originalName}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Process a file from a URL (used by messaging providers).
     */
    async processFromUrl(
        url: string,
        originalName: string,
        mimeType: string,
        conversationId: string
    ): Promise<FileUploadResult> {
        try {
            const axios = (await import('axios')).default;
            const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
            const buffer = Buffer.from(response.data);
            return this.processUpload(buffer, originalName, mimeType, conversationId);
        } catch (error: any) {
            console.error(`[FileUploadService] Download from URL failed:`, error.message);
            return { success: false, error: `Failed to download file: ${error.message}` };
        }
    }

    /**
     * Get a previously uploaded file by its ID.
     */
    getFileById(conversationId: string, fileId: string): string | null {
        const convDir = this.getConversationDir(conversationId);
        const files = fs.readdirSync(convDir);
        const match = files.find(f => f.startsWith(fileId));
        if (match) {
            return path.join(convDir, match);
        }
        return null;
    }

    /**
     * List uploaded files for a conversation.
     */
    listFiles(conversationId: string): string[] {
        const convDir = path.join(this.uploadsBaseDir, conversationId);
        if (!fs.existsSync(convDir)) return [];
        return fs.readdirSync(convDir).map(f => path.join(convDir, f));
    }

    /**
     * Delete an uploaded file.
     */
    deleteFile(filePath: string): boolean {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }

    // ==================================================================
    // PRIVATE HELPERS
    // ==================================================================

    /**
     * Classify file type from MIME type and extension.
     */
    private classifyFile(mimeType: string, filename: string): UploadedFile['type'] {
        if (IMAGE_MIMES.has(mimeType)) return 'image';
        if (mimeType === 'application/pdf') return 'pdf';
        if (AUDIO_MIMES.has(mimeType)) return 'audio';
        if (VIDEO_MIMES.has(mimeType)) return 'video';

        const ext = path.extname(filename).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) return 'code';
        if (TEXT_MIMES.has(mimeType) || ext === '.txt' || ext === '.md' || ext === '.csv') return 'text';

        if (mimeType.includes('officedocument') || mimeType.includes('msword') ||
            ext === '.docx' || ext === '.doc' || ext === '.xlsx' || ext === '.xls') {
            return 'document';
        }

        return 'other';
    }

    /**
     * Extract text content from a file.
     */
    private async extractText(
        filePath: string,
        mimeType: string,
        _originalName: string,
        fileType: UploadedFile['type']
    ): Promise<string | null> {
        switch (fileType) {
            case 'text':
            case 'code': {
                const content = fs.readFileSync(filePath, 'utf-8');
                // Truncate very large files to avoid blowing up context
                const MAX_CHARS = 50000;
                if (content.length > MAX_CHARS) {
                    return content.substring(0, MAX_CHARS) + `\n\n... [truncated, ${this.formatSize(content.length)} total]`;
                }
                return content;
            }

            case 'pdf': {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const pdfParse = require('pdf-parse');
                const dataBuffer = fs.readFileSync(filePath);
                const data = await pdfParse(dataBuffer);
                const text = data.text?.trim();
                if (!text) return null;

                const MAX_CHARS = 50000;
                if (text.length > MAX_CHARS) {
                    return text.substring(0, MAX_CHARS) + `\n\n... [truncated, ${data.numpages} pages total]`;
                }
                return text;
            }

            case 'image':
                // Images are handled by passing the file path to vision-capable LLMs
                return `[Image file: ${path.basename(filePath)}]`;

            case 'audio':
                // Audio could be transcribed via SpeechService
                return `[Audio file: ${path.basename(filePath)}]`;

            case 'video':
                return `[Video file: ${path.basename(filePath)}]`;

            case 'document':
                // Basic handling — could be extended with mammoth for docx
                return `[Document: ${path.basename(filePath)} — content extraction requires additional processing]`;

            default:
                return null;
        }
    }

    /**
     * Guess file extension from MIME type.
     */
    private guessExtension(mimeType: string): string {
        const map: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'application/pdf': '.pdf',
            'text/plain': '.txt',
            'text/markdown': '.md',
            'text/csv': '.csv',
            'application/json': '.json',
            'audio/webm': '.webm',
            'audio/mpeg': '.mp3',
            'audio/wav': '.wav',
            'video/mp4': '.mp4',
        };
        return map[mimeType] || '.bin';
    }

    /**
     * Format file size for display.
     */
    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
}

export const fileUploadService = new FileUploadService();
