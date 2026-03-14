import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../database';
import { vectorMemory, VectorSearchResult } from './VectorMemory';

/**
 * Knowledge Base - Document ingestion, chunking, embedding, and retrieval (RAG)
 *
 * Supports: .txt, .md, .json, .csv, .html, .ts, .js, .py, .yml, .yaml
 * Pipeline: ingest → chunk → embed → store in SQLite
 * Retrieval: hybrid search (vector + keyword) on chunks
 */

const DEFAULT_CHUNK_SIZE = 500;   // chars per chunk
const DEFAULT_CHUNK_OVERLAP = 50; // overlap between chunks

export interface KnowledgeDocument {
    id: string;
    title: string;
    source: string;         // file path or URL
    content_type: string;   // 'text', 'markdown', 'code', 'json', 'csv'
    chunk_count: number;
    total_chars: number;
    created_at: string;
}

export interface KnowledgeChunk {
    id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    embedding?: Buffer | null;
}

export interface KnowledgeSearchResult {
    chunk_id: string;
    document_id: string;
    document_title: string;
    content: string;
    similarity: number;
    chunk_index: number;
}

export class KnowledgeBase {
    private initialized = false;

    async initialize(): Promise<void> {
        if (this.initialized) return;

        // Create tables if they don't exist
        await db.run(`
            CREATE TABLE IF NOT EXISTS knowledge_documents (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                source TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT 'text',
                chunk_count INTEGER DEFAULT 0,
                total_chars INTEGER DEFAULT 0,
                metadata JSON DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.run(`
            CREATE TABLE IF NOT EXISTS knowledge_chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                embedding BLOB,
                FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
            )
        `);

        await db.run(`CREATE INDEX IF NOT EXISTS idx_kchunks_doc ON knowledge_chunks(document_id)`);

        this.initialized = true;
        console.log('[KnowledgeBase] Initialized');
    }

    /**
     * Ingest a document from raw text content
     */
    async ingestText(
        title: string,
        content: string,
        source: string = 'manual',
        contentType: string = 'text'
    ): Promise<KnowledgeDocument> {
        await this.initialize();

        const docId = randomUUID();
        const chunks = this.chunkText(content, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP);

        // Store document record
        await db.run(
            `INSERT INTO knowledge_documents (id, title, source, content_type, chunk_count, total_chars)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [docId, title, source, contentType, chunks.length, content.length]
        );

        // Store and embed chunks
        const vectorAvailable = await vectorMemory.isAvailable();

        for (let i = 0; i < chunks.length; i++) {
            const chunkId = randomUUID();
            let embeddingBlob: Buffer | null = null;

            if (vectorAvailable) {
                const embedding = await vectorMemory.embed(chunks[i]);
                if (embedding) {
                    embeddingBlob = Buffer.from(embedding.buffer);
                }
            }

            await db.run(
                `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, embedding)
                 VALUES (?, ?, ?, ?, ?)`,
                [chunkId, docId, i, chunks[i], embeddingBlob]
            );
        }

        console.log(`[KnowledgeBase] Ingested "${title}" → ${chunks.length} chunks (${content.length} chars)`);

