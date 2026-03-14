/**
 * CalendarTriggerService — Poll Google Calendar and fire AI goals before meetings.
 *
 * How it works:
 *   1. User creates a "calendar trigger" (POST /api/triggers/calendar)
 *   2. Service polls Calendar every N minutes
 *   3. When an event starts within the configured lead time (e.g. 30 min before),
 *      it fires the goal/chat task with event details injected
 *   4. Each event ID is tracked so the trigger fires exactly once per event
 *
 * Template variables: {{title}}, {{start}}, {{end}}, {{location}},
 *                     {{attendees}}, {{description}}, {{event_id}}
 *
 * Requires: GOOGLE_CALENDAR_ACCESS_TOKEN in .env
 */

import crypto from 'crypto';
import { db } from '../database';

export interface CalendarTrigger {
    id: string;
    name: string;
    /** Minutes before event start to fire the trigger (e.g. 30) */
    leadTimeMinutes: number;
    /** Google Calendar ID to monitor (default: primary) */
    calendarId: string;
    taskTemplate: string;
    mode: 'chat' | 'goal';
    userId: string;
    enabled: boolean;
    pollIntervalMinutes: number;
    createdAt: string;
    lastPolledAt?: string;
    triggerCount: number;
}

class CalendarTriggerService {
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private initialized = false;

    async initialize(): Promise<void> {
        if (this.initialized) return;

        await db.run(`
            CREATE TABLE IF NOT EXISTS calendar_triggers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                lead_time_minutes INTEGER NOT NULL DEFAULT 30,
                calendar_id TEXT NOT NULL DEFAULT 'primary',
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
            CREATE TABLE IF NOT EXISTS calendar_trigger_fired (
                trigger_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                fired_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (trigger_id, event_id)
            )
        `);

        this.initialized = true;

        if (!process.env.GOOGLE_CALENDAR_ACCESS_TOKEN) {
            console.log('[CalendarTrigger] Skipping — GOOGLE_CALENDAR_ACCESS_TOKEN not set');
            return;
        }

        const triggers = await this.listTriggers();
        for (const t of triggers) {
            if (t.enabled) this.startPolling(t);
        }

        console.log(`[CalendarTrigger] Initialized with ${triggers.filter(t => t.enabled).length} active triggers`);
    }

