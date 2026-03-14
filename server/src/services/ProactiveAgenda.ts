/**
 * ProactiveAgenda — Decides what the agent should do autonomously on each heartbeat tick.
 *
 * Sits between HeartbeatService and GoalOrientedExecutor:
 *   HeartbeatService (tick) → ProactiveAgenda.evaluate() → ProactiveAction | null
 *                           → GoalOrientedExecutor.executeGoal(action.goal)
 *
 * Decision process:
 *   1. Check quiet hours (from SOUL.md)
 *   2. Check minimum gap since last proactive action
 *   3. Build candidate list from HEARTBEAT.md tasks + memory interests
 *   4. Ask LLM to choose ONE genuinely useful action
 *   5. Return structured action or null (nothing to do)
 */

import { memoryManager } from '../memory/MemoryManager';
import { modelManager } from './llm/modelManager';
import { modelRouter } from './llm/modelRouter';
import { HeartbeatCheckItem } from '../config/MarkdownConfigLoader';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProactiveAction {
    goal: string;                // Goal text passed to GoalOrientedExecutor
    priority: 'high' | 'medium' | 'low';
    reason: string;              // Why this action was chosen
    notify: boolean;             // Push result to messaging channel
    source: 'heartbeat_task' | 'memory_interest' | 'soul_trigger';
    enableNetwork: boolean;      // Whether the goal needs internet access
    profile?: string;            // Agent profile: 'researcher' | 'coder' | 'default'
}

export interface AgendaContext {
    now: Date;
    soulContent: string;
    userContent?: string;
    heartbeatTasks: HeartbeatCheckItem[];
    recentEvents: { event_text: string; event_type: string }[];
    persona: { name?: string; role?: string; preferences?: Record<string, any> };
    lastProactiveAt?: Date | null;
}

// ── ProactiveAgenda ───────────────────────────────────────────────────────────

export class ProactiveAgenda {

    /**
     * Evaluate whether there is ONE genuinely useful proactive action to take right now.
     * Returns null if nothing is worth doing (quiet hours, too soon, no candidates).
     */
    async evaluate(ctx: AgendaContext): Promise<ProactiveAction | null> {
        const llm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) {
            console.log('[ProactiveAgenda] No LLM available — skipping');
            return null;
        }

        // 1. Quiet hours check (parses "Quiet hours: 11 PM - 7 AM" from SOUL.md)
        if (this.isQuietHours(ctx.soulContent, ctx.now)) {
            console.log('[ProactiveAgenda] Quiet hours — skipping');
            return null;
        }

        // 2. Minimum gap: don't fire more often than every 25 minutes
        if (ctx.lastProactiveAt) {
            const gapMs = ctx.now.getTime() - new Date(ctx.lastProactiveAt).getTime();
            if (gapMs < 25 * 60 * 1000) {
                console.log(`[ProactiveAgenda] Last action ${Math.round(gapMs / 60000)}m ago — too soon`);
                return null;
            }
        }

        // 3. Query memory for user interests / recent goals
        let memoryInterests = '';
        try {
            const memories = await memoryManager.hybridSearch(
                'user interests goals preferences recent tasks',
                'default',
                6
            );
            if (memories.length > 0) {
                memoryInterests = memories
                    .map(m => `- ${m.text.substring(0, 160)}`)
                    .join('\n');
            }
        } catch {
            // Memory subsystem unavailable — continue without
        }

        // 4. Filter heartbeat tasks that are due right now
        const dueTasks = ctx.heartbeatTasks.filter(t => this.isTaskDue(t, ctx.now));
        const taskList = dueTasks.map(t => `- [TASK] ${t.text}`).join('\n');

        // Nothing to work with
        if (!taskList && !memoryInterests) {
            console.log('[ProactiveAgenda] No candidates — nothing to do');
            return null;
        }

        // 5. Build rich time context
        const timeStr = ctx.now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const dayOfWeek = ctx.now.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
        const hourIST = parseInt(
            new Intl.DateTimeFormat('en-IN', {
                hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata'
            }).format(ctx.now)
        );