        return {
            id: docId,
            title,
            source,
            content_type: contentType,
            chunk_count: chunks.length,
            total_chars: content.length,
            created_at: new Date().toISOString()
        };
    }

    /**
     * Ingest a file from the filesystem
     */
    async ingestFile(filePath: string, title?: string): Promise<KnowledgeDocument> {
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${resolvedPath}`);
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const ext = path.extname(filePath).toLowerCase();
        const contentType = this.detectContentType(ext);
        const docTitle = title || path.basename(filePath);

        return this.ingestText(docTitle, content, resolvedPath, contentType);
    }

    /**
     * Search the knowledge base using hybrid search (vector + keyword)
     */
    async search(query: string, limit: number = 5): Promise<KnowledgeSearchResult[]> {
        await this.initialize();

        const vectorAvailable = await vectorMemory.isAvailable();

        if (vectorAvailable) {
            return this.hybridSearch(query, limit);
        }
        return this.keywordSearch(query, limit);
    }

    private async hybridSearch(query: string, limit: number): Promise<KnowledgeSearchResult[]> {
        const queryEmbedding = await vectorMemory.embed(query);
        if (!queryEmbedding) return this.keywordSearch(query, limit);

        // Load chunks with embeddings
        const rows = await db.all(
            `SELECT c.id, c.document_id, c.chunk_index, c.content, c.embedding,
                    d.title as document_title
             FROM knowledge_chunks c
             JOIN knowledge_documents d ON c.document_id = d.id
             WHERE c.embedding IS NOT NULL
             LIMIT 500`
        );

        // Keyword scoring
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        const results: (KnowledgeSearchResult & { finalScore: number })[] = [];

        for (const row of rows) {
            // Vector similarity
            const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
            const vectorScore = this.cosineSimilarity(queryEmbedding, stored);

            // Keyword score
            const textLower = row.content.toLowerCase();
            let kwScore = 0;
            for (const kw of keywords) {
                if (textLower.includes(kw)) kwScore += 1;
            }
            kwScore = keywords.length > 0 ? kwScore / keywords.length : 0;

            const finalScore = 0.7 * vectorScore + 0.3 * kwScore;

            results.push({
                chunk_id: row.id,
                document_id: row.document_id,
                document_title: row.document_title,
                content: row.content,
                similarity: finalScore,
                chunk_index: row.chunk_index,
                finalScore
            });
        }

        results.sort((a, b) => b.finalScore - a.finalScore);
        return results.slice(0, limit);
    }

    private async keywordSearch(query: string, limit: number): Promise<KnowledgeSearchResult[]> {
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (keywords.length === 0) return [];

        // Simple keyword matching
        const rows = await db.all(
            `SELECT c.id, c.document_id, c.chunk_index, c.content,
                    d.title as document_title
             FROM knowledge_chunks c
             JOIN knowledge_documents d ON c.document_id = d.id
             LIMIT 500`
        );

        const results: KnowledgeSearchResult[] = [];
        for (const row of rows) {
            const textLower = row.content.toLowerCase();
            let score = 0;
            for (const kw of keywords) {
                if (textLower.includes(kw)) score += 1;
            }
            if (score > 0) {
                results.push({
                    chunk_id: row.id,
                    document_id: row.document_id,
                    document_title: row.document_title,
                    content: row.content,
                    similarity: score / keywords.length,
                    chunk_index: row.chunk_index
                });
            }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
    }

    /**
     * List all indexed documents
     */
    async listDocuments(): Promise<KnowledgeDocument[]> {
        await this.initialize();
        return db.all(
            `SELECT id, title, source, content_type, chunk_count, total_chars, created_at
             FROM knowledge_documents ORDER BY created_at DESC`
        );
    }

    /**
     * Delete a document and all its chunks
     */
    async deleteDocument(documentId: string): Promise<boolean> {
        await this.initialize();
        await db.run('DELETE FROM knowledge_chunks WHERE document_id = ?', [documentId]);
        const result = await db.run('DELETE FROM knowledge_documents WHERE id = ?', [documentId]);
        return (result as any)?.changes > 0;
    }

    // --- Utility methods ---

    private chunkText(text: string, chunkSize: number, overlap: number): string[] {
        const chunks: string[] = [];
        let start = 0;

        while (start < text.length) {
            let end = start + chunkSize;

            // Try to break at a sentence or paragraph boundary
            if (end < text.length) {
                const slice = text.substring(start, end + 100);
                const breakPoints = ['\n\n', '\n', '. ', '! ', '? ', '; '];
                for (const bp of breakPoints) {
                    const idx = slice.lastIndexOf(bp, chunkSize);
                    if (idx > chunkSize * 0.5) {
                        end = start + idx + bp.length;
                        break;
                    }
                }
            }

            end = Math.min(end, text.length);
            const chunk = text.substring(start, end).trim();
            if (chunk.length > 20) {
                chunks.push(chunk);
            }

            start = end - overlap;
            if (start >= text.length) break;
        }

        return chunks;
    }

    private detectContentType(ext: string): string {
        const map: Record<string, string> = {
            '.md': 'markdown', '.txt': 'text', '.json': 'json',
            '.csv': 'csv', '.html': 'html', '.htm': 'html',
            '.ts': 'code', '.js': 'code', '.py': 'code',
            '.yml': 'yaml', '.yaml': 'yaml', '.xml': 'markup',
            '.sql': 'code', '.sh': 'code', '.bash': 'code',
            '.css': 'code', '.scss': 'code', '.less': 'code'
        };
        return map[ext] || 'text';
    }

    private cosineSimilarity(a: Float32Array, b: Float32Array): number {
        if (a.length !== b.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }
}

export const knowledgeBase = new KnowledgeBase();
