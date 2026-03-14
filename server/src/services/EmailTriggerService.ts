/**
 * EmailTriggerService — Poll Gmail at configurable intervals and trigger AI goals/chat.
 *
 * How it works:
 *   1. User creates an "email trigger" via API (POST /api/triggers/email)
 *   2. Service polls Gmail every N minutes for emails matching the filter criteria
 *   3. When a matching email arrives, it fires the configured goal/chat task
 *   4. Processed message IDs are tracked so each email fires exactly once
 *
 * Requires: GMAIL_ACCESS_TOKEN (and GMAIL_USER) to be set in .env
 *
 * Config stored in SQLite (email_triggers table).
 */

import crypto from 'crypto';
import { db } from '../database';

export interface EmailTrigger {
    id: string;
    name: string;
    /** Gmail search filter, e.g. "from:boss@co.com is:unread" */
    filter: string;
    /** Template for the goal/chat message — {{subject}}, {{from}}, {{body}} are replaced */
    taskTemplate: string;
    mode: 'chat' | 'goal';
    userId: string;
    enabled: boolean;
    pollIntervalMinutes: number;
    createdAt: string;
    lastPolledAt?: string;
    triggerCount: number;
}

class EmailTriggerService {
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private initialized = false;

    async initialize(): Promise<void> {
        if (this.initialized) return;

        await db.run(`
            CREATE TABLE IF NOT EXISTS email_triggers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                filter TEXT NOT NULL,
                task_template TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'goal',
                user_id TEXT NOT NULL DEFAULT 'default',
                enabled INTEGER NOT NULL DEFAULT 1,
                poll_interval_minutes INTEGER NOT NULL DEFAULT 5,
                created_at TEXT DEFAULT (datetime('now')),
                last_polled_at TEXT,
                trigger_count INTEGER DEFAULT 0
            )
        `);

        await db.run(`
            CREATE TABLE IF NOT EXISTS email_trigger_seen (
                trigger_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                seen_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (trigger_id, message_id)
            )
        `);

        this.initialized = true;

        // Only start polling if Gmail is configured
        if (!process.env.GMAIL_ACCESS_TOKEN) {
            console.log('[EmailTrigger] Skipping — GMAIL_ACCESS_TOKEN not set');
            return;
        }

        const triggers = await this.listTriggers();
        for (const trigger of triggers) {
            if (trigger.enabled) this.startPolling(trigger);
        }

        console.log(`[EmailTrigger] Initialized with ${triggers.filter(t => t.enabled).length} active triggers`);
    }

