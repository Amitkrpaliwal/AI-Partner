import { modelManager } from './llm/modelManager';
import { modelRouter } from './llm/modelRouter';
import { HistoryMessage, getTextContent } from './llm/types';
import { mcpManager } from '../mcp/MCPManager';
import { memoryManager } from '../memory/MemoryManager';
import { configManager } from './ConfigManager';
import { MarkdownConfigLoader } from '../config/MarkdownConfigLoader';
import { conversationCompressor } from './ConversationCompressor';
import { usageTracker } from './UsageTracker';
import { db } from '../database';
import { randomUUID } from 'crypto';
import { promptLoader } from '../utils/PromptLoader';
import { skillLearner } from './SkillLearner';
import { goalClarifier, ClarifyingQuestion } from '../agents/goal/GoalClarifier';
import { scoreForGoalEscalation, lastMessageIsTaskContext } from './GoalEscalationDetector';

interface ChatResponse {
    response: string;
    toolCalls?: any[];
    contextUsed?: any;
    plan?: ExecutionPlan;
    conversationId?: string;
}

interface ExecutionPlan {
    id: string;
    description: string;
    steps: PlanStep[];
    status: 'pending_approval' | 'approved' | 'rejected' | 'executing' | 'completed';
}

interface PlanStep {
    id: string;
    action: string;
    description: string;
    tool?: string;
    args?: any;
    requiresConfirmation: boolean;
    status: 'pending' | 'executing' | 'completed' | 'failed';
}

// Gateway instance will be set from index.ts
let gateway: any = null;

// Pending approval promises - keyed by plan_id
const pendingApprovals: Map<string, {
    resolve: (approved: boolean) => void;
    reject: (reason: string) => void;
}> = new Map();

// Pending goals awaiting clarification — keyed by conversationId
// When user answers questions in the same conversation, goal runs with enriched context.
const pendingGoals: Map<string, {
    goalText: string;
    questions: ClarifyingQuestion[];
    expiresAt: number;
}> = new Map();

// Pending retry — keyed by conversationId
// Set when a goal fails; cleared when user sends a short affirmative ("yes", "retry", etc.)
const pendingRetry: Map<string, {
    goalText: string;
    expiresAt: number;
    outputDir?: string;   // reuse same folder on retry so agent fixes existing files
}> = new Map();

// ─── Paused OODA state helpers ─────────────────────────────────────────────
// Persists the full OODA loop state when a HITL pause fires, so the next
// user message can resume exactly where the loop left off.

interface PausedOODAState {
    conversationId: string;
    userId: string;
    mode: string;
    iteration: number;
    conversationHistory: HistoryMessage[];
    allToolCalls: any[];
    pendingTool: string;
    pendingArgs: Record<string, unknown>;
    pendingQuestion: string;
    containerSessionId: string | null;
    workspaceFiles: string[];
    modelKey: string;
}

async function savePausedOODAState(state: PausedOODAState): Promise<void> {
    await db.run(
        `INSERT OR REPLACE INTO paused_ooda_states
         (conversation_id, user_id, mode, iteration, conversation_history, all_tool_calls,
          pending_tool, pending_args, pending_question, container_session_id, workspace_files,
          model_key, paused_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+30 minutes'))`,
        [
            state.conversationId, state.userId, state.mode, state.iteration,
            JSON.stringify(state.conversationHistory), JSON.stringify(state.allToolCalls),
            state.pendingTool, JSON.stringify(state.pendingArgs), state.pendingQuestion,
            state.containerSessionId, JSON.stringify(state.workspaceFiles), state.modelKey,
        ]
    );
}

async function loadPausedOODAState(conversationId: string): Promise<PausedOODAState | null> {
    const row = await db.get(
        `SELECT * FROM paused_ooda_states
         WHERE conversation_id = ? AND expires_at > datetime('now')`,
        [conversationId]
    ) as any;
    if (!row) return null;
    return {
        conversationId: row.conversation_id,
        userId: row.user_id,
        mode: row.mode,
        iteration: row.iteration,
        conversationHistory: JSON.parse(row.conversation_history),
        allToolCalls: JSON.parse(row.all_tool_calls),
        pendingTool: row.pending_tool,
        pendingArgs: JSON.parse(row.pending_args),
        pendingQuestion: row.pending_question,
        containerSessionId: row.container_session_id || null,
        workspaceFiles: JSON.parse(row.workspace_files || '[]'),
        modelKey: row.model_key || '',
    };
}

async function clearPausedOODAState(conversationId: string): Promise<void> {
    await db.run('DELETE FROM paused_ooda_states WHERE conversation_id = ?', [conversationId]);
}

async function releaseContainerHold(containerName: string | null): Promise<void> {
    if (!containerName) return;
    try {
        const { containerSessionManager } = await import('../execution/ContainerSession');
        const session = containerSessionManager.getExistingSession(containerName);
        session?.releaseHold();
    } catch { /* non-fatal */ }
}

export function setGateway(gw: any) {
    gateway = gw;

    // Listen for approval/rejection events from Gateway
    if (gateway && gateway.io) {
        gateway.io.on('connection', (socket: any) => {
            socket.on('plan:approve', (data: { plan_id: string }) => {
                const pending = pendingApprovals.get(data.plan_id);
                if (pending) {
                    console.log(`[HITL] Plan ${data.plan_id} APPROVED by user`);
                    pending.resolve(true);
                    pendingApprovals.delete(data.plan_id);
                }
            });

            socket.on('plan:reject', (data: { plan_id: string; reason?: string }) => {
                const pending = pendingApprovals.get(data.plan_id);
                if (pending) {
                    console.log(`[HITL] Plan ${data.plan_id} REJECTED by user: ${data.reason || 'No reason'}`);
                    pending.resolve(false);
                    pendingApprovals.delete(data.plan_id);
                }
            });
        });
    }
}

/**
 * Emit OODA event to connected clients via Gateway
 */
function emitOODA(phase: 'observe' | 'orient' | 'decide' | 'act' | 'reflect', content: string, metadata?: any) {
    console.log(`[OODA:${phase.toUpperCase()}] ${content}`);
    if (gateway) {
        gateway.emitOODA(phase, content, metadata);
    }
}

/**
 * Emit chat progress for real-time streaming updates in the chat UI
 */
function emitChatProgress(event: string, data: any) {
    if (gateway && gateway.io) {
        gateway.io.emit(`chat:${event}`, data);
        console.log(`[ChatProgress] ${event}:`, data.step || data.status || 'update');
    }
}

/**
 * Emit plan preview for HITL approval and wait for user response
 */
function emitPlanPreview(plan: ExecutionPlan): Promise<boolean> {
    console.log(`[HITL] Awaiting approval for plan: ${plan.id}`);

    if (gateway) {
        gateway.emitPlanPreview({
            plan_id: plan.id,
            description: plan.description,
            steps: plan.steps.map(s => ({
                id: s.id,
                action: s.action,
                description: s.description,
                requires_confirmation: s.requiresConfirmation
            }))
        });
    }

    // Create a promise that waits for user approval
    return new Promise((resolve) => {
        // Store the resolver
        pendingApprovals.set(plan.id, {
            resolve,
            reject: () => resolve(false)
        });

        // Timeout after 5 minutes - auto-reject if no response
        setTimeout(() => {
            if (pendingApprovals.has(plan.id)) {
                console.log(`[HITL] Plan ${plan.id} timed out after 5 minutes`);
                pendingApprovals.delete(plan.id);
                resolve(false);
            }
        }, 5 * 60 * 1000);
    });
}

export class AgentOrchestrator {
    private configLoader: MarkdownConfigLoader | null = null;
    private _cancelledConversations: Set<string> = new Set();

    constructor() {
        this.initConfigLoader();
    }

    /**
     * Cancel an active execution for a conversation.
     */
    cancelExecution(conversationId?: string): void {
        if (conversationId) {
            this._cancelledConversations.add(conversationId);
        }
        console.log(`[Orchestrator] Execution cancelled for: ${conversationId || 'current'}`);
    }

    /**
     * Check if execution was cancelled for a conversation.
     */
    isCancelled(conversationId?: string): boolean {
        if (!conversationId) return false;
        return this._cancelledConversations.has(conversationId);
    }

    /**
     * Clear cancellation flag after handling.
     */
    clearCancellation(conversationId?: string): void {
        if (conversationId) {
            this._cancelledConversations.delete(conversationId);
        }
    }

    private initConfigLoader() {
        try {
            const workspaceDir = configManager.getWorkspaceDir();
            this.configLoader = new MarkdownConfigLoader(workspaceDir);
        } catch (e) {
            console.warn('[Orchestrator] Failed to load config:', e);
        }
    }

    /**
     * Load system prompt from SOUL.md + agent configuration + user preferences (Phase 17)
     */
    private async getSystemPrompt(persona: any, recentEvents: any[], userId: string = 'default', messageContext?: string, agentOverride?: string): Promise<string> {
        let soulContent = '';
        if (agentOverride) {
            // Named agent @mention: use the agent's system prompt as the sole identity.
            // SOUL.md identity is skipped — the agent persona defines who is speaking.
            // Infrastructure sections (date, memory, skills, integrations) are still appended below.
            soulContent = agentOverride;
        } else if (this.configLoader) {
            soulContent = this.configLoader.loadSoul();
        }

        const userContent = this.configLoader?.loadUser() ?? '';
        if (userContent) {
            soulContent += `\n\n[USER CONTEXT]\n${userContent}`;
        }

        const eventsText = recentEvents.map(e =>
            `- [${new Date(e.timestamp!).toLocaleString()}] ${e.event_type}: ${e.event_text}`
        ).join('\n');

        // Load user preferences (Phase 17.8)
        let preferencesSection = '';
        try {
            const { memoryConsolidator } = await import('../memory/MemoryConsolidator');
            const prefSummary = await memoryConsolidator.getPreferenceSummary(userId);
            if (prefSummary) {
                preferencesSection = `\n[USER PREFERENCES]\n${prefSummary}\n`;
            }
        } catch { /* consolidator not ready */ }

        // Semantic memory recall — inject relevant past experiences into the chat system prompt.
        // Mirrors what ReActReasoner does for goal mode so both paths benefit from memory.
        let memorySection = '';
        if (messageContext) {
            try {
                const memories = await memoryManager.hybridSearch(messageContext, userId, 3);
                if (memories.length > 0) {
                    memorySection = '\n[RELEVANT PAST EXPERIENCES]\n' +
                        memories.map(m => `- [${m.event_type}] ${m.text.substring(0, 200)}`).join('\n') + '\n';
                }
            } catch { /* vector memory not available */ }
        }

        // Skill library context — show matched skill so LLM can recommend Goal mode
        let skillSection = '';
        if (messageContext) {
            try {
                const matchedSkill = await skillLearner.findMatchingSkill(messageContext);
                if (matchedSkill) {
                    skillSection = `\n[REUSABLE SKILL AVAILABLE]\n` +
                        `Skill: "${matchedSkill.name}" | Runtime: ${matchedSkill.runtime} | Succeeded: ${matchedSkill.successCount}x\n` +
                        `Description: ${matchedSkill.description}\n` +
                        `Pattern: "${matchedSkill.pattern}"\n` +
                        `If the user's request matches this skill, recommend switching to Goal mode — it will execute automatically.\n`;
                }
            } catch { /* non-fatal — skill library unavailable */ }
        }

        // Build integration status section — active tools vs. ones needing configuration
        let integrationSection = '';
        try {
            const { INTEGRATIONS } = await import('../routes/integrationRoutes');
            const active: string[] = [];
            const needsSetup: string[] = [];
            for (const integ of INTEGRATIONS) {
                const isConnected = integ.requiredKeys.length === 0
                    ? integ.optionalKeys.some(k => !!process.env[k])
                    : integ.requiredKeys.every(k => !!process.env[k]);
                if (isConnected) {
                    active.push(`${integ.icon} ${integ.label}: ${integ.description}`);
                } else {
                    needsSetup.push(`${integ.icon} ${integ.label} (needs: ${integ.requiredKeys.join(', ') || integ.optionalKeys[0] || 'API key'})`);
                }
            }
            integrationSection = '\n[INTEGRATIONS]\n';
            if (active.length > 0) {
                integrationSection += `Active — tools available now:\n${active.map(i => `- ${i}`).join('\n')}\n`;
            } else {
                integrationSection += `Active: none configured yet.\n`;
            }
            if (needsSetup.length > 0) {
                integrationSection += `Not configured — guide user to Sidebar → Integrations to set up:\n${needsSetup.map(i => `- ${i}`).join('\n')}\n`;
            }
        } catch { /* integrationRoutes not available */ }

        const basePrompt = soulContent || `You are an autonomous AI Co-Worker named "${persona.name || 'Assistant'}".\nRole: ${persona.role || 'General Assistant'}`;
        const rawTemplate = `${basePrompt}

[CURRENT DATE & TIME]
Today is {{CURRENT_DATE}}, {{CURRENT_TIME}}. Always use this exact date when constructing search queries.

[RECENT EVENTS]
${eventsText || '- No recent events'}
${preferencesSection}${memorySection}${skillSection}${integrationSection}
[CORE PRINCIPLES]
- BE PROACTIVE: Take action rather than asking for clarification when possible
- MAKE DECISIONS: When the user says "decide for yourself" or similar, make a reasonable choice and proceed
- USE TOOLS: If a tool can help accomplish the task, use it immediately
- BE AUTONOMOUS: Complete tasks step-by-step without waiting for approval on each step
- ONLY ask clarification if the request is genuinely ambiguous and you cannot reasonably proceed`;

        return promptLoader.interpolate(rawTemplate).trim();
    }

    private formatDuration(ms: number): string {
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
    }

