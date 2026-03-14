import { db } from '../database';
import { embeddingManager } from './EmbeddingManager';

/**
 * Vector Memory 2.0 — Semantic search with optional sqlite-vss HNSW (Phase 7)
 * Updated: Phase 16 — Uses EmbeddingManager provider chain instead of direct Ollama
 *
 * Architecture:
 * 1. EmbeddingManager provides embeddings (Ollama → OpenAI → Cohere → TF-IDF)
 * 2. Try sqlite-vss for hardware-accelerated HNSW index (O(log n) search)
 * 3. Fallback to in-memory brute-force cosine similarity (works everywhere)
 *
 * Dimension handling: embeddings from different providers may have different
 * dimensions. We store the dimension alongside each embedding and only compare
 * vectors of the same dimension during search.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface VectorSearchResult {
    id: string;
    text: string;
    event_type: string;
    similarity: number;
    timestamp: string;
    context?: Record<string, any>;
}

interface VSSStatus {
    available: boolean;
    reason?: string;
}

// ============================================================================
// VECTOR MEMORY
// ============================================================================

export class VectorMemory {
    private available: boolean | null = null;
    private vssStatus: VSSStatus | null = null;

    /**
     * Check if any embedding provider is available
     */
    async isAvailable(): Promise<boolean> {
        if (this.available !== null) return this.available;
        this.available = await embeddingManager.isAvailable();
        if (this.available) {
            const name = embeddingManager.getActiveProviderName();
            const dims = embeddingManager.getActiveDimensions();
            console.log(`[VectorMemory] Embeddings available via ${name} (${dims}d)`);
        } else {
            console.warn('[VectorMemory] No embedding provider available');
        }
        return this.available;
    }

    /**
     * Phase 7A: Try to initialize sqlite-vss HNSW index
     */
    async initializeVSS(): Promise<VSSStatus> {
        if (this.vssStatus !== null) return this.vssStatus;

        try {
            // @ts-ignore — optional native module
            const sqliteVss = await import('sqlite-vss');

            const dims = embeddingManager.getActiveDimensions() || 768;
            await db.run(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vss_memory USING vss0(
                    embedding(${dims})
                )
            `);

            this.vssStatus = { available: true };
            console.log('[VectorMemory] sqlite-vss HNSW index initialized');
        } catch (e: any) {
            this.vssStatus = {
                available: false,
                reason: e.message || 'sqlite-vss not available'
            };
            console.log(`[VectorMemory] sqlite-vss not available (${this.vssStatus.reason}), using brute-force fallback`);
        }

        return this.vssStatus;
    }

    /**
     * Ensure the embedding_dim column exists on episodic_memory
     */
    async ensureDimensionColumn(): Promise<void> {
        try {
            await db.run(`ALTER TABLE episodic_memory ADD COLUMN embedding_dim INTEGER DEFAULT 0`);
        } catch {
            // Column already exists — ignore
        }
    }

    /**
     * Generate embedding for a text string via EmbeddingManager
     */
    async embed(text: string): Promise<Float32Array | null> {
        return embeddingManager.embed(text);
    }

    /**
     * Generate embeddings for multiple texts (batched) via EmbeddingManager
     */
    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        return embeddingManager.embedBatch(texts);
    }

    /**
     * Store an event with its embedding
     */
    async storeWithEmbedding(
        id: string,
        userId: string,
        text: string,
        eventType: string,
        context?: Record<string, any>
    ): Promise<void> {
        const embedding = await this.embed(text);
        const embeddingBlob = embedding ? Buffer.from(embedding.buffer) : null;
        const embeddingDim = embedding ? embedding.length : 0;

        await db.run(
            `INSERT INTO episodic_memory (id, user_id, event_text, event_type, context, timestamp, embedding, embedding_dim)
             VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
            [id, userId, text, eventType, JSON.stringify(context || {}), embeddingBlob, embeddingDim]
        );

        // Phase 7A: Also store in VSS index if available
        if (embedding) {
            await this.vssInsert(id, embedding);
        }
    }

    /**
     * Update embedding for an existing event
     */
    async updateEmbedding(id: string, text: string): Promise<void> {
        const embedding = await this.embed(text);
        if (embedding) {
            const blob = Buffer.from(embedding.buffer);
            await db.run(
                'UPDATE episodic_memory SET embedding = ?, embedding_dim = ? WHERE id = ?',
                [blob, embedding.length, id]
            );
            await this.vssInsert(id, embedding);
        }
    }

    /**
     * Phase 7A: Insert into VSS index
     */
    private async vssInsert(id: string, embedding: Float32Array): Promise<void> {
        const status = await this.initializeVSS();
        if (!status.available) return;

        try {
            const json = JSON.stringify(Array.from(embedding));
            await db.run(
                `INSERT OR REPLACE INTO vss_memory (rowid, embedding) VALUES (
                    (SELECT rowid FROM episodic_memory WHERE id = ?), ?)`,
                [id, json]
            );
        } catch (e) {
            // Non-critical — fallback search still works
        }
    }

    /**
     * Semantic search — uses VSS if available, otherwise brute-force cosine
     */
    async semanticSearch(
        query: string,
        userId: string = 'default',
        limit: number = 5
    ): Promise<VectorSearchResult[]> {
        const queryEmbedding = await this.embed(query);
        if (!queryEmbedding) return [];

        // Try VSS-accelerated search first
        const vssResults = await this.vssSearch(queryEmbedding, userId, limit);
        if (vssResults.length > 0) return vssResults;

        // Fallback: brute-force cosine similarity
        return this.bruteForceCosineSearch(queryEmbedding, userId, limit);
    }

    /**
     * Phase 7A: VSS-accelerated search using HNSW index
     */
    private async vssSearch(
        queryEmbedding: Float32Array,
        userId: string,
        limit: number
    ): Promise<VectorSearchResult[]> {
        const status = await this.initializeVSS();
        if (!status.available) return [];

        try {
            const json = JSON.stringify(Array.from(queryEmbedding));
            const rows = await db.all(
                `SELECT em.id, em.event_text, em.event_type, em.context, em.timestamp,
                        vss.distance
                 FROM vss_memory AS vss
                 JOIN episodic_memory AS em ON em.rowid = vss.rowid
                 WHERE vss_search(vss.embedding, ?)
                   AND em.user_id = ?
                 LIMIT ?`,
                [json, userId, limit]
            );

            return rows.map((row: any) => ({
                id: row.id,
                text: row.event_text,
                event_type: row.event_type,
                similarity: 1 - (row.distance || 0),
                timestamp: row.timestamp,
                context: JSON.parse(row.context || '{}')
            }));
        } catch {
            return []; // Fall through to brute force
        }
    }

    /**
     * Phase 7B: Brute-force cosine similarity fallback (works on all platforms)
     * Phase 16: Only compares embeddings with matching dimensions
     */
    private async bruteForceCosineSearch(
        queryEmbedding: Float32Array,
        userId: string,
        limit: number
    ): Promise<VectorSearchResult[]> {
        const queryDim = queryEmbedding.length;

        const rows = await db.all(
            `SELECT id, event_text, event_type, context, timestamp, embedding, embedding_dim
             FROM episodic_memory
             WHERE user_id = ? AND embedding IS NOT NULL
             ORDER BY timestamp DESC
             LIMIT 500`,
            [userId]
        );

        const results: VectorSearchResult[] = [];
        for (const row of rows) {
            if (!row.embedding) continue;
            const stored = new Float32Array(new Uint8Array(row.embedding).buffer);

            // Dimension mismatch handling: skip if different dimensions
            // (embedding_dim column may not exist in older DBs, infer from blob size)
            const storedDim = row.embedding_dim || stored.length;
            if (storedDim !== queryDim) continue;

            const similarity = cosineSimilarity(queryEmbedding, stored);

            results.push({
                id: row.id,
                text: row.event_text,
                event_type: row.event_type,
                similarity,
                timestamp: row.timestamp,
                context: JSON.parse(row.context || '{}')
            });
        }

        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
    }

    /**
     * Hybrid search — combines vector similarity (70%) with keyword matching (30%)
     */
    async hybridSearch(
        query: string,
        userId: string = 'default',
        limit: number = 5
    ): Promise<VectorSearchResult[]> {
        const vectorResults = await this.semanticSearch(query, userId, limit * 2);

        // Keyword scoring
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const keywordRows = await db.all(
            `SELECT id, event_text, event_type, context, timestamp
             FROM episodic_memory WHERE user_id = ?
             ORDER BY timestamp DESC LIMIT 200`,
            [userId]
        );

        const keywordScores = new Map<string, number>();
        for (const row of keywordRows) {
            const text = row.event_text.toLowerCase();
            let score = 0;
            for (const kw of keywords) {
                if (text.includes(kw)) score += 1;
            }
            if (score > 0) {
                keywordScores.set(row.id, score / keywords.length);
            }
        }

        // Merge: 70% vector + 30% keyword
        const merged = new Map<string, VectorSearchResult & { finalScore: number }>();

        for (const vr of vectorResults) {
            const kwScore = keywordScores.get(vr.id) || 0;
            const finalScore = 0.7 * vr.similarity + 0.3 * kwScore;
            merged.set(vr.id, { ...vr, finalScore, similarity: finalScore });
        }

        for (const row of keywordRows) {
            if (!merged.has(row.id) && keywordScores.has(row.id)) {
                const kwScore = keywordScores.get(row.id)!;
                merged.set(row.id, {
                    id: row.id,
                    text: row.event_text,
                    event_type: row.event_type,
                    similarity: 0.3 * kwScore,
                    timestamp: row.timestamp,
                    context: JSON.parse(row.context || '{}'),
                    finalScore: 0.3 * kwScore
                });
            }
        }

        const results = Array.from(merged.values());
        results.sort((a, b) => b.finalScore - a.finalScore);
        return results.slice(0, limit);
    }

    /**
     * Backfill embeddings for events that don't have them yet
     */
    async backfillEmbeddings(userId: string = 'default', batchSize: number = 20): Promise<number> {
        await this.ensureDimensionColumn();

        const rows = await db.all(
            `SELECT id, event_text FROM episodic_memory
             WHERE user_id = ? AND embedding IS NULL
             ORDER BY timestamp DESC LIMIT ?`,
            [userId, batchSize]
        );

        if (rows.length === 0) return 0;

        const texts = rows.map((r: any) => r.event_text);
        const embeddings = await this.embedBatch(texts);

        let updated = 0;
        for (let i = 0; i < rows.length; i++) {
            if (embeddings[i]) {
                const blob = Buffer.from(embeddings[i]!.buffer);
                await db.run(
                    'UPDATE episodic_memory SET embedding = ?, embedding_dim = ? WHERE id = ?',
                    [blob, embeddings[i]!.length, rows[i].id]
                );
                await this.vssInsert(rows[i].id, embeddings[i]!);
                updated++;
            }
        }

        console.log(`[VectorMemory] Backfilled ${updated}/${rows.length} embeddings`);
        return updated;
    }

    /**
     * Get search engine status (for diagnostics dashboard)
     */
    async getStatus(): Promise<{
        embeddings: boolean;
        vss: VSSStatus;
        provider: string;
        dimensions: number;
    }> {
        const embeddings = await this.isAvailable();
        const vss = await this.initializeVSS();
        return {
            embeddings,
            vss,
            provider: embeddingManager.getActiveProviderName(),
            dimensions: embeddingManager.getActiveDimensions(),
        };
    }
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
}

// Singleton
export const vectorMemory = new VectorMemory();
