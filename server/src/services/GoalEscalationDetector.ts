/**
 * GoalEscalationDetector — Pure functions for scoring whether a chat message
 * should be escalated from OODA/chat mode to Goal-Oriented execution mode.
 *
 * Extracted from AgentOrchestrator.ts (Phase 3.3 refactor).
 * No side effects, no instance state — fully testable in isolation.
 */

/**
 * Returns true if the last assistant message looks like an active task context —
 * i.e. a goal execution report, HITL pause, or mid-task status update.
 * Used to boost escalation score for short contextual follow-ups.
 */
export function lastMessageIsTaskContext(lastAssistantMsg: string): boolean {
    // OLD format signals
    if (/✓\s*(Completed|Failed)|✗\s*(Completed|Failed)|\biteration[s]?\b|\bexecut(ing|ion|ed)\b/i.test(lastAssistantMsg)) return true;
    // HITL / pause signals
    if (/⏸|paused|Action Required|credentials|login|sign.?in|waiting for/i.test(lastAssistantMsg)) return true;
    // Mid-task step listing
    if (/Step \d+:|browser.*navigat|screenshot|selector|timeout|DOM|anti.?bot/i.test(lastAssistantMsg)) return true;
    // Explicit retry offers (old format)
    if (/Would you like to retry|try again|alternative method|Next Steps?:/i.test(lastAssistantMsg)) return true;
    // NEW FORMAT goal completion signals (✅ Done / ⚠️ Almost there / ❌ Couldn't complete)
    if (/^✅\s+Done|^⚠️\s+Almost there|^❌\s+Couldn't complete/m.test(lastAssistantMsg)) return true;
    // New format: criteria count line or retry tip
    if (/\d+\s+of\s+\d+\s+steps\s+(done|completed)/i.test(lastAssistantMsg)) return true;
    if (/Type\s+"retry"\s+to\s+fix|retry.*to.*fix.*automatically/i.test(lastAssistantMsg)) return true;
    // New format: file criteria lines
    if (/^\s+[✅❌]\s+.+(created|compiles|has `|npm tests|output)/m.test(lastAssistantMsg)) return true;
    return false;
}

/**
 * Scores a chat message for multi-step complexity to decide if it should be
 * escalated from OODA/chat mode to Goal-Oriented (ReAct) execution mode.
 *
 * A score >= 4 triggers escalation. Key signals:
 * - Explicit output file names (+4)
 * - Short follow-up after active task context (+4)
 * - Multi-step connectors, creation+research combos, domain hits, etc.
 */
export function scoreForGoalEscalation(message: string, lastAssistantMsg?: string): number {
    const lower = message.toLowerCase();
    let score = 0;

    // ── Hard override: capability / identity questions never escalate ──────
    // These phrases are always conversational — even after a task context, asking
    // "how can you help me with X" or "what can you do" is a capability question.
    const CAPABILITY_RE = /^(how can you|what can you|what do you|who are you|what are you|can you help|help me understand|how do you|what is your|tell me (about|what) you|how would you|what would you|what('s| is) your)\b/i;
    if (CAPABILITY_RE.test(lower)) return 0;

    // ── Context-aware continuation boost ──────────────────────────────────
    // If the last assistant message was an active task (goal report, HITL, mid-task
    // status) AND this message is short, it's almost certainly a contextual follow-up,
    // not a new standalone query. Boost score so it clears the escalation threshold.
    if (lastAssistantMsg && lastMessageIsTaskContext(lastAssistantMsg)) {
        const wordCount = message.trim().split(/\s+/).length;
        if (wordCount <= 15) {
            score += 4; // clears threshold on its own
            console.log(`[Orchestrator] Context boost: last message was task context, short follow-up detected (+4)`);
        }
    }

    // Bug #1 FIX: Explicit output file names are the strongest possible signal
    // that this is a Goal-mode task. If the message names specific output files,
    // the OODA loop WILL ghost-complete (0 files written, no GoalValidator check).
    // Score += 4 immediately — this alone clears the escalation threshold.
    const OUTPUT_FILE_RE = /\b[\w.-]+\.(json|md|csv|txt|png|jpg|jpeg|pdf|html|xlsx|yaml|yml|svg|mp4|zip|tar|gz)\b/i;
    if (OUTPUT_FILE_RE.test(message)) {
        score += 4;
        console.log(`[Orchestrator] Bug#1: explicit output file detected in message — forcing Goal Mode (score+4)`);
    }

    // Multi-step connectors — "research X and then write Y"
    if (/\band\s+(then|also|after(wards)?|subsequently)\b/.test(lower)) score += 2;
    if (/\band\b.{5,}\band\b/.test(lower)) score += 1;   // "and ... and" (3+ steps)

    // Creation + research combination
    const hasCreate = /\b(create|build|make|implement|develop|generate|set.?up)\b/.test(lower);
    const hasResearch = /\b(research|analyze|analyse|find|gather|collect|compare|investigate|study)\b/.test(lower);
    if (hasCreate && hasResearch) score += 3;

    // Multi-domain signals
    const domains = ['frontend', 'backend', 'database', 'db', 'api', 'auth', 'login',
        'dashboard', 'report', 'excel', 'pdf', 'email', 'stock', 'market',
        'scrape', 'crawler', 'pipeline', 'deploy', 'docker'];
    const domainHits = domains.filter(d => lower.includes(d)).length;
    if (domainHits >= 2) score += 2;
    if (domainHits >= 3) score += 1;

    // Explicit multi-step language
    if (/\b(step.?by.?step|multiple steps?|several|comprehensive|complete|full|end.?to.?end)\b/.test(lower)) score += 1;

    // Long messages are usually complex goals
    if (message.length > 300) score += 1;
    if (message.length > 600) score += 1;

    // Bullet lists or numbered steps in the request
    if (/^\s*[-*\d]\./m.test(message)) score += 2;

    // Explicit goal keywords
    if (/\b(autonomously|automatically|without me|on your own)\b/.test(lower)) score += 2;

    return score;
}