    private async buildGoalCompletionMessage(result: any): Promise<string> {
        const succeeded = result.status === 'completed';
        const durationStr = this.formatDuration(result.summary?.duration_ms || 0);

        const allCriteria = (result.goal?.success_criteria || []) as any[];
        const passedCriteria = allCriteria.filter((c: any) => c.status === 'passed');
        const failedCriteria = allCriteria.filter((c: any) => c.status === 'failed');

        const artifactsFull = ((result.summary?.artifacts_created || []) as string[])
            .filter(f => !f.includes('_goal_script'));
        const userFiles = artifactsFull.map(f => ({ name: f.split('/').pop() || f, path: f }));
        const fileCount = userFiles.length;
        const journal = (result.final_state?.execution_journal || []) as string[];

        // File type icon
        const fileIcon = (name: string) => {
            if (/\.(test|spec)\.[jt]sx?$/.test(name) || /test/.test(name)) return '🧪';
            if (/\.(txt|log|out|csv)$/.test(name)) return '📋';
            if (/\.(json|yaml|yml|env)$/.test(name)) return '⚙️';
            if (/\.(md|html)$/.test(name)) return '📝';
            return '📄';
        };

        // Human-readable criterion label
        const criterionLabel = (c: any): string => {
            const file = (c.config?.path as string | undefined)?.split('/').pop() || '';
            switch (c.type) {
                case 'file_exists':    return file ? `${file} created` : 'File created';
                case 'file_contains': {
                    const pat = String(c.config?.pattern || c.config?.expected || '').replace(/\\/g, '').substring(0, 35);
                    return file ? `${file} has \`${pat}\`` : `Content check: ${pat}`;
                }
                case 'tests_pass':     return 'npm tests pass';
                case 'output_matches': return 'Test output captured';
                case 'code_compiles':  return file ? `${file} compiles` : 'Code compiles';
                case 'llm_evaluates':  return String(c.config?.expected || 'Quality check').substring(0, 50);
                default:               return (c.type as string).replace(/_/g, ' ');
            }
        };

        // Humanize technical error messages
        const humanizeError = (msg: string): string => {
            if (!msg) return '';
            if (/ENOENT|no such file/i.test(msg))                        return 'File not created yet';
            if (/STALE.*predates/i.test(msg))                             return 'File predates this run — needs rewriting';
            if (/describe is not defined|reading 'describe'/i.test(msg))  return 'Test runner (jest/mocha) not installed';
            if (/it is not defined|reading 'it'\b/i.test(msg))            return 'Test runner not installed';
            const modMatch = msg.match(/Cannot find module '([^']+)'/);
            if (modMatch) return `Missing package: ${modMatch[1].split('/').pop()} — run npm install`;
            if (/Missing script.*test/i.test(msg))                        return 'package.json has no "test" script';
            if (/ECONNREFUSED/i.test(msg))                                return 'Server not running during tests';
            if (/SyntaxError|unexpected token/i.test(msg))                return 'Syntax error in test file';
            if (/Test Suites:.*failed/i.test(msg))                        return 'Tests failed — see test output';
            const patMatch = msg.match(/Pattern "([^"]+)" NOT found/);
            if (patMatch) return `Missing: ${patMatch[1].substring(0, 40)}`;
            return msg.split('\n')[0].replace(/\s+/g, ' ').trim().substring(0, 100);
        };

        const sm = result.searchMetrics as { attempted: number; succeeded: number; failed: number } | undefined;
        const searchWarn = sm && sm.attempted > 0 && sm.succeeded === 0
            ? '\n\n  ⚠️  Web search was unavailable — results based on training data only'
            : '';

        // Signal workspace to refresh
        gateway?.io?.emit('workspace:refresh', {});

        const llm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();

        // ── STATE 3: FULL SUCCESS ──
        if (succeeded) {
            const stepCount = allCriteria.length || fileCount || result.summary?.total_iterations || 0;
            const lines: string[] = [];
            const header = `✅  Done${stepCount ? ` — all ${stepCount} steps completed` : ''}`;
            lines.push(`${header.padEnd(48)}${durationStr}`);
            lines.push('');

            // File list with LLM-generated one-phrase descriptions
            let fileDescriptions: Record<string, string> = {};
            try {
                if (llm && fileCount > 0) {
                    const recentSteps = journal.slice(-8).join('\n');
                    const names = userFiles.map(f => f.name).join(', ');
                    const raw = await llm.generate(
                        `Files created: ${names}\nGoal: ${(result.goal?.description || '').substring(0, 120)}\nLog: ${recentSteps.substring(0, 400)}\n\n` +
                        `For each filename write ONE short phrase (≤40 chars) describing what it contains.\nFormat: filename: description\nExample: server.js: 3 REST endpoints, Express 4.x`,
                        { temperature: 0.2, maxTokens: 120 }
                    );
                    for (const line of raw.split('\n')) {
                        const m = line.match(/^(.+?):\s*(.+)$/);
                        if (m) fileDescriptions[m[1].trim().split('/').pop() || ''] = m[2].trim().substring(0, 45);
                    }
                }
            } catch { /* non-critical */ }

            for (const f of userFiles) {
                const desc = fileDescriptions[f.name] || '';
                lines.push(`  ${fileIcon(f.name)}  ${f.name.padEnd(24)}${desc}`);
            }

            // Extract test pass lines from journal
            const testLines: string[] = [];
            for (const entry of journal) {
                const m = entry.match(/✓\s+([A-Z]+\s+\/\S+)\s*→\s*(\d{3})\s*(.{0,30})/);
                if (m) testLines.push(`  ✓  ${m[1].padEnd(22)} → ${m[2]}  ${m[3].trim()}`);
            }
            if (testLines.length === 0) {
                const passEntry = journal.find(j => /\d+\s+passing|\d+ passed|Test Suites:.*passed/i.test(j));
                if (passEntry) {
                    const m = passEntry.match(/(\d+\s+(?:tests? )?passing|\d+ passed)/i);
                    if (m) testLines.push(`  ✓  ${m[1]}`);
                }
            }
            if (testLines.length > 0) {
                lines.push('');
                lines.push('  Test results:');
                lines.push(...testLines);
            }

            // Run commands derived from goal output dir
            const slug = result.final_state?.output_dir?.split('/').pop() || result.goal?.slug || '';
            if (slug) {
                lines.push('');
                const hasServer = userFiles.some(f => /server|app|index/.test(f.name) && /\.[jt]sx?$/.test(f.name));
                if (hasServer) lines.push(`  To run:         cd workspace/${slug} && node server.js`);
                lines.push(`  To test again:  cd workspace/${slug} && npm test`);
            }

            lines.push(searchWarn);
            return lines.join('\n');
        }

        // ── STATE 2: PARTIAL (some passed, some failed) ──
        if (passedCriteria.length > 0 && failedCriteria.length > 0) {
            const stepCount = allCriteria.length;
            const lines: string[] = [];
            const header = `⚠️  Almost there — ${passedCriteria.length} of ${stepCount} steps done`;
            lines.push(`${header.padEnd(48)}${durationStr}`);
            lines.push('');

            // What succeeded
            for (const c of passedCriteria) {
                const file = (c.config?.path as string | undefined)?.split('/').pop() || '';
                const label = criterionLabel(c);
                lines.push(`  ✅  ${file.padEnd(22)}${label}`);
            }
            lines.push('');

            // What failed
            for (const c of failedCriteria) {
                const detail = humanizeError((c.message || '').replace(/\n/g, ' '));
                lines.push(`  ❌  ${detail || criterionLabel(c)}`);
            }

            // 💡 Recovery tip via LLM
            try {
                if (llm) {
                    const failures = failedCriteria
                        .map(c => `${criterionLabel(c)}: ${humanizeError(c.message || '')}`)
                        .join('; ');
                    const raw = await llm.generate(
                        `Goal partially succeeded.\nFailed: ${failures}\nFiles: ${userFiles.map(f => f.name).join(', ')}\nJournal (last 4):\n${journal.slice(-4).join('\n')}\n\n` +
                        `Write a 💡 tip in 2 sentences: (1) what went wrong specifically, (2) action — start with 'Type "retry" to fix automatically' if it's a code/config error, or give manual steps if it's infrastructure. No "I" or "agent". Write directly.`,
                        { temperature: 0.3, maxTokens: 100 }
                    );
                    const tip = raw.trim().replace(/^💡\s*/, '').replace(/^["']/, '').trim();
                    if (tip.length > 20) {
                        lines.push('');
                        lines.push(`  💡 ${tip}`);
                    }
                }
            } catch { /* non-critical */ }

            lines.push(searchWarn);
            return lines.join('\n');
        }

        // ── STATE 4: HARD FAILURE (0 criteria passed or no criteria) ──
        const lines: string[] = [];
        const header = `❌  Couldn't complete this`;
        lines.push(`${header.padEnd(48)}${durationStr}`);
        lines.push('');

        if (fileCount > 0) {
            lines.push('  What was done before it stopped:');
            for (const f of userFiles) {
                lines.push(`  ${fileIcon(f.name)}  ${f.name.padEnd(22)}created`);
            }
            lines.push('');
        }

        // LLM-generated blocked explanation + fix steps
        let blockedBy = '';
        let fixSteps: string[] = [];
        try {
            if (llm) {
                const failures = failedCriteria
                    .map(c => `${criterionLabel(c)}: ${(c.message || '').substring(0, 100)}`)
                    .join('; ') || result.failure_reason || 'unknown';
                const raw = await llm.generate(
                    `Goal execution failed completely.\nWhat failed: ${failures}\nJournal (last 6):\n${journal.slice(-6).join('\n')}\nFiles: ${userFiles.map(f => f.name).join(', ') || 'none'}\n\n` +
                    `Write EXACTLY:\nBLOCKED_BY: [2-3 sentences. Plain English. Specific package names or error messages. No "I" or "agent".]\n\nFIX_STEPS:\n1. [Specific first step]\n2. [Alternative or follow-up]\n3. [Include 'Type "retry"' if re-running would help]`,
                    { temperature: 0.3, maxTokens: 180 }
                );
                const bm = raw.match(/BLOCKED_BY:\s*([\s\S]*?)(?=\n\s*FIX_STEPS:|$)/i);
                const fm = raw.match(/FIX_STEPS:\s*([\s\S]*?)$/i);
                blockedBy = bm?.[1]?.trim() || '';
                fixSteps = (fm?.[1]?.trim() || '').split('\n')
                    .filter(l => /^\d+\./.test(l.trim()))
                    .map(l => l.trim())
                    .slice(0, 4);
            }
        } catch { /* non-critical */ }

        if (!blockedBy) {
            blockedBy = humanizeError(
                result.failure_reason || failedCriteria[0]?.message || 'Execution stopped unexpectedly.'
            );
        }

        lines.push('  What blocked it:');
        // Word-wrap blockedBy at ~62 chars
        const words = blockedBy.split(' ');
        let wrapLine = '  ';
        for (const word of words) {
            if (wrapLine.length + word.length + 1 > 64) { lines.push(wrapLine.trimEnd()); wrapLine = '  '; }
            wrapLine += word + ' ';
        }
        if (wrapLine.trim()) lines.push(wrapLine.trimEnd());

        if (fixSteps.length > 0) {
            lines.push('');
            lines.push('  To fix this yourself:');
            for (const step of fixSteps) lines.push(`  ${step}`);
        } else {
            // Fallback: detect network/package errors
            const hasNetErr = journal.some(j => /ECONNREFUSED|npm ERR|getaddrinfo|network/i.test(j));
            if (hasNetErr) {
                lines.push('');
                lines.push('  To fix this yourself:');
                lines.push('  1. Go to Settings → Sandbox → enable outbound network');
                lines.push('  2. Type "retry" to run again with network access');
                lines.push('     — or —');
                lines.push('  3. Add required packages to your Docker image and rebuild');
            }
        }

        lines.push(searchWarn);
        return lines.join('\n');
    }

    async chat(
        userId: string,
        message: string,
        conversationId?: string,
        mode: string = 'chat',
        progressCallback?: (msg: string) => void,
        agentOverride?: string,
        profileOptions?: { maxIterations?: number; toolWhitelist?: string[]; agentType?: string; agentSlug?: string }
    ): Promise<ChatResponse> {
        console.log(`[Orchestrator] Processing message from ${userId}: "${message}"`);

        // Note: @mention resolution for non-streaming callers (Telegram/Discord) is handled
        // in index.ts via agentOrchestrator.resolveMentionForExternalMessage() before chat() is called.

        // Get execution config
        const config = configManager.getConfig();
        const execConfig = config.execution || { autonomous_mode: true, max_iterations: 10, require_approval_for_writes: true };
        // Profile cap takes priority; otherwise auto=25, chat=10
        const profileCap = profileOptions?.maxIterations;
        const MAX_ITERATIONS = profileCap ?? (mode === 'auto' ? 25 : 10);
        const isProfileCapped = profileCap !== undefined; // track whether a profile set this cap

        let iteration = 0;
        let conversationHistory: HistoryMessage[] = [];
        let allToolCalls: any[] = [];
        let finalResponse = "";

        // Loop detection to prevent repetitive tool calls
        let lastToolName = "";
        let sameToolCount = 0;
        const MAX_SAME_TOOL = 8; // Allow up to 8 consecutive same-tool calls before forcing progress
        const MAX_SAME_READ_TOOL = 12; // Extra headroom for read-only exploration tools (list_directory etc.)

        // Search escalation tracking: if web_search is called multiple times without
        // extracting useful data (prices, numbers, named entities), auto-inject web_fetch
        let webSearchCount = 0;
        let lastSearchTopUrl: string | null = null; // top URL from most recent web_search result

        // ===== CONVERSATION PERSISTENCE =====
        // Create or get conversation ID
        let convId = conversationId;
        if (!convId) {
            convId = randomUUID();
        }

        const title = message.length > 50 ? message.substring(0, 50) + '...' : message;

        // Ensure conversation exists using INSERT OR IGNORE
        await db.run(
            'INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, datetime("now"), datetime("now"))',
            [convId, title]
        );

        // Update existing conversation's timestamp
        await db.run(
            'UPDATE conversations SET updated_at = datetime("now") WHERE id = ?',
            [convId]
        );

        console.log(`[Orchestrator] Active conversation: ${convId}`);

        // Load previous messages for multi-turn conversation continuity
        const prevMessages = await db.all(
            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 20',
            [convId]
        ) as { role: string; content: string }[];
        conversationHistory = prevMessages.map((m: any) => ({ role: m.role, content: m.content }));

        // Save user message
        const userMsgId = randomUUID();
        await db.run(
            'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
            [userMsgId, convId, 'user', message]
        );

        // ===== PRE-FLIGHT: PAUSED OODA STATE RESUME =====
        // If a previous OODA loop paused waiting for user input (HITL), the full
        // execution state was serialized. Restore it and skip all routing gates —
        // the user's current message is their HITL answer, not a new query.
        let skipRouting = false;
        {
            const paused = await loadPausedOODAState(convId);
            if (paused) {
                await clearPausedOODAState(convId);
                await releaseContainerHold(paused.containerSessionId);

                console.log(`[Orchestrator] Resuming paused OODA loop for ${convId} ` +
                    `at iteration ${paused.iteration} (tool was: ${paused.pendingTool})`);

                // Restore OODA working state
                conversationHistory = paused.conversationHistory;
                allToolCalls = paused.allToolCalls;
                iteration = paused.iteration;

                // Inject the user's answer into history so the LLM sees it as context
                conversationHistory.push({
                    role: 'user',
                    content: `[HITL Answer] You asked: "${paused.pendingQuestion}"\nUser replied: ${message}`
                });

                // Re-surface workspace snapshot so the LLM knows what files existed
                if (paused.workspaceFiles.length > 0) {
                    conversationHistory.push({
                        role: 'user',
                        content: `[Context] Files present in /workspace when execution paused: ${paused.workspaceFiles.join(', ')}`
                    });
                }

                skipRouting = true; // skip pendingGoals, slash, @mentions, escalation, native-search
            }
        }

        // ===== PRE-FLIGHT: PENDING GOAL CLARIFICATION CHECK =====
        // If a previous message triggered clarification questions, this message is
        // the user's answers. Inject them into the original goal and run it.
        if (!skipRouting) {
            const pending = pendingGoals.get(convId);
            if (pending) {
                pendingGoals.delete(convId);
                if (Date.now() < pending.expiresAt) {
                    console.log(`[Orchestrator] Clarification received for pending goal — enriching and running`);
                    const enrichedGoal = goalClarifier.injectAnswers(pending.goalText, pending.questions, message);
                    try {
                        const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                        const recentMsgs = await db.all(
                            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 10',
                            [convId]
                        ) as { role: string; content: string }[];
                        const goalResult = await goalOrientedExecutor.executeGoal(enrichedGoal, userId, {
                            enable_hitl: true,
                            enableNetwork: true,
                            conversationContext: recentMsgs.map((r: any) => ({ role: r.role as 'user' | 'assistant', content: r.content })),
                            conversationId: convId
                        });
                        const finalResp = await this.buildGoalCompletionMessage(goalResult);
                        await db.run(
                            'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                            [randomUUID(), convId, 'assistant', finalResp]
                        );
                        const generatedFiles = ((goalResult.summary?.artifacts_created || []) as string[]).filter((f: string) => !f.includes('_goal_script'));
                        return { response: finalResp, conversationId: convId, generatedFiles };
                    } catch (err: any) {
                        console.warn('[Orchestrator] Pending goal execution failed, falling through to OODA:', err.message);
                        // Fall through to normal conversation handling
                    }
                }
                // Expired or failed — fall through normally
            }
        }

        // ===== SLASH COMMAND FAST-PATH =====
        // Intercepts /cmd messages from any source (web UI, Telegram, Discord, WhatsApp).
        // Returns a formatted response without entering the OODA loop.
        if (!skipRouting && message.trimStart().startsWith('/')) {
            const trimmed = message.trim();
            // Special case: /goal <task> → strip prefix, force goal mode
            if (/^\/goal\s+/i.test(trimmed)) {
                const goalTask = trimmed.replace(/^\/goal\s+/i, '').trim();
                return this.chat(userId, goalTask, convId, 'goal', progressCallback);
            }
            const cmdResponse = await this.handleSlashCommand(trimmed, userId, convId);
            if (cmdResponse !== null) {
                await db.run(
                    'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                    [randomUUID(), convId, 'assistant', cmdResponse]
                );
                return { response: cmdResponse, conversationId: convId };
            }
            // Unknown command → fall through to OODA so the LLM can handle it
        }

        // ===== @MENTION ROUTING (works from all channels: web, Telegram, Discord, WhatsApp) =====
        if (!skipRouting) {
            const mention = await this.resolveMention(message);
            if (mention) {
                if (mention.forceGoalMode) {
                    // Task @mention → route straight to GoalOrientedExecutor with named profile
                    try {
                        const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                        const recentMsgs = await db.all(
                            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 10',
                            [convId]
                        ) as { role: string; content: string }[];
                        const goalResult = await goalOrientedExecutor.executeGoal(mention.effectiveMessage, userId, {
                            enable_hitl: true,
                            enableNetwork: true,
                            profile: mention.namedAgentSlug,
                            conversationContext: recentMsgs.map((r: any) => ({ role: r.role as 'user' | 'assistant', content: r.content })),
                            conversationId: convId,
                        });
                        const finalResp = await this.buildGoalCompletionMessage(goalResult);
                        await db.run(
                            'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                            [randomUUID(), convId, 'assistant', finalResp]
                        );
                        const generatedFiles = ((goalResult.summary?.artifacts_created || []) as string[]).filter((f: string) => !f.includes('_goal_script'));
                        return { response: finalResp, conversationId: convId, generatedFiles };
                    } catch (err: any) {
                        console.warn('[Orchestrator] @mention goal routing failed, falling through to OODA:', err.message);
                    }
                } else {
                    // Conversational @mention → continue OODA but with agent persona injected
                    agentOverride = mention.namedAgentSystemPrompt;
                }
            }
        }

        // ===== OBSERVE Phase =====
        emitOODA('observe', `Received message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`, { userId });

        // ===== PLANNING PHASE (for complex tasks) =====
        // Detect if this is a creation/building task that needs planning
        const complexTaskKeywords = ['create', 'make', 'build', 'implement', 'develop', 'write', 'generate'];
        const isComplexTask = complexTaskKeywords.some(k => message.toLowerCase().includes(k));

        if (isComplexTask) {
            emitOODA('orient', 'Detected complex task - creating execution plan...');
            emitChatProgress('planning', {
                conversationId: convId,
                status: 'Creating plan...'
            });
        }


        // 1. Gather Context
        const persona = await memoryManager.getPersona(userId);
        const recentEvents = await memoryManager.getRecentEvents(5);
        const mcpTools = await mcpManager.listTools();

        emitOODA('observe', `Gathered context: ${recentEvents.length} recent events, ${mcpTools.length} available tools`, {
            persona: persona.name,
            eventCount: recentEvents.length,
            toolCount: mcpTools.length
        });

        // ===== ORIENT Phase =====
        const systemPrompt = await this.getSystemPrompt(persona, recentEvents, userId, message, agentOverride);
        // Use smart routing: classify message and pick best adapter
        const { adapter: routedAdapter, taskType } = modelRouter.route(message);
        const llm = routedAdapter || modelManager.getActiveAdapter();
        const modelStatus = modelManager.getActiveModelStatus();  // must come before modelSizeB

        // Trim tool list for small models — large schemas overwhelm <32B models and
        // cause empty/malformed JSON responses. Unknown models default to full list.
        const modelSizeB = this.detectModelSizeBillions(modelStatus.model || '');
        const CORE_TOOLS = ['web_search', 'web_fetch', 'read_file', 'write_file',
            'list_directory', 'run_command', 'create_directory', 'search_files',
            'get_file_info', 'web_search_status'];
        const toolsForModel = (() => {
            // 1. Small-model cap (keep core tools only)
            let tools = modelSizeB < 32
                ? mcpTools.filter(t => CORE_TOOLS.includes(t.tool.name))
                : mcpTools;
            // 2. Profile whitelist (overrides model cap — whitelist is intentional, honour it)
            const wl = profileOptions?.toolWhitelist;
            if (wl && wl.length > 0) {
                tools = mcpTools.filter(t => wl.includes(t.tool.name));
            }
            return tools;
        })();

        // Compact tool format: name(params) + first line of description.
        // Full JSON schemas (~80-120 tok/tool × 56 tools = ~5000 tok) replaced with
        // param signature (~15 tok/tool × 56 = ~840 tok). No capability loss — all
        // tools remain visible; the model can infer types from param names.
        const toolsDescription = toolsForModel.map(t => {
            const props = t.tool.inputSchema?.properties || {};
            const required = new Set<string>(t.tool.inputSchema?.required || []);
            const paramList = Object.keys(props)
                .map(k => required.has(k) ? k : `${k}?`)
                .join(', ');
            const desc = (t.tool.description || '').split('\n')[0].substring(0, 90);
            return `- ${t.tool.name}(${paramList}): ${desc}`;
        }).join('\n');

        emitOODA('orient', `Using model: ${modelStatus.model}`, { provider: modelStatus.provider });

        // Initialize conversation with user message
        // On resume (skipRouting=true), conversationHistory was already restored and the
        // HITL answer already injected — don't push the raw message again.
        if (!skipRouting) {
            conversationHistory.push({ role: 'user', content: message });
        }

        // Track failed tool calls for smarter loop detection
        let consecutiveFailures = 0;

        // ===== PRE-FLIGHT: AUTO-ESCALATE COMPLEX REQUESTS TO GOAL MODE =====
        // Heuristic: score the message for multi-step complexity. If score >= 4,
        // skip the OODA loop and delegate straight to GoalOrientedExecutor.
        // This avoids wasting iterations on "I should use goal mode" decisions.
        if (!skipRouting && (mode === 'auto' || mode === 'chat')) {
            const lastAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant')?.content;
            const escalationScore = scoreForGoalEscalation(message, lastAssistant);
            if (escalationScore >= 4) {
                console.log(`[Orchestrator] Pre-flight escalation to goal mode (score=${escalationScore}): "${message.substring(0, 80)}"`);
                emitOODA('orient', `Routing to Goal mode (complexity score: ${escalationScore})`);

                // === CLARIFICATION STEP ===
                // Ask the LLM if the goal is ambiguous before running.
                // If questions are returned, reply with them and wait for the next message.
                try {
                    const recentMsgsForCtx = convId
                        ? await db.all(
                            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 5',
                            [convId]
                        ) as { role: string; content: string }[]
                        : [];
                    const questions = await goalClarifier.generateQuestions(message, recentMsgsForCtx);
                    if (questions.length > 0) {
                        // Store pending goal — expires in 5 minutes
                        pendingGoals.set(convId, {
                            goalText: message,
                            questions,
                            expiresAt: Date.now() + 5 * 60 * 1000
                        });
                        const qMsg = goalClarifier.formatQuestionsAsMessage(questions);
                        await db.run(
                            'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                            [randomUUID(), convId, 'assistant', qMsg]
                        );
                        return { response: qMsg, conversationId: convId };
                    }
                } catch (err: any) {
                    // Timeout is expected for cloud/large models — GoalClarifier already logs it.
                    // Only log unexpected errors here.
                    if (!err?.message?.includes('timed out')) {
                        console.warn('[Orchestrator] Clarification check failed unexpectedly, skipping:', err.message);
                    }
                }
                // === END CLARIFICATION STEP ===

                try {
                    const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                    const recentMsgs = convId
                        ? await db.all(
                            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 10',
                            [convId]
                        ).then((rows: any[]) => rows.reverse())
                        : [];
                    const goalResult = await goalOrientedExecutor.executeGoal(message, userId, {
                        enable_hitl: true,
                        enableNetwork: true,
                        conversationContext: recentMsgs.map((r: any) => ({ role: r.role as 'user' | 'assistant', content: r.content })),
                        conversationId: convId
                    });
                    const finalResp = await this.buildGoalCompletionMessage(goalResult);
                    await db.run(
                        'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                        [randomUUID(), convId, 'assistant', finalResp]
                    );
                    // If the goal failed, remember it so "yes" / "retry" re-runs in the same dir
                    if (goalResult.status !== 'completed' && convId) {
                        pendingRetry.set(convId, { goalText: message, expiresAt: Date.now() + 5 * 60 * 1000, outputDir: goalResult.final_state?.outputDir });
                    }
                    const generatedFiles = ((goalResult.summary?.artifacts_created || []) as string[]).filter((f: string) => !f.includes('_goal_script'));
                    return { response: finalResp, conversationId: convId, generatedFiles };
                } catch (err: any) {
                    console.warn('[Orchestrator] Goal escalation failed, falling through to OODA:', err.message);
                    // Fall through to normal OODA loop on error
                }
            }
        }

        // ===== NATIVE SEARCH FAST-PATH =====
        // For adapters with native search (e.g. Ollama), use it unless the message
        // is clearly a task (create/build/code/deploy) OR a simple conversational message.
        // Conversational messages (test, hi, help, thanks, etc.) must go to direct LLM
        // response — searching the web for "test" returns encyclopedia articles, not chat.
        if (!skipRouting && llm.nativeSearch && llm.generateWithSearch && !this.isTaskQuery(message) && !this.isConversationalMessage(message)) {
            try {
                emitOODA('orient', `Native search via ${modelStatus.provider} — skipping tool loop`);
                const result = await llm.generateWithSearch(message, { systemPrompt, temperature: 0.5 });
                let reply = result.text;
                if (result.sources.length > 0) {
                    const deduped = result.sources.filter((s, i, arr) => arr.findIndex(x => x.url === s.url) === i);
                    reply += `\n\n**Sources:**\n${deduped.map(s => `- [${s.title || s.url}](${s.url})`).join('\n')}`;
                }
                // Save to memory + conversation
                await memoryManager.storeEvent({
                    event_type: 'conversation',
                    event_text: `User: ${message.substring(0, 100)} | Native search via ${modelStatus.provider}`,
                    user_id: userId,
                });
                await db.run(
                    'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                    [randomUUID(), convId, 'assistant', reply]
                );
                return { response: reply, conversationId: convId };
            } catch (err: any) {
                console.warn(`[Orchestrator] Native search failed (${err.message}), falling back to OODA`);
                // Fall through to OODA loop
            }
        }

        try {
            // ===== AGENTIC LOOP =====
            this.clearCancellation(convId);   // clear any stale cancellation from previous session
            while (iteration < MAX_ITERATIONS) {
                // Check if user cancelled this conversation
                if (this.isCancelled(convId)) {
                    console.log(`[Orchestrator] Chat cancelled by user: ${convId}`);
                    this.clearCancellation(convId);
                    finalResponse = 'Execution stopped by user.';
                    break;
                }

                iteration++;
                emitOODA('decide', `Iteration ${iteration}/${MAX_ITERATIONS} - Analyzing next action...`);
                progressCallback?.(`_step:${iteration}:Thinking…`);

                // Compress history if it's getting too long
                conversationHistory = await conversationCompressor.compress(conversationHistory);

                // Build the decision prompt with conversation history
                const historyText = conversationHistory.map(m => {
                    const text = getTextContent(m.content);
                    return `${m.role.toUpperCase()}: ${text}`;
                }).join('\n');

                // Check for loop - if same tool called too many times, add instruction to break out
                const loopWarning = (sameToolCount >= MAX_SAME_TOOL - 2)
                    ? `\n\nWARNING: You have called "${lastToolName}" ${sameToolCount} times in a row. You MUST use a DIFFERENT tool now or complete the task. DO NOT call ${lastToolName} again.`
                    : '';

                // Force conclusion when approaching max iterations or too many failures
                const nearingLimit = iteration >= Math.floor(MAX_ITERATIONS * 0.8);
                const tooManyFailures = consecutiveFailures >= 3;
                const wrapUpWarning = (nearingLimit || tooManyFailures)
                    ? `\n\nIMPORTANT: You are ${nearingLimit ? 'running low on iterations' : 'experiencing repeated failures'}. You MUST summarize what you have found so far and provide a final answer NOW. Set taskComplete: true and include ALL information gathered from previous tool calls in your response. Do NOT call another tool — synthesize your existing data into a helpful answer.`
                    : '';

                // Get recent tool history for context
                const recentTools = allToolCalls.slice(-5).map(t => t.tool).join(' -> ');

                // === Smart search fallback hint ===
                // If the last tool was web_search and it failed, nudge the LLM toward browser-based search
                const lastCall = allToolCalls[allToolCalls.length - 1];
                const searchFallbackHint = (lastCall?.tool === 'web_search' && lastCall?.softFailure)
                    ? `\n\n⚠️ SEARCH FAILED: web_search returned an error. You MUST try a different approach now. Use browser_navigate to go to https://www.google.com/search?q=${encodeURIComponent(lastCall.args?.query || '')} and then browser_screenshot to read the results visually.`
                    : '';

                // When this is a follow-up in an ongoing conversation, remind the LLM to
                // use the full topic from history — not just the literal current message.
                const priorUserTurns = conversationHistory.filter(m => m.role === 'user').length;
                const contextReminder = priorUserTurns >= 1
                    ? `\n[CONTEXT REMINDER] This is a follow-up message in an ongoing conversation (turn ${priorUserTurns + 1}). The user's message "${message}" is a FOLLOW-UP INSTRUCTION — treat it as a command to act on the topic from previous messages, NOT a standalone question. If it says "confirm", "verify", "check again", "use more sources", or similar — actually use tools to re-research the topic from conversation history. When calling tools, construct queries that reflect the FULL TOPIC above.`
                    : '';

                const decisionPrompt = `
${systemPrompt}

[AVAILABLE TOOLS WITH SCHEMAS]
${toolsDescription || 'No tools available'}

[CONVERSATION SO FAR]
${historyText}

[CURRENT PROGRESS]
Tools used so far: ${allToolCalls.length}
Recent tool sequence: ${recentTools || 'none'}
Iteration: ${iteration}/${MAX_ITERATIONS}
${loopWarning}${wrapUpWarning}${searchFallbackHint}${contextReminder}

[DECISION REQUIRED]
${this.getDecisionRules(mode)}

RESPONSE FORMAT (strict JSON only):
If you need to use a tool:
{"needsTool": true, "tool": "tool_name", "args": {"param": "value"}, "reasoning": "brief explanation"}

If the task requires multi-step autonomous execution (creating projects, building apps, complex workflows):
{"needsTool": false, "taskComplete": false, "escalateToGoal": true, "response": "This task requires Goal mode for autonomous multi-step execution."}

If you can answer directly:
{"needsTool": false, "taskComplete": true, "response": "your answer here"}
`;

                const _llmStart = Date.now();
                let decision: any;
                try {
                    decision = await llm.generateJSON(decisionPrompt, {});
                } catch (jsonErr: any) {
                    // Rate limit / quota exhaustion — bail immediately, don't attempt fallbacks
                    const errMsg = (jsonErr.message || '').toLowerCase();
                    const isRateLimit = jsonErr.status_code === 429 ||
                        errMsg.includes('rate limit') || errMsg.includes('usage limit') ||
                        errMsg.includes('weekly') || errMsg.includes('quota') ||
                        errMsg.includes('too many requests');
                    if (isRateLimit) {
                        emitOODA('reflect', `Rate limit hit on ${modelStatus.model}: ${jsonErr.message}`);
                        finalResponse = `**Rate limit reached** for \`${modelStatus.model}\`.\n\n${jsonErr.message}\n\nPlease wait, or switch to a different model in Settings → Model.`;
                        break;
                    }

                    // Empty response (rawText: '') means the model can't handle the full OODA prompt —
                    // typically a smaller model overwhelmed by 56 tools + history.
                    // Fallback 1: if this looks like a search query, use native search.
                    // Fallback 2: stream a direct LLM answer with no tools.
                    const isEmpty = !jsonErr.rawText || jsonErr.rawText.trim() === '';
                    emitOODA('reflect', `JSON generation failed${isEmpty ? ' (empty response — model context limit?)' : ''}: ${jsonErr.message}`);
                    if (isEmpty && llm.nativeSearch && llm.generateWithSearch) {
                        emitOODA('orient', `Empty JSON from model — falling back to native search`);
                        const result = await llm.generateWithSearch(message, { systemPrompt, temperature: 0.5 });
                        let reply = result.text;
                        if (result.sources?.length > 0) {
                            const deduped = result.sources.filter((s: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.url === s.url) === i);
                            reply += `\n\n**Sources:**\n${deduped.map((s: any) => `- [${s.title || s.url}](${s.url})`).join('\n')}`;
                        }
                        finalResponse = reply;
                        break;
                    }
                    if (isEmpty) {
                        // Last resort: ask the LLM to just answer directly with streaming (no JSON needed)
                        emitOODA('orient', `Empty JSON from model — falling back to direct answer`);
                        finalResponse = await llm.generate(message, { systemPrompt, temperature: 0.7 })
                            .catch(() => `I'm unable to process that request right now. The model returned an empty response — this usually means the model is overwhelmed by the tool list. Try switching to a larger model or use Goal mode for complex queries.`);
                        break;
                    }
                    // Non-empty but un-parseable: model returned prose instead of JSON
                    // (common when context grows large and model "forgets" the JSON instruction).
                    // Use the prose as the final answer rather than crashing the session.
                    const proseText = (jsonErr.rawText || '')
                        .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    if (proseText.length > 20) {
                        // Guard: if the "prose" is actually a raw JSON tool-call object leaked
                        // from the model (e.g. {"needsTool":true,"tool":"write_file",...}),
                        // do NOT show it to the user — produce a neutral summary instead.
                        const looksLikeToolJson = /^\s*\{[\s\S]*"needsTool"\s*:/.test(proseText)
                            || /^\s*\{[\s\S]*"tool"\s*:\s*"[a-z_]+"/.test(proseText);
                        if (looksLikeToolJson) {
                            emitOODA('reflect', `Suppressed raw tool-JSON response on iteration ${iteration} — substituting summary`);
                            // If a tool already ran this session, summarize what was done
                            if (allToolCalls.length > 0) {
                                const last = allToolCalls[allToolCalls.length - 1];
                                finalResponse = `Done. Used \`${last.tool}\` to complete the task.${last.output ? ` Result: ${String(last.output).substring(0, 200)}` : ''}`;
                            } else {
                                finalResponse = 'Task completed.';
                            }
                            break;
                        }
                        emitOODA('reflect', `Non-JSON response on iteration ${iteration} — using prose as final answer`);
                        finalResponse = proseText;
                        break;
                    }
                    throw jsonErr; // Truly empty after stripping — re-throw
                }
                const _llmLatency = Date.now() - _llmStart;
                usageTracker.record({
                    provider: modelStatus.provider,
                    model: modelStatus.model,
                    taskType: taskType || 'chat',
                    promptTokens: Math.ceil(decisionPrompt.length / 4),
                    completionTokens: Math.ceil(JSON.stringify(decision).length / 4),
                    estimatedCost: 0,
                    latencyMs: _llmLatency,
                    conversationId: convId,
                }).catch(() => { });

                // Handle escalation to goal mode (auto mode decided task is too complex)
                if (decision.escalateToGoal) {
                    emitOODA('decide', 'Auto mode escalating to Goal execution...');
                    try {
                        const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                        const recentMsgs = convId
                            ? await db.all(
                                'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 10',
                                [convId]
                            ).then(rows => rows.reverse())
                            : [];
                        const goalResult = await goalOrientedExecutor.executeGoal(message, userId, {
                            enable_hitl: true,
                            conversationContext: recentMsgs.map((r: any) => ({ role: r.role, content: r.content })),
                            conversationId: convId
                        });
                        finalResponse = await this.buildGoalCompletionMessage(goalResult);
                    } catch (e) {
                        finalResponse = `Error during goal execution: ${e}`;
                    }
                    break;
                }

                if (decision.needsTool && decision.tool) {
                    // ===== CHAT MODE: Block write/execute tools (only in chat mode, not auto) =====
                    if (mode === 'chat') {
                        const WRITE_TOOLS_BLOCKED = ['write_file', 'create_directory', 'move_file', 'edit_file', 'run_command'];
                        if (WRITE_TOOLS_BLOCKED.includes(decision.tool)) {
                            finalResponse = `This task requires **Auto mode** or **Goal mode** to create or modify files. ` +
                                `Please switch modes using the toggle button, then try again.\n\n` +
                                `Your request: "${message.substring(0, 100)}"`;
                            emitOODA('reflect', `Write operation "${decision.tool}" blocked in chat mode`);
                            break;
                        }
                    }

                    // ===== TOOL EXECUTION =====
                    emitOODA('decide', `Iteration ${iteration}: Using tool "${decision.tool}" - ${decision.reasoning || ''}`, { decision });
                    progressCallback?.(`_step:${iteration}:${decision.tool}:${decision.reasoning || ''}`);

                    // Create execution plan
                    const plan: ExecutionPlan = {
                        id: `plan_${Date.now()}_${iteration}`,
                        description: decision.reasoning || `Execute ${decision.tool}`,
                        steps: [{
                            id: `step_${iteration}`,
                            action: decision.tool,
                            description: decision.reasoning || `Call ${decision.tool}`,
                            tool: decision.tool,
                            args: decision.args,
                            requiresConfirmation: this.isDestructiveAction(decision.tool),
                            status: 'pending'
                        }],
                        status: 'pending_approval'
                    };

                    // ===== HITL: Configurable approval based on operation type =====
                    const isDestructive = plan.steps[0].requiresConfirmation;
                    const needsApproval = execConfig.autonomous_mode
                        ? (isDestructive && execConfig.require_approval_for_writes)
                        : true;  // Non-autonomous mode requires approval for everything

                    if (needsApproval) {
                        emitOODA('decide', `Step ${iteration}: ${plan.description}. Awaiting approval...`, { plan });

                        const approved = await emitPlanPreview(plan);

                        if (!approved) {
                            plan.status = 'rejected';
                            emitOODA('reflect', `Plan rejected by user at step ${iteration}`);
                            return {
                                response: "Plan was rejected. Let me know if you'd like me to try a different approach.",
                                toolCalls: allToolCalls,
                                plan
                            };
                        }
                    } else {
                        // Auto-approve based on config
                        emitOODA('decide', `Step ${iteration}: ${plan.description} (auto-approved)`, { plan });
                    }

                    plan.status = 'executing';

                    // ===== ACT Phase =====
                    emitOODA('act', `Executing tool: ${decision.tool}`, { args: decision.args, iteration });

                    // Stream step progress to chat UI
                    emitChatProgress('step_start', {
                        conversationId: convId,
                        step: iteration,
                        tool: decision.tool,
                        description: decision.reasoning || `Running ${decision.tool}...`,
                        status: 'executing'
                    });

                    let toolResult = "";
                    let screenshotBase64: string | null = null;
                    try {
                        // Resolve common LLM tool name aliases before lookup
                        const OODA_TOOL_ALIASES: Record<string, string> = {
                            bash: 'run_command', shell: 'run_command', exec: 'run_command',
                            save_file: 'write_file', create_file: 'write_file',
                            mkdir: 'create_directory', make_directory: 'create_directory',
                            search: 'web_search', google: 'web_search', bing: 'web_search',
                            browser_search: 'web_search', web_browse: 'browser_navigate',
                            read: 'read_file', cat: 'read_file',
                            ls: 'list_directory', dir: 'list_directory',
                        };
                        const resolvedTool = OODA_TOOL_ALIASES[decision.tool] || decision.tool;
                        if (resolvedTool !== decision.tool) {
                            console.log(`[Orchestrator] Resolved alias: "${decision.tool}" → "${resolvedTool}"`);
                        }

                        const toolDef = mcpTools.find(t => t.tool.name === resolvedTool);
                        if (!toolDef) throw new Error(`Tool ${decision.tool} not found`);

                        const result = await mcpManager.callTool(toolDef.server, resolvedTool, decision.args);
                        toolResult = typeof result === 'string' ? result : JSON.stringify(result);

                        // Detect context_reset signal — clear conversation history
                        if (result && typeof result === 'object' && (result as any)._contextReset) {
                            console.log('[Orchestrator] Context reset signal received — clearing conversation history');
                            conversationHistory.length = 0; // Clear in-place
                            toolResult = (result as any).message || 'Context has been reset. You can now start fresh.';
                        }

                        // Detect HITL proactive input signal
                        if (result && typeof result === 'object' && (result as any)._hitlRequest) {
                            console.log('[Orchestrator] Proactive HITL input requested - pausing loop');

                            const hitlQuestion = (result as any).question as string;

                            // ── Serialize full OODA state (Gaps 1, 3, 4) ──────────────────
                            try {
                                // Snapshot workspace files so LLM knows what existed at pause time
                                let workspaceFiles: string[] = [];
                                try {
                                    const dirRes = await mcpManager.callTool('filesystem', 'list_directory', { path: '/workspace' });
                                    const entries: any[] = Array.isArray(dirRes) ? dirRes : (dirRes as any)?.entries || [];
                                    workspaceFiles = entries.map((e: any) => e.name || String(e)).filter(Boolean);
                                } catch { /* non-fatal — workspace snapshot is best-effort */ }

                                // Hold the container alive so the 30-min idle timer doesn't fire (Gap 1)
                                let containerSessionId: string | null = null;
                                try {
                                    const { containerSessionManager } = await import('../execution/ContainerSession');
                                    const session = containerSessionManager.getExistingSession(userId);
                                    if (session) {
                                        containerSessionId = session.containerName;
                                        session.holdAlive();
                                    }
                                } catch { /* non-fatal */ }

                                const modelStatus = modelManager.getActiveModel();
                                await savePausedOODAState({
                                    conversationId: convId,
                                    userId,
                                    mode,
                                    iteration,
                                    conversationHistory: [...conversationHistory],
                                    allToolCalls: [...allToolCalls],
                                    pendingTool: decision.tool,          // Gap 3: save tool name
                                    pendingArgs: decision.args || {},     // Gap 3: save tool args
                                    pendingQuestion: hitlQuestion,
                                    containerSessionId,                   // Gap 1: save container ref
                                    workspaceFiles,                       // Gap 1: workspace snapshot
                                    modelKey: modelStatus?.provider || '',
                                    // expiresAt is set in SQL as datetime('now', '+30 minutes') (Gap 4)
                                });
                                console.log(`[Orchestrator] OODA state serialized for ${convId} — expires in 30 min`);
                            } catch (saveErr: any) {
                                console.warn('[Orchestrator] Failed to save paused OODA state:', saveErr.message);
                            }
                            // ─────────────────────────────────────────────────────────────

                            // Send custom UI event to prompt the user
                            emitChatProgress('step_complete', {
                                conversationId: convId,
                                step: iteration,
                                tool: decision.tool,
                                success: true,
                                result: `Awaiting your input: ${hitlQuestion}`
                            });

                            if (gateway && gateway.io) {
                                gateway.io.emit('goal:user-input-needed', {
                                    execution_id: convId,
                                    inputId: `chat_input_${Date.now()}`,
                                    message: hitlQuestion,
                                    fields: (result as any).fields,
                                    proactive: true
                                });
                            }

                            finalResponse = `**Action Required:**\n\n${hitlQuestion}\n\n*(Please reply with the information requested — I will resume right where I left off.)*`;
                            break; // Exit the loop — user reply will trigger resume via loadPausedOODAState
                        }

                        // Detect screenshot results and emit as image rich content
                        if (decision.tool === 'browser_screenshot' && result && typeof result === 'object' && (result as any).base64) {
                            screenshotBase64 = (result as any).base64;
                            emitChatProgress('image', {
                                conversationId: convId,
                                richContent: {
                                    type: 'image',
                                    image: {
                                        base64: screenshotBase64,
                                        alt: `Screenshot from ${decision.args?.path || 'browser'}`,
                                        mimeType: 'image/png',
                                    },
                                },
                            });
                            // Also emit to Inspector browser preview panel (same event Goal mode uses)
                            const { browserServer } = await import('../mcp/servers/BrowserServer');
                            if (gateway?.io) {
                                gateway.io.emit('browser:screenshot', {
                                    base64: screenshotBase64,
                                    mimeType: 'image/png',
                                    url: browserServer.getCurrentUrl(),
                                    iteration: iteration,
                                });
                            }

                            // Browser human-control: if user took control, pause OODA loop here
                            const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                            if (goalOrientedExecutor.browserControlActive) {
                                console.log('[Orchestrator] Browser control active — pausing OODA loop');
                                while (goalOrientedExecutor.browserControlActive) {
                                    await new Promise(r => setTimeout(r, 500));
                                }
                                console.log('[Orchestrator] Browser control released — resuming OODA');
                            }
                        }

                        // Detect soft failures (tool returned but with error content)
                        const isSoftFailure = toolResult.toLowerCase().includes('failed') ||
                            toolResult.toLowerCase().includes('error') ||
                            toolResult.toLowerCase().includes('blocked') ||
                            toolResult.toLowerCase().includes('not found') ||
                            toolResult.trim().length < 10;

                        if (isSoftFailure) {
                            consecutiveFailures++;
                        } else {
                            consecutiveFailures = 0; // Reset on successful data retrieval
                        }

                        plan.steps[0].status = 'completed';
                        allToolCalls.push({ tool: decision.tool, args: decision.args, output: toolResult, iteration, softFailure: isSoftFailure });

                        // ── Search escalation: auto web_fetch when web_search loops without useful data ──
                        if (resolvedTool === 'web_search' && !isSoftFailure) {
                            webSearchCount++;
                            // Extract top URL from search results for potential web_fetch escalation
                            try {
                                const parsed = JSON.parse(toolResult);
                                const firstUrl = parsed?.results?.[0]?.url || parsed?.[0]?.url || null;
                                if (firstUrl) lastSearchTopUrl = firstUrl;
                            } catch { /* toolResult may be plain text */ }

                            // Does the result contain useful data? (numbers, prices, %  — indicates real content)
                            const hasUsefulData = /[\d,.]+\s*(₹|rs|usd|\$|%|rupee|percent|point|inr)/i.test(toolResult) ||
                                /\b\d{4,}\b/.test(toolResult); // any 4+ digit number (price, index value)

                            if (webSearchCount >= 2 && !hasUsefulData && lastSearchTopUrl) {
                                // Force web_fetch on the top URL — bypass LLM decision
                                emitOODA('decide', `Search loop detected (${webSearchCount} searches, no numeric data) — auto-fetching top URL: ${lastSearchTopUrl}`);
                                try {
                                    const fetchTool = mcpTools.find(t => t.tool.name === 'web_fetch');
                                    if (fetchTool) {
                                        const fetchResult = await mcpManager.callTool(fetchTool.server, 'web_fetch', { url: lastSearchTopUrl, maxLength: 3000 });
                                        const fetchText = typeof fetchResult === 'string' ? fetchResult : JSON.stringify(fetchResult);
                                        toolResult += `\n\n[AUTO-FETCHED: ${lastSearchTopUrl}]\n${fetchText.substring(0, 2000)}`;
                                        conversationHistory.push({
                                            role: 'assistant',
                                            content: `Auto-fetched page content from ${lastSearchTopUrl} because search results lacked numeric data:\n${fetchText.substring(0, 1500)}`
                                        });
                                        webSearchCount = 0; // reset after escalation
                                        emitOODA('act', `web_fetch escalation complete — ${fetchText.length} chars retrieved`);
                                    }
                                } catch (fetchErr: any) {
                                    emitOODA('act', `web_fetch escalation failed: ${fetchErr.message}`);
                                }
                            }
                        }

                        // Track loop detection - FORCE break after 3 same calls
                        if (decision.tool === lastToolName) {
                            sameToolCount++;
                        } else {
                            sameToolCount = 1;
                            lastToolName = decision.tool;
                        }

                        // FORCE break out of loop - don't ask LLM, just stop exploring
                        const isReadTool = decision.tool === 'list_directory' || decision.tool === 'list_allowed_directories' || decision.tool === 'read_file';
                        const loopThreshold = isReadTool ? MAX_SAME_READ_TOOL : MAX_SAME_TOOL;
                        if (sameToolCount >= loopThreshold) {
                            emitOODA('reflect', `LOOP BREAK: ${decision.tool} called ${sameToolCount}+ times (limit: ${loopThreshold}). Forcing task completion.`);

                            // Force complete - summarize whatever was gathered
                            finalResponse = `I've been exploring using \`${decision.tool}\` extensively (${sameToolCount} calls). Here is what I found so far:\n\n${toolResult.substring(0, 1000)}\n\nI appear to be stuck in an exploration loop. Please try rephrasing your request or switch to **Goal mode** for complex multi-step tasks.`;

                            emitOODA('reflect', `Task stopped due to loop after ${iteration} iterations.`);
                            break; // EXIT THE LOOP
                        }

                        emitOODA('act', `Tool executed successfully`, { result: toolResult.substring(0, 200) });

                        // Stream step completion to chat UI
                        emitChatProgress('step_complete', {
                            conversationId: convId,
                            step: iteration,
                            tool: decision.tool,
                            success: true,
                            result: toolResult.substring(0, 200)
                        });
                    } catch (e) {
                        toolResult = `Error: ${e}`;
                        plan.steps[0].status = 'failed';
                        consecutiveFailures++;
                        emitOODA('act', `Tool execution failed: ${e}`);

                        // Stream step failure to chat UI
                        emitChatProgress('step_complete', {
                            conversationId: convId,
                            step: iteration,
                            tool: decision.tool,
                            success: false,
                            error: String(e)
                        });
                    }

                    // Add tool result to conversation history for next iteration
                    if (screenshotBase64) {
                        // Multimodal: inject the actual image so the LLM can see it
                        conversationHistory.push({
                            role: 'assistant',
                            content: [
                                { type: 'text', text: `Used tool: browser_screenshot — image captured from ${decision.args?.url || decision.args?.selector || 'current page'}:` },
                                { type: 'image', base64: screenshotBase64, mimeType: 'image/png' },
                            ]
                        });
                    } else {
                        // Browser content tools can return large payloads — give the LLM enough
                        // to actually see what was extracted so it moves on instead of re-calling.
                        const CONTENT_TOOLS = new Set(['browser_extract', 'browser_get_content', 'browser_evaluate', 'web_fetch']);
                        const resultLimit = CONTENT_TOOLS.has(decision.tool) ? 3000 : 500;
                        conversationHistory.push({
                            role: 'assistant',
                            content: `Used tool: ${decision.tool}\nResult: ${toolResult.substring(0, resultLimit)}`
                        });
                    }

                } else {
                    // ===== TASK COMPLETE or INTERMEDIATE RESPONSE =====

                    // Normalize decision.response to a plain string.
                    // The LLM occasionally returns a wrapper object like {text: "..."} or
                    // an array instead of a bare string — coerce it cleanly here so
                    // downstream code never sees [object Object].
                    let rawResp: string;
                    const dr = decision.response;
                    if (typeof dr === 'string') {
                        rawResp = dr;
                    } else if (dr && typeof dr === 'object') {
                        // Common wrapper shapes the LLM produces
                        rawResp = (dr as any).text
                            || (dr as any).message
                            || (dr as any).content
                            || (dr as any).summary
                            || (dr as any).response
                            || (Array.isArray(dr) ? dr.map((x: any) => (typeof x === 'string' ? x : x?.text || JSON.stringify(x))).join('\n') : JSON.stringify(dr, null, 2));
                    } else {
                        rawResp = '';
                    }

                    // Guard: reject raw JSON tool-call objects leaking into the response field
                    const isLeakedJson = /^\s*\{[\s\S]*"needsTool"\s*:/.test(rawResp)
                        || /^\s*\{[\s\S]*"tool"\s*:\s*"[a-z_]+"/.test(rawResp);
                    finalResponse = isLeakedJson
                        ? (allToolCalls.length > 0
                            ? `Done. Used \`${allToolCalls[allToolCalls.length - 1].tool}\` — task completed.`
                            : 'Task completed.')
                        : (rawResp || 'Task completed.');

                    // Check for various indicators that this isn't really complete
                    const isParseError = decision._parseError || decision._normalized;
                    const isIntermediateResponse = decision.reasoning?.includes('intermediate') ||
                        decision.reasoning?.includes('may need to continue') ||
                        decision.reasoning?.includes('gathering more context');

                    // Handle parse errors gracefully - don't force tool use
                    if (isParseError) {
                        emitOODA('reflect', `LLM parse error occurred, accepting response as-is`);
                        if (!finalResponse || finalResponse === 'Task completed.') {
                            finalResponse = 'I had trouble processing that request. Could you try rephrasing?';
                        }
                    }

                    // Handle intermediate responses - retry once at most
                    if (isIntermediateResponse && iteration < 3) {
                        emitOODA('reflect', `Model gave intermediate response, retrying...`);
                        conversationHistory.push({
                            role: 'system',
                            content: `Please provide a complete answer. Use read-only tools if needed.`
                        });
                        continue;
                    }

                    // Accept completion - chat mode trusts the LLM's response
                    if (decision.taskComplete || finalResponse) {
                        // Guard: finalResponse may be an object if buildGoalCompletionMessage returned one
                        if (typeof finalResponse !== 'string') finalResponse = String(finalResponse ?? '');
                        emitOODA('reflect', `Chat completed after ${iteration} iteration(s)`, {
                            totalToolCalls: allToolCalls.length,
                            response: finalResponse.substring(0, 100)
                        });

                        emitChatProgress('execution_done', {
                            conversationId: convId,
                            totalSteps: iteration,
                            success: true,
                            toolCallCount: allToolCalls.length,
                            agentSlug: profileOptions?.agentSlug,
                        });
                    } else if (allToolCalls.length > 0) {
                        // Has data but no response - ask for summary
                        emitOODA('reflect', `Has data but no response, requesting summary...`);
                        conversationHistory.push({
                            role: 'system',
                            content: `Provide a final response summarizing what you found. Set taskComplete: true.`
                        });
                        continue;
                    }

                    break; // Exit the loop
                }
            }

            // Normalise finalResponse — downstream code (sources, DB insert, memory) always
            // expects a string. buildGoalCompletionMessage can resolve to an object.
            if (typeof finalResponse !== 'string') finalResponse = String(finalResponse ?? '');

            // If we hit max iterations, handle based on agent type
            if (iteration >= MAX_ITERATIONS && !finalResponse) {
                const agentType = profileOptions?.agentType ?? 'research';
                const agentSlug = profileOptions?.agentSlug;
                emitOODA('reflect', `Reached ${isProfileCapped ? `@${agentSlug} profile` : 'maximum'} iteration limit (${MAX_ITERATIONS}). agentType=${agentType}`);

                // Collect all tool outputs for context
                const toolSummary = allToolCalls
                    .filter(t => !t.softFailure && t.output && t.output.length > 20)
                    .map(t => `[${t.tool}]: ${t.output.substring(0, 500)}`)
                    .join('\n\n');

                if (agentType === 'execution' && isProfileCapped) {
                    // Execution agents: partial = wrong. Write handoff-context.md and escalate.
                    try {
                        const { path: nodePath } = await import('path');
                        const workspaceDir = process.env['AI_PARTNER_HOST_WORKSPACE'] || process.cwd();
                        const handoffPath = nodePath.join(workspaceDir, 'handoff-context.md');
                        const handoffContent = [
                            `# Handoff Context — @${agentSlug ?? 'agent'} (iteration cap reached)`,
                            `\n**Original task:** ${message}`,
                            `\n**Iterations attempted:** ${iteration}`,
                            `\n**Tools used:** ${allToolCalls.map(t => t.tool).join(', ')}`,
                            toolSummary ? `\n\n## Partial Data Collected\n\n${toolSummary.substring(0, 3000)}` : '',
                            `\n\n---\n*Resume this task in Goal mode — it will read this file as prior context.*`,
                        ].join('');
                        const fs = await import('fs/promises');
                        await fs.writeFile(handoffPath, handoffContent, 'utf8');
                    } catch { /* non-fatal — handoff file is best-effort */ }

                    // Extract handoff hint from system prompt (line starting with "For ")
                    const handoffHint = agentOverride
                        ? (agentOverride.match(/For [^.]+\.\s*/)?.[0] ?? '')
                        : '';

                    finalResponse = [
                        `**@${agentSlug ?? 'Agent'} reached its ${MAX_ITERATIONS}-iteration limit** — the task is incomplete.`,
                        `\nPartial progress has been saved to \`handoff-context.md\` in your workspace.`,
                        handoffHint ? `\n\n${handoffHint}` : '',
                        `\n\n**To complete this task:** Switch to **Goal mode** — it will pick up the handoff context and continue without repeating completed steps.`,
                    ].join('');

                } else if (agentType === 'delivery' && isProfileCapped) {
                    // Delivery agents: nothing was sent — be explicit, no fake summary
                    const handoffHint = agentOverride
                        ? (agentOverride.match(/For [^.]+\.\s*/)?.[0] ?? '')
                        : '';
                    finalResponse = [
                        `**@${agentSlug ?? 'Agent'} reached its ${MAX_ITERATIONS}-iteration limit** — no message was delivered.`,
                        toolSummary ? `\n\nContent prepared but not sent:\n\n${toolSummary.substring(0, 1000)}` : '',
                        handoffHint ? `\n\n${handoffHint}` : '',
                        `\n\nRetry in **Goal mode** for a longer execution window.`,
                    ].join('');

                } else if (toolSummary.length > 50) {
                    // Research / synthesis agents: partial data is still useful — synthesize
                    try {
                        const summarizePrompt = `You gathered the following data using various tools to answer the user's question.

USER'S ORIGINAL QUESTION: ${message}

DATA COLLECTED FROM TOOLS:
${toolSummary.substring(0, 4000)}

Provide a clear, helpful answer based on the data you collected. Note any gaps. Do NOT say "I couldn't find anything" if there IS data above.

Respond with JSON: {"taskComplete": true, "response": "your comprehensive answer here"}`;

                        const summary = await llm.generateJSON(summarizePrompt, {});
                        finalResponse = summary.response || "I gathered some data but couldn't synthesize it properly. Here's what I found:\n\n" + toolSummary.substring(0, 2000);
                    } catch {
                        finalResponse = "I gathered information but hit the processing limit. Here's the raw data I collected:\n\n" + toolSummary.substring(0, 2000);
                    }
                    if (isProfileCapped) {
                        finalResponse += `\n\n*(Reached @${agentSlug}'s ${MAX_ITERATIONS}-iteration cap — for deeper analysis, try **Goal mode**)*`;
                    }
                } else {
                    finalResponse = `I tried ${allToolCalls.length} approaches but wasn't able to retrieve useful data for your request. This may be due to:\n\n` +
                        `- **Search service issues** (rate limiting, blocks)\n` +
                        `- **Website access restrictions** (CAPTCHAs, authentication)\n\n` +
                        `**Suggestions:**\n` +
                        `1. Try rephrasing your request\n` +
                        `2. Try a more specific query\n` +
                        `3. Use Goal mode for complex multi-step tasks`;
                }

                emitChatProgress('execution_done', {
                    conversationId: convId,
                    totalSteps: iteration,
                    success: false,
                    toolCallCount: allToolCalls.length,
                    agentSlug: profileOptions?.agentSlug,
                });
            }

            // Auto-append sources if the response used web_search/web_fetch but didn't cite them
            const webCalls = allToolCalls.filter(t => t.tool === 'web_search' || t.tool === 'web_fetch');
            if (webCalls.length > 0 && !String(finalResponse).toLowerCase().includes('sources:') && !String(finalResponse).toLowerCase().includes('source:')) {
                const seenUrls = new Set<string>();
                const sourceLines: string[] = [];
                for (const call of webCalls) {
                    const results = call.result?.results || [];
                    for (const r of results) {
                        if (r.url && !seenUrls.has(r.url)) {
                            seenUrls.add(r.url);
                            sourceLines.push(`- [${r.title || r.url}](${r.url})`);
                        }
                    }
                    // web_fetch: just cite the URL itself
                    if (call.tool === 'web_fetch' && call.args?.url && !seenUrls.has(call.args.url)) {
                        seenUrls.add(call.args.url);
                        sourceLines.push(`- [${call.args.url}](${call.args.url})`);
                    }
                }
                if (sourceLines.length > 0) {
                    finalResponse += `\n\n**Sources:**\n${sourceLines.join('\n')}`;
                }
            }

            // Save to memory
            await memoryManager.storeEvent({
                event_type: allToolCalls.length > 0 ? 'task_execution' : 'conversation',
                event_text: `User: ${message.substring(0, 50)}... | Steps: ${iteration} | Tools: ${allToolCalls.length}`
            });

            // Post-OODA skill capture — if run_command was called with real script content,
            // learn from the actual executed code (cheaper + more accurate than learnFromInstruction).
            // Conditions: 2+ tool calls, run_command with code > 100 chars, no existing similar skill.
            const runCmdCalls = allToolCalls.filter(t =>
                t.tool === 'run_command' &&
                typeof t.args?.command === 'string' &&
                (t.args.command as string).length > 100 &&
                !t.softFailure
            );
            if (runCmdCalls.length > 0 && allToolCalls.length >= 2) {
                // Use the longest run_command content — most likely the main script
                const bestCmd = runCmdCalls.reduce((a, b) =>
                    (a.args.command as string).length > (b.args.command as string).length ? a : b
                );
                const code = bestCmd.args.command as string;
                const runtime: 'python' | 'node' = code.includes('python3') || code.includes('import ') ? 'python' : 'node';
                // Fire-and-forget: non-blocking, won't delay response
                skillLearner.findMatchingSkill(message).then(existing => {
                    if (!existing) {
                        return skillLearner.learnFromSuccess(message, code, runtime, []);
                    }
                }).then(learned => {
                    if (learned) console.log('[Orchestrator] Post-OODA skill captured from run_command:', learned.name);
                }).catch(() => { /* non-fatal */ });
            }

            // Extract preferences from conversation (Phase 17.6 — async, non-blocking)
            import('../memory/MemoryConsolidator').then(({ memoryConsolidator }) => {
                memoryConsolidator.extractPreferences(
                    userId,
                    `User: ${message}\nAssistant: ${finalResponse}`
                ).catch(() => { });
            }).catch(() => { });

            // ===== SAVE ASSISTANT RESPONSE =====
            const assistantMsgId = randomUUID();
            await db.run(
                'INSERT INTO messages (id, conversation_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, datetime("now"))',
                [assistantMsgId, convId, 'assistant', finalResponse, JSON.stringify({ toolCalls: allToolCalls.length, iterations: iteration })]
            );

            return {
                response: finalResponse,
                toolCalls: allToolCalls,
                contextUsed: { events: recentEvents.length, iterations: iteration },
                conversationId: convId
            };

        } catch (e) {
            console.error('[Orchestrator] Error:', e);
            emitOODA('reflect', `Error occurred: ${e}`, { error: true });
            return { response: "I encountered an error processing your request." };
        }
    }

    /**
     * Check if an action is destructive and requires confirmation
     */
    private isDestructiveAction(tool: string): boolean {
        const toolLower = tool.toLowerCase();

        // Read-only operations - no approval needed
        const safeTools = [
            'read', 'list', 'search', 'get', 'find', 'directory_tree',
            'show', 'view', 'fetch', 'query', 'check', 'status'
        ];

        // Check if it's a safe/read-only tool
        if (safeTools.some(t => toolLower.includes(t))) {
            return false;
        }

        // Destructive operations - require approval
        const destructiveTools = [
            'write', 'create', 'delete', 'remove', 'update', 'modify',
            'run_shell', 'run_command', 'execute', 'shell', 'bash',
            'move', 'rename', 'edit', 'send', 'post', 'put'
        ];

        return destructiveTools.some(t => toolLower.includes(t));
    }

    /**
     * Get mode-specific decision rules for the OODA prompt
     */
    private getDecisionRules(mode: string): string {
        if (mode === 'auto') {
            return `You are an intelligent AI assistant in AUTO MODE with full tool access.

RULES:
1. You have access to ALL available tools listed above — use them proactively
2. For information gathering: use web_search, web_fetch, read_file, list_directory, search_files, etc.
3. For web browsing: use browser_navigate, browser_click, browser_screenshot, browser_type, etc.
4. For file operations: use write_file, create_directory, edit_file, run_command, etc.
5. For multi-step complex tasks (building entire projects, complex workflows), respond with escalateToGoal: true
6. Answer questions by USING TOOLS to find real information — do NOT make up answers
7. If the user asks about capabilities, demonstrate them by using the appropriate tool
8. Keep responses concise, accurate, and helpful
9. DO NOT repeat the same tool call — try a different approach if a tool fails
10. SEARCH FALLBACK: If web_search fails or returns no results, use browser_navigate to go to a search engine (e.g. https://www.google.com/search?q=YOUR+QUERY), then use browser_screenshot to capture the results. You can SEE screenshots — use them to read search results visually.
11. ALWAYS take a browser_screenshot after browser_navigate so you can see what's on the page
12. ALWAYS cite your sources: when your answer uses information from web_search or web_fetch results, end your response with a "Sources:" section listing the relevant URLs as markdown links. Example: "Sources:\n- [Title](url)"`;
        }

        // Chat mode: read-only, safe tools only
        return `You are a helpful AI assistant in CHAT MODE.

RULES:
1. You can use read-only and information-gathering tools: list_directory, read_file, search_files, get_file_info, web_search, web_fetch
2. You CANNOT use write_file, create_directory, run_command, or any write/execute tools
3. If the user asks to CREATE, BUILD, or MODIFY files, suggest they switch to Auto or Goal mode
4. Answer questions directly — use tools when needed to look up information
5. You CAN search the web, browse websites, and gather information
6. Keep responses concise and helpful
7. DO NOT repeat the same tool call
8. SEARCH FALLBACK: If web_search fails or returns no results, use browser_navigate to go to a search engine (e.g. https://www.google.com/search?q=YOUR+QUERY), then use browser_screenshot to capture the results. You can SEE screenshots.
9. ALWAYS take a browser_screenshot after browser_navigate to see what's on the page
10. ALWAYS cite your sources: when your answer uses information from web_search or web_fetch results, end your response with a "Sources:" section listing the relevant URLs as markdown links. Example: "Sources:\n- [Title](url)"`;
    }

    /**
     * Streaming chat - sends tokens via callback as they arrive.
     * For simple Q&A: streams LLM response token by token.
     * For tool-using tasks: runs OODA loop, streams final response.
     */
    async chatStreaming(
        userId: string,
        message: string,
        conversationId: string | undefined,
        mode: string,
        onToken: (data: { id: string; role: string; content: string; timestamp: Date; done: boolean; conversationId?: string }) => void,
        onConversationId?: (convId: string) => void
    ): Promise<void> {
        const messageId = randomUUID();

        // ── /auto command — update approval mode from any messaging channel ──
        // Works from Web chat, Telegram, Discord, WhatsApp — all routes through here.
        // Syntax: /auto on | /auto off | /auto all | /auto status
        const autoCmd = message.trim().match(/^\/auto(?:\s+(on|off|script|all|status))?$/i);
        if (autoCmd) {
            const arg = (autoCmd[1] || 'status').toLowerCase();
            const modeMap: Record<string, 'none' | 'script' | 'all'> = {
                on: 'none', off: 'script', script: 'script', all: 'all'
            };
            const modeLabels: Record<string, string> = {
                none: '🟢 Autonomous — agent runs end-to-end without pausing',
                script: '🟡 Script Review — scripts pause for your approval',
                all: '🔴 Manual — every write/command waits for approval (60s timeout → auto-deny)',
            };
            if (arg === 'status') {
                const current = configManager.getConfig().execution.approval_mode ?? 'script';
                onToken({ id: messageId, role: 'assistant', content: `Current mode: ${modeLabels[current]}\n\nChange with:\n/auto on — Autonomous\n/auto off — Script Review\n/auto all — Manual`, timestamp: new Date(), done: true, conversationId });
            } else {
                const newMode = modeMap[arg] ?? 'script';
                await configManager.updateConfig({ execution: { approval_mode: newMode } as any });
                onToken({ id: messageId, role: 'assistant', content: `Approval mode updated → ${modeLabels[newMode]}`, timestamp: new Date(), done: true, conversationId });
            }
            return;
        }

        // ── Skill-learn intent (all modes) ──
        const skillDescription = this.detectSkillIntent(message);
        if (skillDescription) {
            onToken({ id: messageId, role: 'assistant', content: '🧠 Learning skill...', timestamp: new Date(), done: false, conversationId });
            const skill = await skillLearner.learnFromInstruction(skillDescription);
            const reply = skill
                ? `Learned skill \`${skill.name}\`. Pattern: "${skill.pattern}". Say something matching that pattern next time to reuse it automatically.`
                : `Couldn't generate a skill template for that. Try running it as a goal first so I can learn from the execution.`;
            onToken({ id: messageId, role: 'assistant', content: reply, timestamp: new Date(), done: true, conversationId });
            return;
        }

        // ── Agent-create intent (all modes) ──
        const agentCreateIntent = this.detectAgentCreateIntent(message);
        if (agentCreateIntent) {
            onToken({ id: messageId, role: 'assistant', content: `🤖 Creating agent **${agentCreateIntent.name}**...`, timestamp: new Date(), done: false, conversationId });
            const { agentPool } = await import('../agents/AgentPool');
            const profile = await agentPool.createProfileFromDescription(agentCreateIntent.name, agentCreateIntent.description);
            const reply = profile
                ? `Agent **${profile.name}** created.\n\n` +
                  `**Role:** ${profile.role}\n` +
                  `**Mention:** \`@${profile.slug}\`\n` +
                  `**Auto-triggers on:** ${profile.autoSelectKeywords?.length ? profile.autoSelectKeywords.map(k => `\`${k}\``).join(', ') : 'manual @mention only'}\n\n` +
                  `Use it with \`@${profile.slug} <task>\` or just mention a trigger keyword and it will activate automatically.`
                : `Couldn't create the agent profile. Try again with a more specific description.`;
            onToken({ id: messageId, role: 'assistant', content: reply, timestamp: new Date(), done: true, conversationId });
            return;
        }

        // ── Pending retry — short affirmative after a failed goal ("yes", "retry", "ok") ──
        // If a goal failed in the previous turn, a short affirmative re-runs it directly
        // without going through escalation scoring (which scores "yes" = 0 and falls through
        // to OODA, causing it to search for the definition of "yes").
        const SHORT_AFFIRMATIVE = /^(yes|yeah|yep|sure|ok|okay|retry|try again|go ahead|proceed|please|do it|sure thing|affirmative|correct|yup|of course|absolutely|definitely)\s*[.!?]?$/i;
        if (SHORT_AFFIRMATIVE.test(message.trim()) && conversationId) {
            const retry = pendingRetry.get(conversationId);
            if (retry && Date.now() < retry.expiresAt) {
                pendingRetry.delete(conversationId);
                console.log('[Orchestrator] Short affirmative → retrying failed goal:', retry.goalText.substring(0, 80));
                const retryConvId = conversationId;
                onConversationId?.(retryConvId);
                try {
                    const { goalOrientedExecutor: retryExec } = await import('../agents/GoalOrientedExecutor');
                    const recentMsgs = await db.all(
                        'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 10',
                        [retryConvId]
                    ) as { role: string; content: string }[];
                    // Persist user "yes" message
                    await db.run('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))', [randomUUID(), retryConvId, 'user', message]);
                    const retryDirLabel = retry.outputDir ? ` in \`${retry.outputDir}\`` : '';
                    onToken({ id: messageId, role: 'assistant', content: `♻️ Retrying goal${retryDirLabel}...`, timestamp: new Date(), done: false, conversationId: retryConvId });
                    const result = await retryExec.executeGoal(retry.goalText, userId, {
                        enable_hitl: true,
                        conversationContext: recentMsgs.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content })),
                        conversationId: retryConvId,
                        outputDirOverride: retry.outputDir,  // reuse same folder — fix files, don't recreate
                    });
                    // Keep pendingRetry alive if it failed again so user can retry once more
                    if (result.status !== 'completed') {
                        pendingRetry.set(retryConvId, { goalText: retry.goalText, expiresAt: Date.now() + 5 * 60 * 1000, outputDir: result.final_state?.outputDir });
                    }
                    const response = await this.buildGoalCompletionMessage(result);
                    onToken({ id: messageId, role: 'assistant', content: response, timestamp: new Date(), done: true, conversationId: retryConvId });
                    // Persist assistant response
                    await db.run('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))', [messageId, retryConvId, 'assistant', response]);
                    emitChatProgress('execution_done', { conversationId: retryConvId, success: true });
                } catch (error) {
                    const errMsg = `Error: ${error}`;
                    onToken({ id: messageId, role: 'assistant', content: errMsg, timestamp: new Date(), done: true, conversationId: retryConvId });
                    await db.run('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))', [messageId, retryConvId, 'assistant', errMsg]);
                    emitChatProgress('execution_done', { conversationId: retryConvId, success: false });
                }
                return;
            }
        }

        // ── Contextual follow-up fast-path ──────────────────────────────────────
        // When the last assistant message was a goal result (✅/⚠️/❌) and the user
        // asks a short follow-up question ("then what needs to be done here", "why did
        // it fail", "what's next"), respond conversationally — don't search the web,
        // don't re-execute the goal.
        if (conversationId && mode !== 'goal') {
            const words = message.trim().split(/\s+/);
            const FOLLOW_UP_SIGNAL = /\b(what|how|why|next|here|now|fix|do|should|explain|tell|proceed|continue|show|mean|failed|wrong|missing|error|issue)\b/i;
            const NO_BUILD_KEYWORDS = !/\b(create|build|make|implement|develop|run|install|deploy|generate|write)\b/i.test(message);
            if (words.length <= 12 && NO_BUILD_KEYWORDS && FOLLOW_UP_SIGNAL.test(message)) {
                const recentForCtx = await db.all(
                    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 4',
                    [conversationId]
                ) as { role: string; content: string }[];
                const lastAssistant = recentForCtx.find(m => m.role === 'assistant');
                if (lastAssistant && lastMessageIsTaskContext(lastAssistant.content)) {
                    // Build a tight context prompt: prior result + question → conversational answer
                    const contextPrompt = `You are a helpful AI assistant. The user just ran a task that produced the following result:\n\n${lastAssistant.content.substring(0, 1200)}\n\nNow the user asks: "${message}"\n\nAnswer conversationally and specifically — tell them exactly what went wrong and what concrete steps to take next. Be concise (3-6 sentences max). Do NOT search the web.`;
                    const llm = modelRouter.getAdapterForTask('simple_qa') || modelManager.getActiveAdapter();
                    if (llm) {
                        await db.run('INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, datetime("now"), datetime("now"))', [conversationId, message.substring(0, 50)]);
                        await db.run('UPDATE conversations SET updated_at = datetime("now") WHERE id = ?', [conversationId]);
                        await db.run('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))', [randomUUID(), conversationId, 'user', message]);
                        let accumulated = '';
                        try {
                            const generator = llm.stream(contextPrompt, { systemPrompt: 'You are a concise, helpful assistant. Answer directly without searching the web.', temperature: 0.4 });
                            for await (const token of generator) {
                                accumulated += token;
                                onToken({ id: messageId, role: 'assistant', content: accumulated, timestamp: new Date(), done: false, conversationId });
                            }
                        } catch { /* fall through if stream fails */ }
                        if (accumulated) {
                            onToken({ id: messageId, role: 'assistant', content: accumulated, timestamp: new Date(), done: true, conversationId });
                            await db.run('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))', [messageId, conversationId, 'assistant', accumulated]);
                            return;
                        }
                    }
                }
            }
        }

        // ── Named agent @mention routing ──
        let namedAgentSlug: string | undefined;
        let namedAgentSystemPrompt: string | undefined;
        let effectiveMessage = message;
        // profileOptions carries per-profile caps passed into chat()
        let profileOptions: { maxIterations?: number; toolWhitelist?: string[]; agentType?: string; agentSlug?: string } | undefined;

        const mention = await this.resolveMention(message);
        if (mention) {
            namedAgentSlug = mention.namedAgentSlug;
            effectiveMessage = mention.effectiveMessage;
            namedAgentSystemPrompt = mention.namedAgentSystemPrompt;
            if (mention.forceGoalMode) mode = 'goal';
            // Build profileOptions from the resolved profile
            if (!mention.forceGoalMode) {
                profileOptions = {
                    maxIterations: mention.maxIterations,
                    toolWhitelist: mention.toolWhitelist,
                    agentType: mention.agentType,
                    agentSlug: mention.namedAgentSlug,
                };
            }
        } else {
            // Check if message looks like an @mention that failed to resolve
            const unknownMention = message.match(/^@([\w-]+)\s/);
            if (unknownMention) {
                const slug = unknownMention[1];
                const errorMsg = `Agent \`@${slug}\` not found. Check the Agent Profiles panel — you may need to click **Starter Pack** to seed the built-in agents, or create a custom profile with that slug.`;
                onToken({ id: messageId, role: 'assistant', content: errorMsg, timestamp: new Date(), done: true, conversationId: earlyConvId });
                return;
            }
        }

        // ── Auto-keyword routing (opt-in per profile) ──
        // If any profile has matching auto_select_keywords, route to it automatically.
        if (!namedAgentSlug && (mode === 'auto' || mode === 'chat' || mode === 'goal')) {
            try {
                const { agentPool } = await import('../agents/AgentPool');
                const profiles = await agentPool.listProfiles();
                const lower = effectiveMessage.toLowerCase();
                for (const p of profiles) {
                    if (!p.autoSelectKeywords?.length) continue;
                    const hit = (p as any).autoSelectKeywords.find((kw: string) => lower.includes(kw.toLowerCase()));
                    if (hit) {
                        namedAgentSlug = p.slug;
                        mode = 'goal';
                        console.log(`[Orchestrator] Keyword "${hit}" matched profile "${p.name}" — auto-routing`);
                        break;
                    }
                }
            } catch { /* non-fatal */ }
        }

        // ── Determine conversation ID early so Stop button works during long executions ──
        let earlyConvId = conversationId;
        if (!earlyConvId) {
            earlyConvId = randomUUID();
            const title = message.length > 50 ? message.substring(0, 50) + '...' : message;
            await db.run(
                'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, datetime("now"), datetime("now"))',
                [earlyConvId, title]
            );
        }
        // Notify frontend immediately — enables Stop button before execution starts
        onConversationId?.(earlyConvId);

        // ── State 1: Plan-step progress display ──
        // Registered before mode check so they fire for goal mode AND auto-escalation.
        const startTime = Date.now();

        // Plan step state
        const planSteps: string[] = [];
        type StepState = 'pending' | 'running' | 'done' | 'failed';
        const stepStatus: StepState[] = [];
        let replanCount = 0;

        const fmtElapsed = () => {
            const s = Math.round((Date.now() - startTime) / 1000);
            return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
        };
        const makeBar = (done: number, total: number, width = 20) => {
            const n = total > 0 ? Math.min(Math.round(done / total * width), width) : 0;
            return '█'.repeat(n) + '░'.repeat(width - n);
        };

        const emitState1 = () => {
            const doneCount = stepStatus.filter(s => s === 'done').length;
            const total = planSteps.length || 1;
            const current = Math.min(doneCount + 1, total);
            const pct = planSteps.length > 0 ? Math.round(doneCount / total * 100) : 0;
            const elapsed = fmtElapsed();

            const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
            const line1 = `${pad('⚙️  Working on it...', 46)}Step ${current} of ${total}`;
            const barStr = `${makeBar(doneCount, total)}  ${pct}%`;
            const line2 = `${pad(barStr, 36)}elapsed: ${elapsed}`;

            const lines: string[] = [line1, line2, ''];
            if (planSteps.length > 0) {
                planSteps.forEach((step, i) => {
                    const st = stepStatus[i] || 'pending';
                    const icon = st === 'done' ? '✅' : st === 'running' ? '⏳' : st === 'failed' ? '❌' : '○';
                    // Trim the "  Step N: " prefix emitted by TaskDecomposer
                    const label = step.replace(/^\s*Step\s+\d+:\s*/i, '').replace(/\s*→\s*creates\s*\[.*?\]\s*$/, '').trim();
                    lines.push(`  ${icon}  ${label}`);
                });
            } else {
                lines.push('  ⏳  Preparing execution plan...');
            }
            if (replanCount > 0) lines.push(`\n  🔄  Replanned ${replanCount}×`);

            onToken({ id: messageId, role: 'assistant', content: lines.join('\n'), timestamp: new Date(), done: false, conversationId: earlyConvId });
        };

        const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');

        const onPlanSteps = (data: any) => {
            const steps: any[] = Array.isArray(data?.steps) ? data.steps : [];
            planSteps.length = 0;
            steps.forEach(s => planSteps.push(typeof s === 'string' ? s : String(s.description || s)));
            stepStatus.length = 0;
            planSteps.forEach(() => stepStatus.push('pending'));
            if (planSteps.length > 0) stepStatus[0] = 'running';
            emitState1();
        };

        const onReasoning = (_data: any) => {
            emitState1();
        };

        const onAction = (data: any) => {
            const tool = data?.action?.tool || data?.tool || '';
            const args = data?.action?.args || data?.args || {};
            // Match action to a plan step by filename/command keywords
            const fileStem = (args.path || '').split('/').pop()?.replace(/\.[^.]+$/, '') || '';
            const cmd = String(args.command || '').toLowerCase();
            let matchIdx = -1;
            for (let i = 0; i < planSteps.length; i++) {
                if (stepStatus[i] === 'done') continue;
                const step = planSteps[i].toLowerCase();
                if (tool === 'write_file' && fileStem && step.includes(fileStem)) { matchIdx = i; break; }
                if (tool === 'run_command' && /npm\s+install/.test(cmd) && step.includes('install')) { matchIdx = i; break; }
                if (tool === 'run_command' && /npm\s+test|jest|mocha/.test(cmd) && (step.includes('test') || step.includes('run'))) { matchIdx = i; break; }
            }
            if (matchIdx >= 0) {
                for (let i = 0; i < matchIdx; i++) { if (stepStatus[i] !== 'done') stepStatus[i] = 'done'; }
                stepStatus[matchIdx] = 'running';
            }
            emitState1();
        };

        const onActionResult = (data: any) => {
            const success = data?.result?.success !== false;
            const tool = data?.action?.tool || data?.tool || '';
            if (success && (tool === 'write_file' || tool === 'run_command')) {
                const runningIdx = stepStatus.lastIndexOf('running');
                if (runningIdx >= 0) {
                    stepStatus[runningIdx] = 'done';
                    for (let i = runningIdx + 1; i < stepStatus.length; i++) {
                        if (stepStatus[i] === 'pending') { stepStatus[i] = 'running'; break; }
                    }
                }
            }
            emitState1();
        };

        const onReplanning = (_data: any) => {
            replanCount++;
            // Reset pending steps back to pending (done steps stay done)
            for (let i = 0; i < stepStatus.length; i++) {
                if (stepStatus[i] === 'running') stepStatus[i] = 'pending';
            }
            const firstPending = stepStatus.indexOf('pending');
            if (firstPending >= 0) stepStatus[firstPending] = 'running';
            emitState1();
        };

        goalOrientedExecutor.on('goal:plan_steps', onPlanSteps);
        goalOrientedExecutor.on('goal:reasoning', onReasoning);
        goalOrientedExecutor.on('goal:action', onAction);
        goalOrientedExecutor.on('goal:action_result', onActionResult);
        goalOrientedExecutor.on('goal:replanning', onReplanning);

        const cleanupListeners = () => {
            goalOrientedExecutor.off('goal:plan_steps', onPlanSteps);
            goalOrientedExecutor.off('goal:reasoning', onReasoning);
            goalOrientedExecutor.off('goal:action', onAction);
            goalOrientedExecutor.off('goal:action_result', onActionResult);
            goalOrientedExecutor.off('goal:replanning', onReplanning);
        };

        // ── Skill match fast-path (chat/auto modes only) ──
        // If a learned skill matches the message, bypass the OODA loop entirely
        // and route straight to goal mode — ExecutionEngine will find + apply the skill.
        if (mode !== 'goal') {
            try {
                const matchedSkill = await skillLearner.findMatchingSkill(message);
                if (matchedSkill) {
                    console.log('[Orchestrator] Skill matched — bypassing OODA, routing to goal mode:', matchedSkill.name);
                    onToken({ id: messageId, role: 'assistant', content: `Found skill "${matchedSkill.name}" — executing...`, timestamp: new Date(), done: false, conversationId: earlyConvId });
                    mode = 'goal'; // fall through to goal mode handler below
                }
            } catch { /* non-fatal — if skill lookup fails, continue to OODA as normal */ }
        }

        // Goal mode: delegate to GoalOrientedExecutor (events stream via goal:* events)
        if (mode === 'goal') {
            // Persist user message so history reload works (use effectiveMessage — strips @mention prefix)
            await db.run(
                'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                [randomUUID(), earlyConvId, 'user', effectiveMessage]
            );
            await db.run('UPDATE conversations SET updated_at = datetime("now") WHERE id = ?', [earlyConvId]);

            let assistantContent = '';
            try {
                const recentMsgs = await db.all(
                    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 10',
                    [earlyConvId]
                ) as { role: string; content: string }[];

                // Emit initial placeholder immediately so bubble appears (shows "Preparing execution plan...")
                emitState1();

                const result = await goalOrientedExecutor.executeGoal(effectiveMessage, userId, {
                    enable_hitl: true,
                    conversationId: earlyConvId,
                    conversationContext: recentMsgs.map((r: any) => ({ role: r.role as 'user' | 'assistant', content: r.content })),
                    ...(namedAgentSlug ? { profile: namedAgentSlug } : {}),
                });

                cleanupListeners();
                assistantContent = await this.buildGoalCompletionMessage(result);
                // If the goal failed, remember it so "yes" / "retry" re-runs in the same dir
                if (result.status !== 'completed') {
                    pendingRetry.set(earlyConvId, { goalText: effectiveMessage, expiresAt: Date.now() + 5 * 60 * 1000, outputDir: result.final_state?.outputDir });
                }
                onToken({ id: messageId, role: 'assistant', content: assistantContent, timestamp: new Date(), done: true, conversationId: earlyConvId });
            } catch (error) {
                cleanupListeners();
                assistantContent = `Error: ${error}`;
                onToken({ id: messageId, role: 'assistant', content: assistantContent, timestamp: new Date(), done: true, conversationId: earlyConvId });
            }
            // Persist assistant response
            await db.run(
                'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
                [messageId, earlyConvId, 'assistant', assistantContent]
            );
            // Signal sidebar to reload conversation list
            emitChatProgress('execution_done', { conversationId: earlyConvId, success: true });
            return;
        }

        // Shared helper: streams OODA progress steps for auto/chat mode (not goal mode).
        const oodaLines: string[] = [];
        const emitOodaLog = () => {
            if (oodaLines.length === 0) return;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const footer = `\n_${elapsed}s elapsed_`;
            onToken({ id: messageId, role: 'assistant', content: oodaLines.join('\n') + footer, timestamp: new Date(), done: false, conversationId: earlyConvId });
        };
        const makeProgressCallback = () => {
            // Start with ⚙️ header so ChatArea routes content to GoalExecutionLog renderer
            oodaLines.push('⚙️  Analyzing...');
            oodaLines.push('  ⏳  Starting...');
            emitOodaLog();
            return (msg: string) => {
                const stepMatch = msg.match(/^_step:(\d+):([^:]+)(?::(.*))?$/);
                let line: string;
                if (stepMatch) {
                    const [, step, tool, reason] = stepMatch;
                    line = tool === 'Thinking…'
                        ? '  ⏳  Thinking…'
                        : `  ⏳  Step ${step}: ${tool}${reason ? ` — ${reason.substring(0, 80)}` : ''}`;
                } else {
                    line = `  ⏳  ${msg}`;
                }
                const last = oodaLines[oodaLines.length - 1] || '';
                if (last.startsWith('  ⏳') || last === line) {
                    oodaLines[oodaLines.length - 1] = line;
                } else {
                    oodaLines.push(line);
                }
                emitOodaLog();
            };
        };

        // Auto mode: intelligently decide between chat, tools, and goal execution
        if (mode === 'auto') {
            const isTrivial = this.isSimpleQuestion(effectiveMessage);
            if (isTrivial) {
                cleanupListeners();
                await this.streamSimpleResponse(userId, effectiveMessage, earlyConvId, messageId, onToken, namedAgentSystemPrompt);
            } else {
                const progressCallback = makeProgressCallback();
                const result = await this.chat(userId, effectiveMessage, earlyConvId, 'auto', progressCallback, namedAgentSystemPrompt, profileOptions);
                cleanupListeners();
                onToken({
                    id: messageId,
                    role: 'assistant',
                    content: result.response,
                    timestamp: new Date(),
                    done: true,
                    conversationId: result.conversationId
                });
            }
            return;
        }

        // Chat mode: check if this is a simple Q&A that can stream directly
        const isSimple = this.isSimpleQuestion(effectiveMessage);

        if (isSimple) {
            cleanupListeners();
            await this.streamSimpleResponse(userId, effectiveMessage, earlyConvId, messageId, onToken, namedAgentSystemPrompt);
        } else {
            // ── Agent Pool parallel lookups in chat mode (Phase 4) ───────────
            // When the user asks multiple independent factual questions in one message
            // (e.g. "compare Bitcoin and Ethereum" or "get me NSE top gainers and weather"),
            // decompose into parallel sub-agent lookups and merge the results.
            const parallelTasks = this.detectParallelSubtasks(effectiveMessage);
            if (parallelTasks.length >= 2) {
                try {
                    const { agentPool } = await import('../agents/AgentPool');
                    agentPool.resetSpawnCounter();
                    agentPool.setBudget({ maxDepth: 1, maxConcurrent: parallelTasks.length, totalAgentLimit: parallelTasks.length + 2, timeoutMs: 60_000 });

                    oodaLines.push(`🔀 Running ${parallelTasks.length} parallel lookups...`);
                    emitOodaLog();

                    const results = await agentPool.delegateParallel(
                        parallelTasks.map(t => ({ task: t, role: 'researcher' })),
                        earlyConvId, 0
                    );

                    const merged = results
                        .map((r, i) => `**Lookup ${i + 1}: ${parallelTasks[i].substring(0, 60)}**\n${r.result}`)
                        .join('\n\n---\n\n');

                    cleanupListeners();
                    onToken({ id: messageId, role: 'assistant', content: merged, timestamp: new Date(), done: true, conversationId: earlyConvId });
                    // Persist both messages so history reload works (effectiveMessage strips @mention)
                    await db.run('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))', [randomUUID(), earlyConvId, 'user', effectiveMessage]);
                    await db.run('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))', [messageId, earlyConvId, 'assistant', merged]);
                    await db.run('UPDATE conversations SET updated_at = datetime("now") WHERE id = ?', [earlyConvId]);
                    return;
                } catch {
                    // Parallel lookup failed — fall through to normal chat
                }
            }

            const progressCallback = makeProgressCallback();
            const result = await this.chat(userId, effectiveMessage, earlyConvId, 'chat', progressCallback, namedAgentSystemPrompt, profileOptions);
            cleanupListeners();
            onToken({
                id: messageId,
                role: 'assistant',
                content: result.response,
                timestamp: new Date(),
                done: true,
                conversationId: result.conversationId
            });
        }
    }

    /**
     * Detect if a chat message contains 2+ independent lookup sub-tasks.
     * Returns an array of task descriptions if parallel execution is worthwhile,
     * or an empty array for single-intent messages.
     */
    private detectParallelSubtasks(message: string): string[] {
        const lower = message.toLowerCase();

        // Only trigger for lookup/research-flavoured requests
        const isLookup = /\b(compare|vs\.?|versus|both|each|respectively|and also|as well as|alongside)\b/.test(lower)
            || /\b(get|fetch|find|lookup|check|search)\b.{0,50}\b(and|also|plus|&)\b/i.test(lower);
        if (!isLookup) return [];

        // Split on common conjunctions / "and" between distinct noun phrases
        // Heuristic: split message into clauses around "and", "vs", "versus", "compare"
        const SPLIT_RE = /\s+(?:and|vs\.?|versus|also|plus|as well as|alongside)\s+/i;
        const parts = message.split(SPLIT_RE).map(s => s.trim()).filter(s => s.length > 10);
        if (parts.length < 2) return [];

        // Each part becomes a self-contained lookup task
        return parts.map(p => `Research and summarize: ${p}`).slice(0, 4); // cap at 4 parallel
    }

    /**
     * Quick classify: is this a simple question that can be answered without tools?
     * Only returns true for genuinely simple greetings/Q&A that need NO tool access.
     */
    private isSimpleQuestion(message: string): boolean {
        const msg = message.toLowerCase().trim();

        // Patterns that NEED tool access - NOT simple Q&A
        const needsToolPatterns = [
            // File/workspace operations
            /\b(create|make|build|write|generate|implement|develop)\b/,
            /\b(read|list|show|find|search|look|check|scan)\s+(file|folder|director|code|project|workspace)/,
            /\b(run|execute|install|deploy|start|stop)\b/,
            // Web/internet operations
            /\b(search|browse|fetch|scrape|download|web|internet|online|url|http|website|google)\b/,
            // Tool/MCP references
            /\b(tool|mcp|use|access|connect|api)\b/,
            // Capability questions that need tool awareness
            /\b(can you|are you able|do you have access|what tools|what can you)\b/,
            // Data/analysis operations
            /\b(analyze|parse|extract|convert|transform|process)\b/,
            // Navigation/browser
            /\b(navigate|open|visit|go to|screenshot|browser)\b/,
            // Goal-oriented requests
            /\b(goal|plan|step.?by.?step|autonom)\b/,
        ];
        if (needsToolPatterns.some(p => p.test(msg))) return false;

        // Only truly simple patterns: greetings and basic knowledge questions
        const simplePatterns = [
            /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|ok|okay)\b/,
            /^(what is|what are|what does|who is|who are|explain|define|describe)\s+(a |an |the )?\w+\??$/,
        ];

        // Short messages (under 15 words) that are just greetings or basic questions
        const wordCount = msg.split(/\s+/).length;
        if (wordCount <= 3 && simplePatterns.some(p => p.test(msg))) return true;
        if (wordCount <= 8 && /^(hi|hello|hey)\b/.test(msg)) return true;

        // Default: NOT simple - route through OODA loop
        return false;
    }

    /**
     * Detect if the user wants to create a reusable skill from a natural language description.
     * Returns the skill description string, or null if no skill intent detected.
     * Examples: "learn how to check weather", "remember how to fetch BTC price",
     *           "teach yourself to send a daily report", "save a skill for scraping prices"
     */
    private detectSkillIntent(message: string): string | null {
        const patterns = [
            /^(?:learn|remember|teach yourself?)\s+(?:how to\s+)?(.{5,})/i,
            /^(?:save a skill for|create a skill (?:to|that|for))\s+(.{5,})/i,
            /^remember this[:\s]+(.{5,})/i,
            /^save (?:a )?skill[:\s]+(.{5,})/i,
        ];
        for (const pattern of patterns) {
            const m = message.trim().match(pattern);
            if (m?.[1]) return m[1].trim();
        }
        return null;
    }

    /**
     * Detects intent to create a named agent profile from a chat message.
     * Returns { name, description } or null.
     * Examples: "create an agent called Finance that tracks stocks"
     *           "make me a Swiggy agent for ordering food"
     *           "add an agent named Researcher for deep web research"
     */
    private detectAgentCreateIntent(message: string): { name: string; description: string } | null {
        const patterns = [
            /^(?:create|make|add|build|set up)\s+(?:an?\s+)?agent\s+(?:called|named)\s+["']?([^"',]{2,30})["']?\s+(?:that|for|to|which)\s+(.{5,})/i,
            /^(?:create|make|add|build)\s+(?:an?\s+)?["']?([^"',]{2,30})["']?\s+agent\s+(?:that|for|to|which)\s+(.{5,})/i,
            /^(?:create|make|add)\s+(?:an?\s+)?agent[:\s]+([^\n,]{2,30})[,\s]+(.{5,})/i,
        ];
        for (const pattern of patterns) {
            const m = message.trim().match(pattern);
            if (m?.[1] && m?.[2]) {
                return { name: m[1].trim(), description: m[2].trim() };
            }
        }
        return null;
    }

    /**
     * Heuristic complexity scorer for pre-flight goal escalation.
     * Returns a score 0–8. Score >= 4 triggers immediate goal mode routing.
     *
     * Designed to catch "do X AND Y", multi-domain tasks, and project-build requests
     * without burning an LLM call just to make that decision.
     */
    /**
     * Heuristic: does this message look like a search/lookup query?
     * Used to decide whether to use the native search fast-path.
     * Avoids triggering on file operations, code tasks, or multi-step goals.
     */
    /**
     * Returns true only when the message is clearly asking to CREATE, BUILD, or EXECUTE
     * something — code, files, scripts, deployments. Used to gate native search:
     * "use search for everything EXCEPT tasks." Much more reliable than trying to
     * enumerate all possible search intents with regex.
     */
    private isTaskQuery(message: string): boolean {
        // Self-referential queries must skip native web search — OODA has the answer in system prompt
        const selfRef = /\b(you|your|yourself|this\s+(app|application|bot|agent|assistant|system|tool|platform|ai|software|program))\b/i;
        if (selfRef.test(message)) return true;

        return /\b(create|build|write a?|generate|make a?|code|script|run|execute|save|install|deploy|refactor|implement|fix the bug|set up|automate|modify|delete|rename|move|open|launch|navigate|browse|scrape|order|buy|purchase|login|sign in|sign-in|log in|download|upload|send|fetch|show me|display|click|fill|submit|start|stop|restart|schedule|book|reserve)\b/i.test(message);
    }

    /**
     * Returns true for short/casual messages that should get a direct conversational reply,
     * not a web search. Prevents "test" → Ollama searching the web for the word "test".
     */
    private isConversationalMessage(message: string): boolean {
        const msg = message.trim().toLowerCase();
        // 1–3 word messages are almost always conversational (test, hi, ok, thanks, help...)
        if (msg.split(/\s+/).length <= 3) return true;
        // Common openers and filler phrases regardless of length
        if (/^(hi|hello|hey|yo|sup|test|testing|thanks|thank you|ok|okay|sure|yes|no|nope|yep|bye|goodbye|great|good|nice|cool|awesome|got it|understood|makes sense|sounds good|never mind|nevermind|forget it|what can you do|what do you do|who are you|what are you)\b/.test(msg)) return true;
        return false;
    }

    /**
     * Purpose-built classifier for @mention routing.
     * Distinct from isTaskQuery() — that method has a selfRef guard designed to prevent
     * native-search on app-self-queries, which breaks "what do you think about Tesla?"
     * (contains "you") when re-used here.
     *
     * Logic:
     *   1. Conversational openers → always chat
     *   2. Wh-questions asking for knowledge/opinion → always chat
     *   3. Clear action verbs (broader list than isTaskQuery) → goal
     *   4. Everything else (ambiguous) → chat (conservative default)
     */
    private isMentionedAgentTask(message: string): boolean {
        const msg = message.toLowerCase().trim();

        // ── 1. Greetings → chat ──
        if (/^(hi|hello|hey|yo|sup|greetings|howdy)\b/.test(msg)) return false;

        // ── 2. Opinion / feeling questions → chat ──
        if (/^(what do you think|what('s| is) your (view|opinion|take|thought|stance)|your (thoughts|opinion|view)|do you think|don('t| not) you think)\b/.test(msg)) return false;

        // ── 3. Capability / identity questions → always chat ──
        if (/^(how can you|what can you|what do you|who are you|what are you|can you help|how do you|what is your|tell me (about|what) you|how would you|what would you)\b/.test(msg)) return false;

        // ── 4. Pure knowledge / yes-no questions → chat ──
        // "what is/are/was/were X", "why/where/when/who", "is/are/can/could/would/will/does/do/did X"
        if (/^(why|when|where|who (is|are|was|were|did|do)\b)/.test(msg)) return false;
        if (/^what (is|are|was|were|will|would|could|can|do you|does)\b/.test(msg)) return false;
        if (/^(is |are |can |could |would |will |does |do |did |has |have |had )\b/.test(msg)) return false;
        if (/^(tell me about|explain |describe |how (does|do|did|is|are|was|were)\b)/.test(msg)) return false;

        // ── 4. Agentic action verbs → goal ──
        // Broader than isTaskQuery(): includes research, analysis, and retrieval verbs
        return /\b(create|build|write|generate|make|code|script|run|execute|save|install|deploy|refactor|implement|fix|analyze|analyse|research|compare|summarize|summarise|summary|fetch|scrape|extract|search|find|calculate|compute|report|process|check|test|review|scan|monitor|track|send|post|publish|update|modify|delete|rename|move|copy|download|upload|parse|format|convert|compile|debug|optimize|optimise|automate|set up|setup|configure|integrate|get me|give me|show me|list|enumerate|evaluate|assess|audit|migrate|refactor|benchmark)\b/i.test(message);
    }

    /**
     * Shared @mention resolver used by BOTH chat() and chatStreaming().
     * Parses "@slug <rest>" from the message, looks up the profile, and classifies intent.
     * Returns null if no valid @mention is found.
     */
    async resolveMention(message: string): Promise<{
        effectiveMessage: string;
        namedAgentSlug: string;
        namedAgentSystemPrompt: string | undefined;
        forceGoalMode: boolean;
        maxIterations?: number;
        toolWhitelist?: string[];
        agentType?: string;
    } | null> {
        const mentionMatch = message.match(/^@([\w-]+)\s+([\s\S]+)/);
        if (!mentionMatch) return null;

        const candidateSlug = mentionMatch[1].toLowerCase();
        try {
            const { agentPool } = await import('../agents/AgentPool');
            const profile = await agentPool.lookupProfile(candidateSlug);
            if (!profile) return null;

            const effectiveMessage = mentionMatch[2].trim();
            const forceGoalMode = this.isMentionedAgentTask(effectiveMessage);
            const agentType = (profile as any).agentType ?? 'research';
            console.log(`[Orchestrator] @${profile.slug} → ${forceGoalMode ? 'goal' : 'chat'} mode (maxIter=${profile.maxIterations ?? 'default'}, type=${agentType})`);
            return {
                effectiveMessage,
                namedAgentSlug: profile.slug,
                namedAgentSystemPrompt: forceGoalMode ? undefined : (profile.systemPrompt || undefined),
                forceGoalMode,
                maxIterations: profile.maxIterations,
                toolWhitelist: profile.toolWhitelist?.length ? profile.toolWhitelist : undefined,
                agentType,
            };
        } catch {
            return null; // non-fatal — DB unavailable, proceed normally
        }
    }

    /**
     * Detect approximate model size in billions from the model name string.
     * Used to decide whether to trim the tool list (small models struggle with 50+ tools).
     * Returns 100 (large) when size cannot be determined — safe default keeps full tools.
     */
    private detectModelSizeBillions(modelName: string): number {
        // Match patterns like "20b", "8b", "7b", "70b", "3.8b", "480b", "20b-cloud"
        const m = modelName.match(/(\d+(?:\.\d+)?)\s*b\b/i);
        if (m) return parseFloat(m[1]);
        return 100; // Unknown size — assume large, use full tool list
    }

    /** @deprecated Use isTaskQuery() for native-search routing instead */
    private isSearchQuery(message: string): boolean {
        const lower = message.toLowerCase().trim();
        const searchPatterns = [
            /^(find|search|look up|lookup|what is|what are|who is|who are|where is|when (is|was|did)|how (much|many|does|do|did|is|are)|tell me about|give me|show me|get me)\b/i,
            /\b(latest|current|today|price|cost|cheapest|best|top|recent|news|weather|stock|rate|score)\b/i,
            /\b(vs|versus|compare|difference between)\b/i,
            /\b(nse|bse|sensex|nifty|nasdaq|dow|s&p|crypto|bitcoin|btc|eth|gold|silver|oil|forex)\b/i,
            /\b(predict|prediction|forecast|outlook|tomorrow|monday|tuesday|wednesday|thursday|friday|weekend|next week|this week)\b/i,
            /\b(who won|who is leading|match score|live score|ipl|cricket|football|election|result)\b/i,
        ];
        if (!searchPatterns.some(p => p.test(lower))) return false;
        if (/\b(create|build|write|generate|make|code|file|script|run|execute|save|install|deploy|refactor|implement)\b/i.test(lower)) return false;
        if (lower.split(' ').length > 40) return false;
        return true;
    }



    // ─────────────────────────────────────────────────────────────────────────
    // SLASH COMMAND HANDLER
    // Supports /help, /status, /model, /files, /skills, /memory, /mode, /goal
    // Returns formatted string (Markdown) or null if command is unknown.
    // ─────────────────────────────────────────────────────────────────────────
    private async handleSlashCommand(raw: string, userId: string, convId: string): Promise<string | null> {
        // Parse: "/cmd arg1 arg2..."
        const parts = raw.split(/\s+/);
        const cmd = (parts[0] || '').toLowerCase();
        const args = parts.slice(1).join(' ').trim();

        switch (cmd) {
            // ── /help ────────────────────────────────────────────────────────
            case '/help':
                return [
                    '**AI Partner — Available Commands**',
                    '',
                    '**Conversation**',
                    '  `/mode chat` — Read-only mode (search, browse, answer questions)',
                    '  `/mode auto` — Full mode (write files, run code, call APIs)',
                    '  `/goal <task>` — Run an autonomous multi-step goal (ReAct engine)',
                    '',
                    '**Specialist Agents**',
                    '  `/agents` — List all named specialist agents',
                    '  `/agent <slug> <task>` — Route task to a named agent (e.g. `/agent researcher find top AI papers`)',
                    '  `@slug <task>` — Inline mention (same as /agent but works mid-sentence)',
                    '',
                    '**Model**',
                    '  `/model` — Show current active model',
                    '  `/model list` — List all available models grouped by provider',
                    '  `/model <id> [provider]` — Switch to a specific model',
                    '',
                    '**Status & Info**',
                    '  `/status` — System status (model, integrations, search, memory)',
                    '  `/files` — List recently generated files',
                    '  `/skills` — Show learned skills',
                    '  `/memory <query>` — Search your memory/past goals',
                    '  `/kb <query>` — Search knowledge base documents',
                    '  `/cost` — Token usage and cost breakdown by model',
                    '',
                    '**Scheduling**',
                    '  `/schedule` — Show scheduled proactive tasks',
                    '  `/proactive` — Show heartbeat status',
                    '  `/proactive on` — Enable proactive agent',
                    '  `/proactive off` — Disable proactive agent',
                    '',
                    '*Tip: For complex multi-step tasks, use `/goal` or just describe the task naturally — the agent auto-escalates.*',
                ].join('\n');

            // ── /status ──────────────────────────────────────────────────────
            case '/status': {
                const ms = modelManager.getActiveModelStatus();
                const providerCfgs = modelManager.getProviderConfigs();
                const connectedProviders = providerCfgs.filter(p => p.connected && p.name !== 'ollama-cloud').map(p => p.label);
                const { searchProviderManager } = await import('../search');
                const searchStatus = await searchProviderManager.getStatus();
                const availableSearch = searchStatus.filter(s => s.available).map(s => s.name);
                const memCount = await db.all('SELECT COUNT(*) as c FROM events').catch(() => [{ c: 0 }]);
                const convCount = await db.all('SELECT COUNT(*) as c FROM conversations').catch(() => [{ c: 0 }]);
                return [
                    '**System Status**',
                    '',
                    `🤖 **Model**: \`${ms.model || 'unknown'}\` via ${ms.provider}`,
                    `🔌 **Connected providers**: ${connectedProviders.join(', ') || 'None'}`,
                    `🔍 **Search**: ${availableSearch.join(', ') || 'None available'}`,
                    `🧠 **Memory events**: ${(memCount[0] as any)?.c ?? 0}`,
                    `💬 **Conversations**: ${(convCount[0] as any)?.c ?? 0}`,
                ].join('\n');
            }

            // ── /model ───────────────────────────────────────────────────────
            case '/model': {
                if (!args || args === '') {
                    // Show current model
                    const ms = modelManager.getActiveModelStatus();
                    return `**Active model**: \`${ms.model || 'unknown'}\` (provider: ${ms.provider})\n\nUse \`/model list\` to see all available models.`;
                }
                if (args === 'list') {
                    // List all models grouped by provider
                    const allModels = await modelManager.discoverModels();
                    if (allModels.length === 0) return '❌ No models discovered. Check provider connections in Settings.';
                    const grouped: Record<string, string[]> = {};
                    for (const m of allModels) {
                        if (!grouped[m.provider]) grouped[m.provider] = [];
                        grouped[m.provider].push(m.id);
                    }
                    const lines = ['**Available Models**', ''];
                    for (const [provider, ids] of Object.entries(grouped)) {
                        lines.push(`**${provider}** (${ids.length} models)`);
                        // Show first 8 per provider to avoid spam
                        ids.slice(0, 8).forEach(id => lines.push(`  • \`${id}\``));
                        if (ids.length > 8) lines.push(`  _...and ${ids.length - 8} more_`);
                        lines.push('');
                    }
                    lines.push('*Use `/model <model-id> [provider]` to switch.*');
                    return lines.join('\n');
                }
                // Switch model: /model <id> [provider]
                const switchParts = args.split(/\s+/);
                const modelId = switchParts[0];
                const provider = switchParts[1];
                const allForSwitch = await modelManager.discoverModels();
                const match = allForSwitch.find(m =>
                    m.id === modelId && (!provider || m.provider === provider)
                );
                if (!match) return `❌ Model \`${modelId}\` not found. Use \`/model list\` to see available models.`;
                await modelManager.switchModel(match.id, match.provider);
                return `✅ Switched to **${match.id}** (${match.provider})`;
            }

            // ── /files ───────────────────────────────────────────────────────
            case '/files': {
                const files = await db.all(
                    'SELECT filename, created_at, file_size FROM generated_files ORDER BY created_at DESC LIMIT 10'
                ).catch(() => []);
                if ((files as any[]).length === 0) return 'No generated files found.';
                const lines = ['**Recent Generated Files**', ''];
                for (const f of files as any[]) {
                    const size = f.file_size ? `${(f.file_size / 1024).toFixed(1)} KB` : '';
                    lines.push(`📄 \`${f.filename}\` ${size} — ${new Date(f.created_at).toLocaleDateString()}`);
                }
                return lines.join('\n');
            }

            // ── /skills ──────────────────────────────────────────────────────
            case '/skills': {
                const { skillLearner } = await import('./SkillLearner');
                const skills = await skillLearner.listSkills().catch(() => []);
                if (skills.length === 0) return 'No learned skills yet.\n\nSay *"learn how to X"* to teach the agent a new skill.';
                const lines = ['**Learned Skills**', ''];
                for (const s of skills as any[]) {
                    lines.push(`🔧 **${s.name}** — success: ${s.success_count ?? 0}×`);
                    if (s.description) lines.push(`   _${s.description}_`);
                }
                return lines.join('\n');
            }

            // ── /memory ──────────────────────────────────────────────────────
            case '/memory': {
                if (!args) return 'Usage: `/memory <search query>`\n\nSearches your episodic memory and past goal outcomes.';
                const results = await memoryManager.hybridSearch(args, 5).catch(() => []);
                if (results.length === 0) return `No memory found for: "${args}"`;
                const lines = [`**Memory: "${args}"**`, ''];
                for (const r of results) {
                    const score = (r as any).score ? ` _(${((r as any).score * 100).toFixed(0)}%)_` : '';
                    lines.push(`• ${(r as any).event_text || (r as any).text}${score}`);
                }
                return lines.join('\n');
            }

            // ── /mode ────────────────────────────────────────────────────────
            case '/mode': {
                if (!args) return 'Usage: `/mode chat|auto`\n\nCurrent mode is determined per-message. Use this to set default for this session.';
                const m = args.toLowerCase();
                if (m !== 'chat' && m !== 'auto') return '❌ Unknown mode. Use `chat` or `auto`.';
                // Store as a user preference in memory
                await memoryManager.storeEvent({
                    event_type: 'preference',
                    event_text: `User set default mode to: ${m}`,
                    user_id: userId,
                }).catch(() => { });
                return `✅ Default mode set to **${m}** for this session.\n\n_Note: Complex multi-step messages auto-escalate to goal mode regardless of this setting._`;
            }

            // ── /proactive ───────────────────────────────────────────────────
            case '/proactive': {
                const { heartbeatService } = await import('./HeartbeatService');
                if (!heartbeatService) return '❌ Heartbeat service not available (still starting up).';
                if (args === 'on') {
                    (heartbeatService as any).enabled = true;
                    return '✅ Proactive agent **enabled**. The agent will run scheduled tasks automatically.';
                }
                if (args === 'off') {
                    (heartbeatService as any).enabled = false;
                    return '⏹ Proactive agent **disabled**.';
                }
                // Status
                const enabled = (heartbeatService as any).enabled !== false;
                const logs = await db.all(
                    'SELECT goal_text, status, timestamp FROM heartbeat_logs ORDER BY timestamp DESC LIMIT 3'
                ).catch(() => []);
                const lines = [`**Proactive Agent**: ${enabled ? '✅ Enabled' : '⏹ Disabled'}`, ''];
                if ((logs as any[]).length > 0) {
                    lines.push('**Recent activity:**');
                    for (const l of logs as any[]) {
                        const when = new Date(l.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
                        lines.push(`• ${l.status === 'completed' ? '✅' : '❌'} ${l.goal_text?.substring(0, 60)} — ${when}`);
                    }
                } else {
                    lines.push('_No recent activity._');
                }
                lines.push('\nUse `/proactive on` or `/proactive off` to toggle.');
                return lines.join('\n');
            }

            // ── /goal ────────────────────────────────────────────────────────
            case '/goal': {
                if (!args) return 'Usage: `/goal <task description>`\n\nRuns a full autonomous ReAct goal execution.\n\nExample: `/goal research top 3 AI frameworks and create a comparison report`';
                return null; // Fall through — handled by caller stripping /goal prefix
            }

            // ── /agent ───────────────────────────────────────────────────────
            // Route a task to a specific named specialist agent by slug.
            // Usage: /agent <slug> <task>
            // Example: /agent researcher find top 5 AI papers this month
            case '/agent': {
                const agentParts = args.split(/\s+/);
                const agentSlug = agentParts[0]?.toLowerCase();
                const agentTask = agentParts.slice(1).join(' ').trim();
                if (!agentSlug) {
                    return 'Usage: `/agent <slug> <task>`\n\nExample: `/agent researcher find top AI papers this week`\n\nUse `/agents` to list available agents.';
                }
                if (!agentTask) {
                    return `Missing task. Usage: \`/agent ${agentSlug} <task description>\``;
                }
                // Look up profile in DB
                try {
                    const profileRow = await db.get(
                        'SELECT slug, name FROM agent_profiles WHERE slug = ? LIMIT 1',
                        [agentSlug]
                    ).catch(() => null);
                    if (!profileRow) {
                        return `❌ No agent found with slug \`${agentSlug}\`. Use \`/agents\` to list available agents.`;
                    }
                    const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                    const recentMsgs = await db.all(
                        'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 10',
                        [convId]
                    ) as { role: string; content: string }[];
                    const goalResult = await goalOrientedExecutor.executeGoal(agentTask, userId, {
                        enable_hitl: true,
                        enableNetwork: true,
                        profile: agentSlug,
                        conversationContext: recentMsgs.map((r: any) => ({ role: r.role as 'user' | 'assistant', content: r.content })),
                        conversationId: convId,
                    });
                    // Build compact completion summary
                    const statusIcon = goalResult.status === 'completed' ? '✅' : '❌';
                    const filesCreated = (goalResult.generated_files || []).filter((f: string) => !f.includes('_goal_script'));
                    const fileList = filesCreated.length > 0
                        ? `\n\n📎 Files: ${filesCreated.map((f: string) => `[${f.split('/').pop() || f}](workspace:${f})`).join('  ·  ')}`
                        : '';
                    const outcome = goalResult.outcome_summary || (goalResult.status === 'completed' ? 'Task completed.' : 'Task did not complete fully.');
                    return `${statusIcon} **@${agentSlug}** — ${outcome}${fileList}`;
                } catch (err: any) {
                    return `❌ Agent \`${agentSlug}\` error: ${err.message}`;
                }
            }

            // ── /agents ──────────────────────────────────────────────────────
            // List all named specialist agents
            case '/agents': {
                try {
                    const profiles = await db.all(
                        'SELECT slug, name, role, auto_select_keywords FROM agent_profiles ORDER BY name ASC LIMIT 20'
                    ).catch(() => []);
                    if ((profiles as any[]).length === 0) {
                        return '🤖 No specialist agents configured yet.\n\nCreate agents in the web UI under **Agents → Profiles**, then use them here with `/agent <slug> <task>`.';
                    }
                    const lines = ['🤖 **Available Specialist Agents**', ''];
                    for (const p of profiles as any[]) {
                        const keywords = p.auto_select_keywords
                            ? ` _(auto: ${p.auto_select_keywords.split(',').slice(0, 3).join(', ')})_`
                            : '';
                        lines.push(`**@${p.slug}** — ${p.role || p.name}${keywords}`);
                    }
                    lines.push('', '_Use:_  `/agent <slug> <task>` — run a task with a specific agent');
                    lines.push('_Or mention directly:_  `@slug task description`');
                    return lines.join('\n');
                } catch {
                    return '❌ Could not load agent profiles.';
                }
            }

            // ── /cost ────────────────────────────────────────────────────────
            case '/cost': {
                try {
                    const rows = await db.all<any>(
                        `SELECT provider, model, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct, COUNT(*) as calls
                         FROM llm_usage GROUP BY provider, model ORDER BY (pt+ct) DESC LIMIT 10`
                    ).catch(() => []);
                    if (!rows || rows.length === 0) return '📊 No usage data yet. Usage is tracked after the first LLM call.';
                    const lines = ['📊 **Token Usage by Model**', ''];
                    let totalPt = 0, totalCt = 0;
                    for (const r of rows) {
                        const total = (r.pt || 0) + (r.ct || 0);
                        lines.push(`**${r.provider}** \`${r.model}\``);
                        lines.push(`  ${(r.pt || 0).toLocaleString()} in + ${(r.ct || 0).toLocaleString()} out = ${total.toLocaleString()} tokens (${r.calls} calls)`);
                        totalPt += r.pt || 0; totalCt += r.ct || 0;
                    }
                    lines.push('', `**Total**: ${(totalPt + totalCt).toLocaleString()} tokens (${totalPt.toLocaleString()} prompt + ${totalCt.toLocaleString()} completion)`);
                    lines.push('\n_Exact cost depends on your provider pricing._');
                    return lines.join('\n');
                } catch {
                    return '📊 Usage tracking not available (requires `llm_usage` table in DB).';
                }
            }

            // ── /kb ──────────────────────────────────────────────────────────
            case '/kb': {
                if (!args) return 'Usage: `/kb <search query>`\n\nSearches the knowledge base documents added via the Knowledge Base view.';
                try {
                    const { knowledgeBaseService } = await import('./KnowledgeBaseService').catch(() => ({ knowledgeBaseService: null }));
                    if (!knowledgeBaseService) return '📚 Knowledge Base service not available.';
                    const results = await (knowledgeBaseService as any).search(args, 5).catch(() => []);
                    if (!results || results.length === 0) return `📚 No knowledge base results for "${args}".`;
                    const lines = [`📚 **Knowledge Base** — results for "${args}"`, ''];
                    for (const r of results) {
                        lines.push(`**${r.title || r.filename || 'Document'}**`);
                        if (r.snippet || r.content) lines.push((r.snippet || r.content || '').substring(0, 200) + '...');
                        lines.push('');
                    }
                    return lines.join('\n').trim();
                } catch {
                    return '📚 Knowledge Base search failed.';
                }
            }

            // ── /schedule ────────────────────────────────────────────────────
            case '/schedule': {
                try {
                    const { heartbeatService } = await import('./HeartbeatService');
                    if (!heartbeatService) return '⏰ Heartbeat service not available (still starting up).';
                    const md = await (heartbeatService as any).readHeartbeatMd?.() || '';
                    if (!md) return '⏰ No scheduled tasks configured. Edit HEARTBEAT.md in the Proactive view to add tasks.';
                    // Extract task lines from HEARTBEAT.md
                    const taskLines = md.split('\n').filter((l: string) => l.match(/^[-*]\s|^##\s|^\d+\./));
                    if (taskLines.length === 0) return '⏰ No tasks found in HEARTBEAT.md.';
                    return ['⏰ **Scheduled Tasks** (from HEARTBEAT.md)', '', ...taskLines.slice(0, 20)].join('\n');
                } catch {
                    return '⏰ Could not load scheduled tasks.';
                }
            }

            default:
                return null; // Unknown command — let OODA handle it
        }
    }

    /**
     * Stream a simple Q&A response token by token using llm.stream()
     */
    private async streamSimpleResponse(
        userId: string,
        message: string,
        conversationId: string | undefined,
        messageId: string,
        onToken: (data: { id: string; role: string; content: string; timestamp: Date; done: boolean; conversationId?: string }) => void,
        agentOverride?: string
    ): Promise<void> {
        // Conversation persistence
        let convId = conversationId;
        if (!convId) {
            convId = randomUUID();
            const title = message.length > 50 ? message.substring(0, 50) + '...' : message;
            await db.run(
                'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, datetime("now"), datetime("now"))',
                [convId, title]
            );
        } else {
            await db.run('UPDATE conversations SET updated_at = datetime("now") WHERE id = ?', [convId]);
        }

        // Save user message
        await db.run(
            'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
            [randomUUID(), convId, 'user', message]
        );

        const persona = await memoryManager.getPersona(userId);
        const recentEvents = await memoryManager.getRecentEvents(5);
        const systemPrompt = await this.getSystemPrompt(persona, recentEvents, userId, message, agentOverride);
        // Route simple Q&A to the fastest available model
        const llm = modelRouter.getAdapterForTask('simple_qa') || modelManager.getActiveAdapter();

        emitOODA('observe', `Received: "${message.substring(0, 80)}"`);
        emitOODA('decide', 'Simple Q&A - streaming response directly');

        // Load conversation history so follow-up messages have context
        const prevMsgs = convId ? await db.all(
            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT 10',
            [convId]
        ) as { role: string; content: string }[] : [];
        const historyPrefix = prevMsgs.length > 0
            ? `[CONVERSATION HISTORY]\n${prevMsgs.map(m => `${m.role.toUpperCase()}: ${m.content.substring(0, 400)}`).join('\n')}\n\n[CURRENT MESSAGE]\n`
            : '';

        let accumulated = '';
        try {
            const generator = llm.stream(historyPrefix + message, { systemPrompt, temperature: 0.7 });

            for await (const token of generator) {
                accumulated += token;
                onToken({
                    id: messageId,
                    role: 'assistant',
                    content: accumulated,
                    timestamp: new Date(),
                    done: false,
                    conversationId: convId
                });
            }
        } catch (error) {
            console.error('[Orchestrator] Stream error, falling back to generate():', error);
            // Fallback to non-streaming
            accumulated = await llm.generate(message, { systemPrompt, temperature: 0.7 });
        }

        // Emit final done event
        onToken({
            id: messageId,
            role: 'assistant',
            content: accumulated,
            timestamp: new Date(),
            done: true,
            conversationId: convId
        });

        // Save to DB
        await db.run(
            'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, datetime("now"))',
            [messageId, convId, 'assistant', accumulated]
        );

        // Signal sidebar to reload conversation list
        emitChatProgress('execution_done', { conversationId: convId, success: true });

        emitOODA('reflect', `Streamed response (${accumulated.length} chars)`);

        // Save to memory
        await memoryManager.storeEvent({
            event_type: 'conversation',
            event_text: `User: ${message.substring(0, 50)}... | Streamed response`
        });
    }

    async proactiveCheck(context: string): Promise<{ actionTaken: boolean; decision: string }> {
        console.log('[Orchestrator] Running proactive check...');

        emitOODA('observe', 'Heartbeat check initiated');

        const llm = modelManager.getActiveAdapter();

        // Load SOUL.md for persona context
        let soulContent = '';
        if (this.configLoader) {
            soulContent = this.configLoader.loadSoul();
        }

        const prompt = `
SYSTEM: You are the autonomous "Brain" of an AI Co-Worker.
${soulContent ? `\n${soulContent}\n` : ''}

It is time for a periodic check-in.

CONTEXT:
${context}

TASK:
Analyze the context. Do you need to take any action?
- If there are overdue tasks, remind the user.
- If the user was working on something important recently, ask if they need help.
- If nothing is urgent, stay silent.

DECISION FORMAT (JSON):
{
    "shouldAct": boolean,
    "reason": "string explanation",
    "action": "string description of what to do (e.g. 'Send notification about X')"
}
`;

        try {
            emitOODA('orient', 'Analyzing context for proactive opportunities');

            const result = await llm.generateJSON(prompt, {});

            emitOODA('decide', result.shouldAct
                ? `Action needed: ${result.action}`
                : `No action needed: ${result.reason}`
            );

            if (result.shouldAct) {
                emitOODA('act', `Executing proactive action: ${result.action}`);
            }

            emitOODA('reflect', `Heartbeat complete. Action taken: ${result.shouldAct}`);

            return {
                actionTaken: result.shouldAct || false,
                decision: result.shouldAct ? result.action : (result.reason || "No action needed")
            };

        } catch (e) {
            console.error('[Orchestrator] Proactive check failed:', e);
            emitOODA('reflect', `Heartbeat failed: ${e}`, { error: true });
            return { actionTaken: false, decision: "Error during check" };
        }
    }

    /**
     * Execute a single step for autonomous task execution
     * Called by AutonomousTaskExecutor
     */
    async executeAutonomousStep(params: {
        user_id: string;
        execution_id: string;
        step_id: string;
        prompt: string;
    }): Promise<any> {
        const { user_id, execution_id, step_id, prompt } = params;

        console.log(`[Orchestrator] Executing autonomous step ${step_id} for execution ${execution_id}`);

        try {
            const llm = modelManager.getActiveAdapter();
            if (!llm) {
                throw new Error('No LLM provider configured');
            }

            // Get tools available for this step
            const toolsList = await mcpManager.listTools();

            // Build system prompt with available tools
            const toolDescriptions = toolsList.map(t =>
                `- ${t.tool.name}: ${t.tool.description || 'No description'}`
            ).join('\n');

            const systemPrompt = `You are executing a step in an autonomous task.

Available tools:
${toolDescriptions}

When you need to use a tool, respond with JSON in this format:
{
  "action": "tool_name",
  "args": { "arg1": "value1" },
  "reasoning": "Why this tool is needed"
}

If no tool is needed, respond with:
{
  "action": "complete",
  "response": "Your response here"
}`;

            // Use generateJSON to get structured output
            const result = await llm.generateJSON(systemPrompt + '\n\n' + prompt, {});

            const artifacts: string[] = [];

            // Check if result indicates tool use
            if (result.action && result.action !== 'complete') {
                const toolName = result.action;
                const toolArgs = result.args || {};

                console.log(`[Orchestrator] Step ${step_id} using tool: ${toolName}`);

                emitOODA('act', `[${step_id}] Executing: ${toolName}`, {
                    tool: toolName,
                    args: toolArgs,
                    execution_id
                });

                // Find which server has this tool
                const toolInfo = toolsList.find(t => t.tool.name === toolName);
                if (toolInfo) {
                    const toolResult = await mcpManager.callTool(toolInfo.server, toolName, toolArgs);

                    // Track file artifacts
                    if (toolName === 'write_file' && toolArgs?.path) {
                        artifacts.push(toolArgs.path);
                    }

                    return {
                        response: result.reasoning || `Executed ${toolName}`,
                        tool_calls: [{ name: toolName, args: toolArgs, result: toolResult }],
                        artifacts,
                        step_id
                    };
                } else {
                    console.warn(`[Orchestrator] Tool ${toolName} not found in any server`);
                }
            }

            return {
                response: result.response || JSON.stringify(result),
                tool_calls: [],
                artifacts,
                step_id
            };

        } catch (error) {
            console.error(`[Orchestrator] Autonomous step ${step_id} failed:`, error);
            throw error;
        }
    }
}

export const agentOrchestrator = new AgentOrchestrator();
