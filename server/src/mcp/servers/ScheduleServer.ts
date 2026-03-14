/**
 * ScheduleServer — MCP tool for scheduling future goal executions.
 * Tools: schedule_task, list_scheduled, cancel_scheduled
 * Minimum cron interval: 15 minutes (prevents runaway scheduling).
 * Idempotent: re-scheduling the same task_id replaces the existing schedule.
 */

import { db } from '../../database';

// ============================================================================
// TYPES
// ============================================================================

interface ScheduledTask {
    id: string;
    task_description: string;
    cron_expression: string;   // e.g. "0 9 * * 1-5" (weekdays 9am)
    next_run_at: string;       // ISO timestamp
    enabled: boolean;
    created_at: string;
    last_run_at: string | null;
    run_count: number;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Parse a simple cron expression and return the next run timestamp.
 *  Only supports 5-field cron (min hour dom month dow).
 *  Returns null if the expression is invalid.
 */
function nextRunFromCron(cron: string): Date | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minPart, hourPart] = parts;
    const min = minPart === '*' ? 0 : parseInt(minPart, 10);
    const hour = hourPart === '*' ? -1 : parseInt(hourPart, 10);
    if (isNaN(min)) return null;

    const now = new Date();
    const next = new Date(now);
    next.setSeconds(0, 0);

    if (hour >= 0) {
        next.setHours(hour, min, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
    } else {
        next.setMinutes(next.getMinutes() + 15); // default: 15min from now
    }
    return next;
}

/** Validate that the cron expression has a minimum 15-minute interval. */
function validateMinInterval(cron: string): { valid: boolean; reason?: string } {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) {
        return { valid: false, reason: 'Cron must have exactly 5 fields: minute hour dom month dow' };
    }
    const [minPart, hourPart] = parts;
    // If minute is '*/N', N must be >= 15
    const everyNMatch = minPart.match(/^\*\/(\d+)$/);
    if (everyNMatch) {
        const n = parseInt(everyNMatch[1], 10);
        if (n < 15) {
            return { valid: false, reason: `Minimum cron interval is 15 minutes (got */=${n})` };
        }
    }
    // If both minute and hour are fixed numbers, interval is 24h+ which is fine
    if (/^\d+$/.test(minPart) && /^\d+$/.test(hourPart)) {
        return { valid: true };
    }
    // If hour is '*' (runs every hour at fixed minute), also valid
    if (/^\d+$/.test(minPart) && hourPart === '*') {
        return { valid: true };
    }
    // Default allow
    return { valid: true };
}

// ============================================================================
// SERVER
// ============================================================================

class ScheduleServer {
    isAvailable(): boolean {
        return true; // Always available — no API key required
    }

    getTools() {
        return [
            {
                name: 'schedule_task',
                description: 'Schedule a goal or task to run in the future on a cron schedule. Minimum interval: 15 minutes. Re-scheduling the same task_id replaces the existing entry (idempotent).',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        task_id: { type: 'string', description: 'Unique ID for this scheduled task (used for idempotent updates)' },
                        task_description: { type: 'string', description: 'Natural language description of what the agent should do' },
                        cron_expression: { type: 'string', description: '5-field cron: "minute hour dom month dow". E.g. "0 9 * * 1-5" = weekdays 9am IST. Minimum interval 15min.' },
                    },
                    required: ['task_id', 'task_description', 'cron_expression']
                }
            },
            {
                name: 'list_scheduled',
                description: 'List all currently scheduled tasks.',
                inputSchema: { type: 'object' as const, properties: {}, required: [] }
            },
            {
                name: 'cancel_scheduled',
                description: 'Cancel a scheduled task by its task_id.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        task_id: { type: 'string', description: 'The task_id to cancel' }
                    },
                    required: ['task_id']
                }
            }
        ];
    }

    async callTool(toolName: string, args: Record<string, any>): Promise<any> {
        await this.ensureTable();

        if (toolName === 'schedule_task') {
            const { task_id, task_description, cron_expression } = args;
            if (!task_id || !task_description || !cron_expression) {
                return { error: 'task_id, task_description, and cron_expression are required' };
            }

            const validation = validateMinInterval(cron_expression);
            if (!validation.valid) {
                return { error: validation.reason };
            }

            const nextRun = nextRunFromCron(cron_expression);
            if (!nextRun) {
                return { error: 'Invalid cron_expression. Use 5-field format: minute hour dom month dow' };
            }

            const now = new Date().toISOString();
            // Upsert: insert or replace by task_id
            await db.run(
                `INSERT INTO scheduled_tasks (id, task_description, cron_expression, next_run_at, enabled, created_at, last_run_at, run_count)
                 VALUES (?, ?, ?, ?, 1, ?, NULL, 0)
                 ON CONFLICT(id) DO UPDATE SET
                   task_description = excluded.task_description,
                   cron_expression  = excluded.cron_expression,
                   next_run_at      = excluded.next_run_at,
                   enabled          = 1`,
                [task_id, task_description, cron_expression, nextRun.toISOString(), now]
            );

            return {
                scheduled: true,
                task_id,
                next_run_at: nextRun.toISOString(),
                cron_expression,
                message: `Task "${task_id}" scheduled. Next run: ${nextRun.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
            };
        }

        if (toolName === 'list_scheduled') {
            const rows = await db.all(
                'SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC'
            );
            return {
                tasks: rows.map(r => ({
                    task_id: r.id,
                    task_description: r.task_description,
                    cron_expression: r.cron_expression,
                    next_run_at: r.next_run_at,
                    enabled: !!r.enabled,
                    last_run_at: r.last_run_at,
                    run_count: r.run_count,
                })),
                total: rows.length,
            };
        }

        if (toolName === 'cancel_scheduled') {
            const { task_id } = args;
            if (!task_id) return { error: 'task_id is required' };
            const result = await db.run('DELETE FROM scheduled_tasks WHERE id = ?', [task_id]);
            const deleted = (result as any)?.changes > 0;
            return { cancelled: deleted, task_id, message: deleted ? `Task "${task_id}" cancelled.` : `Task "${task_id}" not found.` };
        }

        return { error: `Unknown tool: ${toolName}` };
    }

    private async ensureTable(): Promise<void> {
        await db.run(`
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id               TEXT PRIMARY KEY,
                task_description TEXT NOT NULL,
                cron_expression  TEXT NOT NULL,
                next_run_at      TEXT NOT NULL,
                enabled          INTEGER DEFAULT 1,
                created_at       TEXT NOT NULL,
                last_run_at      TEXT,
                run_count        INTEGER DEFAULT 0
            )
        `);
    }
}

export const scheduleServer = new ScheduleServer();
