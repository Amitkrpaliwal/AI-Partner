import { db } from '../database';
import { PersonaService, Persona } from './PersonaService';
import { EpisodicMemory, EpisodicEvent } from './EpisodicMemory';
import { vectorMemory, VectorSearchResult } from './VectorMemory';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

export interface BiographicFact {
    id?: string;
    user_id: string;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    source?: string;
}

export class MemoryManager extends EventEmitter {
    private personaService: PersonaService;
    private episodicMemory: EpisodicMemory;
    private vectorEnabled: boolean = false;

    constructor() {
        super();
        this.personaService = new PersonaService();
        this.episodicMemory = new EpisodicMemory();
    }

    /**
     * Called from index.ts after embeddingManager.initialize().
     * Explicitly sets vectorEnabled so there is no race condition on first use.
     */
    async initializeVector(): Promise<void> {
        const available = await vectorMemory.isAvailable();
        this.vectorEnabled = available;
        if (available) {
            console.log('[MemoryManager] Vector memory enabled');
            vectorMemory.backfillEmbeddings().catch(console.error);
        } else {
            console.warn('[MemoryManager] Vector memory unavailable — falling back to keyword search');
        }
    }

    // --- Persona Delegation ---
    async getPersona(userId: string = 'default'): Promise<Persona> {
        return this.personaService.getPersona(userId);
    }

    async updatePersona(userId: string = 'default', updates: Partial<Persona>): Promise<void> {
        return this.personaService.updatePersona(userId, updates);
    }

    // --- Episodic Memory Delegation ---
    async storeEvent(event: Omit<EpisodicEvent, 'user_id'> & { user_id?: string }): Promise<string> {
        const userId = event.user_id || 'default';
        const id = await this.episodicMemory.storeEvent({
            ...event,
            user_id: userId,
        });

        // Generate embedding async (non-blocking)
        if (this.vectorEnabled) {
            vectorMemory.updateEmbedding(id, event.event_text).catch(e =>
                console.warn('[MemoryManager] Failed to embed event:', e)
            );
        }

        // Notify listeners so Socket.IO can push to frontend in real-time
        this.emit('event:stored', {
            id,
            type: event.event_type,
            text: event.event_text,
            timestamp: new Date().toISOString(),
        });

        return id;
    }

    async getRecentEvents(limit: number = 10, userId: string = 'default'): Promise<EpisodicEvent[]> {
        return this.episodicMemory.getRecentEvents(userId, limit);
    }

    // --- Vector/Semantic Search ---
    async semanticSearch(query: string, userId: string = 'default', limit: number = 5): Promise<VectorSearchResult[]> {
        if (!this.vectorEnabled) return [];
        return vectorMemory.semanticSearch(query, userId, limit);
    }

    async hybridSearch(query: string, userId: string = 'default', limit: number = 5): Promise<VectorSearchResult[]> {
        if (!this.vectorEnabled) {
            // Fallback: keyword-only search
            return this.keywordSearch(query, userId, limit);
        }
        return vectorMemory.hybridSearch(query, userId, limit);
    }

    private async keywordSearch(query: string, userId: string, limit: number): Promise<VectorSearchResult[]> {
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (keywords.length === 0) return [];

        const rows = await db.all(
            `SELECT id, event_text, event_type, context, timestamp
             FROM episodic_memory WHERE user_id = ?
             ORDER BY timestamp DESC LIMIT 200`,
            [userId]
        );

        const results: VectorSearchResult[] = [];
        for (const row of rows) {
            const text = row.event_text.toLowerCase();
            let matches = 0;
            for (const kw of keywords) {
                if (text.includes(kw)) matches++;
            }
            if (matches > 0) {
                results.push({
                    id: row.id,
                    text: row.event_text,
                    event_type: row.event_type,
                    similarity: matches / keywords.length,
                    timestamp: row.timestamp,
                    context: JSON.parse(row.context || '{}')
                });
            }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
    }

    isVectorEnabled(): boolean {
        return this.vectorEnabled;
    }

    // --- Biographic/Semantic Memory ---
    async storeFact(fact: BiographicFact): Promise<string> {
        const id = fact.id || uuidv4();
        await db.run(
            `INSERT INTO biographic_facts (id, user_id, subject, predicate, object, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, fact.user_id, fact.subject, fact.predicate, fact.object, fact.confidence, fact.source]
        );
        return id;
    }

    async queryFacts(userId: string, subject?: string, predicate?: string): Promise<BiographicFact[]> {
        let query = `SELECT * FROM biographic_facts WHERE user_id = ?`;
        const params: any[] = [userId];

        if (subject) {
            query += ` AND subject LIKE ?`;
            params.push(`%${subject}%`);
        }
        if (predicate) {
            query += ` AND predicate = ?`;
            params.push(predicate);
        }

        query += ` ORDER BY confidence DESC`;

        const rows = await db.all(query, params);
        return rows;
    }
}

export const memoryManager = new MemoryManager();