        const timeHints = [
            hourIST >= 7  && hourIST < 11  ? 'MORNING (good time for a briefing or market open summary)' : null,
            hourIST >= 9  && hourIST <= 15 ? 'NSE/BSE MARKET HOURS (9:15 AM – 3:30 PM IST)' : null,
            hourIST >= 15 && hourIST < 18  ? 'AFTERNOON — good for research tasks or summaries' : null,
            hourIST >= 18 && hourIST < 22  ? 'EVENING — good for daily recap or planning tomorrow' : null,
        ].filter(Boolean).join(' | ');

        const recentStr = ctx.recentEvents
            .slice(0, 6)
            .map(e => `- [${e.event_type}] ${e.event_text.substring(0, 130)}`)
            .join('\n') || '- No recent activity';

        const personaStr = ctx.persona.name
            ? `${ctx.persona.name} (${ctx.persona.role || 'general user'})`
            : 'User';

        const prefsStr = ctx.persona.preferences
            ? Object.entries(ctx.persona.preferences)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ')
                .substring(0, 200)
            : '';

        // 6. Ask LLM to choose ONE action
        const prompt = `You are the proactive intelligence engine of an AI Partner. Your job: decide if there is ONE genuinely useful action to take RIGHT NOW for the user — without being asked.

CURRENT TIME: ${timeStr} (${dayOfWeek})
${timeHints ? `TIME CONTEXT: ${timeHints}` : ''}

USER: ${personaStr}
${prefsStr ? `PREFERENCES: ${prefsStr}` : ''}

${ctx.soulContent ? `AGENT SOUL (personality & behaviour rules):\n${ctx.soulContent.substring(0, 500)}\n` : ''}
${ctx.userContent ? `USER PREFERENCES (always follow these conventions):\n${ctx.userContent}\n` : ''}
RECENT USER ACTIVITY (last 6 events):
${recentStr}

STANDING HEARTBEAT TASKS (from user's HEARTBEAT.md — these are what the user WANTS the agent to proactively do):
${taskList || '- None configured yet'}

USER MEMORY / INTERESTS (from past conversations):
${memoryInterests || '- No memory available yet'}

DECISION RULES:
1. HEARTBEAT TASKS take priority — if a task is due right now, DO IT
2. MEMORY INTERESTS are next — if the user mentioned stocks/crypto/weather etc, proactively fetch updates
3. Only act if the action is GENUINELY USEFUL right now, not just possible
4. Skip if the user just did the same thing in recent activity (check "Recent User Activity")
5. If truly nothing is useful, return shouldAct: false
6. NEVER pick a trivial action ("say hello", "check if server is running")
7. For market/financial tasks: only during market hours (9 AM – 4 PM IST weekdays)
8. Prefer actions with clear, tangible output (a file, a message, a summary)

Output ONLY this JSON (no markdown, no explanation):
{
  "shouldAct": true | false,
  "reason": "one sentence why or why not",
  "goal": "the exact goal description to pass to the executor (be specific and actionable)",
  "priority": "high" | "medium" | "low",
  "notify": true | false,
  "source": "heartbeat_task" | "memory_interest" | "soul_trigger",
  "enableNetwork": true | false,
  "profile": "researcher" | "coder" | "default"
}`;