    async create(
        name: string,
        filter: string,
        taskTemplate: string,
        options: { mode?: 'chat' | 'goal'; userId?: string; pollIntervalMinutes?: number } = {}
    ): Promise<EmailTrigger> {
        await this.ensureInit();
        const id = `etrig_${crypto.randomBytes(6).toString('hex')}`;
        const mode = options.mode || 'goal';
        const userId = options.userId || 'default';
        const pollInterval = options.pollIntervalMinutes || 5;

        await db.run(
            `INSERT INTO email_triggers (id, name, filter, task_template, mode, user_id, poll_interval_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, name, filter, taskTemplate, mode, userId, pollInterval]
        );

        const trigger = await this.getTrigger(id);
        if (trigger?.enabled) this.startPolling(trigger);
        console.log(`[EmailTrigger] Created trigger: ${name} (${id})`);
        return trigger!;
    }

    async listTriggers(): Promise<EmailTrigger[]> {
        await this.ensureInit();
        const rows = await db.all('SELECT * FROM email_triggers ORDER BY created_at DESC');
        return rows.map(this.rowToTrigger);
    }

    async getTrigger(id: string): Promise<EmailTrigger | null> {
        await this.ensureInit();
        const row = await db.get('SELECT * FROM email_triggers WHERE id = ?', [id]);
        return row ? this.rowToTrigger(row) : null;
    }

    async deleteTrigger(id: string): Promise<void> {
        await this.ensureInit();
        this.stopPolling(id);
        await db.run('DELETE FROM email_triggers WHERE id = ?', [id]);
        await db.run('DELETE FROM email_trigger_seen WHERE trigger_id = ?', [id]);
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        await this.ensureInit();
        await db.run('UPDATE email_triggers SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
        const trigger = await this.getTrigger(id);
        if (!trigger) return;
        if (enabled) {
            this.startPolling(trigger);
        } else {
            this.stopPolling(id);
        }
    }

    private startPolling(trigger: EmailTrigger): void {
        this.stopPolling(trigger.id);
        const intervalMs = trigger.pollIntervalMinutes * 60 * 1000;
        // Poll immediately, then at interval
        this.pollOnce(trigger).catch(e => console.error(`[EmailTrigger] Poll error:`, e));
        const timer = setInterval(() => {
            this.pollOnce(trigger).catch(e => console.error(`[EmailTrigger] Poll error:`, e));
        }, intervalMs);
        this.timers.set(trigger.id, timer);
    }

    private stopPolling(triggerId: string): void {
        const timer = this.timers.get(triggerId);
        if (timer) { clearInterval(timer); this.timers.delete(triggerId); }
    }

    private async pollOnce(trigger: EmailTrigger): Promise<void> {
        const token = process.env.GMAIL_ACCESS_TOKEN;
        if (!token) return;

        try {
            // Search Gmail for matching messages
            const params = new URLSearchParams({ q: trigger.filter, maxResults: '10' });
            const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.status === 401) {
                console.warn('[EmailTrigger] Access token expired — polling paused');
                return;
            }
            if (!res.ok) return;

            const data: any = await res.json();
            if (!data.messages?.length) return;

            for (const msg of data.messages) {
                // Skip if already processed
                const seen = await db.get(
                    'SELECT 1 FROM email_trigger_seen WHERE trigger_id = ? AND message_id = ?',
                    [trigger.id, msg.id]
                );
                if (seen) continue;

                // Mark as seen immediately to avoid duplicate fires
                await db.run(
                    'INSERT OR IGNORE INTO email_trigger_seen (trigger_id, message_id) VALUES (?, ?)',
                    [trigger.id, msg.id]
                );

                // Fetch full message
                const msgRes = await fetch(
                    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject,From,To,Date`,
                    { headers: { 'Authorization': `Bearer ${token}` } }
                );
                if (!msgRes.ok) continue;
                const msgData: any = await msgRes.json();

                const headers = Object.fromEntries(
                    (msgData.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value])
                );

                // Build task message from template
                const taskMessage = trigger.taskTemplate
                    .replace(/\{\{subject\}\}/gi, headers.subject || '(no subject)')
                    .replace(/\{\{from\}\}/gi, headers.from || '')
                    .replace(/\{\{to\}\}/gi, headers.to || '')
                    .replace(/\{\{date\}\}/gi, headers.date || '')
                    .replace(/\{\{snippet\}\}/gi, msgData.snippet || '')
                    .replace(/\{\{message_id\}\}/gi, msg.id);

                console.log(`[EmailTrigger] "${trigger.name}" fired for email: ${headers.subject}`);
                await this.fireTask(trigger, taskMessage);

                await db.run(
                    'UPDATE email_triggers SET trigger_count = trigger_count + 1, last_polled_at = datetime("now") WHERE id = ?',
                    [trigger.id]
                );
            }
        } catch (err: any) {
            console.error(`[EmailTrigger] Poll failed for ${trigger.name}:`, err.message);
        }
    }

    private async fireTask(trigger: EmailTrigger, taskMessage: string): Promise<void> {
        try {
            if (trigger.mode === 'goal') {
                const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                await goalOrientedExecutor.executeGoal(trigger.userId, taskMessage, {});
            } else {
                const { agentOrchestrator } = await import('./AgentOrchestrator');
                await agentOrchestrator.chat(trigger.userId, taskMessage);
            }
        } catch (err: any) {
            console.error(`[EmailTrigger] Task execution failed:`, err.message);
        }
    }

    private rowToTrigger(row: any): EmailTrigger {
        return {
            id: row.id,
            name: row.name,
            filter: row.filter,
            taskTemplate: row.task_template,
            mode: row.mode,
            userId: row.user_id,
            enabled: row.enabled === 1,
            pollIntervalMinutes: row.poll_interval_minutes,
            createdAt: row.created_at,
            lastPolledAt: row.last_polled_at,
            triggerCount: row.trigger_count
        };
    }

    private async ensureInit(): Promise<void> {
        if (!this.initialized) await this.initialize();
    }
}

export const emailTriggerService = new EmailTriggerService();
