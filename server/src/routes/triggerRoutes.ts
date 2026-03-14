/**
 * Trigger Routes — REST API for email and calendar automation triggers.
 *
 * Email triggers:    POST/GET/DELETE /api/triggers/email
 * Calendar triggers: POST/GET/DELETE /api/triggers/calendar
 */

import { Router, Request, Response } from 'express';
import { emailTriggerService } from '../services/EmailTriggerService';
import { calendarTriggerService } from '../services/CalendarTriggerService';

const router = Router();

// ── EMAIL TRIGGERS ──────────────────────────────────────────────────────────

/** List all email triggers */
router.get('/email', async (_req: Request, res: Response) => {
    try {
        const triggers = await emailTriggerService.listTriggers();
        res.json({ triggers });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Create an email trigger.
 * Body: { name, filter, taskTemplate, mode?, pollIntervalMinutes? }
 *
 * Example:
 * {
 *   "name": "Boss email → prep reply",
 *   "filter": "from:boss@company.com is:unread",
 *   "taskTemplate": "New email from {{from}} — Subject: {{subject}}\n\nSnippet: {{snippet}}\n\nDraft a professional reply and save it to /workspace/drafts/reply_{{message_id}}.txt",
 *   "mode": "goal",
 *   "pollIntervalMinutes": 5
 * }
 */
router.post('/email', async (req: Request, res: Response) => {
    const { name, filter, taskTemplate, mode, pollIntervalMinutes } = req.body;
    if (!name || !filter || !taskTemplate) {
        return res.status(400).json({ error: 'name, filter, and taskTemplate are required' });
    }
    try {
        const trigger = await emailTriggerService.create(name, filter, taskTemplate, {
            mode: mode || 'goal',
            userId: (req as any).userId || 'default',
            pollIntervalMinutes
        });
        res.status(201).json({ trigger });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/** Enable/disable an email trigger */
router.patch('/email/:id', async (req: Request, res: Response) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });
    try {
        await emailTriggerService.setEnabled(req.params.id, enabled);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/** Delete an email trigger */
router.delete('/email/:id', async (req: Request, res: Response) => {
    try {
        await emailTriggerService.deleteTrigger(req.params.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ── CALENDAR TRIGGERS ───────────────────────────────────────────────────────

/** List all calendar triggers */
router.get('/calendar', async (_req: Request, res: Response) => {
    try {
        const triggers = await calendarTriggerService.listTriggers();
        res.json({ triggers });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Create a calendar trigger.
 * Body: { name, taskTemplate, leadTimeMinutes?, calendarId?, mode?, pollIntervalMinutes? }
 *
 * Example:
 * {
 *   "name": "Meeting prep",
 *   "taskTemplate": "Meeting in {{minutes_until_start}} minutes: {{title}}\nAttendees: {{attendees}}\n\nCreate a brief prep note in /workspace/meetings/{{event_id}}.md with key talking points and attendee backgrounds.",
 *   "leadTimeMinutes": 30,
 *   "mode": "goal"
 * }
 */
router.post('/calendar', async (req: Request, res: Response) => {
    const { name, taskTemplate, leadTimeMinutes, calendarId, mode, pollIntervalMinutes } = req.body;
    if (!name || !taskTemplate) {
        return res.status(400).json({ error: 'name and taskTemplate are required' });
    }
    try {
        const trigger = await calendarTriggerService.create(name, taskTemplate, {
            mode: mode || 'goal',
            userId: (req as any).userId || 'default',
            leadTimeMinutes,
            calendarId,
            pollIntervalMinutes
        });
        res.status(201).json({ trigger });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/** Enable/disable a calendar trigger */
router.patch('/calendar/:id', async (req: Request, res: Response) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });
    try {
        await calendarTriggerService.setEnabled(req.params.id, enabled);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/** Delete a calendar trigger */
router.delete('/calendar/:id', async (req: Request, res: Response) => {
    try {
        await calendarTriggerService.deleteTrigger(req.params.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