        try {
            const result = await llm.generateJSON(prompt, { temperature: 0.2 });

            // Normalise common LLM key variations (snake_case vs camelCase)
            const shouldAct = result.shouldAct ?? result.should_act ?? result.act ?? false;
            const goal = result.goal ?? result.action ?? result.task ?? '';
            const reason = result.reason ?? result.rationale ?? result.explanation ?? '';
            const enableNetwork = result.enableNetwork ?? result.enable_network ?? result.network ?? false;

            console.log(`[ProactiveAgenda] LLM decision: shouldAct=${shouldAct} | ${reason}`);
            if (Object.keys(result).length < 2) {
                console.warn('[ProactiveAgenda] Result has very few keys — raw:', JSON.stringify(result));
            }

            if (!shouldAct || !goal || String(goal).trim().length < 5) {
                return null;
            }

            return {
                goal: String(goal),
                priority: result.priority || 'medium',
                reason: String(reason),
                notify: result.notify !== false,
                source: result.source || 'memory_interest',
                enableNetwork: enableNetwork === true,
                profile: result.profile || 'default',
            };
        } catch (e: any) {
            // generateJSON throws with e.rawText when all JSON tiers fail
            if (e.rawText) {
                console.error('[ProactiveAgenda] LLM returned unparseable response:', e.rawText.substring(0, 200));
            } else {
                console.error('[ProactiveAgenda] LLM decision failed:', e);
            }
            return null;
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Parse "Quiet hours: 11 PM - 7 AM IST" from SOUL.md and check if now is in that window.
     * Accepts 12h (11 PM) or 24h (23:00) formats.
     */
    private isQuietHours(soulContent: string, now: Date): boolean {
        if (!soulContent) return false;

        const match = soulContent.match(
            /quiet\s+hours?[:\s]+(\d{1,2})[:\.]?(\d{0,2})\s*(am|pm)?[\s\-–—]+(\d{1,2})[:\.]?(\d{0,2})\s*(am|pm)?/i
        );
        if (!match) return false;

        try {
            const to24 = (h: number, ampm?: string): number => {
                if (!ampm) return h;
                const pm = ampm.toLowerCase() === 'pm';
                if (pm && h !== 12) return h + 12;
                if (!pm && h === 12) return 0;
                return h;
            };

            const startH = to24(parseInt(match[1]), match[3]);
            const endH = to24(parseInt(match[4]), match[6]);
            const nowH = parseInt(
                new Intl.DateTimeFormat('en-IN', {
                    hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata'
                }).format(now)
            );

            // Overnight window: e.g., 23 → 7 means 23, 0, 1, 2, 3, 4, 5, 6
            if (startH > endH) return nowH >= startH || nowH < endH;
            return nowH >= startH && nowH < endH;
        } catch {
            return false;
        }
    }

    /**
     * Return true if a heartbeat task text implies it should be done at the current time.
     * Supports: "every morning", "market hours", "every Monday", "daily", "weekly".
     * Tasks with no time qualifier are always candidates (let LLM decide).
     */
    private isTaskDue(task: HeartbeatCheckItem, now: Date): boolean {
        const text = task.text.toLowerCase();

        const hourIST = parseInt(
            new Intl.DateTimeFormat('en-IN', {
                hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata'
            }).format(now)
        );

        const dayIST = new Intl.DateTimeFormat('en-IN', {
            weekday: 'long', timeZone: 'Asia/Kolkata'
        }).format(now).toLowerCase();

        // Morning tasks — 7 AM to 11 AM
        if (/morning|briefing|good morning/.test(text)) return hourIST >= 7 && hourIST < 11;

        // Market hours — 9 AM to 3:30 PM IST (NSE)
        if (/market|trading|nse|bse|stocks?|sensex|nifty|shares?/.test(text)) {
            return hourIST >= 9 && hourIST <= 15;
        }

        // Evening recap — 6 PM to 9 PM
        if (/evening|recap|end.?of.?day|eod/.test(text)) return hourIST >= 18 && hourIST < 21;

        // Specific day of week
        const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        for (const day of weekdays) {
            if (text.includes(day)) return dayIST.includes(day);
        }

        // Weekdays only
        if (/weekday|business day/.test(text)) {
            return !['saturday', 'sunday'].some(d => dayIST.includes(d));
        }

        // Daily or always-on tasks
        if (/daily|every day|always/.test(text)) return true;

        // "Every N hours" — always a candidate
        if (/every \d+ hour/.test(text)) return true;

        // No time qualifier → always a candidate (LLM decides if it's relevant now)
        return true;
    }
}

export const proactiveAgenda = new ProactiveAgenda();