    async create(
        name: string,
        taskTemplate: string,
        options: {
            mode?: 'chat' | 'goal';
            userId?: string;
            leadTimeMinutes?: number;
            calendarId?: string;
            pollIntervalMinutes?: number;
        } = {}
    ): Promise<CalendarTrigger> {
        await this.ensureInit();
        const id = `ctrig_${crypto.randomBytes(6).toString('hex')}`;
        const mode = options.mode || 'goal';
        const userId = options.userId || 'default';
        const leadTime = options.leadTimeMinutes ?? 30;
        const calendarId = options.calendarId || 'primary';
        const pollInterval = options.pollIntervalMinutes || 5;

        await db.run(
            `INSERT INTO calendar_triggers (id, name, lead_time_minutes, calendar_id, task_template, mode, user_id, poll_interval_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, name, leadTime, calendarId, taskTemplate, mode, userId, pollInterval]
        );

        const trigger = await this.getTrigger(id);
        if (trigger?.enabled) this.startPolling(trigger);
        console.log(`[CalendarTrigger] Created: ${name} (${id}), ${leadTime}min lead time`);
        return trigger!;
    }

    async listTriggers(): Promise<CalendarTrigger[]> {
        await this.ensureInit();
        const rows = await db.all('SELECT * FROM calendar_triggers ORDER BY created_at DESC');
        return rows.map(this.rowToTrigger);
    }

    async getTrigger(id: string): Promise<CalendarTrigger | null> {
        await this.ensureInit();
        const row = await db.get('SELECT * FROM calendar_triggers WHERE id = ?', [id]);
        return row ? this.rowToTrigger(row) : null;
    }

    async deleteTrigger(id: string): Promise<void> {
        await this.ensureInit();
        this.stopPolling(id);
        await db.run('DELETE FROM calendar_triggers WHERE id = ?', [id]);
        await db.run('DELETE FROM calendar_trigger_fired WHERE trigger_id = ?', [id]);
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        await this.ensureInit();
        await db.run('UPDATE calendar_triggers SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
        const trigger = await this.getTrigger(id);
        if (!trigger) return;
        if (enabled) this.startPolling(trigger);
        else this.stopPolling(id);
    }

    private startPolling(trigger: CalendarTrigger): void {
        this.stopPolling(trigger.id);
        const intervalMs = trigger.pollIntervalMinutes * 60 * 1000;
        this.pollOnce(trigger).catch(e => console.error('[CalendarTrigger] Poll error:', e));
        const timer = setInterval(() => {
            this.pollOnce(trigger).catch(e => console.error('[CalendarTrigger] Poll error:', e));
        }, intervalMs);
        this.timers.set(trigger.id, timer);
    }

    private stopPolling(triggerId: string): void {
        const timer = this.timers.get(triggerId);
        if (timer) { clearInterval(timer); this.timers.delete(triggerId); }
    }

    private async pollOnce(trigger: CalendarTrigger): Promise<void> {
        const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
        if (!token) return;

        try {
            const now = new Date();
            // Fetch events starting in the next (leadTime + pollInterval) minutes
            const windowEnd = new Date(now.getTime() + (trigger.leadTimeMinutes + trigger.pollIntervalMinutes + 5) * 60000);

            const calId = encodeURIComponent(trigger.calendarId);
            const params = new URLSearchParams({
                timeMin: now.toISOString(),
                timeMax: windowEnd.toISOString(),
                singleEvents: 'true',
                orderBy: 'startTime',
                maxResults: '20'
            });

            const res = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );

            if (res.status === 401) {
                console.warn('[CalendarTrigger] Access token expired — polling paused');
                return;
            }
            if (!res.ok) return;

            const data: any = await res.json();
            const events: any[] = data.items || [];

            for (const event of events) {
                if (event.status === 'cancelled') continue;

                const startStr: string = event.start?.dateTime || event.start?.date;
                if (!startStr) continue;

                const eventStart = new Date(startStr);
                const minutesUntilStart = (eventStart.getTime() - now.getTime()) / 60000;

                // Fire if within the lead time window
                if (minutesUntilStart > trigger.leadTimeMinutes) continue;
                if (minutesUntilStart < 0) continue; // Event already started

                // Check if already fired for this event
                const alreadyFired = await db.get(
                    'SELECT 1 FROM calendar_trigger_fired WHERE trigger_id = ? AND event_id = ?',
                    [trigger.id, event.id]
                );
                if (alreadyFired) continue;

                // Mark fired immediately
                await db.run(
                    'INSERT OR IGNORE INTO calendar_trigger_fired (trigger_id, event_id) VALUES (?, ?)',
                    [trigger.id, event.id]
                );

                const attendees = (event.attendees || [])
                    .map((a: any) => a.displayName || a.email)
                    .join(', ');

                const taskMessage = trigger.taskTemplate
                    .replace(/\{\{title\}\}/gi, event.summary || '(Untitled event)')
                    .replace(/\{\{start\}\}/gi, startStr)
                    .replace(/\{\{end\}\}/gi, event.end?.dateTime || event.end?.date || '')
                    .replace(/\{\{location\}\}/gi, event.location || 'No location')
                    .replace(/\{\{attendees\}\}/gi, attendees || 'No attendees')
                    .replace(/\{\{description\}\}/gi, (event.description || '').substring(0, 500))
                    .replace(/\{\{event_id\}\}/gi, event.id)
                    .replace(/\{\{minutes_until_start\}\}/gi, String(Math.round(minutesUntilStart)));

                console.log(`[CalendarTrigger] "${trigger.name}" fired for: ${event.summary} (starts in ${Math.round(minutesUntilStart)}min)`);
                await this.fireTask(trigger, taskMessage);

                await db.run(
                    'UPDATE calendar_triggers SET trigger_count = trigger_count + 1, last_polled_at = datetime("now") WHERE id = ?',
                    [trigger.id]
                );
            }
        } catch (err: any) {
            console.error(`[CalendarTrigger] Poll failed for ${trigger.name}:`, err.message);
        }
    }

    private async fireTask(trigger: CalendarTrigger, taskMessage: string): Promise<void> {
        try {
            if (trigger.mode === 'goal') {
                const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                await goalOrientedExecutor.executeGoal(trigger.userId, taskMessage, {});
            } else {
                const { agentOrchestrator } = await import('./AgentOrchestrator');
                await agentOrchestrator.chat(trigger.userId, taskMessage);
            }
        } catch (err: any) {
            console.error(`[CalendarTrigger] Task execution failed:`, err.message);
        }
    }

    private rowToTrigger(row: any): CalendarTrigger {
        return {
            id: row.id,
            name: row.name,
            leadTimeMinutes: row.lead_time_minutes,
            calendarId: row.calendar_id,
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

export const calendarTriggerService = new CalendarTriggerService();
