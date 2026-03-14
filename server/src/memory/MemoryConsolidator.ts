import { db } from '../database';
import { v4 as uuidv4 } from 'uuid';
import { modelManager } from '../services/llm/modelManager';

/**
 * MemoryConsolidator — Compresses episodic memory into summaries (Phase 17)
 *
 * Daily consolidation: Groups today's events by topic, creates summaries.
 * Weekly consolidation: Summarizes daily summaries into weekly insights.
 * Archive: Moves old raw events to archive table (retains summaries).
 *
 * Tables:
 * - memory_summaries (id, user_id, summary_type, period_start, period_end, content, topics, created_at)
 * - user_preferences (id, user_id, key, value, confidence, source, updated_at)
 * - episodic_memory_archive (same schema as episodic_memory)
 */

export interface MemorySummary {
    id: string;
    user_id: string;
    summary_type: 'daily' | 'weekly';
    period_start: string;
    period_end: string;
    content: string;
    topics: string[];
    event_count: number;
    created_at: string;
}

export interface UserPreference {
    id: string;
    user_id: string;
    key: string;
    value: string;
    confidence: number;
    source: string;
    updated_at: string;
}

export class MemoryConsolidator {
    private initialized = false;

    async initialize(): Promise<void> {
        if (this.initialized) return;

        await db.run(`
            CREATE TABLE IF NOT EXISTS memory_summaries (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                summary_type TEXT NOT NULL,
                period_start TEXT NOT NULL,
                period_end TEXT NOT NULL,
                content TEXT NOT NULL,
                topics TEXT DEFAULT '[]',
                event_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_user_period ON memory_summaries(user_id, summary_type, period_start)`);

        await db.run(`
            CREATE TABLE IF NOT EXISTS user_preferences (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                confidence REAL DEFAULT 0.5,
                source TEXT DEFAULT '',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, key)
            )
        `);

        // Archive table mirrors episodic_memory structure
        await db.run(`
            CREATE TABLE IF NOT EXISTS episodic_memory_archive (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                event_text TEXT NOT NULL,
                event_type TEXT NOT NULL,
                context TEXT DEFAULT '{}',
                timestamp TIMESTAMP,
                embedding BLOB,
                embedding_dim INTEGER DEFAULT 0,
                archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        this.initialized = true;
        console.log('[MemoryConsolidator] Initialized');
    }

    /**
     * Daily consolidation — group today's events by topic, create summaries
     */
    async consolidateDaily(userId: string = 'default'): Promise<MemorySummary | null> {
        await this.initialize();

        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

        // Check if already consolidated for today
        const existing = await db.get(
            `SELECT id FROM memory_summaries
             WHERE user_id = ? AND summary_type = 'daily' AND period_start = ?`,
            [userId, startOfDay.toISOString()]
        );
        if (existing) {
            console.log('[MemoryConsolidator] Daily summary already exists for today');
            return null;
        }

        // Fetch today's events
        const events = await db.all(
            `SELECT event_text, event_type, context, timestamp
             FROM episodic_memory
             WHERE user_id = ? AND timestamp >= ? AND timestamp < ?
             ORDER BY timestamp ASC`,
            [userId, startOfDay.toISOString(), endOfDay.toISOString()]
        );

        if (events.length < 3) {
            console.log(`[MemoryConsolidator] Only ${events.length} events today, skipping consolidation`);
            return null;
        }

        // Build event text for summarization
        const eventText = events.map((e: any) =>
            `[${e.event_type}] ${e.event_text}`
        ).join('\n');

        const summary = await this.generateSummary(
            `Summarize the following events from today into a concise daily summary.
Group related events by topic. Highlight key decisions, learnings, and outcomes.
Keep the summary under 300 words.

Events:
${eventText}`,
            eventText
        );

        const topics = await this.extractTopics(eventText);

        const id = uuidv4();
        await db.run(
            `INSERT INTO memory_summaries (id, user_id, summary_type, period_start, period_end, content, topics, event_count)
             VALUES (?, ?, 'daily', ?, ?, ?, ?, ?)`,
            [id, userId, startOfDay.toISOString(), endOfDay.toISOString(), summary, JSON.stringify(topics), events.length]
        );

        console.log(`[MemoryConsolidator] Daily summary created: ${events.length} events → ${summary.length} chars`);

        return {
            id,
            user_id: userId,
            summary_type: 'daily',
            period_start: startOfDay.toISOString(),
            period_end: endOfDay.toISOString(),
            content: summary,
            topics,
            event_count: events.length,
            created_at: new Date().toISOString(),
        };
    }

    /**
     * Weekly consolidation — summarize daily summaries into weekly insights
     */
    async consolidateWeekly(userId: string = 'default'): Promise<MemorySummary | null> {
        await this.initialize();

        const now = new Date();
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Check if already consolidated
        const existing = await db.get(
            `SELECT id FROM memory_summaries
             WHERE user_id = ? AND summary_type = 'weekly' AND period_start = ?`,
            [userId, weekStart.toISOString()]
        );
        if (existing) {
            console.log('[MemoryConsolidator] Weekly summary already exists');
            return null;
        }

        // Fetch this week's daily summaries
        const dailySummaries = await db.all(
            `SELECT content, topics, event_count, period_start
             FROM memory_summaries
             WHERE user_id = ? AND summary_type = 'daily'
               AND period_start >= ? AND period_start < ?
             ORDER BY period_start ASC`,
            [userId, weekStart.toISOString(), weekEnd.toISOString()]
        );

        if (dailySummaries.length < 2) {
            console.log(`[MemoryConsolidator] Only ${dailySummaries.length} daily summaries, skipping weekly`);
            return null;
        }

        const summaryText = dailySummaries.map((d: any, i: number) =>
            `Day ${i + 1} (${new Date(d.period_start).toLocaleDateString()}):\n${d.content}`
        ).join('\n\n');

        const totalEvents = dailySummaries.reduce((sum: number, d: any) => sum + d.event_count, 0);

        const weeklySummary = await this.generateSummary(
            `Create a weekly summary from these daily summaries.
Identify recurring themes, key accomplishments, and patterns.
Keep the summary under 200 words.

${summaryText}`,
            summaryText
        );

        // Merge topics from all daily summaries
        const allTopics = new Set<string>();
        for (const d of dailySummaries) {
            const parsed = JSON.parse(d.topics || '[]');
            parsed.forEach((t: string) => allTopics.add(t));
        }

        const id = uuidv4();
        await db.run(
            `INSERT INTO memory_summaries (id, user_id, summary_type, period_start, period_end, content, topics, event_count)
             VALUES (?, ?, 'weekly', ?, ?, ?, ?, ?)`,
            [id, userId, weekStart.toISOString(), weekEnd.toISOString(), weeklySummary, JSON.stringify([...allTopics]), totalEvents]
        );

        console.log(`[MemoryConsolidator] Weekly summary created: ${dailySummaries.length} days, ${totalEvents} total events`);

        return {
            id,
            user_id: userId,
            summary_type: 'weekly',
            period_start: weekStart.toISOString(),
            period_end: weekEnd.toISOString(),
            content: weeklySummary,
            topics: [...allTopics],
            event_count: totalEvents,
            created_at: new Date().toISOString(),
        };
    }

    /**
     * Archive old raw events (older than daysToKeep) into archive table
     */
    async archiveOldEvents(userId: string = 'default', daysToKeep: number = 7): Promise<number> {
        await this.initialize();

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - daysToKeep);

        // Copy to archive
        const result = await db.run(
            `INSERT OR IGNORE INTO episodic_memory_archive (id, user_id, event_text, event_type, context, timestamp, embedding, embedding_dim)
             SELECT id, user_id, event_text, event_type, context, timestamp, embedding,
                    COALESCE(embedding_dim, 0) as embedding_dim
             FROM episodic_memory
             WHERE user_id = ? AND timestamp < ?`,
            [userId, cutoff.toISOString()]
        );

        // Delete from main table
        const deleteResult = await db.run(
            `DELETE FROM episodic_memory WHERE user_id = ? AND timestamp < ?`,
            [userId, cutoff.toISOString()]
        );

        const archived = (deleteResult as any)?.changes || 0;
        if (archived > 0) {
            console.log(`[MemoryConsolidator] Archived ${archived} events older than ${daysToKeep} days`);
        }
        return archived;
    }

    /**
     * Extract user preferences from a conversation
     */
    async extractPreferences(userId: string, conversationText: string): Promise<UserPreference[]> {
        await this.initialize();

        // Skip extraction when content is code-heavy — LLM will echo code instead of returning JSON
        const codeLineCount = (conversationText.match(/^[ \t]*(?:def |class |import |from |#!|\/\/|const |let |var |function |return |if \(|for \()/mg) || []).length;
        if (/```[\s\S]{20,}```/.test(conversationText) || codeLineCount >= 3) {
            return [];
        }

        const prompt = `Analyze this conversation and extract any user preferences, habits, or patterns.
Return a JSON array of preferences found. Each item should have:
- "key": short identifier (e.g., "preferred_language", "communication_style", "work_hours")
- "value": the preference value (e.g., "Python", "casual", "9am-5pm")
- "confidence": 0.0 to 1.0 (how certain is this preference)

Only extract clear, actionable preferences. Return an empty array if none found.

Conversation:
${conversationText.substring(0, 2000)}

Return ONLY valid JSON array, no markdown or explanation.`;

        try {
            const llm = modelManager.getActiveAdapter();
            const result = await llm.generate(prompt, { temperature: 0.3 });

            // Parse JSON from response — require array of objects, not bare Python-style brackets
            const jsonMatch = result.match(/\[\s*(?:\{[\s\S]*?\}[\s,]*)*\s*\]/);
            if (!jsonMatch) return [];

            const prefs: { key: string; value: string; confidence: number }[] = JSON.parse(jsonMatch[0]);
            const stored: UserPreference[] = [];

            for (const pref of prefs) {
                if (!pref.key || !pref.value) continue;
                const id = uuidv4();
                await db.run(
                    `INSERT INTO user_preferences (id, user_id, key, value, confidence, source, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                     ON CONFLICT(user_id, key) DO UPDATE SET
                        value = excluded.value,
                        confidence = MAX(user_preferences.confidence, excluded.confidence),
                        updated_at = datetime('now')`,
                    [id, userId, pref.key, pref.value, pref.confidence, 'conversation']
                );
                stored.push({
                    id,
                    user_id: userId,
                    key: pref.key,
                    value: pref.value,
                    confidence: pref.confidence,
                    source: 'conversation',
                    updated_at: new Date().toISOString(),
                });
            }

            if (stored.length > 0) {
                console.log(`[MemoryConsolidator] Extracted ${stored.length} preferences`);
            }
            return stored;
        } catch (e) {
            console.warn('[MemoryConsolidator] Preference extraction failed:', e);
            return [];
        }
    }

    /**
     * Get stored preferences for a user
     */
    async getPreferences(userId: string): Promise<UserPreference[]> {
        await this.initialize();
        return db.all(
            `SELECT * FROM user_preferences WHERE user_id = ? ORDER BY confidence DESC`,
            [userId]
        );
    }

    /**
     * Build a preference summary string for injection into system prompts
     */
    async getPreferenceSummary(userId: string): Promise<string> {
        const prefs = await this.getPreferences(userId);
        if (prefs.length === 0) return '';

        const highConfidence = prefs.filter(p => p.confidence >= 0.6);
        if (highConfidence.length === 0) return '';

        return highConfidence
            .map(p => `- ${p.key}: ${p.value}`)
            .join('\n');
    }

    /**
     * List summaries for a user
     */
    async getSummaries(userId: string, type?: 'daily' | 'weekly', limit: number = 20): Promise<MemorySummary[]> {
        await this.initialize();
        let query = `SELECT * FROM memory_summaries WHERE user_id = ?`;
        const params: any[] = [userId];

        if (type) {
            query += ` AND summary_type = ?`;
            params.push(type);
        }

        query += ` ORDER BY period_start DESC LIMIT ?`;
        params.push(limit);

        const rows = await db.all(query, params);
        return rows.map((r: any) => ({
            ...r,
            topics: JSON.parse(r.topics || '[]'),
        }));
    }

    /**
     * Get archive stats
     */
    async getArchiveStats(userId: string): Promise<{ archived: number; active: number; summaries: number }> {
        await this.initialize();
        const archived = await db.get(
            `SELECT COUNT(*) as count FROM episodic_memory_archive WHERE user_id = ?`, [userId]
        );
        const active = await db.get(
            `SELECT COUNT(*) as count FROM episodic_memory WHERE user_id = ?`, [userId]
        );
        const summaries = await db.get(
            `SELECT COUNT(*) as count FROM memory_summaries WHERE user_id = ?`, [userId]
        );
        return {
            archived: archived?.count || 0,
            active: active?.count || 0,
            summaries: summaries?.count || 0,
        };
    }

    // --- Private Helpers ---

    private async generateSummary(prompt: string, fallbackText: string): Promise<string> {
        try {
            const llm = modelManager.getActiveAdapter();
            return await llm.generate(prompt, { temperature: 0.3 });
        } catch (e) {
            console.warn('[MemoryConsolidator] LLM summary failed, using truncated fallback');
            return fallbackText.substring(0, 500) + '...';
        }
    }

    private async extractTopics(text: string): Promise<string[]> {
        try {
            const llm = modelManager.getActiveAdapter();
            const result = await llm.generate(
                `Extract 3-5 topic keywords from this text. Return ONLY a JSON array of strings, no explanation.

Text: ${text.substring(0, 1000)}`,
                { temperature: 0.2 }
            );
            const match = result.match(/\[[\s\S]*?\]/);
            if (match) return JSON.parse(match[0]);
        } catch { /* fallback below */ }

        // Simple fallback: extract frequent words
        const words = text.toLowerCase().split(/\s+/);
        const freq = new Map<string, number>();
        const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
        for (const w of words) {
            if (w.length > 3 && !stopWords.has(w)) {
                freq.set(w, (freq.get(w) || 0) + 1);
            }
        }
        return [...freq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([word]) => word);
    }
}

// Singleton
export const memoryConsolidator = new MemoryConsolidator();
