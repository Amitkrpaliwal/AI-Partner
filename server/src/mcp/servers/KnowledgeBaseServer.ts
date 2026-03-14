/**
 * KnowledgeBaseServer — MCP tool for persistent factual knowledge storage.
 * Agents can upsert, search, and delete knowledge entries across executions.
 * Backed by SQLite — no external service required.
 */

import { db } from '../../database';
import { randomUUID } from 'crypto';

class KnowledgeBaseServer {
    isAvailable(): boolean {
        return true; // Always available
    }

    getTools() {
        return [
            {
                name: 'kb_upsert',
                description: 'Store or update a fact in the knowledge base. If an entry with the same key exists, it is overwritten. Use for cross-session factual memory.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        key: { type: 'string', description: 'Unique key for this fact (e.g. "user_preference_language", "api_endpoint_nse")' },
                        value: { type: 'string', description: 'The fact content to store' },
                        category: { type: 'string', description: 'Optional grouping category (e.g. "preferences", "api_keys", "facts")' },
                        ttl_days: { type: 'number', description: 'Optional time-to-live in days. Entry auto-expires after this many days. Omit for permanent storage.' }
                    },
                    required: ['key', 'value']
                }
            },
            {
                name: 'kb_search',
                description: 'Search the knowledge base by key prefix or value substring.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Search term (matched against key and value)' },
                        category: { type: 'string', description: 'Optional: filter by category' },
                        limit: { type: 'number', description: 'Max results (default 10)' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'kb_get',
                description: 'Get a specific knowledge base entry by exact key.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        key: { type: 'string', description: 'The exact key to retrieve' }
                    },
                    required: ['key']
                }
            },
            {
                name: 'kb_delete',
                description: 'Delete a knowledge base entry by key.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        key: { type: 'string', description: 'The key to delete' }
                    },
                    required: ['key']
                }
            }
        ];
    }

    async callTool(toolName: string, args: Record<string, any>): Promise<any> {
        await this.ensureTable();

        if (toolName === 'kb_upsert') {
            const { key, value, category = 'general', ttl_days } = args;
            if (!key || value === undefined) return { error: 'key and value are required' };

            const now = new Date().toISOString();
            const expiresAt = ttl_days
                ? new Date(Date.now() + ttl_days * 86400_000).toISOString()
                : null;

            await db.run(
                `INSERT INTO knowledge_base (id, key, value, category, created_at, updated_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET
                   value      = excluded.value,
                   category   = excluded.category,
                   updated_at = excluded.updated_at,
                   expires_at = excluded.expires_at`,
                [randomUUID(), key, String(value), category, now, now, expiresAt]
            );

            return { stored: true, key, category, expires_at: expiresAt };
        }

        if (toolName === 'kb_search') {
            const { query, category, limit = 10 } = args;
            if (!query) return { error: 'query is required' };

            const now = new Date().toISOString();
            const rows = await db.all(
                `SELECT key, value, category, updated_at FROM knowledge_base
                 WHERE (key LIKE ? OR value LIKE ?)
                   AND (expires_at IS NULL OR expires_at > ?)
                   ${category ? 'AND category = ?' : ''}
                 ORDER BY updated_at DESC LIMIT ?`,
                category
                    ? [`%${query}%`, `%${query}%`, now, category, limit]
                    : [`%${query}%`, `%${query}%`, now, limit]
            );

            return { results: rows, count: rows.length };
        }

        if (toolName === 'kb_get') {
            const { key } = args;
            if (!key) return { error: 'key is required' };

            const now = new Date().toISOString();
            const row = await db.get(
                `SELECT key, value, category, updated_at, expires_at FROM knowledge_base
                 WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`,
                [key, now]
            );

            if (!row) return { found: false, key };
            return { found: true, key: row.key, value: row.value, category: row.category, updated_at: row.updated_at };
        }

        if (toolName === 'kb_delete') {
            const { key } = args;
            if (!key) return { error: 'key is required' };

            const result = await db.run('DELETE FROM knowledge_base WHERE key = ?', [key]);
            const deleted = (result as any)?.changes > 0;
            return { deleted, key };
        }

        return { error: `Unknown tool: ${toolName}` };
    }

    private async ensureTable(): Promise<void> {
        await db.run(`
            CREATE TABLE IF NOT EXISTS knowledge_base (
                id         TEXT PRIMARY KEY,
                key        TEXT NOT NULL UNIQUE,
                value      TEXT NOT NULL,
                category   TEXT DEFAULT 'general',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT
            )
        `);
        // Index for fast search
        await db.run('CREATE INDEX IF NOT EXISTS idx_kb_key ON knowledge_base(key)').catch(() => {});
        await db.run('CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category)').catch(() => {});
    }
}

export const knowledgeBaseServer = new KnowledgeBaseServer();
