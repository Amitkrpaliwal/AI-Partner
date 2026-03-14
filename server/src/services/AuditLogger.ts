/**
 * Audit Logger Service
 *
 * Logs security-relevant events to SQLite for traceability:
 * - Tool calls (name, args, result, userId)
 * - Auth events (login, logout, failed login, API key usage)
 * - Security events (blocked commands, SSRF attempts)
 * - Goal executions (start, complete, fail)
 *
 * Query API:
 * - GET /api/audit/logs         — paginated log entries
 * - GET /api/audit/logs/stats   — aggregate counts
 */

import { db } from '../database';

export type AuditCategory = 'tool_call' | 'auth' | 'security' | 'goal' | 'config' | 'system';
export type AuditSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface AuditEntry {
    id?: number;
    timestamp: string;
    category: AuditCategory;
    severity: AuditSeverity;
    action: string;
    userId: string;
    details: string; // JSON-encoded
    ip?: string;
}

export interface AuditQuery {
    category?: AuditCategory;
    severity?: AuditSeverity;
    userId?: string;
    action?: string;
    since?: string;   // ISO timestamp
    until?: string;   // ISO timestamp
    limit?: number;
    offset?: number;
}

class AuditLogger {
    private initialized = false;

    async initialize(): Promise<void> {
        if (this.initialized) return;
        // Table created via migration 002_audit_log.sql — no inline DDL needed
        this.initialized = true;
        console.log('[AuditLogger] Initialized');
    }

    /**
     * Log an audit event.
     */
    async log(
        category: AuditCategory,
        action: string,
        details: Record<string, any> = {},
        options: { userId?: string; severity?: AuditSeverity; ip?: string } = {}
    ): Promise<void> {
        await this.ensureInitialized();

        const { userId = 'system', severity = 'info', ip } = options;

        try {
            await db.run(
                `INSERT INTO audit_log (category, severity, action, user_id, details, ip)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [category, severity, action, userId, JSON.stringify(details), ip || null]
            );
        } catch (e) {
            // Don't let audit logging failures break the app
            console.error('[AuditLogger] Failed to log:', e);
        }
    }

    /**
     * Log a tool call.
     */
    async logToolCall(
        serverName: string,
        toolName: string,
        args: Record<string, any>,
        result: { success: boolean; error?: string },
        userId: string = 'system'
    ): Promise<void> {
        // Truncate large args/results to avoid bloating the DB
        const safeArgs = truncateObj(args, 500);
        const safeResult = result.error
            ? { success: false, error: result.error.substring(0, 200) }
            : { success: true };

        await this.log('tool_call', `${serverName}.${toolName}`, {
            server: serverName,
            tool: toolName,
            args: safeArgs,
            result: safeResult,
        }, { userId, severity: result.success ? 'info' : 'warn' });
    }

    /**
     * Log an auth event.
     */
    async logAuth(
        action: 'login' | 'logout' | 'login_failed' | 'register' | 'apikey_created' | 'apikey_used' | 'secret_created' | 'secret_updated' | 'secret_deleted',
        details: Record<string, any> = {},
        options: { userId?: string; ip?: string } = {}
    ): Promise<void> {
        const severity: AuditSeverity = action === 'login_failed' ? 'warn' : 'info';
        await this.log('auth', action, details, { ...options, severity });
    }

    /**
     * Log a security event (blocked action).
     */
    async logSecurity(
        action: string,
        details: Record<string, any> = {},
        options: { userId?: string; ip?: string } = {}
    ): Promise<void> {
        await this.log('security', action, details, { ...options, severity: 'warn' });
    }

    /**
     * Query audit logs.
     */
    async query(params: AuditQuery = {}): Promise<{ entries: AuditEntry[]; total: number }> {
        await this.ensureInitialized();

        const conditions: string[] = [];
        const values: any[] = [];

        if (params.category) {
            conditions.push('category = ?');
            values.push(params.category);
        }
        if (params.severity) {
            conditions.push('severity = ?');
            values.push(params.severity);
        }
        if (params.userId) {
            conditions.push('user_id = ?');
            values.push(params.userId);
        }
        if (params.action) {
            conditions.push('action LIKE ?');
            values.push(`%${params.action}%`);
        }
        if (params.since) {
            conditions.push('timestamp >= ?');
            values.push(params.since);
        }
        if (params.until) {
            conditions.push('timestamp <= ?');
            values.push(params.until);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = params.limit || 50;
        const offset = params.offset || 0;

        const countRow = await db.get(`SELECT COUNT(*) as total FROM audit_log ${where}`, values);
        const total = countRow?.total || 0;

        const entries = await db.all(
            `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
            [...values, limit, offset]
        );

        return {
            entries: entries.map((row: any) => ({
                id: row.id,
                timestamp: row.timestamp,
                category: row.category,
                severity: row.severity,
                action: row.action,
                userId: row.user_id,
                details: row.details,
                ip: row.ip,
            })),
            total,
        };
    }

    /**
     * Get aggregate stats.
     */
    async getStats(since?: string): Promise<Record<string, any>> {
        await this.ensureInitialized();

        const timeFilter = since ? `WHERE timestamp >= ?` : '';
        const timeValues = since ? [since] : [];

        const byCategory = await db.all(
            `SELECT category, COUNT(*) as count FROM audit_log ${timeFilter} GROUP BY category`,
            timeValues
        );

        const bySeverity = await db.all(
            `SELECT severity, COUNT(*) as count FROM audit_log ${timeFilter} GROUP BY severity`,
            timeValues
        );

        const totalRow = await db.get(
            `SELECT COUNT(*) as total FROM audit_log ${timeFilter}`,
            timeValues
        );

        return {
            total: totalRow?.total || 0,
            byCategory: Object.fromEntries((byCategory || []).map((r: any) => [r.category, r.count])),
            bySeverity: Object.fromEntries((bySeverity || []).map((r: any) => [r.severity, r.count])),
        };
    }

    /**
     * Prune old logs (keep last N days).
     */
    async prune(keepDays: number = 90): Promise<number> {
        await this.ensureInitialized();

        const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
        const result = await db.run(`DELETE FROM audit_log WHERE timestamp < ?`, [cutoff]);
        const deleted = (result as any)?.changes || 0;

        if (deleted > 0) {
            console.log(`[AuditLogger] Pruned ${deleted} entries older than ${keepDays} days`);
        }
        return deleted;
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.initialize();
        }
    }
}

/**
 * Truncate object values to a max string length (for safe DB storage).
 */
function truncateObj(obj: any, maxLen: number): any {
    if (typeof obj === 'string') return obj.substring(0, maxLen);
    if (typeof obj !== 'object' || obj === null) return obj;
    const result: any = Array.isArray(obj) ? [] : {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            result[key] = value.substring(0, maxLen);
        } else if (typeof value === 'object' && value !== null) {
            result[key] = '[object]';
        } else {
            result[key] = value;
        }
    }
    return result;
}

export const auditLogger = new AuditLogger();
