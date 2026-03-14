import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    GoalDefinition,
    ExecutionState,
    GoalExecutionOptions,
    GoalExecutionResult,
    StateAssessment,
    ActionResult,
    Milestone,
    calculateMaxIterations,
    generateId
} from '../types/goal';
import { goalValidator } from './GoalValidator';
import { agentPool } from './AgentPool';
import { agentBus } from './AgentBus';
import { db } from '../database';
import { mcpManager } from '../mcp/MCPManager';
import { configManager } from '../services/ConfigManager';
import { MarkdownConfigLoader } from '../config/MarkdownConfigLoader';
import { skillLearner } from '../services/SkillLearner';
import { modelRouter } from '../services/llm/modelRouter';
import { modelManager } from '../services/llm/modelManager';
import { containerSessionManager } from '../execution/ContainerSession';

// ============================================================================
// EXTENSION HOOKS
// Lifecycle hooks that external extensions can register to inject behaviour
// into the goal execution loop without modifying core agent code.
//
// Usage (from any module):
//   import { extensionHooks } from './GoalOrientedExecutor';
//   extensionHooks.on('before_reason', async (ctx) => { ... });
//
// Available hooks:
//   before_reason  — fires before every ReAct reason() call
//                    ctx: { state: ExecutionState; iteration: number }
//   after_action   — fires after every action execution
//                    ctx: { state: ExecutionState; action: any; result: any }
//   system_prompt_build — fires when building the agent system prompt
//                    ctx: { state: ExecutionState; promptSections: string[] }
//                    Extensions push additional sections into promptSections[].
//   after_execution — fires when a goal finishes (success or failure)
//                    ctx: { state: ExecutionState; result: GoalExecutionResult }
// ============================================================================

type HookContext = Record<string, any>;
type HookFn = (context: HookContext) => Promise<void> | void;

class ExtensionHooks {
    private hooks: Map<string, HookFn[]> = new Map();

    /** Register a handler for a named hook. */
    on(hookName: string, fn: HookFn): void {
        if (!this.hooks.has(hookName)) this.hooks.set(hookName, []);
        this.hooks.get(hookName)!.push(fn);
    }

    /** Remove a previously registered handler. */
    off(hookName: string, fn: HookFn): void {
        const fns = this.hooks.get(hookName);
        if (fns) {
            const idx = fns.indexOf(fn);
            if (idx !== -1) fns.splice(idx, 1);
        }
    }

    /** Fire all handlers for a hook, awaiting each in sequence. */
    async emit(hookName: string, context: HookContext): Promise<void> {
        const fns = this.hooks.get(hookName) || [];
        for (const fn of fns) {
            try {
                await fn(context);
            } catch (e: any) {
                log.warn({ err: e.message }, `[ExtensionHooks] Handler error in "${hookName}"`);
            }
        }
    }

    /** List registered hook names (for diagnostics). */
    list(): string[] {
        return Array.from(this.hooks.keys());
    }
}

/** Singleton — import this in any extension module to register hooks. */
export const extensionHooks = new ExtensionHooks();

// ============================================================================
// Extracted modules (Sprint 2: Kill the Monolith)
// ============================================================================
import { GoalExtractor } from './goal/GoalExtractor';
import { TaskDecomposer } from './goal/TaskDecomposer';
import { ExecutionEngine } from './goal/ExecutionEngine';
import { SelfCorrector, classifyErrorSeverity } from './goal/SelfCorrector';
import { ReActReasoner } from './goal/ReActReasoner';
import { promptLoader } from '../utils/PromptLoader';
import { createLogger, goalLogger } from '../utils/Logger';
import { agentError } from '../utils/errors';
import { parseParamCount, isSmallModel } from '../utils/modelUtils';

const log = createLogger('GoalOrientedExecutor');

// ============================================================================
// GOAL-ORIENTED EXECUTOR (Orchestrator)
// Delegates extraction, decomposition, execution, reasoning, and correction
// to focused modules under ./goal/
// ============================================================================

export class GoalOrientedExecutor extends EventEmitter {
    private executions: Map<string, ExecutionState> = new Map();
    private gateway: any = null;

    // Sub-modules
    private extractor = new GoalExtractor();
    private decomposer = new TaskDecomposer();
    private engine = new ExecutionEngine();
    private corrector = new SelfCorrector();
    private reasoner = new ReActReasoner();

    // Agent profile — determines reasoning style
    private activeProfile: string = 'default';

    // HITL Approval system
    private pendingApprovals: Map<string, {
        resolve: (response: { approved: boolean; modifiedScript?: string }) => void;
        timeout: ReturnType<typeof setTimeout>;
    }> = new Map();
    private approvalMode: 'none' | 'script' | 'all' = 'script';

    // User-input escalation (ask user when all strategies exhausted).
    // Keyed by executionId → FIFO queue of pending entries.
    // FIFO ensures the oldest unanswered question is resolved first when
    // the browser is released — not the most recent one (.at(-1) bug).
    private pendingInputs: Map<string, Array<{
        inputId: string;
        resolve: (hint: string) => void;
        timeout: ReturnType<typeof setTimeout>;
    }>> = new Map();
    // Fast reverse-lookup: inputId → executionId (for respondToUserInput by API callers)
    private inputIdToExecution: Map<string, string> = new Map();

    // Browser control: user can pause agent, interact with browser, then resume
    public browserControlActive: boolean = false;

    /** Pause the ReAct loop so the user can interact with the browser directly. */
    public takeBrowserControl(): void {
        this.browserControlActive = true;
    }

    /** Resume the ReAct loop after user releases browser control. */
    public releaseBrowserControl(): void {
        this.browserControlActive = false;
    }

    /**
     * Wait for the user to release browser control, with a hard timeout.
     * Returns 'released' if user clicked Release Control, 'timeout' if user was away,
     * or 'cancelled' if the goal was cancelled.
     */
    private async waitForBrowserRelease(
        checkCancelled: () => boolean,
        timeoutMs = 10 * 60 * 1000   // 10 minutes
    ): Promise<'released' | 'timeout' | 'cancelled'> {
        const deadline = Date.now() + timeoutMs;
        while (this.browserControlActive) {
            await new Promise(r => setTimeout(r, 500));
            if (checkCancelled()) return 'cancelled';
            if (Date.now() >= deadline) {
                this.browserControlActive = false;
                return 'timeout';
            }
        }
        return 'released';
    }

    /**
     * Send an urgent notification to the user's preferred messaging channel
     * (Telegram / Discord / etc.) when the agent is paused waiting for a CAPTCHA solve.
     * Falls back silently if no channel is configured.
     */
    private async notifyUserOfCaptcha(url: string | undefined, waitMinutes: number): Promise<void> {
        try {
            const { heartbeatService } = await import('../services/HeartbeatService');
            const { messagingGateway } = await import('../services/MessagingGateway');
            const cfg = heartbeatService.getConfig();
            const channel = cfg?.preferredChannel;
            const chatId = cfg?.channelChatId;
            if (!channel || channel === 'web' || !chatId) return;
            const status = messagingGateway.getProviderStatus(channel);
            if (!status?.connected) return;
            const domain = (() => { try { return new URL(url || '').hostname; } catch { return url || 'unknown'; } })();
            await messagingGateway.sendMessage(
                channel, chatId,
                `⚠️ *Action required — CAPTCHA detected*\n\nAI Partner is paused waiting for you to solve a CAPTCHA on *${domain}*.\n\nOpen the Browser Inspector in AI Partner and click "Take Control" to solve it.\n\nYou have *${waitMinutes} minute${waitMinutes !== 1 ? 's' : ''}* before it gives up and uses an alternative approach.`
            );
        } catch { /* notification is best-effort */ }
    }

    /**
     * Notify user via Telegram/Discord when the agent escalates to browser HITL.
     * Includes the goal name, blocked reason, and clear options so the user
     * knows exactly what to do — especially if they're away from the web UI.
     */
    private async notifyUserOfBlockedHITL(goalTitle: string, blockedReason: string, targetUrl: string | undefined): Promise<void> {
        try {
            const { heartbeatService } = await import('../services/HeartbeatService');
            const { messagingGateway } = await import('../services/MessagingGateway');
            const cfg = heartbeatService.getConfig();
            const channel = cfg?.preferredChannel;
            const chatId = cfg?.channelChatId;
            if (!channel || channel === 'web' || !chatId) return;
            const status = messagingGateway.getProviderStatus(channel);
            if (!status?.connected) return;
            const urlLine = targetUrl ? `\n🔗 *Page:* ${targetUrl}` : '';
            await messagingGateway.sendMessage(
                channel, chatId,
                `⚠️ *Agent needs your help*\n\n` +
                `*Goal:* ${goalTitle}${urlLine}\n\n` +
                `${blockedReason}\n\n` +
                `*Your options:*\n` +
                `1️⃣ Browser is open — complete the action manually, then close it\n` +
                `2️⃣ Paste a working URL in chat — I'll navigate there\n` +
                `3️⃣ Reply *skip goal* to abandon this task\n\n` +
                `_You have 5 minutes before I try a different approach automatically._`
            );
        } catch { /* notification is best-effort */ }
    }

    /**
     * Extracted HITL flow for browser blocks — DRY helper called from the Cloudflare stealth-fail
     * branch and the non-Cloudflare direct-block branch.
     */
    private async _requestBrowserHITL(
        executionId: string,
        state: any,
        blockType: string,
        blockedUrl: string | undefined,
        checkCancelled: () => boolean,
        _consecutiveBrowserBlockedFailures: number
    ): Promise<void> {
        const { browserServer: bs } = await import('../mcp/servers/BrowserServer');
        this.browserControlActive = true;
        this.broadcastGoalEvent('browser:blocked', {
            execution_id: executionId,
            blockType,
            url: blockedUrl || bs.getCurrentUrl(),
            message: `Browser blocked by ${blockType}. Take Control in the Inspector panel, solve the challenge, then click Release Control to resume.`,
        });
        await this.notifyUserOfCaptcha(blockedUrl || bs.getCurrentUrl(), 2);
        const waitOutcome = await this.waitForBrowserRelease(checkCancelled, 2 * 60 * 1000);
        state.human_browser_help_used = (state.human_browser_help_used || 0) + 1;
        if (waitOutcome === 'timeout') {
            const resolvedDomain = (() => { try { return new URL(blockedUrl || '').hostname; } catch { return blockedUrl || 'unknown'; } })();
            this.broadcastGoalEvent('browser:control_timeout', { execution_id: executionId, url: blockedUrl });
            state.execution_journal.push(`[human_browser_help_timeout] User unavailable for 2 min on ${resolvedDomain}. Domain blocked for session.`);
            state.error_history.push({
                iteration: state.current_iteration,
                timestamp: new Date(),
                error: `CAPTCHA/block wait timed out on ${resolvedDomain}. PERMANENTLY SKIP this domain — use alternative data sources.`,
                context: 'captcha_timeout',
                recovery_attempted: false,
                recovery_successful: false,
            });
        } else {
            state.execution_journal.push(`[human_browser_help] User took browser control after ${blockType} block (attempt ${state.human_browser_help_used})`);
            state.error_history.push({
                iteration: state.current_iteration,
                timestamp: new Date(),
                error: `Human browser control used for ${blockType} block. If still stuck, do NOT retry this site.`,
                context: 'human_browser_help_released',
                recovery_attempted: true,
                recovery_successful: false,
            });
        }
    }

    constructor() {
        super();
    }

    // ========================================================================
    // GATEWAY & EVENTS
    // ========================================================================

    setGateway(gw: any): void {
        this.gateway = gw;
        // Wire AgentBus to the same Socket.IO gateway so agent:message events reach the frontend
        agentBus.setGateway(gw);
    }

    private broadcastGoalEvent(event: string, data: any): void {
        const execution = this.executions.get(data.execution_id || data.approvalId?.split('_')[0] || data.inputId?.split('_')[0]);
        const conversationId = execution?.conversationContext ? (execution as any).conversationId : data.conversationId;

        const enrichedData = {
            ...data,
            containerSessionId: this.engine.containerSessionId || undefined,
            conversationId: conversationId
        };
        this.emit(event, enrichedData);
        if (this.gateway?.io) {
            const ts = new Date().toISOString();
            this.gateway.io.emit(event, { timestamp: ts, ...enrichedData });

            // Mirror key goal events to ooda:event so Agent Logs / Recent Events stay live
            let oodaPhase: string | null = null;
            let oodaContent: string | null = null;
            if (event === 'goal:started') {
                oodaPhase = 'orient';
                oodaContent = `Goal started: ${String(data.goal || '').substring(0, 100)}`;
            } else if (event === 'goal:reasoning') {
                oodaPhase = 'decide';
                oodaContent = `Iter ${data.iteration}: ${String(data.reasoning || '').substring(0, 120)}`;
            } else if (event === 'goal:delegation') {
                oodaPhase = 'act';
                oodaContent = `Delegating ${data.taskCount ?? ''} sub-tasks to agent pool`;
            } else if (event === 'goal:replanning') {
                oodaPhase = 'reflect';
                oodaContent = `Replanning (stuck_count=${data.stuck_count ?? 0})`;
            } else if (event === 'goal:completed') {
                oodaPhase = 'reflect';
                const pct = data.result?.summary?.progress_percent ?? data.progress ?? 0;
                const iters = data.result?.summary?.total_iterations ?? data.iterations ?? '?';
                oodaContent = `Goal completed ✓ (${pct}% in ${iters} iterations)`;
            } else if (event === 'goal:failed') {
                oodaPhase = 'reflect';
                const iters = data.result?.summary?.total_iterations ?? data.iterations ?? '?';
                oodaContent = `Goal failed after ${iters} iterations`;
            }
            // Signal workspace file tree to refresh whenever a goal finishes
            if (event === 'goal:completed' || event === 'goal:failed') {
                this.gateway.io.emit('workspace:refresh', {});
            }
            if (oodaPhase && oodaContent) {
                this.gateway.io.emit('ooda:event', {
                    type: 'ooda_event',
                    timestamp: ts,
                    payload: { phase: oodaPhase, content: oodaContent },
                });
            }
        }
    }

    // ========================================================================
    // HITL APPROVAL SYSTEM
    // ========================================================================

    setApprovalMode(mode: 'none' | 'script' | 'all'): void {
        this.approvalMode = mode;
        log.info(`[GoalExecutor] Approval mode set to: ${mode}`);
    }

    getApprovalMode(): 'none' | 'script' | 'all' {
        return this.approvalMode;
    }

    // ========================================================================
    // AGENT PROFILES
    // ========================================================================

    /**
     * Set the active profile by name. Built-in: 'default', 'researcher', 'coder'.
     * Profile content is loaded from server/prompts/profiles/{name}.md.
     */
    setProfile(name: string): void {
        this.activeProfile = name;
        log.info(`[GoalExecutor] Profile set to: ${name}`);
    }

    getProfile(): string {
        return this.activeProfile;
    }

    /**
     * Auto-detect the best profile for a goal based on keyword heuristics.
     * Returns 'coder' for code/build goals, 'researcher' for research/analysis,
     * 'default' otherwise.
     */
    private detectProfile(goalDescription: string): string {
        const desc = goalDescription.toLowerCase();
        const codeKeywords = ['code', 'script', 'program', 'function', 'class', 'app', 'build', 'implement',
            'api', 'server', 'database', 'test', 'debug', 'refactor', 'deploy', 'typescript', 'python', 'javascript'];
        const researchKeywords = ['research', 'analyse', 'analyze', 'compare', 'summarize', 'summarise',
            'report', 'study', 'investigate', 'survey', 'review', 'explore', 'find out', 'what is'];

        if (codeKeywords.some(k => desc.includes(k))) return 'coder';
        if (researchKeywords.some(k => desc.includes(k))) return 'researcher';
        return 'default';
    }

    /**
     * Load profile content from server/prompts/profiles/{name}.md.
     * Falls back to empty string if file doesn't exist.
     */
    private loadProfileContent(name: string): string {
        return promptLoader.load(`profiles/${name}`, '');
    }

    private async requestScriptApproval(
        executionId: string,
        script: string,
        runtime: 'python' | 'node',
        goalDescription: string
    ): Promise<{ approved: boolean; modifiedScript?: string }> {
        if (this.approvalMode === 'none') {
            return { approved: true };
        }

        const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        return new Promise<{ approved: boolean; modifiedScript?: string }>((resolve) => {
            // 'all' mode runs inside unattended goal loops — use a short timeout (config default 60s)
            // so the goal doesn't deadlock waiting for a human who isn't watching.
            // 'script' mode is a deliberate review step — use 10 minutes.
            const hitlSecs = configManager.getConfig().execution.hitl_timeout_seconds ?? 60;
            const TIMEOUT_MS = this.approvalMode === 'all'
                ? hitlSecs * 1000
                : 10 * 60 * 1000;

            const timeout = setTimeout(() => {
                this.pendingApprovals.delete(approvalId);
                log.info(`[GoalExecutor] Approval timed out after ${TIMEOUT_MS / 1000}s for ${approvalId}, auto-rejecting`);
                resolve({ approved: false });
            }, TIMEOUT_MS);

            this.pendingApprovals.set(approvalId, { resolve, timeout });

            this.broadcastGoalEvent('goal:approval-needed', {
                approvalId,
                executionId,
                type: 'script_execution',
                runtime,
                goalDescription,
                scriptPreview: script.substring(0, 2000),
                fullScript: script,
                scriptLength: script.length,
                message: `A ${runtime} script (${script.length} chars) was generated to achieve your goal. Review and approve before execution.`
            });

            log.info(`[GoalExecutor] Waiting for approval: ${approvalId}`);
        });
    }

    respondToApproval(
        approvalId: string,
        approved: boolean,
        modifiedScript?: string
    ): boolean {
        const pending = this.pendingApprovals.get(approvalId);
        if (!pending) {
            log.warn(`[GoalExecutor] No pending approval found: ${approvalId}`);
            return false;
        }

        clearTimeout(pending.timeout);
        this.pendingApprovals.delete(approvalId);
        pending.resolve({ approved, modifiedScript });
        log.info(`[GoalExecutor] Approval ${approvalId}: ${approved ? 'APPROVED' : 'REJECTED'}`);
        return true;
    }

    /**
     * Count how many executions for a given userId are currently in a running state.
     * Used by goal routes to enforce the concurrent-active limit (max 3 per user).
     */
    countActiveExecutions(userId: string): number {
        let count = 0;
        for (const state of this.executions.values()) {
            if (state.status === 'executing' || state.status === 'planning' ||
                state.status === 'validating' || state.status === 'replanning') {
                // ExecutionState doesn't store userId directly — check via DB key pattern.
                // For single-user deployments (no auth), userId is 'default' and all executions count.
                // For multi-user deployments, execution_id encodes userId in the DB, not in-memory state.
                // We conservatively count ALL active executions — correct for single-user, safe for multi-user.
                count++;
            }
        }
        return count;
    }

    // ========================================================================
    // USER-INPUT ESCALATION — ask user when all strategies exhausted
    // ========================================================================

    /**
     * Called by the route handler when the user submits a hint for a stuck goal.
     * Returns false if the inputId is unknown (already timed out or resolved).
     */
    respondToUserInput(inputId: string, hint: string): boolean {
        const execId = this.inputIdToExecution.get(inputId);
        if (!execId) {
            log.warn(`[GoalExecutor] No pending user-input found: ${inputId}`);
            return false;
        }
        const arr = this.pendingInputs.get(execId);
        if (!arr) {
            log.warn(`[GoalExecutor] Execution queue missing for inputId ${inputId} (execId: ${execId})`);
            this.inputIdToExecution.delete(inputId);
            return false;
        }
        const idx = arr.findIndex(e => e.inputId === inputId);
        if (idx < 0) {
            log.warn(`[GoalExecutor] inputId ${inputId} not found in execution queue`);
            this.inputIdToExecution.delete(inputId);
            return false;
        }
        const [entry] = arr.splice(idx, 1);
        if (arr.length === 0) this.pendingInputs.delete(execId);
        this.inputIdToExecution.delete(inputId);
        clearTimeout(entry.timeout);
        entry.resolve(hint);
        log.info(`[GoalExecutor] User hint received for ${inputId}: "${hint.substring(0, 80)}"`);
        return true;
    }

    /**
     * Resolve the OLDEST pending HITL input across all active executions.
     * Called when the user releases browser control — FIFO ensures the question
     * that was asked first gets answered first, not the most recent one.
     * Returns true if a pending input was found and resolved, false if none was pending.
     */
    resolveAnyPendingInput(message: string): boolean {
        // FIFO: Map iterates in insertion order — first execution with pending inputs wins
        for (const [execId, arr] of this.pendingInputs) {
            if (arr.length === 0) {
                this.pendingInputs.delete(execId);
                continue;
            }
            const entry = arr.shift()!;  // oldest first
            if (arr.length === 0) this.pendingInputs.delete(execId);
            this.inputIdToExecution.delete(entry.inputId);
            clearTimeout(entry.timeout);
            entry.resolve(message);
            log.info(`[GoalExecutor] Auto-resolved pending HITL ${entry.inputId} (exec: ${execId}) after browser release`);
            return true;
        }
        return false;
    }

    /**
     * Pause execution and wait for the user to provide a strategic hint or structured input.
     * Emits `goal:user-input-needed` so the frontend can show an input prompt.
     * Times out after 10 minutes and rejects (returns empty string → fail).
     *
     * @param executionId  Active execution ID
     * @param state        Current execution state
     * @param override     Optional override: custom question + structured fields for proactive input requests
     */
    /**
     * Extract the most relevant URL the agent was working with in this execution.
     * Priority: most-recent browser_navigate > browser_fetch > web_fetch > URL in goal text.
     */
    private extractTargetUrl(state: ExecutionState): string {
        const URL_TOOLS = ['browser_navigate', 'browser_fetch', 'web_fetch'];
        for (let i = state.completed_actions.length - 1; i >= 0; i--) {
            const a = state.completed_actions[i];
            if (URL_TOOLS.includes(a.tool_used)) {
                const url = a.args?.url || a.args?.path;
                if (typeof url === 'string' && url.startsWith('http')) return url;
            }
        }
        // Fall back to first URL in goal description
        const m = state.goal.description.match(/https?:\/\/[^\s,)'"]+/);
        return m ? m[0] : '';
    }

    /**
     * Deterministically detects goals that require user credentials (login/order/booking).
     * Uses verb-intent regex with negative lookahead to avoid false positives on
     * informational / how-to queries (e.g. "explain how to order on Swiggy").
     * Returns false when credentials are already present in conversation context.
     */
    private needsCredentials(goalText: string, conversationContext?: ConversationMessage[]): boolean {
        // Negative-lookahead: skip if preceded by "how to", "explain", "learn", etc.
        const CRED_VERB = /(?<!how to |explain |understand |learn |about |write |code |script )(order|book|checkout|sign in to|post on|buy from|reserve|pay for|log in to|purchase from|place.*order|submit.*form|fill.*form|login to|sign up for|register on|subscribe to)\b/i;
        if (!CRED_VERB.test(goalText)) return false;

        // Check whether credentials are already visible in conversation context
        if (conversationContext && conversationContext.length > 0) {
            const history = conversationContext.map(m => m.content).join('\n');
            const hasEmail = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/.test(history);
            const hasPwd = /\bpassword\s*[:=]?\s*\S+/i.test(history) || /\bpwd\s*[:=]?\s*\S+/i.test(history);
            if (hasEmail && hasPwd) return false; // already have them
        }
        return true;
    }

    private async requestUserInput(
        executionId: string,
        state: ExecutionState,
        override?: {
            question: string;
            fields: Array<{ name: string; label: string; type?: string; required?: boolean; placeholder?: string; options?: string[] }>;
        }
    ): Promise<string> {
        const inputId = `input_${Date.now()}_${randomUUID().substring(0, 8)}`;
        const TIMEOUT_MS = 5 * 60 * 1000; // 5-minute window; on timeout agent tries a different strategy

        // URL the browser should open to when human takes control
        const browserTargetUrl = this.extractTargetUrl(state);

        if (override) {
            // Signal the frontend that the browser is relevant to this request
            // (password field present, or question mentions login/auth/captcha).
            // Client uses this to show an optional "Fill in Browser ↗" button.
            const hasBrowserFields = override.fields.some(
                f => f.type === 'password' || f.name === 'password' || f.name === 'otp'
            );
            const mentionsBrowser = /login|captcha|authenticat|credential|sign.?in|2fa|otp/i.test(override.question);
            const browserAvailable = hasBrowserFields || mentionsBrowser;

            // Proactive structured request — agent explicitly needs specific data from the user
            this.broadcastGoalEvent('goal:user-input-needed', {
                execution_id: executionId,
                inputId,
                message: override.question,
                fields: override.fields,
                proactive: true,
                browserAvailable,
                browserTargetUrl: browserAvailable ? browserTargetUrl : undefined,
            });
        } else {
            // Fallback stuck-state request — agent ran out of strategies
            const triedStrategies = state.error_history
                .map(e => `- ${e.context}: ${e.error.substring(0, 80)}`)
                .slice(-6)
                .join('\n');

            const criteriaPassed = state.goal.success_criteria.filter(c => c.status === 'passed').length;
            const criteriaTotal = state.goal.success_criteria.length;

            this.broadcastGoalEvent('goal:user-input-needed', {
                execution_id: executionId,
                inputId,
                context: {
                    goal: state.goal.description,
                    tried: triedStrategies || 'Multiple approaches attempted',
                    artifacts_so_far: state.artifacts,
                    criteria_passed: criteriaPassed,
                    criteria_total: criteriaTotal,
                    strategy_changes: state.strategy_changes,
                    last_error: state.error_history[state.error_history.length - 1]?.error || 'Unknown error',
                },
                message: `I've tried ${state.strategy_changes} strategies and I'm stuck on "${state.goal.description}". What should I do next?`,
                fields: null,
                proactive: false,
                browserTargetUrl: browserTargetUrl || undefined,
            });
        }

        log.info(`[GoalExecutor] Waiting for user input: ${inputId} (proactive: ${!!override})`);

        return new Promise<string>((resolve) => {
            const timeout = setTimeout(() => {
                // Remove from queue on timeout
                const arr = this.pendingInputs.get(executionId);
                if (arr) {
                    const idx = arr.findIndex(e => e.inputId === inputId);
                    if (idx >= 0) arr.splice(idx, 1);
                    if (arr.length === 0) this.pendingInputs.delete(executionId);
                }
                this.inputIdToExecution.delete(inputId);
                log.info(`[GoalExecutor] User input timed out for ${inputId} — switching to autonomous retry strategy`);
                resolve(''); // empty string → caller treats as give-up
            }, TIMEOUT_MS);

            // Push to FIFO queue for this execution
            const arr = this.pendingInputs.get(executionId) ?? [];
            arr.push({ inputId, resolve, timeout });
            this.pendingInputs.set(executionId, arr);
            this.inputIdToExecution.set(inputId, executionId);
        });
    }

    // ========================================================================
    // MAIN EXECUTION METHOD
    // ========================================================================

    async executeGoal(
        userRequest: string,
        userId: string = 'default',
        options: GoalExecutionOptions = {}
    ): Promise<GoalExecutionResult> {
        const executionId = `goal_${Date.now()}_${randomUUID().substring(0, 8)}`;
        const startTime = Date.now();
        // Bind executionId + requestId to every log line for this execution
        const log = goalLogger(executionId, 'GoalOrientedExecutor', options.requestId);

        // Auto-enable network when the goal requires live data fetching.
        // Explicit option always wins; otherwise heuristic-detect from request text.
        const liveDataKeywords = /\b(stocks?|nse|bse|shares?|equity|price|market|crypto|bitcoin|weather|news|fetch|live|real.?time|api|url|https?|download|scrape|finance|yahoo|moneycontrol)\b/i;
        const needsNetwork = liveDataKeywords.test(userRequest);
        const enableNetwork = options.enableNetwork ?? needsNetwork;

        // Detect browser intent — tasks that require an interactive browser OR explicitly name browser tools.
        // Explicit browser tool names (browser_launch, browser_screenshot, etc.) always trigger intent
        // so the LLM can see and use them. Also: any task that directs the agent to a URL for
        // data extraction should use browser tools — "go to", "scrape", "extract from" included.
        const browserKeywords = /\b(go to (https?:\/\/|www\.)\S+|visit (https?:\/\/|www\.)\S+|open (https?:\/\/|www\.)\S+|navigate to (https?:\/\/|www\.)\S+|scrape|web scraping|web crawl|extract (top|all|list|data|table)|login to|log into|sign in to|fill out|fill in the form|submit (the )?form|click (the )?button|solve captcha|bypass cloudflare|oauth|authenticate (with|to)|google forms?|typeform|web portal login|interactive (dashboard|form|app)|browser automation|headless browser|browser_launch|browser_navigate|browser_screenshot|browser_click|browser_fill|browser_extract|browser_get_content|browser_fetch|browser_wait|browser_eval|take a screenshot of|screenshot (of the|the) (page|site|front))\b/i;
        const needsBrowser = browserKeywords.test(userRequest);

        // Configure sub-modules for this execution
        this.engine.enableNetwork = enableNetwork;
        this.engine.containerSessionId = `goal_${executionId.replace('goal_', '')}`;
        this.engine.selfCorrectionAttempts = 0;
        this.reasoner.containerSessionId = this.engine.containerSessionId;
        this.reasoner.enableNetwork = this.engine.enableNetwork;
        this.reasoner.browserIntent = needsBrowser;
        this.reasoner.resetSearchState();

        if (needsNetwork && options.enableNetwork === undefined) {
            log.info(`[GoalExecutor] Auto-enabling network (live data keywords detected in request)`);
        }
        if (needsBrowser) {
            log.info(`[GoalExecutor] Browser intent detected — injecting browser tool hints into prompt`);
        }

        // Sync approval mode from live config so the toggle is hot
        // (no restart required — takes effect on the next executeGoal() call)
        const execCfg = configManager.getConfig().execution;
        const configuredMode = execCfg.approval_mode ?? (
            execCfg.require_approval_for_writes ? 'script' : 'none'
        );
        // options.approvalMode (per-call override) always wins; config is the default
        this.approvalMode = (options.approvalMode ?? configuredMode) as 'none' | 'script' | 'all';
        log.info(`[GoalExecutor] Approval mode: ${this.approvalMode}`);

        // Auto-detect or use explicitly set profile
        const profileName = options.profile || this.detectProfile(userRequest);
        // Check if profileName is a named agent slug/id in the DB (Phase 2)
        let profileContent = '';
        try {
            const dbProfile = await agentPool.lookupProfile(profileName);
            if (dbProfile && dbProfile.systemPrompt.trim()) {
                profileContent = dbProfile.systemPrompt;
                log.info(`[GoalExecutor] Using named agent profile: "${dbProfile.name}" (${dbProfile.slug})`);
            } else {
                profileContent = this.loadProfileContent(profileName);
                if (profileName !== 'default') {
                    log.info(`[GoalExecutor] Using profile: ${profileName}`);
                }
            }
        } catch {
            profileContent = this.loadProfileContent(profileName);
        }
        this.reasoner.profileContent = profileContent;
        this.reasoner.activeProfile = profileName;

        // Sync GoalValidator's workspace root with the MCP filesystem server so that
        // file_exists checks use the exact same base directory as write_file writes.
        goalValidator.setWorkspace(mcpManager.getWorkspace() || configManager.getWorkspaceDir());

        // Cleanup orphaned containers from crashed/timed-out past runs (fire-and-forget)
        containerSessionManager.cleanupStaleContainers().catch(() => { /* non-fatal */ });

        log.info(`[GoalExecutor] Starting execution ${executionId}`);
        log.info(`[GoalExecutor] Request: "${userRequest.substring(0, 100)}..."`);
        log.info(`[GoalExecutor] Container session: ${this.engine.containerSessionId}, network: ${this.engine.enableNetwork}`);

        this.broadcastGoalEvent('goal:started', {
            execution_id: executionId,
            request: userRequest,
            containerSessionId: this.engine.containerSessionId,
            enableNetwork: this.engine.enableNetwork,
        });

        // Register this goal execution as root agent on the bus so child agents
        // (AgentPool workers) can escalate results back to it, and the frontend
        // AgentPoolMonitor can track the primary agent alongside child agents.
        agentBus.registerAgent(executionId, null);
        agentBus.send(executionId, 'broadcast', 'status', {
            phase: 'started', goal: userRequest.substring(0, 200)
        });

        try {
            // ================================================================
            // PHASE 1: GOAL EXTRACTION (delegated to GoalExtractor)
            // ================================================================
            this.emitProgress(executionId, 'planning', 'Analyzing your request...');

            const goal = await this.extractor.extractGoal(userRequest, executionId, options.conversationContext);
            log.info(`[GoalExecutor] Goal extracted: ${goal.description}`);
            log.info(`[GoalExecutor] Success criteria: ${goal.success_criteria.length}`);
            log.info(`[GoalExecutor] Complexity: ${goal.estimated_complexity}/10`);

            const maxIterations = options.max_iterations ||
                calculateMaxIterations(goal.estimated_complexity, goal.success_criteria.length);

            // ================================================================
            // PHASE 1.5: CONFIGURE AGENT POOL (complexity-gated delegation)
            // ----------------------------------------------------------------
            // complexity < 6  → delegation OFF (simple tasks, single-domain)
            // complexity 6-7  → 2 delegations, depth 1
            // complexity 8-9  → 3 delegations, depth 1
            // complexity 10   → 4 delegations, depth 2
            //
            // OVERRIDE: if the user explicitly requests delegation, force-enable
            // regardless of complexity estimate (GoalExtractor may underestimate).
            // ================================================================
            const complexity = goal.estimated_complexity;

            // ── DYNAMIC AGENT COUNT ───────────────────────────────────────────────
            // Parse explicit agent count from the user request (e.g. "4 agents" → 4).
            // Hard cap at 12 — beyond that API quota exhaustion risk is too high.
            // When not specified, fall back to complexity-based heuristics.
            const MAX_AGENTS = 12;
            const agentCountMatch = userRequest.match(/\b(\d+)\s+agents?\b/i);
            const parsedAgentCount = agentCountMatch
                ? Math.min(parseInt(agentCountMatch[1], 10), MAX_AGENTS)
                : 0;

            const delegationRequestedExplicitly = /\b(delegate|child agent|sub.?agent|spawn|assign to|have\s+an?\s+agent|orchestrat[a-z]*|multiple\s+agents?|\d+\s+agents?|\d+\s+specialist)\b/i.test(userRequest);
            const delegationEnabled = complexity >= 6 || delegationRequestedExplicitly;

            // maxDelegations: honour the explicit count; otherwise use complexity scale
            const maxDelegations = delegationEnabled
                ? (parsedAgentCount > 0 ? parsedAgentCount : (complexity >= 10 ? 4 : complexity >= 8 ? 3 : 2))
                : 0;

            // maxConcurrent: all requested agents run truly in parallel (no queuing).
            // Without an explicit count, cap at 5 to protect free-tier API quotas.
            const maxConcurrent = parsedAgentCount > 0 ? parsedAgentCount : Math.min(complexity, 5);

            const maxDepth = complexity >= 9 ? 3 : complexity >= 7 ? 2 : 1;

            agentPool.clearAbort(executionId);   // clear any stale abort from a previous run
            agentPool.resetSpawnCounter();

            // Inject user context into child agents and reasoner so preferences
            // (TypeScript over JS, output paths, etc.) are visible everywhere
            try {
                const userCtx = new MarkdownConfigLoader(configManager.getWorkspaceDir()).loadUser();
                agentPool.setUserContext(userCtx);
                this.reasoner.userContext = userCtx;
            } catch { /* non-fatal — no USER.md yet */ }
            agentPool.setBudget({
                maxDepth,
                maxConcurrent,
                totalAgentLimit: Math.max(maxDelegations * 3, MAX_AGENTS),
                timeoutMs: 90_000,
            });

            // Pass explicit-delegation flag so the reasoner can allow delegation on
            // iteration 1 and inject the "must delegate first" prompt instruction.
            this.reasoner.setDelegationConfig(delegationEnabled, delegationRequestedExplicitly && parsedAgentCount > 0);

            log.info(`[GoalExecutor] AgentPool: delegation=${delegationEnabled}, requested=${parsedAgentCount}, maxDelegations=${maxDelegations}, maxConcurrent=${maxConcurrent}, maxDepth=${maxDepth}`);

            // ================================================================
            // PHASE 2: INITIALIZE STATE
            // ================================================================

            // Detect explicit /workspace/output/... paths in the goal text.
            // When present, use 'output' as the fixed output dir so the redirector
            // does not move files to a goal-slug directory — the agent will write
            // exactly where instructed and the validator will find them.
            const explicitOutputFiles: string[] = [
                ...userRequest.matchAll(/\/workspace\/output\/([^\s,'")\n\]>]+)/gi)
            ].map(m => `output/${m[1].replace(/[.,;)>\]]+$/, '')}`);

            // Generate a human-readable folder name from the goal description.
            // On retry, reuse the same folder (outputDirOverride) so the agent sees
            // files already written and can fix them rather than starting fresh.
            const goalSlug = options.outputDirOverride
                ? options.outputDirOverride
                : explicitOutputFiles.length > 0 ? 'output' : (() => {
                    const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
                        'of', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
                        'you', 'your', 'i', 'my', 'we', 'our', 'can', 'please', 'help', 'make',
                        'create', 'generate', 'write', 'build', 'do', 'that', 'this', 'it', 'its']);
                    const words = goal.description
                        .replace(/[^a-zA-Z0-9\s]/g, ' ')
                        .toLowerCase()
                        .split(/\s+/)
                        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
                    const slug = words.slice(0, 5).join('-') || 'goal';
                    // Append short timestamp suffix to prevent collisions across runs
                    const ts = Date.now().toString(36).slice(-4);
                    return `${slug}-${ts}`;
                })();
            const workspaceRoot = mcpManager.getWorkspace() || '/workspace';

            const state: ExecutionState = {
                execution_id: executionId,
                goal,
                current_iteration: 0,
                max_iterations: maxIterations,
                status: 'executing',
                milestones: this.createMilestones(goal),
                completed_actions: [],
                artifacts: [],
                progress_percent: 0,
                stuck_count: 0,
                consecutive_read_only: 0,
                file_read_counts: {},
                strategy_changes: 0,
                error_history: [],
                execution_journal: [],
                delegation_count: 0,
                max_delegations: maxDelegations,
                started_at: new Date(),
                last_progress_at: new Date(),
                conversationContext: options.conversationContext,
                outputDir: goalSlug,
                human_browser_help_used: 0,
                escalation_count: 0,
                max_escalations: 2,
                pinned_artifacts: {},
                visited_urls: {},
                timing_metrics: [],
                criterionFailStreak: {},
            };

            // Stash conversationId on state so broadcastGoalEvent can find it
            if (options.conversationId) {
                (state as any).conversationId = options.conversationId;
            }

            // Create the per-goal output directory immediately so agents can write to it
            const outputDirFull = `${workspaceRoot}/${goalSlug}`;
            try {
                await mcpManager.callTool('filesystem', 'create_directory',
                    { path: outputDirFull });
                log.info(`[GoalExecutor] Output directory: ${outputDirFull}`);
            } catch {
                // May already exist on retry — that's fine
            }
            // Wire outputDir into GoalValidator so checkTestsPass / checkOutputMatches
            // run npm test from the project subdirectory, not the workspace root.
            // This is the fix for "Missing script: test" firing every iteration regardless
            // of what the agent writes to package.json.
            goalValidator.setOutputDir(outputDirFull);

            // Cap in-memory executions at 100 entries. Evict the oldest terminal entry
            // (completed/failed/cancelled) to keep memory bounded on long-running servers.
            // Running and paused executions are never evicted — only finished ones.
            if (this.executions.size >= 100) {
                for (const [evictId, evictState] of this.executions) {
                    if (['completed', 'failed', 'cancelled'].includes(evictState.status)) {
                        this.executions.delete(evictId);
                        log.info(`[GoalExecutor] Evicted finished execution from memory (cap=100): ${evictId}`);
                        break;
                    }
                }
            }
            this.executions.set(executionId, state);
            await this.saveExecution(state, userId, userRequest);

            this.broadcastGoalEvent('goal:plan_created', {
                execution_id: executionId,
                goal,
                max_iterations: maxIterations
            });

            // ================================================================
            // PHASE 2.5: GOAL DECOMPOSITION (delegated to TaskDecomposer)
            // ================================================================
            this.emitProgress(executionId, 'planning', 'Breaking goal into steps...');
            const subtasks = await this.decomposer.decomposeGoal(goal);

            log.info(`[GoalExecutor] ${subtasks.length} sub-task(s) to execute`);

            // Wire plan into state + reasoner so the ReAct loop knows the ordered steps
            this.reasoner.outputDir = state.outputDir;  // per-goal output folder
            this.reasoner.executionPlan = '';            // reset from any previous execution
            this.reasoner.skillStrategyHint = '';        // reset skill hint from any previous execution

            // ── Skill pre-execution injection (§4.2) ──────────────────────────
            // Semantic search for a past skill that matches this goal.
            // Inject its strategy_hint (human-readable approach, NOT code) so the
            // LLM skips the trial-and-error phase and uses the proven approach directly.
            try {
                const matchedSkill = await skillLearner.findMatchingSkill(goal.description);
                if (matchedSkill?.strategy_hint) {
                    this.reasoner.skillStrategyHint = matchedSkill.strategy_hint;
                    log.info(`[GoalExecutor] Skill strategy injected from "${matchedSkill.name}": ${matchedSkill.strategy_hint.substring(0, 80)}`);
                }
            } catch {
                // Non-critical — continue without skill hint
            }

            // Lookup prior outcomes for this domain and inject as execution_journal context
            try {
                const { db } = await import('../database/index');
                const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will',
                    'not', 'use', 'get', 'set', 'run', 'can', 'are', 'was', 'had', 'its']);
                const queryTags = goal.description
                    .toLowerCase()
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .filter((w: string) => w.length >= 3 && !STOP_WORDS.has(w))
                    .slice(0, 8);
                if (queryTags.length > 0) {
                    const placeholders = queryTags.map(() => '?').join(', ');
                    const priorOutcomes = await db.all(
                        `SELECT DISTINCT o.status, o.failure_cause, o.working_approach, o.blocked_tools
                         FROM goal_outcomes o
                         JOIN goal_outcome_tags t ON o.id = t.outcome_id
                         WHERE t.tag IN (${placeholders})
                         ORDER BY o.created_at DESC LIMIT 3`,
                        queryTags
                    );
                    if (priorOutcomes.length > 0) {
                        const priorContext = priorOutcomes.map((o: any) =>
                            o.status === 'completed'
                                ? `[PRIOR SUCCESS] Approach that worked: ${o.working_approach?.substring(0, 200) ?? 'unknown'}`
                                : `[PRIOR FAILURE] Cause: ${o.failure_cause?.substring(0, 200) ?? 'unknown'}${o.blocked_tools ? ` | Blocked tools: ${o.blocked_tools}` : ''}`
                        ).join('\n');
                        state.execution_journal.push(`--- PRIOR OUTCOMES FOR SIMILAR GOALS ---\n${priorContext}\n--- END PRIOR OUTCOMES ---`);
                        log.info(`[GoalExecutor] Injected ${priorOutcomes.length} prior outcome(s) into execution journal`);
                    }
                }
            } catch { /* non-critical — never block execution */ }

            // ── SEARCH PROVIDER PRE-FLIGHT CHECK ─────────────────────────────
            // Check search backend availability before the ReAct loop starts.
            // A degraded SearXNG is one of the most common silent failure causes —
            // the agent keeps calling web_search which returns empty results,
            // spending budget on a broken tool without knowing it's broken.
            try {
                const { searchProviderManager } = await import('../search/SearchProviderManager');
                const searchStatus = await searchProviderManager.getStatus();
                const available = searchStatus.filter((s: any) => s.available);
                const unavailable = searchStatus.filter((s: any) => !s.available);
                if (available.length === 0) {
                    const warning = `[PRE-FLIGHT WARNING] All search providers are unavailable (${unavailable.map((s: any) => s.name).join(', ')}). ` +
                        `Do NOT use web_search or web_fetch — they will return empty results. ` +
                        `Use only local tools (write_file, run_command) and your training knowledge instead.`;
                    state.execution_journal.push(warning);
                    log.warn(`[GoalExecutor] Search pre-flight FAILED — all providers down: ${unavailable.map((s: any) => s.name).join(', ')}`);
                } else if (unavailable.length > 0) {
                    state.execution_journal.push(
                        `[PRE-FLIGHT INFO] Search available via: ${available.map((s: any) => s.name).join(', ')}. ` +
                        `Unavailable: ${unavailable.map((s: any) => s.name).join(', ')}.`
                    );
                    log.info(`[GoalExecutor] Search pre-flight: ${available.length} provider(s) available`);
                }
            } catch { /* non-critical */ }
            // ── END SEARCH PRE-FLIGHT ─────────────────────────────────────────

            // Remap all GoalExtractor-generated file criteria from generic "output/"
            // to the goal-specific directory so validator and agent path normalization agree.
            // Applies to file_exists, file_contains, and llm_evaluates (all use config.path).
            const DATA_EXT_RE = /\.(md|txt|csv|json|xlsx|pdf|docx|pptx|html|xml|yaml|yml|py|js|ts|sh|rb|go|r)$/i;
            const FILE_CRITERION_TYPES = new Set(['file_exists', 'file_contains', 'llm_evaluates']);
            for (const c of goal.success_criteria) {
                if (FILE_CRITERION_TYPES.has(c.type) && typeof c.config.path === 'string') {
                    const p: string = c.config.path;
                    if (p.startsWith('output/')) {
                        c.config.path = `${state.outputDir}/${p.slice('output/'.length)}`;
                    } else if (!path.isAbsolute(p) && !p.startsWith(state.outputDir) && DATA_EXT_RE.test(p)) {
                        // Covers bare filenames (server.js) AND relative sub-paths (tests/api.test.js).
                        // Prior condition `!p.includes('/')` caused tests/api.test.js to fall through,
                        // resolving to /workspace/tests/api.test.js (stale) instead of /workspace/<slug>/tests/api.test.js.
                        c.config.path = `${state.outputDir}/${p}`;
                    }
                }
            }

            // When the goal text has explicit /workspace/output/filename paths, override
            // criteria with those exact paths. The LLM-inferred names (e.g. data.csv) are
            // often wrong; the explicit paths in the goal text are authoritative.
            if (explicitOutputFiles.length > 0) {
                const nonFileCriteria = goal.success_criteria.filter(c =>
                    !FILE_CRITERION_TYPES.has(c.type) || !c.config.path
                );
                const explicitCriteria = explicitOutputFiles.map(ep => ({
                    id: generateId('criterion'),
                    type: 'file_exists' as const,
                    config: { path: ep },
                    weight: 1.0,
                    required: true,
                    status: 'pending' as const,
                }));
                goal.success_criteria = [...nonFileCriteria, ...explicitCriteria];
                log.info(`[GoalExecutor] Using ${explicitCriteria.length} explicit file criteria from goal text`);
            }
            if (subtasks.length > 1) {
                const planLines = subtasks.map(s =>
                    `  Step ${s.order}: ${s.description}${s.expected_files.length > 0 ? ` → creates [${s.expected_files.join(', ')}]` : ''}`
                );
                const planText = planLines.join('\n');
                state.current_strategy = planText;
                this.reasoner.executionPlan = planText;
                this.broadcastGoalEvent('goal:plan_steps', {
                    execution_id: executionId,
                    steps: planLines,
                    step_count: subtasks.length,
                });
                log.info(`[GoalExecutor] Execution plan:\n${planText}`);
            }

            // Fix 1: Replace GoalExtractor file_exists criteria with TaskDecomposer planned files.
            // GoalExtractor guesses filenames from the raw goal text (often wrong).
            // TaskDecomposer produces the actual execution plan — its filenames are authoritative.
            // We collect ALL expected files from ALL subtasks and replace file_exists criteria.
            // Non-file criteria (llm_evaluates, file_contains) from GoalExtractor are kept.
            // Exception: if the user specified explicit /workspace/ paths in the goal text,
            // those were already set above and take precedence — skip this replacement.
            if (subtasks.length > 0 && explicitOutputFiles.length === 0) {
                const FORBIDDEN_PATHS = new Set(['output/result.txt', 'result.txt']);
                const looksLikeFilePath = (s: string) => {
                    if (/[\s:]/.test(s)) return false;
                    if (!/^[\w./\-]/.test(s)) return false;
                    return /\.\w{2,6}$/.test(s);
                };
                const DATA_EXT = /\.(md|txt|csv|json|xlsx|pdf|docx|pptx|html|xml|yaml|yml|py|js|ts|sh|rb|go|r)$/i;

                // Collect all planned files from all subtasks
                const allPlannedFiles: string[] = [];
                for (const subtask of subtasks) {
                    for (let file of (subtask.expected_files || [])) {
                        if (FORBIDDEN_PATHS.has(file) || !looksLikeFilePath(file)) continue;
                        // Normalize paths to goal-specific output dir
                        if (!file.includes('/') && DATA_EXT.test(file)) {
                            file = `${state.outputDir}/${file}`;
                        } else if (file.startsWith('output/')) {
                            file = `${state.outputDir}/${file.slice('output/'.length)}`;
                        }
                        if (!FORBIDDEN_PATHS.has(file) && !allPlannedFiles.includes(file)) {
                            allPlannedFiles.push(file);
                        }
                    }
                }

                if (allPlannedFiles.length > 0) {
                    // Replace all GoalExtractor file_exists criteria with the planned files
                    const nonFileCriteria = goal.success_criteria.filter(c => c.type !== 'file_exists');
                    const plannedCriteria = allPlannedFiles.map(file => ({
                        id: generateId('criterion'),
                        type: 'file_exists' as const,
                        config: { path: file },
                        weight: 1.0,
                        required: true,
                        status: 'pending' as const,
                    }));
                    goal.success_criteria = [...nonFileCriteria, ...plannedCriteria];
                    log.info(`[GoalExecutor] Replaced file criteria: ${plannedCriteria.length} planned files from TaskDecomposer (all steps)`);
                    plannedCriteria.forEach(c => log.info(`[GoalExecutor]   ✓ ${c.config.path}`));
                } else {
                    log.info(`[GoalExecutor] TaskDecomposer produced no valid file paths — keeping GoalExtractor criteria`);
                }
            }

            // ================================================================
            // PHASE 2.6: CRITERIA–PLAN ALIGNMENT CHECK
            // Cross-check every file_exists criterion against the files that
            // TaskDecomposer actually planned to produce. Criteria with no
            // matching planned file were inferred by GoalExtractor (low confidence)
            // and should not block goal completion.
            //
            // Threshold: configurable via CRITERIA_CONFIDENCE_THRESHOLD env var.
            // Default 0.65 — empirically chosen from observed false-positive rate
            // in run logs where GoalExtractor inferred wrong filenames.
            // Calibrate from your own run archive before hardening this value.
            // ================================================================
            {
                const confidenceThreshold = parseFloat(process.env['CRITERIA_CONFIDENCE_THRESHOLD'] ?? '0.65');
                const allPlannedPaths = new Set<string>(
                    subtasks.flatMap(s => s.expected_files || []).map(f => f.toLowerCase())
                );

                if (allPlannedPaths.size > 0) {
                    let demoted = 0;
                    for (const criterion of goal.success_criteria) {
                        if (criterion.type !== 'file_exists' || !criterion.config.path) continue;
                        // Already demoted or explicitly set non-required — leave alone
                        if (!criterion.required) continue;

                        const criterionFile = (criterion.config.path as string).toLowerCase();
                        const basename = criterionFile.split('/').pop() ?? criterionFile;

                        // Match: exact path OR basename match against any planned file
                        const hasMatch = allPlannedPaths.has(criterionFile) ||
                            [...allPlannedPaths].some(p => p === basename || p.endsWith(`/${basename}`));

                        // Assign confidence: 1.0 if explicitly planned, lower if only inferred
                        const confidence = hasMatch ? 1.0 : 0.5;
                        (criterion as any).confidence = confidence;

                        if (confidence < confidenceThreshold) {
                            criterion.required = false;
                            demoted++;
                            log.warn(`[GoalExecutor] Criterion DEMOTED (confidence=${confidence}, no planned file match): ${criterion.config.path}`);
                        }
                    }
                    if (demoted > 0) {
                        log.info(`[GoalExecutor] Alignment check: demoted ${demoted} unmatched file_exists criteria to optional`);
                    }
                }
            }

            // ================================================================
            // PHASE 2.75: CLEAN STALE ARTIFACTS
            // Delete files referenced in file_exists criteria that may have
            // been left over from a previous run.  Without this, GoalValidator
            // finds the old file on iteration 1 and marks the goal complete
            // before any real work has been done (the "false pass" bug).
            // ================================================================
            for (const criterion of goal.success_criteria) {
                if (criterion.type === 'file_exists' && criterion.config.path) {
                    const relPath = criterion.config.path as string;
                    const absPath = relPath.startsWith('/') ? relPath : `${workspaceRoot}/${relPath}`;
                    try {
                        await mcpManager.callTool('filesystem', 'delete_file', { path: absPath });
                        log.info(`[GoalExecutor] Cleared stale artifact: ${relPath}`);
                    } catch {
                        // File didn't exist — that's expected and fine
                    }
                }
            }

            // ================================================================
            // PHASE 2.8: FAST-PATH FOR TRIVIAL GOALS
            // Goals with complexity ≤ 3 that only need a single text file written
            // (no network, no code execution) skip the full ReAct loop.
            // A single LLM call generates the content; write_file writes it.
            // On failure, falls through to the normal ReAct loop below.
            // ================================================================
            // Fast-path only applies to text-based files (not binary xlsx/pdf/docx)
            const BINARY_EXTS = new Set(['xlsx', 'xls', 'pdf', 'docx', 'doc', 'pptx', 'ppt', 'png', 'jpg', 'jpeg', 'gif', 'zip']);
            const primaryFilePath = goal.success_criteria.find(c => c.config.path)?.config.path || '';
            const primaryExt = (primaryFilePath.split('.').pop() || '').toLowerCase();
            const isTrivialGoal = goal.estimated_complexity <= 3 &&
                !BINARY_EXTS.has(primaryExt) &&
                goal.success_criteria.every(c => c.type === 'file_exists' || c.type === 'file_contains') &&
                !/fetch|api|live|current|today|price|weather|stock|crypto|news|search|scrape|download|run|execut|install/i.test(goal.description);

            if (isTrivialGoal) {
                this.emitProgress(executionId, 'executing', 'Fast-path: generating file content...');
                try {
                    const llm = modelRouter.getAdapterForTask('simple_qa') || modelManager.getActiveAdapter();
                    if (llm) {
                        // Find the primary output file criterion
                        const primaryCrit = goal.success_criteria.find(
                            c => (c.type === 'file_exists' || c.type === 'file_contains') && c.config.path
                        );
                        if (primaryCrit?.config.path) {
                            const filePath = primaryCrit.config.path as string;
                            const absPath = filePath.startsWith('/') ? filePath : `${workspaceRoot}/${filePath}`;
                            const ext = filePath.split('.').pop()?.toLowerCase() || 'txt';

                            // Collect any explicit keyword requirements from file_contains criteria
                            const requiredKeywords = goal.success_criteria
                                .filter(c => c.type === 'file_contains' && c.config.pattern)
                                .map(c => `"${c.config.pattern}"`)
                                .join(', ');

                            const contentPrompt = `Generate the COMPLETE file content for this task.

ORIGINAL REQUEST: ${userRequest}

File path: ${filePath}
File type: .${ext}

Output ONLY the file content — no explanation, no markdown fences, no preamble.
For JSON: valid JSON only. For CSV: header + data rows. For Python: complete runnable script. For Markdown: proper markdown.
Criteria to satisfy: ${goal.success_criteria.map(c => c.config.pattern || c.config.path || c.type).join(', ')}${requiredKeywords ? `\nCRITICAL: The file content MUST contain these exact words (use the exact text): ${requiredKeywords}` : ''}`;

                            const content = await llm.generate(contentPrompt, { temperature: 0.3 });

                            if (content && content.trim()) {
                                // Ensure parent directory exists
                                const parentDir = path.dirname(absPath);
                                try {
                                    await mcpManager.callTool('filesystem', 'create_directory', { path: parentDir });
                                } catch { /* already exists */ }

                                await mcpManager.callTool('filesystem', 'write_file', {
                                    path: absPath,
                                    content: content.trim()
                                });
                                state.artifacts.push(filePath);
                                state.completed_actions.push({
                                    iteration: 0,
                                    action: 'Fast-path: generated and wrote file content',
                                    tool_used: 'write_file',
                                    args: { path: absPath },
                                    result: { stdout: `Written ${content.length} chars` },
                                    success: true,
                                    artifacts_created: [filePath],
                                    progress_made: true,
                                    duration_ms: 0,
                                    timestamp: new Date()
                                });

                                // Validate immediately
                                const fastValidation = await goalValidator.validateGoal(goal);
                                if (fastValidation.complete) {
                                    log.info(`[GoalExecutor] Fast-path SUCCESS for: ${goal.description}`);
                                    state.progress_percent = 100;
                                    state.status = 'completed';
                                    // Skip the ReAct loop entirely
                                    const result = this.buildResult(state, startTime);
                                    this.executions.set(executionId, state);
                                    await this.saveExecution(state, userId, userRequest);
                                    this.broadcastGoalEvent('goal:completed', { execution_id: executionId, result });
                                    return result;
                                }
                                log.info(`[GoalExecutor] Fast-path wrote file but validation failed — falling through to ReAct loop`);
                            }
                        }
                    }
                } catch (fastErr: any) {
                    log.warn(`[GoalExecutor] Fast-path error (falling through): ${fastErr.message}`);
                }
            }

            // ================================================================
            // PHASE 3: INCREMENTAL TOOL EXECUTION (ReAct loop — PRIMARY)
            // Uses reason() → decideAction() → executeAction() pipeline.
            // Each tool call is individually recoverable — one failure
            // doesn't undo prior progress (unlike the old monolithic script).
            // ================================================================
            this.emitProgress(executionId, 'executing', 'Executing steps incrementally...');

            // Bound callbacks for script fallback paths
            const requestApproval = this.requestScriptApproval.bind(this);
            const selfCorrect = (script: string, error: string, s: ExecutionState, runtime: 'python' | 'node') =>
                this.corrector.selfCorrectScript(script, error, s, runtime, this.engine.isRuntimeNotFoundError.bind(this.engine));
            const broadcast = this.broadcastGoalEvent.bind(this);

            const maxStuckIterations = options.max_stuck_iterations || 3;
            const maxStrategyChanges = options.max_strategy_changes || 3;
            const validationInterval = options.validation_interval || 1;

            // Loop detection
            let lastToolName = '';
            let sameToolCount = 0;
            let readOnlyStreakCount = 0;   // consecutive iterations using ANY read-only tool
            const MAX_SAME_READ_TOOL = 3;
            const MAX_READ_ONLY_STREAK = 6; // alternating read-only tools (e.g. mkdir↔list_dir)

            // Tracks consecutive llm_evaluates failures whose message indicates the task
            // requires a human (manual signup, CAPTCHA, login, browser blocked, etc.).
            // When this hits 3, we auto-escalate to HITL rather than letting the agent
            // spin writing dummy files forever while stuck_count resets on every write.
            let consecutiveBrowserBlockedFailures = 0;
            const BROWSER_BLOCKED_PATTERN = /manual|blocked|browser|authenticat|captcha|sign.?up|enroll|human intervention|requires.*login|cannot.*automat/i;
            const MAX_BROWSER_BLOCKED_FAILURES = 3;
            let hitlTimeoutRetried = false; // allow one autonomous retry on HITL timeout before failing

            // LLM failure tracking — abort after N consecutive LLM errors instead of spinning
            // on the deterministic fallback action indefinitely (e.g. when Gemini hits quota).
            let consecutiveLlmFailures = 0;
            const MAX_CONSECUTIVE_LLM_FAILURES = 3;

            // Browser live-preview tracking
            let browserStartEmitted = false;
            // All browser tools that warrant an auto-screenshot after execution.
            // Includes eval/extract tools so the Inspector updates after JS data extraction.
            const BROWSER_SNAPSHOT_TOOLS = new Set([
                'browser_navigate', 'browser_click', 'browser_type',
                'browser_fill', 'browser_select', 'browser_scroll',
                'browser_eval', 'browser_get_content', 'browser_extract',
            ]);

            // Helper: check if this execution was cancelled/paused externally
            const checkCancelled = (): boolean => {
                const s = this.executions.get(executionId);
                if (!s || s.status === 'cancelled' || s.status === 'paused') {
                    state.status = s?.status || 'cancelled';
                    log.info(`[GoalExecutor] Execution ${executionId} ${state.status} — stopping loop`);
                    return true;
                }
                return false;
            };

            // Atomic checkpoint helper — draft first, then promote. Partial writes never
            // become the active checkpoint. Container ID is saved alongside so resume
            // can detect if the container was lost between checkpoint and crash.
            const saveCheckpoint = async () => {
                try {
                    const { db } = await import('../database/index');
                    const checkpointData = JSON.stringify({
                        iteration: state.current_iteration,
                        stuck_count: state.stuck_count,
                        strategy_changes: state.strategy_changes,
                        artifacts: state.artifacts,
                        error_history: state.error_history.slice(-10),
                        execution_journal: state.execution_journal.slice(-20),
                        current_strategy: state.current_strategy,
                        progress_percent: state.progress_percent,
                    });
                    const containerId = this.engine.containerSessionId ?? null;
                    // Step 1: write draft
                    await db.run(
                        `UPDATE autonomous_executions
                         SET checkpoint_draft = ?, container_id = ?, files_written = ?
                         WHERE id = ?`,
                        [checkpointData, containerId, JSON.stringify(state.artifacts), executionId]
                    );
                    // Step 2: promote draft → active checkpoint atomically
                    await db.run(
                        `UPDATE autonomous_executions
                         SET checkpoint = checkpoint_draft
                         WHERE id = ? AND checkpoint_draft IS NOT NULL`,
                        [executionId]
                    );
                } catch { /* never block execution on checkpoint failure */ }
            };
            // Set execution start time on validator — used to reject pre-run stale files
            goalValidator.executionStartTime = Date.now();

            // ── Pre-flight credential check ─────────────────────────────────────────
            // If the goal requires logging in / placing an order / booking etc. and no
            // credentials are already visible in the conversation context, ask the user
            // BEFORE the ReAct loop starts so the agent has them from iteration 1.
            if (this.needsCredentials(state.goal.description, options.conversationContext)) {
                log.info('[GoalExecutor] Pre-flight: goal requires credentials — asking user');
                const credResponse = await this.requestUserInput(executionId, state, {
                    question: 'This task requires logging in to a website. Please provide your credentials:',
                    fields: [
                        { name: 'email',    label: 'Email / Username', type: 'text',     required: true,  placeholder: 'you@example.com' },
                        { name: 'password', label: 'Password',         type: 'password', required: true,  placeholder: '••••••••' },
                    ],
                });
                if (credResponse && credResponse.trim()) {
                    state.secureContext = credResponse.trim();
                    log.info('[GoalExecutor] Pre-flight credentials received — stored in secureContext');
                }
            }

            const executionStartTime = Date.now();
            const MAX_EXECUTION_TIME_MS = parseInt(
                process.env['GOAL_MAX_EXECUTION_MS'] ?? String(90 * 60 * 1000), 10
            ); // default 90 minutes

            while (
                state.status === 'executing' &&
                state.current_iteration < state.max_iterations
            ) {
                state.current_iteration++;
                const iterationStartMs = Date.now();

                log.info(`[GoalExecutor] Iteration ${state.current_iteration}/${state.max_iterations}`);

                // Absolute wall-clock timeout guard — prevents runaway goals
                if (Date.now() - executionStartTime > MAX_EXECUTION_TIME_MS) {
                    log.warn(
                        { iterations: state.current_iteration, elapsed_ms: Date.now() - executionStartTime },
                        '[GoalExecutor] Absolute execution timeout reached — failing goal'
                    );
                    state.status = 'failed';
                    const timeoutErr = agentError(
                        `Goal exceeded maximum wall-clock time of ${MAX_EXECUTION_TIME_MS}ms`,
                        'goal_timeout',
                        { iterations: state.current_iteration, elapsed_ms: Date.now() - executionStartTime }
                    );
                    state.error_history.push({
                        iteration: state.current_iteration,
                        error: timeoutErr.message,
                        context: 'absolute_timeout',
                        recovery_attempted: false,
                        recovery_successful: false,
                        timestamp: new Date()
                    });
                    break;
                }

                // Checkpoint every 3 iterations for crash recovery + HITL state preservation
                if (state.current_iteration % 3 === 0) {
                    void saveCheckpoint().catch((err: unknown) => {
                        const ae = agentError('Checkpoint save failed', 'checkpoint_failed', {}, err);
                        log.warn(ae.toLogObject(), '[GoalExecutor] Checkpoint save failed (non-fatal)');
                    });
                }

                // Check for pause/cancel at top of iteration
                if (checkCancelled()) break;

                this.emitProgress(executionId, 'executing', `Iteration ${state.current_iteration}...`, {
                    iteration: state.current_iteration,
                    max_iterations: state.max_iterations,
                    progress_percent: state.progress_percent
                });

                // Extension hook: before_reason
                await extensionHooks.emit('before_reason', { state, iteration: state.current_iteration });

                // ReAct: REASON + DECIDE in ONE LLM call (true ReAct design).
                // Previously two separate calls (reason → prose, decide → JSON) caused
                // the reasoning context to be disconnected from the action choice.
                // Now both come from the same response, cutting iteration time in half.
                const { reasoning, action: nextAction } = await this.reasoner.reasonAndDecide(state);

                // ── CONSECUTIVE LLM FAILURE GUARD ─────────────────────────────────────
                // reasonAndDecide() silently catches LLM errors and returns the deterministic
                // fallback action with this sentinel reasoning string. If the LLM is quota-
                // exhausted (e.g. Gemini free-tier 429), every iteration gets the same
                // fallback and stuck_count never increments — causing an infinite spin.
                // Abort cleanly after MAX_CONSECUTIVE_LLM_FAILURES consecutive failures.
                const LLM_FAILURE_SENTINEL = 'LLM call failed — using fallback action.';
                if (reasoning === LLM_FAILURE_SENTINEL || reasoning === 'No LLM available.') {
                    consecutiveLlmFailures++;
                    log.warn(`[GoalExecutor] LLM failure #${consecutiveLlmFailures}/${MAX_CONSECUTIVE_LLM_FAILURES} (iteration ${state.current_iteration})`);
                    if (consecutiveLlmFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
                        const { provider: curProvider, model: curModel } = modelManager.getActiveModelStatus();
                        log.warn(`[GoalExecutor] ${MAX_CONSECUTIVE_LLM_FAILURES} consecutive LLM failures (${curProvider}/${curModel}) — asking user to switch model`);

                        const userResponse = await this.requestUserInput(executionId, state, {
                            question: `The AI model (${curProvider}/${curModel ?? 'unknown'}) has hit its API limit or is unavailable after ${consecutiveLlmFailures} consecutive failures.\n\nEnter a replacement model to continue, or leave blank to abort.`,
                            fields: [
                                {
                                    name: 'provider',
                                    label: 'Provider',
                                    type: 'select',
                                    // All supported providers — not just currently registered ones.
                                    // Configured providers are sent separately so the frontend can
                                    // mark them and decide whether api_key is required.
                                    options: [
                                        'openai', 'anthropic', 'gemini', 'groq', 'deepseek',
                                        'ollama', 'lmstudio', 'ollama-cloud',
                                        'perplexity', 'mistral', 'openrouter', 'together',
                                    ],
                                    // Pipe-separated list of already-configured providers so the
                                    // frontend can mark them as "(configured)" and skip the api_key field.
                                    placeholder: modelManager.getProviderNames().join('|'),
                                    required: true,
                                },
                                {
                                    name: 'model',
                                    label: 'Model name',
                                    type: 'text',
                                    placeholder: 'e.g. gpt-4o-mini  or  claude-3-haiku-20240307',
                                    required: true,
                                },
                                {
                                    name: 'api_key',
                                    label: 'API Key',
                                    type: 'password',
                                    placeholder: 'Required for new providers; leave blank if already configured',
                                    required: false,
                                },
                            ],
                        });

                        if (userResponse && userResponse.trim()) {
                            // GoalProgressPanel sends structured fields as JSON, but handle plain text too
                            let newProvider: string | null = null;
                            let newModel: string | null = null;
                            let newApiKey: string | null = null;
                            try {
                                const parsed = JSON.parse(userResponse);
                                newProvider = (parsed.provider || '').trim();
                                newModel = (parsed.model || '').trim();
                                newApiKey = (parsed.api_key || '').trim() || null;
                            } catch {
                                // Plain text: "openai:gpt-4o-mini" or "openai gpt-4o-mini"
                                const sep = userResponse.includes(':') ? ':' : ' ';
                                const parts = userResponse.trim().split(sep);
                                if (parts.length >= 2) {
                                    newProvider = parts[0].trim();
                                    newModel = parts.slice(1).join(sep).trim();
                                } else {
                                    newModel = userResponse.trim();
                                    // Auto-detect provider from model name prefix
                                    if (newModel.startsWith('gpt') || newModel.startsWith('o1') || newModel.startsWith('o3')) newProvider = 'openai';
                                    else if (newModel.startsWith('claude')) newProvider = 'anthropic';
                                    else if (newModel.startsWith('gemini')) newProvider = 'gemini';
                                    else if (newModel.startsWith('llama') || newModel.startsWith('mistral') || newModel.startsWith('mixtral')) newProvider = 'groq';
                                    else if (newModel.startsWith('deepseek')) newProvider = 'deepseek';
                                }
                            }

                            // If the user supplied a new API key, inject it immediately so
                            // modelManager.switchModel() can authenticate with the new provider.
                            if (newApiKey && newProvider) {
                                const PROVIDER_KEY_MAP: Record<string, string> = {
                                    openai: 'OPENAI_API_KEY',
                                    anthropic: 'ANTHROPIC_API_KEY',
                                    gemini: 'GEMINI_API_KEY',
                                    groq: 'GROQ_API_KEY',
                                    deepseek: 'DEEPSEEK_API_KEY',
                                    perplexity: 'PERPLEXITY_API_KEY',
                                    mistral: 'MISTRAL_API_KEY',
                                    openrouter: 'OPENROUTER_API_KEY',
                                    together: 'TOGETHER_API_KEY',
                                };
                                const envKey = PROVIDER_KEY_MAP[newProvider.toLowerCase()];
                                if (envKey) {
                                    process.env[envKey] = newApiKey;
                                    modelManager.refreshProviders().catch(() => {});
                                    log.info(`[GoalExecutor] Applied new API key for ${newProvider} (${envKey})`);
                                }
                            }

                            if (newProvider && newModel) {
                                try {
                                    await modelManager.switchModel(newModel, newProvider);
                                    log.info(`[GoalExecutor] Switched to ${newProvider}/${newModel} — resuming execution`);
                                    consecutiveLlmFailures = 0;
                                    continue; // Retry the current iteration with the new model
                                } catch (switchErr: any) {
                                    log.error({ err: String(switchErr) }, `[GoalExecutor] Model switch failed`);
                                    // Fall through to fail the goal
                                }
                            }
                        }

                        // User provided no model or switch failed — give up
                        state.status = 'failed';
                        state.error_history.push({
                            iteration: state.current_iteration,
                            error: `LLM provider exhausted after ${consecutiveLlmFailures} consecutive failures and no replacement model was provided.`,
                            context: 'consecutive_llm_failure',
                            recovery_attempted: true,
                            recovery_successful: false,
                            timestamp: new Date()
                        });
                        break;
                    }
                } else {
                    consecutiveLlmFailures = 0;
                }
                // ─────────────────────────────────────────────────────────────────────

                log.info(`[GoalExecutor] Reasoning: ${reasoning.substring(0, 200)}...`);
                log.info(`[GoalExecutor] Next action: ${nextAction?.tool}(${JSON.stringify(nextAction?.args || {}).substring(0, 100)})`);

                // Broadcast reasoning so the frontend GoalProgressPanel can show "Agent Thinking"
                if (reasoning && reasoning.trim().length > 0) {
                    this.broadcastGoalEvent('goal:reasoning', {
                        execution_id: executionId,
                        iteration: state.current_iteration,
                        reasoning: reasoning.substring(0, 800),
                        next_tool: nextAction?.tool,
                    });
                }

                // Check after the combined LLM call (can take 30–60s for slow LLMs)
                if (checkCancelled()) break;

                const assessment: StateAssessment = {
                    current_progress_percent: state.progress_percent,
                    blocking_issues: [],
                    missing_for_goal: [],
                    suggested_next_action: nextAction,
                    should_replan: state.stuck_count >= maxStuckIterations,
                    replan_reason: state.stuck_count >= maxStuckIterations ? 'Stuck after multiple attempts' : undefined
                };

                // --- LOOP DETECTION ---
                const suggestedTool = assessment.suggested_next_action?.tool || '';
                const READ_ONLY_TOOLS = ['list_directory', 'list_allowed_directories', 'read_file', 'search_files', 'get_file_info'];
                const WRITE_EXECUTE_TOOLS = ['write_file', 'run_command', 'create_directory', 'move_file', 'edit_file'];

                // Track same-tool streak (original check)
                if (suggestedTool === lastToolName && READ_ONLY_TOOLS.includes(suggestedTool)) {
                    sameToolCount++;
                } else if (suggestedTool === 'write_file' && suggestedTool === lastToolName &&
                    assessment.suggested_next_action?.args?.path === (state.completed_actions[state.completed_actions.length - 1]?.args?.path)) {
                    // Detect repeated write_file to the same path (the fallback stub loop)
                    sameToolCount++;
                } else {
                    sameToolCount = 0;
                }
                lastToolName = suggestedTool;

                // Track alternating read-only streak (catches list_dir↔create_dir↔list_dir loops)
                // create_directory with no actual content progress also counts as read-only for loop detection
                const isReadOnlyOrNoop = READ_ONLY_TOOLS.includes(suggestedTool) ||
                    (suggestedTool === 'create_directory' && state.consecutive_read_only > 0);
                if (isReadOnlyOrNoop) {
                    readOnlyStreakCount++;
                } else if (WRITE_EXECUTE_TOOLS.includes(suggestedTool) && suggestedTool !== 'create_directory') {
                    readOnlyStreakCount = 0;
                }

                const loopDetected = sameToolCount >= MAX_SAME_READ_TOOL ||
                    readOnlyStreakCount >= MAX_READ_ONLY_STREAK;

                if (loopDetected) {
                    const loopReason = sameToolCount >= MAX_SAME_READ_TOOL
                        ? `${suggestedTool} called ${sameToolCount + 1}x consecutively`
                        : `read-only/noop streak of ${readOnlyStreakCount} iterations`;

                    // Determine loop type: "debug loop" = model has a recent error and is re-reading
                    // the same file to understand it but never writing the fix.
                    // "stuck loop" = no recent error, model genuinely doesn't know what to do.
                    // Debug loops should NOT run executeViaScript (it fires the wrong skill).
                    // Instead, force the file_read_counts hint to kick in on the next prompt.
                    const recentActions = state.completed_actions.slice(-6);
                    const lastWriteIdx = recentActions.map(a => a.tool_used).lastIndexOf('write_file');
                    const errorsAfterLastWrite = recentActions
                        .slice(lastWriteIdx + 1)
                        .filter(a => !a.success && a.tool_used === 'run_command').length;
                    const isDebugLoop = errorsAfterLastWrite > 0 && suggestedTool === 'read_file';

                    if (isDebugLoop) {
                        // Debug loop: model knows the bug but won't commit to writing.
                        // Bump file_read_counts to MAX to guarantee REPEATED_READ_HINT fires,
                        // then let the ReAct loop continue — the hint will force a write_file.
                        log.info(`[GoalExecutor] LOOP DETECTED (debug): ${loopReason}. Injecting forced-write hint instead of script fallback.`);
                        const readPath = String(assessment.suggested_next_action?.args?.path || '');
                        if (readPath) {
                            state.file_read_counts[readPath] = Math.max(state.file_read_counts[readPath] ?? 0, 3);
                        }
                        sameToolCount = 0;
                        readOnlyStreakCount = 0;
                        // Do NOT call executeViaScript — let the prompt hint do its job
                        continue;
                    }

                    log.info(`[GoalExecutor] LOOP DETECTED (stuck): ${loopReason}. Forcing script execution.`);

                    // Try force-write via script first (for write_file loops)
                    if (suggestedTool === 'write_file') {
                        const forceAction = await this.reasoner.generateForceWriteAction(
                            state,
                            this.engine.detectRuntime.bind(this.engine)
                        );
                        if (forceAction) {
                            log.info(`[GoalExecutor] Escalating to force-write script`);
                            const forceResult = await this.reasoner.executeAction(executionId, state, forceAction, broadcast);
                            state.completed_actions.push(forceResult);
                            sameToolCount = 0;
                            readOnlyStreakCount = 0;
                            continue;
                        }
                    }

                    const scriptRetry = await this.engine.executeViaScript(state, requestApproval, selfCorrect, broadcast);
                    if (scriptRetry) {
                        sameToolCount = 0;
                        readOnlyStreakCount = 0;
                        const retryValidation = await goalValidator.validateGoal(state.goal);
                        state.progress_percent = retryValidation.score;
                        if (retryValidation.complete) {
                            state.status = 'completed';
                            state.completed_at = new Date();
                            break;
                        }
                        continue;
                    } else {
                        state.status = 'failed';
                        state.error_history.push({
                            iteration: state.current_iteration,
                            error: 'Loop detected and script recovery failed',
                            context: loopReason,
                            recovery_attempted: true,
                            recovery_successful: false,
                            timestamp: new Date()
                        });
                        break;
                    }
                }

                // Check if we should replan (delegated to SelfCorrector)
                if (assessment.should_replan && state.strategy_changes < maxStrategyChanges) {
                    state.status = 'replanning';
                    this.emitProgress(executionId, 'replanning', assessment.replan_reason || 'Changing strategy...');

                    const newStrategy = await this.corrector.replan(state, assessment);
                    state.strategy_changes++;
                    state.stuck_count = 0;
                    state.current_strategy = newStrategy.new_strategy;

                    log.info(`[GoalExecutor] Re-planned (${state.strategy_changes}/${maxStrategyChanges}): ${newStrategy.new_strategy}`);

                    this.broadcastGoalEvent('goal:replanning', {
                        execution_id: executionId,
                        new_strategy: newStrategy.new_strategy || `Strategy change #${state.strategy_changes}`,
                        strategy_changes: state.strategy_changes
                    });

                    state.status = 'executing';

                    if (newStrategy.first_action) {
                        assessment.suggested_next_action = {
                            tool: newStrategy.first_action.tool,
                            args: newStrategy.first_action.args,
                            reasoning: newStrategy.new_strategy
                        };
                    }
                }

                // EXECUTE ACTION
                if (!assessment.suggested_next_action) {
                    log.info(`[GoalExecutor] No action suggested, attempting script fallback`);
                    const forceScript = await this.engine.executeViaScript(state, requestApproval, selfCorrect, broadcast);
                    if (forceScript) {
                        state.stuck_count = 0;
                    } else {
                        state.stuck_count++;
                    }
                } else {
                    // ---- HITL: per-action approval when approvalMode === 'all' ----
                    const SENSITIVE_TOOLS = ['write_file', 'delete_file', 'run_command', 'run_script', 'create_directory'];
                    if (this.approvalMode === 'all' && SENSITIVE_TOOLS.includes(assessment.suggested_next_action.tool)) {
                        const actionSummary = `${assessment.suggested_next_action.tool}(${JSON.stringify(assessment.suggested_next_action.args).substring(0, 300)})`;
                        const approval = await this.requestScriptApproval(
                            executionId,
                            actionSummary,
                            'node',
                            state.goal.description
                        );
                        if (!approval.approved) {
                            log.info(`[GoalExecutor] Action rejected by user (approvalMode=all): ${assessment.suggested_next_action.tool}`);
                            state.stuck_count++;
                            state.error_history.push({
                                iteration: state.current_iteration,
                                error: `Action rejected by user: ${assessment.suggested_next_action.tool}`,
                                context: 'HITL per-action approval',
                                recovery_attempted: false,
                                recovery_successful: false,
                                timestamp: new Date()
                            });
                            continue;
                        }
                    }
                    // ---------------------------------------------------------------

                    // ---- HITL: proactive user input via request_user_input tool ----
                    if (assessment.suggested_next_action.tool === 'request_user_input') {
                        const { question, fields = [] } = assessment.suggested_next_action.args || {};
                        if (!question) {
                            state.error_history.push({
                                iteration: state.current_iteration,
                                error: 'request_user_input called without a question',
                                context: 'HITL proactive input',
                                recovery_attempted: false,
                                recovery_successful: false,
                                timestamp: new Date()
                            });
                            state.stuck_count++;
                            continue;
                        }
                        const userResponse = await this.requestUserInput(executionId, state, { question, fields });
                        this.broadcastGoalEvent('goal:resumed', { execution_id: executionId, reason: 'user_input_provided' });
                        state.status = 'executing';
                        // Inject user response into error_history as a "hint" so ReActReasoner sees it
                        state.error_history.push({
                            iteration: state.current_iteration,
                            error: `User provided: ${userResponse || '(no response)'}`,
                            context: 'user_input_response',
                            recovery_attempted: true,
                            recovery_successful: !!userResponse,
                            timestamp: new Date()
                        });
                        // NOTE: use state.execution_journal.push directly — this.appendToJournal
                        // takes an ActionResult object, not a string.
                        if (!state.execution_journal) state.execution_journal = [];
                        state.execution_journal.push(
                            `[user_input] Q: "${question}" → User: "${userResponse || '(timeout)'}"`
                        );

                        // ── HITL loop prevention ──────────────────────────────────────────
                        // After the user responds, permanently mark any 'custom' criteria
                        // whose description mentions HITL/user-confirmation as passed.
                        // Without this, GoalValidator re-runs runCustomValidation() each
                        // iteration (returns false because no command/path), the LLM sees
                        // the failing criterion and calls request_user_input again → loop.
                        if (userResponse && goal.success_criteria) {
                            const qKeywords = question.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3);
                            for (const criterion of goal.success_criteria) {
                                if (criterion.type === 'custom' && criterion.status !== 'passed') {
                                    const desc = (
                                        criterion.config?.expected ||
                                        criterion.config?.pattern ||
                                        ''
                                    ).toLowerCase();
                                    // HITL criteria contain words like: pause, confirm, wait, user, input
                                    const isHITLCriterion = /\b(pause|confirm|wait|user.?(input|confirm|response)|ask|input|response)\b/.test(desc);
                                    // Also match if criterion description keywords overlap with the question
                                    const descWords = desc.split(/\W+/).filter((w: string) => w.length > 3);
                                    const overlap = qKeywords.filter((w: string) => descWords.includes(w)).length;
                                    if (isHITLCriterion || overlap >= 2) {
                                        criterion.status = 'passed';
                                        log.info(`[GoalExecutor] HITL loop prevention: auto-passed custom criterion after user response: "${desc.substring(0, 60)}"`);
                                    }
                                }
                            }
                        }
                        // ── END HITL loop prevention ──────────────────────────────────────

                        continue;
                    }
                    // ---------------------------------------------------------------

                    // ---- AGENT DELEGATION via AgentPool --------------------------------
                    // When the LLM chooses action=delegate, spawn a child agent via
                    // agentPool.delegateTask() instead of falling through to executeAction
                    // (which has no handler for it and would silently do nothing).
                    if (assessment.suggested_next_action.tool === 'delegate' &&
                        state.delegation_count < state.max_delegations) {

                        const dArgs = assessment.suggested_next_action.args || {};
                        const delegateTask = dArgs.task || dArgs.description || '';
                        const delegateRole = dArgs.role || 'general assistant';

                        if (delegateTask.trim().length > 5) {
                            state.delegation_count++;
                            log.info(`[GoalExecutor] Delegating to AgentPool: role="${delegateRole}", task="${delegateTask.substring(0, 80)}"`);
                            this.emitProgress(executionId, 'executing', `Spawning ${delegateRole} agent...`);
                            this.broadcastGoalEvent('goal:delegation', {
                                execution_id: executionId,
                                delegation_count: state.delegation_count,
                                role: delegateRole,
                                task: delegateTask,
                            });
                            try {
                                const delegateResult = await agentPool.delegateTask(
                                    delegateTask, delegateRole, executionId, 0
                                );

                                // Merge sub-agent artifacts into goal state
                                if (delegateResult.artifacts.length > 0) {
                                    state.artifacts.push(...delegateResult.artifacts);
                                }

                                const resultText = delegateResult.result || '';
                                if (resultText.startsWith('ESCALATION::')) {
                                    // Sub-agent could not complete its task — surface to user
                                    const parts = resultText.split('::');
                                    const problem = parts[1] || 'Sub-agent blocked';
                                    const need = parts[2] || 'Unknown requirement';
                                    log.warn(`[GoalExecutor] Sub-agent (${delegateRole}) escalated: ${problem}`);
                                    this.broadcastGoalEvent('goal:agent-escalation', {
                                        execution_id: executionId,
                                        role: delegateRole,
                                        task: delegateTask,
                                        problem,
                                        need,
                                        delegation_count: state.delegation_count,
                                    });
                                    state.stuck_count++;
                                    state.error_history.push({
                                        iteration: state.current_iteration,
                                        error: `Sub-agent (${delegateRole}) escalated: ${problem}`,
                                        context: `DelegationResult#${state.delegation_count}: ${need}`,
                                        recovery_attempted: true,
                                        recovery_successful: false,
                                        timestamp: new Date(),
                                    });
                                } else {
                                    log.info(`[GoalExecutor] Delegation complete: ${resultText.substring(0, 120)}`);
                                    state.last_progress_at = new Date();
                                    state.stuck_count = 0;
                                    // Inject result as context so the parent ReActReasoner builds on it
                                    state.error_history.push({
                                        iteration: state.current_iteration,
                                        error: `Sub-agent (${delegateRole}) completed: ${resultText.substring(0, 300)}`,
                                        context: `delegation_result#${state.delegation_count}`,
                                        recovery_attempted: false,
                                        recovery_successful: true,
                                        timestamp: new Date(),
                                    });
                                    if (delegateResult.artifacts.length > 0) {
                                        state.last_progress_at = new Date();
                                    }
                                }
                            } catch (delegateErr: any) {
                                log.error({ err: String(delegateErr) }, `[GoalExecutor] AgentPool.delegateTask threw`);
                                state.stuck_count++;
                            }
                            continue; // Skip normal executeAction for this iteration
                        }
                    }
                    // ---- End delegation ------------------------------------------------

                    this.broadcastGoalEvent('goal:action', {
                        execution_id: executionId,
                        iteration: state.current_iteration,
                        tool: assessment.suggested_next_action.tool,
                        args: assessment.suggested_next_action.args || {},
                    });

                    const actionResult = await this.reasoner.executeAction(
                        executionId,
                        state,
                        assessment.suggested_next_action,
                        broadcast
                    );

                    // Check after the action (container exec can block 30–60s)
                    if (checkCancelled()) break;

                    state.completed_actions.push(actionResult);
                    state.timing_metrics.push({
                        iteration: state.current_iteration,
                        duration_ms: Date.now() - iterationStartMs,
                        tool: actionResult.tool_used,
                        success: actionResult.success,
                    });
                    this.appendToJournal(state, actionResult);

                    this.broadcastGoalEvent('goal:action_result', {
                        execution_id: executionId,
                        iteration: state.current_iteration,
                        result: { success: actionResult.success, tool: actionResult.tool_used },
                    });

                    // ── AUTO-EXECUTE SCRIPTS (Phase 6) ───────────────────────
                    // When agent writes a .py/.js/.sh script AND there is an unmet
                    // file_exists criterion pointing to a DIFFERENT file (the output),
                    // immediately execute the script so the output is produced.
                    // This fixes the "write script but never run it" loop (G09).
                    //
                    // Fix D: Server files are explicitly excluded. A file that calls
                    // app.listen() / server.listen() / http.createServer() is a persistent
                    // process — auto-running it starts a server that never exits, burns a
                    // container slot, and produces misleading exit codes. The tests_pass
                    // criterion will handle running the server when needed.
                    if (actionResult.success && actionResult.tool_used === 'write_file') {
                        const writtenPath = String(actionResult.args?.path || '');
                        const scriptExt = writtenPath.split('.').pop()?.toLowerCase() || '';
                        const SCRIPT_EXTS = new Set(['py', 'js', 'mjs', 'sh']);
                        if (SCRIPT_EXTS.has(scriptExt)) {
                            // Detect persistent-process (server) files by content
                            const writtenContent = String(actionResult.args?.content || '');
                            const SERVER_PATTERNS = [
                                /app\.listen\s*\(/,
                                /server\.listen\s*\(/,
                                /http\.createServer/,
                                /https\.createServer/,
                                /\.listen\s*\(\s*PORT/i,
                                /\.listen\s*\(\s*process\.env/i,
                            ];
                            const isTestFile = /\.(test|spec)\.[jt]sx?$/.test(writtenPath) ||
                                /[/\\](tests?|__tests?__)[/\\]/.test(writtenPath);
                            const isServerFile = !isTestFile && SERVER_PATTERNS.some(p => p.test(writtenContent));

                            if (isServerFile) {
                                log.info(`[GoalExecutor] Auto-execute SKIPPED — ${writtenPath} is a server file (.listen detected). Run npm test to execute tests against it.`);
                                state.execution_journal.push(
                                    `[AUTO-EXECUTE SKIPPED @ iter ${state.current_iteration}] ${writtenPath} starts a persistent server (contains .listen()). ` +
                                    `Do NOT run this file directly — it will block. ` +
                                    `To run tests: ensure package.json has a "test" script, then the validator will handle test execution.`
                                );
                            } else {
                                const unmetOutput = state.goal.success_criteria.find(c =>
                                    (c.type === 'file_exists' || c.type === 'file_contains') &&
                                    c.status !== 'passed' &&
                                    c.config.path &&
                                    !c.config.path.endsWith(`.${scriptExt}`)
                                );
                                if (unmetOutput) {
                                    const scriptFwd = writtenPath.replace(/\\/g, '/');
                                    const runCmd = scriptExt === 'py' ? `python3 "${scriptFwd}"`
                                        : scriptExt === 'js' || scriptExt === 'mjs' ? `node "${scriptFwd}"`
                                            : `sh "${scriptFwd}"`;
                                    log.info(`[GoalExecutor] Auto-executing written script: ${runCmd}`);
                                    const autoExecResult = await this.reasoner.executeAction(
                                        executionId, state,
                                        { tool: 'run_command', args: { command: runCmd }, reasoning: 'Auto-executing written script to produce output' },
                                        broadcast
                                    );
                                    state.completed_actions.push(autoExecResult);
                                    this.appendToJournal(state, autoExecResult);
                                    this.broadcastGoalEvent('goal:action_result', {
                                        execution_id: executionId,
                                        iteration: state.current_iteration,
                                        result: { success: autoExecResult.success, tool: 'run_command (auto)' },
                                    });
                                }
                            }
                        }
                    }
                    // ── END AUTO-EXECUTE ─────────────────────────────────────

                    // ── Gap A: browser_extract EMPTY → browser_eval ESCALATION ──────────
                    // When browser_extract returns empty twice consecutively, it means CSS
                    // selectors aren't matching JS-rendered content. Auto-escalate to
                    // browser_eval (direct JS execution) which always sees rendered DOM.
                    if (actionResult.tool_used === 'browser_extract') {
                        const resultText = (() => {
                            const r = actionResult.result as any;
                            if (typeof r === 'string') return r;
                            if (Array.isArray(r?.content)) return r.content.map((c: any) => c?.text || '').join('');
                            return JSON.stringify(r || '');
                        })();
                        const isEmpty = !resultText || resultText.trim().length < 20 ||
                            resultText.includes('[]') || resultText.includes('No elements found');

                        if (isEmpty) {
                            (state as any)._emptyExtractCount = ((state as any)._emptyExtractCount || 0) + 1;
                            log.info(`[GoalExecutor] browser_extract empty result #${(state as any)._emptyExtractCount}`);

                            if ((state as any)._emptyExtractCount >= 2) {
                                (state as any)._emptyExtractCount = 0;
                                log.info(`[GoalExecutor] Gap A: 2x empty browser_extract → injecting browser_eval escalation hint`);
                                const evalHint = [
                                    'browser_extract returned empty results twice',
                                    '— CSS selectors are not matching JS-rendered content.',
                                    'Switch to browser_eval with a script argument to run JavaScript',
                                    'directly against the rendered DOM instead of CSS selector matching.',
                                    'Example: browser_eval({ "script": "Array.from(document.querySelectorAll(athing)).map(r => r.innerText)" })',
                                ].join(' ');
                                state.error_history.push({
                                    iteration: state.current_iteration,
                                    error: evalHint,
                                    context: 'browser_extract_empty_escalation',
                                    recovery_attempted: true,
                                    recovery_successful: false,
                                    timestamp: new Date(),
                                });
                            }
                        } else {
                            (state as any)._emptyExtractCount = 0;
                        }
                    }
                    // ── END Gap A ────────────────────────────────────────────────────────

                    // ── DATA-HOARDING LOOP DETECTION ──────────────────────────────────────
                    // Symptom: agent calls browser_eval repeatedly collecting data in LLM
                    // context but never calls write_file. By iteration 8+ with 0 file
                    // criteria passing, the agent is clearly stuck in a browsing loop.
                    // Fix: inject a CRITICAL write-now escalation that overrides the next
                    // decision, forcing write_file before any further browsing.
                    if (actionResult.tool_used === 'browser_eval') {
                        (state as any)._browserEvalCount = ((state as any)._browserEvalCount || 0) + 1;
                    }
                    const pctDone = state.current_iteration / Math.max(state.max_iterations || 15, 1);
                    const filesPassed = (goal.success_criteria || []).filter((c: any) =>
                        (c.type === 'file_exists' || c.type === 'file_contains') && c.status === 'passed'
                    ).length;
                    const evalCount = (state as any)._browserEvalCount || 0;
                    if (evalCount >= 3 && pctDone >= 0.50 && filesPassed === 0) {
                        // Only inject once per run to avoid spamming
                        if (!(state as any)._writeEscalationInjected) {
                            (state as any)._writeEscalationInjected = true;
                            log.warn(`[GoalExecutor] DATA-HOARDING LOOP: ${evalCount} browser_eval calls, 0 files written at ${Math.round(pctDone * 100)}% iterations — injecting write-now escalation`);
                            state.error_history.push({
                                iteration: state.current_iteration,
                                error: [
                                    `CRITICAL: You have called browser_eval ${evalCount} times and are at iteration ${state.current_iteration} of ${state.max_iterations || 15},`,
                                    'but you have NOT written a single output file yet.',
                                    'You are running out of iterations. You MUST call write_file IMMEDIATELY with the data you have already collected.',
                                    'Do NOT navigate to any more pages. Do NOT call browser_eval again.',
                                    'Write ALL required output files (JSON + Markdown) RIGHT NOW using the data already in your context.',
                                    'Use write_file for each required output file before doing anything else.',
                                ].join(' '),
                                context: 'write_now_escalation',
                                recovery_attempted: true,
                                recovery_successful: false,
                                timestamp: new Date(),
                            });
                        }
                    }
                    // ── END DATA-HOARDING LOOP DETECTION ─────────────────────────────────

                    // Browser control: if user took control, pause here until released
                    if (this.browserControlActive) {
                        log.info(`[GoalExecutor] Browser control active — pausing ReAct loop until user releases`);
                        while (this.browserControlActive) {
                            await new Promise(r => setTimeout(r, 500));
                            if (checkCancelled()) break;
                        }
                        log.info(`[GoalExecutor] Browser control released — resuming`);
                    }

                    // ── Browser live preview ─────────────────────────────────
                    // Emit browser:started on first browser tool use so Inspector
                    // can show a placeholder before the first screenshot arrives.
                    if (!browserStartEmitted && actionResult.tool_used?.startsWith('browser_')) {
                        browserStartEmitted = true;
                        this.broadcastGoalEvent('browser:started', { execution_id: executionId });
                    }

                    // Emit explicit browser_screenshot result from pending_screenshot state
                    if (actionResult.tool_used === 'browser_screenshot' && state.pending_screenshot) {
                        const { base64, mimeType } = state.pending_screenshot;
                        this.broadcastGoalEvent('browser:screenshot', {
                            execution_id: executionId,
                            base64,
                            mimeType: mimeType || 'image/png',
                            url: (actionResult.args as any)?.url || '',
                            iteration: state.current_iteration,
                        });
                    }

                    // Auto-screenshot after any page-changing browser action so the Inspector
                    // shows the current page state without needing an explicit browser_screenshot.
                    if (BROWSER_SNAPSHOT_TOOLS.has(actionResult.tool_used || '')) {
                        try {
                            const { browserServer } = await import('../mcp/servers/BrowserServer');
                            const shot = await browserServer.screenshot({});
                            if (shot.base64) {
                                // Attach normalized cursor coords for click/type actions
                                // so the Inspector can render an agent cursor overlay dot.
                                const args = actionResult.args as any;
                                let cursor: { xRatio: number; yRatio: number } | undefined;
                                if (['browser_click', 'browser_fill', 'browser_type'].includes(actionResult.tool_used || '')) {
                                    const rawX = args?.x ?? args?.coordinate?.[0];
                                    const rawY = args?.y ?? args?.coordinate?.[1];
                                    if (rawX != null && rawY != null) {
                                        cursor = { xRatio: rawX / 1366, yRatio: rawY / 768 };
                                    }
                                }
                                this.broadcastGoalEvent('browser:screenshot', {
                                    execution_id: executionId,
                                    base64: shot.base64,
                                    mimeType: 'image/png',
                                    url: browserServer.getCurrentUrl(),
                                    iteration: state.current_iteration,
                                    cursor,
                                });

                                // Auto-pause when browser is blocked (Cloudflare, login wall, CAPTCHA).
                                // For Cloudflare specifically: try stealth_fetch first before requesting HITL.
                                const navResult = actionResult.result as any;
                                if (navResult?.blocked === true && !this.browserControlActive) {
                                    const blockType = navResult.blockType || 'anti-bot protection';
                                    const blockedTargetUrl = navResult.url || assessment.suggested_next_action?.args?.url as string | undefined;

                                    // Option A+B: For Cloudflare blocks, auto-retry with stealth_fetch before HITL
                                    if (blockType === 'cloudflare' && blockedTargetUrl) {
                                        log.info(`[GoalExecutor] Cloudflare block detected — trying stealth_fetch before HITL: ${blockedTargetUrl}`);
                                        this.broadcastGoalEvent('goal:progress', {
                                            execution_id: executionId,
                                            message: `Cloudflare detected on ${blockedTargetUrl} — attempting stealth bypass...`,
                                            iteration: state.current_iteration,
                                        });
                                        try {
                                            const stealthResult = await browserServer.stealthFetch(blockedTargetUrl);
                                            if (stealthResult.success && stealthResult.body) {
                                                const preview = stealthResult.body.substring(0, 200);
                                                log.info(`[GoalExecutor] stealth_fetch bypassed Cloudflare (${stealthResult.strategy}) — ${stealthResult.body.length} chars`);
                                                state.execution_journal.unshift(
                                                    `✅ [STEALTH_FETCH_SUCCESS] Cloudflare bypassed via ${stealthResult.strategy} for ${blockedTargetUrl}. ` +
                                                    `Content preview: ${preview}... ` +
                                                    `NEXT ACTION: parse this content and write output files. Do NOT call browser_navigate again.`
                                                );
                                                // Store content in error_history as a "positive" context so LLM can reference it
                                                state.error_history.push({
                                                    iteration: state.current_iteration,
                                                    timestamp: new Date(),
                                                    error: `[STEALTH_CONTENT] ${blockedTargetUrl} content (${stealthResult.body.length} chars): ${stealthResult.body.substring(0, 3000)}`,
                                                    context: 'stealth_fetch_success',
                                                    recovery_attempted: true,
                                                    recovery_successful: true,
                                                });
                                                // Skip HITL — agent can now process the content
                                                state.stuck_count = 0;
                                                consecutiveBrowserBlockedFailures = 0; // eslint-disable-line
                                            } else {
                                                log.warn(`[GoalExecutor] stealth_fetch failed (${stealthResult.error}) — proceeding to HITL`);
                                                state.execution_journal.unshift(
                                                    `⚠️ [STEALTH_FETCH_FAILED] stealth_fetch also blocked by Cloudflare on ${blockedTargetUrl}. Escalating to human control.`
                                                );
                                                // Fall through to HITL below
                                                await this._requestBrowserHITL(executionId, state, blockType, blockedTargetUrl, checkCancelled, consecutiveBrowserBlockedFailures);
                                            }
                                        } catch (stealthErr: any) {
                                            log.warn(`[GoalExecutor] stealth_fetch threw: ${stealthErr.message} — proceeding to HITL`);
                                            await this._requestBrowserHITL(executionId, state, blockType, blockedTargetUrl, checkCancelled, consecutiveBrowserBlockedFailures);
                                        }
                                    } else {
                                        // Non-Cloudflare block (login wall, rate limit, etc.) — go straight to HITL
                                        log.info(`[GoalExecutor] Browser blocked (${blockType}) — auto-pausing for user`);
                                        this.browserControlActive = true;
                                        this.broadcastGoalEvent('browser:blocked', {
                                            execution_id: executionId,
                                            blockType,
                                            url: browserServer.getCurrentUrl(),
                                            message: `Browser blocked by ${blockType}. Take Control in the Inspector panel, solve the challenge, then click Release Control to resume.`,
                                        });
                                        await this.notifyUserOfCaptcha(browserServer.getCurrentUrl(), 2);
                                        const waitOutcome = await this.waitForBrowserRelease(checkCancelled, 2 * 60 * 1000);
                                        state.human_browser_help_used = (state.human_browser_help_used || 0) + 1;
                                        if (waitOutcome === 'timeout') {
                                            const blockedUrl = browserServer.getCurrentUrl() || '';
                                            const blockedDomain = (() => { try { return new URL(blockedUrl).hostname; } catch { return blockedUrl; } })();
                                            log.warn(`[GoalExecutor] Browser CAPTCHA wait timed out (2 min) — blocking ${blockedDomain} for this session`);
                                            this.broadcastGoalEvent('browser:control_timeout', { execution_id: executionId, url: blockedUrl });
                                            state.execution_journal.push(`[human_browser_help_timeout] User was unavailable for 2 min while waiting for CAPTCHA solve on ${blockedDomain}. Domain blocked for this session.`);
                                            state.error_history.push({
                                                iteration: state.current_iteration,
                                                timestamp: new Date(),
                                                error: `CAPTCHA wait timed out after 10 minutes on ${blockedDomain}. User was not available. PERMANENTLY SKIP this domain — do NOT try browser_navigate, web_fetch, or run_command scripts on ${blockedDomain} again. Use alternative data sources instead.`,
                                                context: 'captcha_timeout',
                                                recovery_attempted: false,
                                                recovery_successful: false,
                                            });
                                        } else {
                                            state.execution_journal.push(
                                                `[human_browser_help] User took browser control after ${blockType} block and released it (attempt ${state.human_browser_help_used})`
                                            );
                                            state.error_history.push({
                                                iteration: state.current_iteration,
                                                timestamp: new Date(),
                                                error: `Human browser control used for ${blockType} block — if still stuck after this, do NOT try scripts on the same site; give up.`,
                                                context: 'human_browser_help_released',
                                                recovery_attempted: true,
                                                recovery_successful: false,
                                            });
                                        }
                                    } // end else (non-Cloudflare HITL)
                                }
                            }
                        } catch (_) { /* browser not launched — ignore */ }
                    }

                    // CAPTCHA detected by ReActReasoner in web_fetch/browser_fetch result.
                    // The error result contains [CAPTCHA_BLOCKED] — auto-open browser + pause for user.
                    const captchaDetected =
                        !actionResult.success &&
                        ['web_fetch', 'browser_fetch'].includes(actionResult.tool_used) &&
                        (() => {
                            const r = actionResult.result as any;
                            const txt = Array.isArray(r?.content) ? r.content.map((c: any) => c?.text || '').join('') : String(r || '');
                            return txt.includes('[CAPTCHA_BLOCKED]');
                        })();
                    if (captchaDetected && !this.browserControlActive) {
                        const captchaUrl = assessment.suggested_next_action?.args?.url as string | undefined;
                        log.info(`[GoalExecutor] CAPTCHA detected in web_fetch — launching browser + pausing for user (${captchaUrl})`);
                        this.browserControlActive = true;
                        this.broadcastGoalEvent('browser:blocked', {
                            execution_id: executionId,
                            blockType: 'CAPTCHA / bot-wall',
                            url: captchaUrl,
                            message: `CAPTCHA detected on ${captchaUrl}. Open the Browser Inspector, navigate to this URL, solve the CAPTCHA, then click Release Control to resume.`,
                        });
                        await this.notifyUserOfCaptcha(captchaUrl, 2);
                        const captchaWaitOutcome = await this.waitForBrowserRelease(checkCancelled, 2 * 60 * 1000);
                        state.human_browser_help_used = (state.human_browser_help_used || 0) + 1;
                        const captchaDomain = (() => { try { return new URL(captchaUrl || '').hostname; } catch { return captchaUrl || 'unknown'; } })();
                        if (captchaWaitOutcome === 'timeout') {
                            log.warn(`[GoalExecutor] CAPTCHA wait timed out (2 min) — blocking ${captchaDomain} for this session`);
                            this.broadcastGoalEvent('browser:control_timeout', { execution_id: executionId, url: captchaUrl });
                            state.execution_journal.push(`[captcha_timeout] Waited 2 min for CAPTCHA solve on ${captchaDomain} — user unavailable. Domain blocked.`);
                            state.error_history.push({
                                iteration: state.current_iteration,
                                timestamp: new Date(),
                                error: `CAPTCHA wait timed out after 2 minutes on ${captchaDomain}. User was not available. PERMANENTLY SKIP this domain — find alternative data sources for this information.`,
                                context: 'captcha_timeout',
                                recovery_attempted: false,
                                recovery_successful: false,
                            });
                            // Do NOT reset stuck_count — let replanning kick in with alternative approach
                        } else {
                            state.execution_journal.push(
                                `[human_browser_help] CAPTCHA detected on ${captchaUrl} — user took browser control and released it (attempt ${state.human_browser_help_used})`
                            );
                            state.error_history.push({
                                iteration: state.current_iteration,
                                timestamp: new Date(),
                                error: `CAPTCHA blocked ${captchaUrl}. User solved it via browser control. Now use browser_navigate to ${captchaUrl} to continue.`,
                                context: 'captcha_resolved_by_user',
                                recovery_attempted: true,
                                recovery_successful: false,
                            });
                            // Reset stuck so agent retries with browser_navigate after CAPTCHA solve
                            state.stuck_count = 0;
                        }
                    }

                    // LLM self-declared completion via mark_complete virtual tool
                    if (actionResult.tool_used === 'mark_complete' &&
                        typeof actionResult.result === 'string' &&
                        actionResult.result.startsWith('GOAL_COMPLETE::')) {
                        state.status = 'completed';
                        state.completed_at = new Date();
                        state.progress_percent = 100;
                        log.info(`[GoalExecutor] LLM declared goal complete at iteration ${state.current_iteration}`);
                        break;
                    }

                    // Extension hook: after_action
                    await extensionHooks.emit('after_action', {
                        state,
                        action: assessment.suggested_next_action,
                        result: actionResult
                    });

                    const WRITE_TOOLS = ['write_file', 'create_directory', 'move_file', 'edit_file', 'run_command'];
                    // Read-only tools that returned actual data are making progress (gathering info).
                    // Only increment stuck_count when the action genuinely produced nothing useful.
                    const READ_DATA_TOOLS = new Set([
                        'list_directory', 'read_file', 'search_files', 'get_file_info',
                        'web_search', 'web_fetch', 'browser_fetch',
                    ]);
                    // Navigation/interaction tools that succeed but return no data are still progress
                    // (e.g. browser_navigate to a page, browser_click on a button).
                    // Counting these as "stuck" was the #1 false-positive source in browser tasks.
                    const NAVIGATION_TOOLS = new Set([
                        'browser_navigate', 'browser_click', 'browser_type', 'browser_scroll',
                        'browser_wait', 'browser_hover', 'browser_select',
                    ]);

                    // ── DUPLICATE ACTION DETECTION ─────────────────────────────────────────
                    // If the agent called the exact same tool with the same key args as the
                    // previous iteration, it's spinning in place. Immediately flag as stuck so
                    // replanning fires on the next iteration rather than wasting 6 more rounds.
                    const prevAction = state.completed_actions[state.completed_actions.length - 2]; // -2 because current is already appended
                    if (prevAction && actionResult.success && READ_DATA_TOOLS.has(actionResult.tool_used)) {
                        const curArgs = assessment.suggested_next_action?.args || {};
                        const prevArgs = prevAction.args || {};
                        const curSig = `${actionResult.tool_used}::${curArgs.query || curArgs.url || curArgs.path || JSON.stringify(curArgs).slice(0, 120)}`;
                        const prevSig = `${prevAction.tool_used}::${prevArgs.query || prevArgs.url || prevArgs.path || JSON.stringify(prevArgs).slice(0, 120)}`;
                        if (curSig === prevSig) {
                            state.stuck_count++;
                            state.consecutive_read_only++;
                            state.error_history.push({
                                iteration: state.current_iteration,
                                timestamp: new Date(),
                                error: `Duplicate action detected: called ${actionResult.tool_used} with identical args as previous iteration. The data source returned the same result — try a different approach, different query, or write the output now.`,
                                context: 'duplicate_action',
                                recovery_attempted: false,
                                recovery_successful: false,
                            });
                            log.warn({ tool: actionResult.tool_used, sig: curSig.slice(0, 80) }, '[GoalExecutor] Duplicate action detected — incrementing stuck_count');
                        }
                    }
                    // ── END DUPLICATE ACTION DETECTION ────────────────────────────────────

                    const hasUsefulOutput = (() => {
                        const r = actionResult.result;
                        if (!r) return false;
                        if (typeof r === 'string') return r.length > 20;
                        if (typeof r !== 'object') return false;
                        if (r.results && Array.isArray(r.results) && r.results.length > 0) return true;
                        if (typeof r.content === 'string' && r.content.length > 20) return true;
                        if (Array.isArray(r.content) && r.content.length > 0) return true;
                        if (r.stdout && r.stdout.length > 5) return true;
                        return false;
                    })();

                    if (actionResult.success && WRITE_TOOLS.includes(actionResult.tool_used)) {
                        // Write/execute tool succeeded → definite progress; reset all loop counters
                        state.last_progress_at = new Date();
                        state.stuck_count = 0;
                        state.consecutive_read_only = 0;
                        state.file_read_counts = {};
                    } else if (actionResult.success && actionResult.tool_used === 'run_command') {
                        // Successful run_command (e.g. test passed) → also reset file read counts
                        state.file_read_counts = {};
                    } else if (actionResult.success && NAVIGATION_TOOLS.has(actionResult.tool_used)) {
                        // Browser navigation/interaction succeeded → progress, never increment stuck_count
                        state.consecutive_read_only = 0;
                        log.info(`[GoalExecutor] ${actionResult.tool_used} succeeded — navigation progress, stuck_count unchanged`);
                    } else if (actionResult.success && READ_DATA_TOOLS.has(actionResult.tool_used) && hasUsefulOutput) {
                        // Read-only tool returned data → agent is gathering info, not stuck.
                        // Don't increment stuck_count, but track the read-only streak.
                        // After 6 consecutive read-only iterations bump stuck_count so replanning triggers.
                        state.consecutive_read_only++;
                        // Track per-file read counts (read_file only)
                        if (actionResult.tool_used === 'read_file') {
                            const filePath = String(actionResult.args?.path || '');
                            if (filePath) {
                                state.file_read_counts[filePath] = (state.file_read_counts[filePath] ?? 0) + 1;
                                const readCount = state.file_read_counts[filePath];
                                if (readCount >= 2) {
                                    log.info(`[GoalExecutor] read_file "${filePath}" read ${readCount}x since last write — triggering REPEATED_READ_HINT`);
                                }
                            }
                        }
                        if (state.consecutive_read_only >= 4) {
                            state.stuck_count++;
                            log.info(`[GoalExecutor] ${actionResult.tool_used} returned data but read-only streak=${state.consecutive_read_only} — incrementing stuck_count`);
                        } else {
                            log.info(`[GoalExecutor] ${actionResult.tool_used} returned data — read-only streak=${state.consecutive_read_only}, not incrementing stuck_count`);
                        }
                    } else if (!actionResult.success) {
                        const errorText = String(actionResult.result);
                        const errorSeverity = classifyErrorSeverity(errorText);

                        // Fatal errors are deterministic — they will never self-heal.
                        // Skip wasted iterations by jumping straight to the replan threshold.
                        if (errorSeverity === 'fatal') {
                            log.warn({ tool: actionResult.tool_used, error: errorText.slice(0, 120) },
                                `[GoalExecutor] FATAL error classified — accelerating to replan (was stuck_count=${state.stuck_count})`);
                            state.stuck_count = maxStuckIterations; // triggers replan on next assessment
                            state.execution_journal.push(
                                `[FATAL ERROR @ iter ${state.current_iteration}] ${errorText.slice(0, 300)} — strategy must change immediately.`
                            );
                        } else {
                            state.stuck_count++;
                        }

                        state.error_history.push({
                            iteration: state.current_iteration,
                            error: errorText,
                            context: assessment.suggested_next_action.reasoning,
                            recovery_attempted: false,
                            recovery_successful: false,
                            timestamp: new Date()
                        });
                    } else {
                        // Action succeeded but produced nothing useful (e.g. empty read result)
                        // Only count as stuck if consecutive — first empty result might be transient
                        state.stuck_count++;
                    }

                    if ((actionResult.artifacts_created || []).length > 0) {
                        state.artifacts.push(...actionResult.artifacts_created);
                    }
                }

                // ── HARD FAIL: human browser help used + still stuck ─────────────────
                // If the user already took browser control (e.g. tried to solve CAPTCHA/login)
                // and the agent is still stuck, do NOT fall back to run_command scripts on the
                // same blocked site. Report failure cleanly.
                if ((state.human_browser_help_used || 0) >= 1 && state.stuck_count >= 2) {
                    log.warn(`[GoalExecutor] Human browser help used ${state.human_browser_help_used}x but still stuck — giving up`);
                    state.status = 'failed';
                    state.completed_at = new Date();
                    (state as any).failure_reason = 'Browser blocked and human control could not resolve it. The website is inaccessible (anti-bot protection, login required, or CAPTCHA unsolvable). Cannot use scripts as fallback for browser-specific goals.';
                    break;
                }

                // ── EARLY SCRIPT ESCALATION ──────────────────────────────────────────
                // If recent run_command calls keep failing (e.g. missing module, wrong API),
                // escalate to a full Python/Node script immediately rather than waiting for
                // the slow loop-detection path (which requires 3+ identical tool calls).
                // This is the most common failure mode for data-fetching goals.
                {
                    const recentCmds = state.completed_actions.slice(-5);
                    const failedCmds = recentCmds.filter(a => a.tool_used === 'run_command' && !a.success).length;
                    // But NOT when human browser help was already used — don't fall back to scripts after human help failed
                    if (failedCmds >= 3 && state.stuck_count >= 3 && !(state.human_browser_help_used >= 1)) {
                        log.info(`[GoalExecutor] Early script escalation: ${failedCmds} failed run_commands + stuck=${state.stuck_count}`);
                        this.emitProgress(executionId, 'executing', 'Commands failing — escalating to full script...');
                        const scriptSuccess = await this.engine.executeViaScript(state, requestApproval, selfCorrect, broadcast);
                        if (scriptSuccess) {
                            state.stuck_count = 0;
                            sameToolCount = 0;
                            readOnlyStreakCount = 0;
                            const earlVal = await goalValidator.validateGoal(state.goal);
                            state.progress_percent = earlVal.score;
                            if (earlVal.complete) {
                                state.status = 'completed';
                                state.completed_at = new Date();
                                log.info(`[GoalExecutor] GOAL ACHIEVED via early script escalation!`);
                                break;
                            }
                            continue;
                        }
                    }
                }
                // ─────────────────────────────────────────────────────────────────────

                // VALIDATE PROGRESS
                // hasRealWork: any meaningful action succeeded (files, commands, web searches)
                const hasRealWork = state.artifacts.length > 0 || state.completed_actions.some(a =>
                    ['write_file', 'create_directory', 'move_file', 'edit_file', 'run_command',
                        'web_search', 'browser_navigate', 'browser_extract'].includes(a.tool_used) && a.success
                );
                // Also validate after iter 3 even without real work (catches edge cases and pure-info goals)
                const shouldValidate = hasRealWork || state.current_iteration > 3;

                if (state.current_iteration % validationInterval === 0 && shouldValidate) {
                    state.status = 'validating';
                    // Build execution context from recent tool results so llm_evaluates
                    // can see what the agent actually did (fixes 'No output provided' loop)
                    const recentContext = state.completed_actions
                        .slice(-5)
                        .filter(a => a.success && a.result)
                        .map(a => `[${a.tool_used}] ${typeof a.result === 'string' ? a.result.substring(0, 600) : JSON.stringify(a.result).substring(0, 600)}`)
                        .join('\n---\n');
                    // Pass all tools used — GoalValidator uses this for tool-evasion gate (Option B)
                    const allToolsUsed = state.completed_actions.map(a => a.tool_used).filter(Boolean);
                    const validation = await goalValidator.validateGoal(
                        state.goal,
                        recentContext || undefined,
                        { current: state.current_iteration, max: state.max_iterations },
                        allToolsUsed
                    );
                    state.progress_percent = validation.score;

                    this.broadcastGoalEvent('goal:validation', {
                        execution_id: executionId,
                        score: validation.score,
                        complete: validation.complete,
                        passed: validation.passed.length,
                        failed: validation.failed.length
                    });

                    if (validation.complete) {
                        state.status = 'completed';
                        state.completed_at = new Date();
                        log.info(`[GoalExecutor] GOAL ACHIEVED at iteration ${state.current_iteration}!`);
                        break;
                    }

                    // ── STUCK CRITERION DETECTION (Fix B) ────────────────────────────────
                    // Track consecutive failures per criterion. After 2 consecutive failures
                    // on the same criterion, inject a MUST_FIX_NEXT journal entry so the LLM
                    // stops drifting to comfortable but wrong actions.
                    // Threshold=2: by the 3rd consecutive failure the pattern is established.
                    {
                        const criterionFailStreak = state.criterionFailStreak;

                        for (const failedCriterion of validation.failed) {
                            const streak = (criterionFailStreak[failedCriterion.id] ?? 0) + 1;
                            criterionFailStreak[failedCriterion.id] = streak;

                            if (streak >= 2) {
                                const failMsg = failedCriterion.message?.substring(0, 200) ?? '';

                                // Specific AUTO-HINT: missing npm test script
                                if (
                                    failedCriterion.type === 'tests_pass' &&
                                    (failMsg.includes('Missing script') || failMsg.includes('missing script'))
                                ) {
                                    const hint = `[AUTO-HINT @ iter ${state.current_iteration}] ` +
                                        `npm test has failed ${streak} times with "Missing script: test". ` +
                                        `package.json does not have a "test" script. ` +
                                        `ACTION: write_file package.json and add "scripts": { "test": "node tests/api.test.js" } (or appropriate test command). ` +
                                        `Do NOT rewrite server.js — fix package.json first.`;
                                    if (!state.execution_journal.some(e => e.includes('AUTO-HINT') && e.includes('Missing script'))) {
                                        state.execution_journal.push(hint);
                                        log.warn(`[GoalExecutor] Stuck criterion AUTO-HINT injected: tests_pass missing script`);
                                    }

                                // Specific AUTO-HINT: test framework not installed
                                } else if (
                                    failedCriterion.type === 'tests_pass' &&
                                    (
                                        failMsg.includes("Cannot find module 'mocha'") ||
                                        failMsg.includes('Cannot find module "mocha"') ||
                                        failMsg.includes("Cannot find module 'jest'") ||
                                        failMsg.includes('Cannot find module "jest"') ||
                                        failMsg.includes("mocha: not found") ||
                                        failMsg.includes("jest: not found") ||
                                        // before() / describe() / it() undefined → mocha not installed
                                        failMsg.includes("reading 'before'") ||
                                        failMsg.includes("reading 'describe'") ||
                                        failMsg.includes("reading 'it'") ||
                                        failMsg.includes('before is not defined') ||
                                        failMsg.includes('describe is not defined')
                                    )
                                ) {
                                    const framework = failMsg.toLowerCase().includes('jest') ? 'jest' : 'mocha';
                                    const testScript = framework === 'mocha' ? 'mocha tests/**/*.test.js --exit' : 'jest --forceExit';
                                    const frameworkHint = `[AUTO-HINT @ iter ${state.current_iteration}] ` +
                                        `npm test failed because "${framework}" is not installed or not set as the test runner. ` +
                                        `ATOMIC ACTION REQUIRED — do this in a SINGLE write_file call to package.json: ` +
                                        `(1) add "${framework}" and "supertest" under devDependencies, ` +
                                        `(2) set scripts.test to "${testScript}". ` +
                                        `Then run_command "npm install" to install the new deps. ` +
                                        `Do NOT patch devDependencies and scripts in separate writes — that wastes an iteration.`;
                                    if (!state.execution_journal.some(e => e.includes('AUTO-HINT') && e.includes(framework + ' is not installed'))) {
                                        state.execution_journal.push(frameworkHint);
                                        log.warn(`[GoalExecutor] Stuck criterion AUTO-HINT injected: tests_pass ${framework} not installed`);
                                    }

                                // Specific AUTO-HINT: ECONNREFUSED — server not running during tests
                                } else if (
                                    failedCriterion.type === 'tests_pass' &&
                                    (failMsg.includes('ECONNREFUSED') || failMsg.includes('connect ECONNREFUSED'))
                                ) {
                                    const connHint = `[AUTO-HINT @ iter ${state.current_iteration}] ` +
                                        `npm test failed with ECONNREFUSED — the test suite is trying to reach a server that is not running. ` +
                                        `ACTION: Use supertest with app directly (require('./app') not a live server), OR add a beforeAll() that starts the server on a test port and an afterAll() that closes it. ` +
                                        `Do NOT rely on a separately running server during automated tests.`;
                                    if (!state.execution_journal.some(e => e.includes('AUTO-HINT') && e.includes('ECONNREFUSED'))) {
                                        state.execution_journal.push(connHint);
                                        log.warn(`[GoalExecutor] Stuck criterion AUTO-HINT injected: tests_pass ECONNREFUSED`);
                                    }

                                } else if (streak >= 2) {
                                    // Generic stuck criterion forcing function
                                    const targetFile = (failedCriterion.config as any)?.path
                                        ? `file: ${(failedCriterion.config as any).path}`
                                        : `criterion type: ${failedCriterion.type}`;
                                    const forcingHint = `[STUCK CRITERION @ iter ${state.current_iteration}] ` +
                                        `"${failedCriterion.type}" on ${targetFile} has failed ${streak} consecutive times. ` +
                                        `Last failure: ${failMsg}. ` +
                                        `NEXT ACTION MUST directly address this specific ${targetFile} — do not repeat the same approach.`;
                                    // Only inject once per streak milestone (2, 4, 6...) and cap at 3
                                    // total hints per criterion to prevent unbounded context growth.
                                    const existingHintCount = state.execution_journal.filter(
                                        e => e.includes('STUCK CRITERION') && e.includes(targetFile)
                                    ).length;
                                    if (streak % 2 === 0 && existingHintCount < 3) {
                                        state.execution_journal.push(forcingHint);
                                        log.warn({ criterionId: failedCriterion.id, streak }, `[GoalExecutor] Stuck criterion detected — journal hint injected`);
                                    }
                                }
                            }
                        }

                        // Reset streak for any criterion that just passed
                        for (const passedCriterion of validation.passed) {
                            delete criterionFailStreak[passedCriterion.id];
                        }
                    }
                    // ── END STUCK CRITERION DETECTION ────────────────────────────────────

                    // ── BROWSER-BLOCKED AUTO-HITL ──────────────────────────────────────────
                    // If llm_evaluates keeps failing with a "needs human/browser" message,
                    // stuck_count never fires because the agent keeps writing dummy files
                    // (every successful write resets stuck_count to 0). Detect this pattern
                    // directly from the validation evidence and escalate immediately.
                    {
                        const llmFailMsg = validation.failed
                            .find(c => c.type === 'llm_evaluates')?.message || '';
                        // Only count as "site blocked agent" if NOT a TOOL-EVASION message.
                        // TOOL-EVASION = agent didn't use browser yet (different fix needed).
                        // BROWSER_BLOCKED_PATTERN accidentally matches "browser_* tool" strings.
                        const isSiteBlocked = llmFailMsg &&
                            !llmFailMsg.startsWith('TOOL-EVASION') &&
                            BROWSER_BLOCKED_PATTERN.test(llmFailMsg);
                        if (isSiteBlocked) {
                            consecutiveBrowserBlockedFailures++;
                            log.info(`[GoalExecutor] llm_evaluates site-blocked failure #${consecutiveBrowserBlockedFailures}: "${llmFailMsg.substring(0, 100)}"`);
                        } else {
                            consecutiveBrowserBlockedFailures = 0;
                        }

                        if (consecutiveBrowserBlockedFailures >= MAX_BROWSER_BLOCKED_FAILURES) {
                            consecutiveBrowserBlockedFailures = 0; // reset so it doesn't re-fire immediately after resume
                            log.info(`[GoalExecutor] Browser-blocked pattern confirmed — escalating to HITL`);
                            state.status = 'paused';
                            this.executions.set(executionId, state);

                            // Notify user via Telegram/Discord — fire-and-forget
                            this.notifyUserOfBlockedHITL(
                                state.goal.description.substring(0, 100),
                                llmFailMsg.substring(0, 300),
                                this.extractTargetUrl(state) || undefined
                            );

                            const userResponse = await this.requestUserInput(executionId, state, {
                                question: `The agent cannot complete this task automatically.\n\n${llmFailMsg}\n\nPlease open the browser and complete the action manually, then close the browser window to resume.`,
                                fields: [
                                    { name: 'email', label: 'Account Email (if needed)', type: 'email', required: false, placeholder: 'you@example.com' },
                                    { name: 'password', label: 'Account Password (if needed)', type: 'password', required: false, placeholder: 'leave blank if not needed' },
                                ],
                            });

                            this.broadcastGoalEvent('goal:resumed', { execution_id: executionId, reason: 'user_browser_action' });
                            state.status = 'executing';

                            if (userResponse.trim()) {
                                // User responded — continue from browser state.
                                // Extract the post-release URL from the response message
                                // (GatewayService embeds it via resolveAnyPendingInput).
                                const urlMatch = userResponse.match(/Browser is now at:\s*(https?:\/\/[^\s.]+[^\s]*)/i);
                                const postReleaseUrl = urlMatch?.[1] ?? 'unknown URL';

                                state.current_strategy = `User completed browser action. Browser is now at: ${postReleaseUrl}. Continue from current browser state.`;

                                // Prepend to journal so LLM sees this FIRST — prevents recency
                                // bias toward the last failed action (e.g. web_search).
                                state.execution_journal.unshift(
                                    `✅ [BROWSER STATE] Browser is OPEN and loaded at: ${postReleaseUrl}. ` +
                                    `DO NOT call browser_launch, browser_navigate (away), or web_search. ` +
                                    `NEXT ACTION: browser_screenshot → browser_get_content → write_file.`
                                );

                                state.error_history.push({
                                    iteration: state.current_iteration,
                                    error: `User handled browser action: ${userResponse.substring(0, 200)}`,
                                    context: 'browser_blocked_hitl',
                                    recovery_attempted: true,
                                    recovery_successful: true,
                                    timestamp: new Date(),
                                });
                                state.stuck_count = 0;
                            } else {
                                // Timeout — user unavailable. Force a strategy change: try without browser.
                                log.info(`[GoalExecutor] Browser HITL timed out — injecting replan hint`);
                                const noHumanHint = 'User did not respond (5-min timeout). Manual browser interaction is not available. Abandon browser/login approach entirely. Find a completely different strategy to achieve the goal without requiring account access — e.g. use a public API, scrape public data, or find an alternative data source.';
                                state.current_strategy = noHumanHint;
                                // Reset strategy_changes so this fresh direction doesn't immediately
                                // trigger the "all strategies exhausted" HITL again.
                                state.strategy_changes = 0;
                                state.stuck_count = 0;
                                state.error_history.push({
                                    iteration: state.current_iteration,
                                    error: 'Browser HITL timed out — switching to no-browser strategy',
                                    context: 'browser_blocked_hitl_timeout',
                                    recovery_attempted: true,
                                    recovery_successful: false,
                                    timestamp: new Date(),
                                });
                            }
                        }
                    }

                    state.status = 'executing';

                    // -- INJECT llm_evaluates FAILURE REASON INTO AGENT CONTEXT -----------
                    // When llm_evaluates fails, the LLM needs to know WHY -- without this,
                    // the agent re-runs the same script hoping the output changes.
                    const llmEvalFailures = validation.failed.filter((c: any) => c.type === 'llm_evaluates');
                    for (const failedCrit of llmEvalFailures) {
                        const filePath = (failedCrit.config as any)?.path || 'the output file';
                        const failReason = failedCrit.message || 'Content did not meet quality requirements';
                        const lastEntry = state.error_history[state.error_history.length - 1];
                        const alreadyInjected = lastEntry?.context === 'llm_evaluates_feedback' &&
                            lastEntry?.error?.includes(failReason.substring(0, 60));
                        if (!alreadyInjected) {
                            log.info(`[GoalExecutor] Injecting llm_evaluates feedback: ${failReason.substring(0, 120)}`);
                            state.error_history.push({
                                iteration: state.current_iteration,
                                error: `QUALITY CHECK FAILED for '${filePath}': ${failReason}. Fix these SPECIFIC issues -- do NOT just re-run the same script unchanged.`,
                                context: 'llm_evaluates_feedback',
                                recovery_attempted: false,
                                recovery_successful: false,
                                timestamp: new Date(),
                            });
                        }
                    }
                    // -------------------------------------------------------------------
                }

                // CHECK STUCK — ask the user before giving up entirely
                if (state.stuck_count >= maxStuckIterations && state.strategy_changes >= maxStrategyChanges) {
                    log.info(`[GoalExecutor] All strategies exhausted — escalating to user`);
                    state.status = 'paused';
                    this.executions.set(executionId, state);

                    const userHint = await this.requestUserInput(executionId, state);

                    if (!userHint.trim()) {
                        if (!hitlTimeoutRetried) {
                            // First timeout — inject autonomous retry hint, reset counters, continue
                            hitlTimeoutRetried = true;
                            log.info(`[GoalExecutor] HITL timed out — injecting autonomous retry hint`);
                            const autonomousHint = 'User did not respond (5-min timeout). User is unavailable. Try a completely different autonomous strategy to achieve the goal — explore alternative approaches, different tools, or a simpler subset of the goal that can be accomplished without human interaction.';
                            state.current_strategy = autonomousHint;
                            state.strategy_changes = 0;
                            state.stuck_count = 0;
                            state.status = 'executing';
                            state.error_history.push({
                                iteration: state.current_iteration,
                                error: 'HITL timed out — autonomous retry with new strategy',
                                context: 'hitl_timeout_retry',
                                recovery_attempted: true,
                                recovery_successful: false,
                                timestamp: new Date(),
                            });
                            this.broadcastGoalEvent('goal:resumed', { execution_id: executionId, reason: 'hitl_timeout_autonomous_retry' });
                            continue;
                        }
                        // Second timeout — give up
                        state.status = 'failed';
                        log.info(`[GoalExecutor] HITL timed out twice — failing goal`);
                        break;
                    }

                    // Inject user hint and give the agent another chance
                    log.info(`[GoalExecutor] Resuming with user hint: "${userHint.substring(0, 80)}"`);
                    state.current_strategy = `User hint: ${userHint}`;
                    state.strategy_changes = 0;
                    state.stuck_count = 0;
                    state.status = 'executing';

                    state.error_history.push({
                        iteration: state.current_iteration,
                        error: `User guided: "${userHint}"`,
                        context: 'user_escalation',
                        recovery_attempted: true,
                        recovery_successful: true,
                        timestamp: new Date()
                    });

                    this.broadcastGoalEvent('goal:resumed', {
                        execution_id: executionId,
                        reason: 'user_hint',
                        hint: userHint,
                    });
                }

                if (state.current_iteration % 5 === 0) {
                    await this.updateExecution(state);
                }
            }

            // ================================================================
            // PHASE 3.4: SMALL MODEL ESCALATION
            // If the active model is small (<= 8B params) and completed 0% of goal,
            // escalate to the next larger available model and resume from checkpoint.
            // Capped at max_escalations (default 2) to prevent runaway API spend.
            // ================================================================
            if (
                state.status !== 'completed' &&
                state.status !== 'cancelled' &&
                state.progress_percent === 0 &&
                state.escalation_count < state.max_escalations
            ) {
                const { modelManager } = await import('../services/llm/modelManager');
                const activeModel = modelManager.getActiveModelStatus().model || '';

                // Only escalate for known-small local models (isSmallModel returns false for unknown/cloud)
                if (isSmallModel(activeModel, 8)) {
                    const nextAdapter = modelManager.getFallbackAdapter?.();
                    if (nextAdapter) {
                        const paramCount = parseParamCount(activeModel);
                        log.warn(`[GoalExecutor] Small model (${activeModel}, ${paramCount}B) achieved 0% — escalating to larger model`);
                        this.broadcastGoalEvent('goal:model_escalation', {
                            execution_id: executionId,
                            from_model: activeModel,
                            escalation_count: state.escalation_count + 1,
                        });
                        state.escalation_count++;
                        state.stuck_count = 0;  // Critical: don't inherit stuck state from small model
                        state.strategy_changes = 0;
                        state.status = 'executing';
                        state.current_iteration = Math.max(0, state.current_iteration - 5); // rewind
                        state.execution_journal.push(
                            `[model_escalation] Escalated from ${activeModel} (${paramCount}B) to larger model after 0% progress. Retry from iteration ${state.current_iteration}.`
                        );
                        this.reasoner.overrideAdapter?.(nextAdapter);
                        // After escalation, verify artifacts from the small-model run still exist.
                        // The container may have been replaced — stale paths would cause hallucinated progress.
                        await this.pruneStaleArtifacts(state, log);
                    }
                }
            }

            // ================================================================
            // PHASE 3.5: SCRIPT FALLBACK (for simple file-creation)
            // If the ReAct loop didn't complete AND the goal is mostly about
            // creating files, try the old monolithic script approach as a
            // last-resort recovery.
            // ================================================================
            if (state.status !== 'completed' && state.status !== 'failed' && state.status !== 'cancelled') {
                const fileExistsCriteria = state.goal.success_criteria.filter(c => c.type === 'file_exists');
                const unmetFiles = fileExistsCriteria.filter(c => c.status !== 'passed');

                if (unmetFiles.length > 0 && fileExistsCriteria.length === state.goal.success_criteria.filter(c => c.required).length) {
                    log.info(`[GoalExecutor] ReAct loop incomplete (${state.progress_percent}%), trying script fallback for ${unmetFiles.length} unmet file criteria`);
                    this.emitProgress(executionId, 'executing', 'Trying script-based file generation as fallback...');

                    const scriptSuccess = await this.engine.executeViaScript(state, requestApproval, selfCorrect, broadcast);
                    if (scriptSuccess) {
                        const postScriptValidation = await goalValidator.validateGoal(state.goal);
                        state.progress_percent = postScriptValidation.score;
                        if (postScriptValidation.complete) {
                            state.status = 'completed';
                            state.completed_at = new Date();
                            log.info('[GoalExecutor] GOAL ACHIEVED via script fallback!');
                        }
                    }
                }
            }

            // ================================================================
            // PHASE 4: FINAL VALIDATION
            // ================================================================
            if (state.status === 'executing') {
                const finalValidation = await goalValidator.validateGoal(state.goal);
                state.progress_percent = finalValidation.score;

                if (finalValidation.complete) {
                    state.status = 'completed';
                } else {
                    state.status = 'failed';
                }
            }

            // ================================================================
            // PHASE 5: BUILD RESULT
            // ================================================================
            // Drop credentials from memory before any further DB/log writes
            delete (state as any).secureContext;

            const result = this.buildResult(state, startTime);
            await this.updateExecution(state);

            // Write index.md into the goal's output folder — lists all files produced,
            // the goal description, timing, and model used.
            try {
                const goalFolder = `${workspaceRoot}/${state.outputDir}`;
                const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
                const durationSec = Math.round((Date.now() - startTime) / 1000);
                const fileLines = state.artifacts.length > 0
                    ? state.artifacts.map(f => `- ${f.replace(workspaceRoot + '/', '')}`).join('\n')
                    : '- *(no files written)*';
                const model = (() => {
                    try { return (modelManager as any).getActiveModelStatus?.()?.model || 'unknown'; }
                    catch { return 'unknown'; }
                })();
                const indexContent = `# ${state.outputDir}

**Goal:** ${state.goal.description.substring(0, 200)}${state.goal.description.length > 200 ? '...' : ''}

**Status:** ${state.status === 'completed' ? '✅ Completed' : '❌ Failed'}
**Completed:** ${timestamp} UTC
**Duration:** ${durationSec}s over ${state.current_iteration} iterations
**Model:** ${model}

## Files Generated

${fileLines}

## Success Criteria

${state.goal.success_criteria.map(c =>
                    `- ${c.status === 'passed' ? '✅' : '❌'} \`${c.config?.path || c.type}\``
                ).join('\n')}
`;
                await mcpManager.callTool('filesystem', 'write_file', {
                    path: `${goalFolder}/index.md`,
                    content: indexContent,
                });
                log.info(`[GoalExecutor] Wrote index.md → ${goalFolder}/index.md`);
            } catch (idxErr: any) {
                log.warn({ err: String(idxErr) }, '[GoalExecutor] Failed to write index.md (non-fatal)');
            }

            this.broadcastGoalEvent(state.status === 'completed' ? 'goal:completed' : 'goal:failed', {
                execution_id: executionId,
                result
            });

            // Store structured outcome in vector memory + domain-tagged SQL table for future recall
            try {
                const { memoryManager } = await import('../memory/MemoryManager');
                const success = state.status === 'completed';
                const toolsUsed = [...new Set(state.completed_actions.map(a => a.tool_used))].join(', ');
                const blockedTools = state.error_history
                    .filter(e => e.error.includes('CAPTCHA') || e.error.includes('PERMANENTLY SKIP') || e.error.includes('blocked'))
                    .map(e => e.context)
                    .filter(Boolean);
                const whatWorked = state.execution_journal
                    .filter(e => e.includes('→ SUCCESS'))
                    .slice(-3)
                    .map(e => e.split('\n')[0])
                    .join('; ');
                const failureCause = !success
                    ? state.execution_journal.filter(e => e.includes('→ FAILED')).slice(-1)[0] || null
                    : null;
                const workingApproach = success
                    ? state.execution_journal.slice(-5).join('\n')
                    : null;

                const memoryEntry = {
                    goal_summary: state.goal.description.substring(0, 100),
                    outcome: success ? 'success' : 'failure',
                    iterations_used: state.current_iteration,
                    tools_used: toolsUsed,
                    what_worked: whatWorked || null,
                    failure_cause: failureCause,
                    working_approach: workingApproach,
                    artifacts: state.artifacts.slice(0, 5).join(', ') || null
                };

                await memoryManager.storeEvent({
                    event_type: success ? 'learning' : 'decision',
                    event_text: `Goal ${success ? 'COMPLETED' : 'FAILED'}: ${JSON.stringify(memoryEntry)}`,
                    context: { goal: state.goal.description, artifacts: state.artifacts, iterations: state.current_iteration }
                });

                // Write to goal_outcomes + goal_outcome_tags for deterministic domain-tag lookup
                const { db } = await import('../database/index');
                const outcomeId = `outcome_${executionId}`;
                await db.run(
                    `INSERT OR REPLACE INTO goal_outcomes
                     (id, goal_text, status, failure_cause, working_approach, blocked_tools, iterations_used)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        outcomeId,
                        state.goal.description.substring(0, 500),
                        success ? 'completed' : 'failed',
                        failureCause?.substring(0, 500) ?? null,
                        workingApproach?.substring(0, 1000) ?? null,
                        blockedTools.length > 0 ? JSON.stringify(blockedTools) : null,
                        state.current_iteration
                    ]
                );
                // Extract domain tags from goal text — uppercase words ≥ 3 chars that look domain-specific
                const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will',
                    'not', 'use', 'get', 'set', 'run', 'can', 'are', 'was', 'had', 'its']);
                const tags = [...new Set(
                    state.goal.description
                        .toLowerCase()
                        .replace(/[^a-z0-9\s]/g, ' ')
                        .split(/\s+/)
                        .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
                        .slice(0, 15) // cap at 15 tags
                )];
                for (const tag of tags) {
                    await db.run(
                        `INSERT OR IGNORE INTO goal_outcome_tags (outcome_id, tag) VALUES (?, ?)`,
                        [outcomeId, tag]
                    );
                }
            } catch (memErr: any) {
                log.warn({ err: String(memErr) }, '[GoalExecutor] Failed to store memory event (non-critical)');
            }

            log.info(`[GoalExecutor] Execution ${executionId} finished: ${state.status}`);
            log.info(`[GoalExecutor] Progress: ${state.progress_percent}%, Iterations: ${state.current_iteration}`);

            // Extension hook: after_execution
            await extensionHooks.emit('after_execution', { state, result });

            // Unregister from AgentBus — execution is complete
            agentBus.unregisterAgent(executionId);

            // Only learn a skill if the run meets the quality gate:
            //   1. score === 100%  — partial or lucky passes teach wrong strategies
            //   2. iterations < 60% of budget  — efficient solutions only
            //   3. no tool hallucinations  — hallucinated tool calls in history = broken skill
            // Without this gate, broken skills (wrong paths, stale screenshots, wrong item count)
            // get injected into future runs and actively make model-independence WORSE.
            if (state.status === 'completed' && state.progress_percent >= 100) {
                const iterBudgetPct = state.current_iteration / Math.max(state.max_iterations || 15, 1);
                const hadToolHallucinations = state.error_history.some(e =>
                    e.error?.includes('Unknown tool') || e.error?.includes('hallucinated')
                );
                const hadStaleArtifact = state.error_history.some(e =>
                    e.error?.includes('STALE') || e.context === 'stale_file_detected'
                );
                const qualityGatePassed = iterBudgetPct < 0.60 && !hadToolHallucinations && !hadStaleArtifact;

                if (qualityGatePassed) {
                    import('../services/SkillLearner').then(({ skillLearner }) => {
                        skillLearner.learnFromInstruction(state.goal.description)
                            .then(skill => { if (skill) log.info({ skill: skill.name }, '[GoalExecutor] Skill learned from goal'); })
                            .catch(() => { /* non-fatal */ });
                    }).catch(() => { });
                } else {
                    log.info(`[GoalExecutor] Skill quality gate: skip save (iterBudget=${Math.round(iterBudgetPct * 100)}%, toolHalluc=${hadToolHallucinations}, staleArtifact=${hadStaleArtifact})`);
                }
            }

            // Attach search provenance so completion message can warn user if web data was sparse
            result.searchMetrics = { ...this.reasoner.searchMetrics };

            return result;

        } catch (error) {
            log.error({ err: String(error) }, '[GoalExecutor] Fatal error');

            const state = this.executions.get(executionId);
            if (state) {
                state.status = 'failed';
                await this.updateExecution(state);
            }

            this.broadcastGoalEvent('goal:failed', { execution_id: executionId, error: String(error) });
            agentBus.unregisterAgent(executionId);

            throw error;
        } finally {
            // Clean up the per-goal sandbox container after execution ends (success, failure, or cancel).
            // Each goal gets a unique container so there's nothing to preserve between runs.
            const sessionId = this.engine.containerSessionId;
            if (sessionId) {
                containerSessionManager.destroySession(sessionId).catch(() => { /* non-fatal */ });
            }
        }
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    /**
     * Verify that every path in state.artifacts still exists on the filesystem.
     * Removes stale paths in-place so the agent doesn't assume work was done
     * that was lost when the container was replaced (e.g. after model escalation
     * or a crash-resume cycle).
     *
     * Called when the agent re-enters execution with a non-empty artifacts list
     * to avoid re-doing work that truly persisted, but stop hallucinating that
     * work is done when the files are gone.
     */
    private async pruneStaleArtifacts(state: ExecutionState, execLog: { warn: (...a: any[]) => void; info: (...a: any[]) => void }): Promise<void> {
        if (state.artifacts.length === 0) return;

        const surviving: string[] = [];
        for (const filePath of state.artifacts) {
            try {
                await mcpManager.callTool('filesystem', 'get_file_info', { path: filePath });
                surviving.push(filePath);
            } catch {
                execLog.warn({ path: filePath }, '[GoalExecutor] Artifact no longer exists — removed from state.artifacts');
                const err = agentError(`Artifact missing after resume: ${filePath}`, 'artifact_missing', { path: filePath });
                state.error_history.push({
                    iteration: state.current_iteration,
                    error: err.message,
                    context: 'artifact_stale',
                    recovery_attempted: false,
                    recovery_successful: false,
                    timestamp: new Date(),
                });
            }
        }
        const removed = state.artifacts.length - surviving.length;
        if (removed > 0) {
            execLog.info(`[GoalExecutor] pruneStaleArtifacts: removed ${removed} stale artifact(s), ${surviving.length} surviving`);
            state.artifacts = surviving;
        }
    }

    private createMilestones(goal: GoalDefinition): Milestone[] {
        if (goal.suggested_milestones && goal.suggested_milestones.length > 0) {
            return goal.suggested_milestones.map((desc, i) => ({
                id: generateId('milestone'),
                description: desc,
                status: 'pending' as const,
                criteria_ids: [],
                completed_at: undefined
            }));
        }

        return [{
            id: generateId('milestone'),
            description: 'Complete the task',
            status: 'pending' as const,
            criteria_ids: goal.success_criteria.map(c => c.id)
        }];
    }

    /**
     * Append a one-or-two-line entry to the execution journal after each action.
     * FAILED entries include full error detail; SUCCESS entries are kept brief.
     */
    private appendToJournal(state: ExecutionState, actionResult: ActionResult): void {
        if (!state.execution_journal) state.execution_journal = [];

        const iter = `[Iter ${actionResult.iteration}]`;
        const argsShort = JSON.stringify(actionResult.args || {}).substring(0, 80);
        const status = actionResult.success ? 'SUCCESS' : 'FAILED';
        let entry = `${iter} ${actionResult.tool_used}(${argsShort}) → ${status}`;

        const r = actionResult.result;

        if (actionResult.tool_used === 'write_file' && actionResult.args?.content) {
            // Show script preview so LLM knows what code it actually wrote
            const preview = String(actionResult.args.content).substring(0, 150).replace(/\n/g, ' ');
            entry += `\n         [script preview]: ${preview}`;
        }

        if (actionResult.tool_used === 'run_command' && r && typeof r === 'object') {
            const stdout = (r.stdout || '').trim();
            const stderr = (r.stderr || '').trim();
            if (!actionResult.success) {
                // Fast-exit detection: very short, no output → import/module error
                if (actionResult.duration_ms < 1500 && !stdout && !stderr) {
                    entry += `\n         [WARN] Fast exit — likely import error or module not found`;
                } else {
                    const errText = (stderr || stdout).substring(0, 250);
                    if (errText) entry += `\n         ${errText}`;
                }
            } else {
                const outText = (stdout || stderr).substring(0, 120);
                if (outText) entry += `\n         [out]: ${outText}`;
            }
        }

        state.execution_journal.push(entry);
    }

    private buildResult(state: ExecutionState, startTime: number): GoalExecutionResult {
        const passed = state.goal.success_criteria.filter(c => c.status === 'passed');
        const failed = state.goal.success_criteria.filter(c => c.status === 'failed');

        // ── PRIMARY OUTPUT FILE ─────────────────────────────────────────────
        // Find the most useful deliverable: last passed file_exists criterion.
        // Prefer text/document files (md, txt, json, html, csv) over scripts.
        const TEXT_EXTS = /\.(md|txt|json|html|csv|yaml|yml|xml|rst)$/i;
        const passedFileCriteria = state.goal.success_criteria.filter(
            c => c.status === 'passed' && c.type === 'file_exists' && c.config.path
        );
        // Sort so text-doc files come first
        passedFileCriteria.sort((a, b) => {
            const aIsText = TEXT_EXTS.test(a.config.path || '');
            const bIsText = TEXT_EXTS.test(b.config.path || '');
            return (bIsText ? 1 : 0) - (aIsText ? 1 : 0);
        });

        let primary_file_path: string | undefined;
        let file_content_preview: string | undefined;
        let final_answer: string | undefined;

        if (passedFileCriteria.length > 0) {
            const workspaceRoot = mcpManager.getWorkspace() || '/workspace';
            const relPath = passedFileCriteria[0].config.path as string;
            const absPath = relPath.startsWith('/') ? relPath : `${workspaceRoot}/${relPath}`;
            primary_file_path = relPath;

            // Synchronously attempt to read — mcpManager.callTool is async so we
            // schedule it and capture asynchronously, then fall back to the journal.
            // We set a flag so the async read can patch the result before broadcast.
            try {
                // We use a fire-and-read pattern: read the file content right now
                // using the file system module directly (we're in the same Node process).
                const MAX_PREVIEW = 8192; // 8 KB cap
                if (fs.existsSync(absPath)) {
                    const raw = fs.readFileSync(absPath, 'utf8');
                    file_content_preview = raw.length > MAX_PREVIEW
                        ? raw.substring(0, MAX_PREVIEW) + '\n\n… *(truncated — see full file)*'
                        : raw;
                    final_answer = file_content_preview;
                }
            } catch (readErr: any) {
                log.warn({ err: String(readErr) }, `[GoalExecutor] Could not read primary output file for preview`);
            }
        }

        // Fallback chain if file read failed
        if (!final_answer) {
            if (state.completed_actions.length > 0) {
                const lastActions = state.completed_actions.slice(-5);
                const resultParts: string[] = [];
                for (const action of lastActions) {
                    const r = action.result;
                    const text = typeof r === 'string' ? r
                        : typeof r?.content === 'string' ? r.content
                            : typeof r?.text === 'string' ? r.text
                                : typeof r?.output === 'string' ? r.output
                                    : typeof r?.result === 'string' ? r.result
                                        : null;
                    if (text && text.length > 10) resultParts.push(text);
                }
                if (resultParts.length > 0) {
                    final_answer = resultParts.join('\n\n---\n\n');
                }
            }
            // Last fallback: last journal entries
            if (!final_answer && state.execution_journal.length > 0) {
                final_answer = state.execution_journal.slice(-5).join('\n');
            }
        }

        return {
            execution_id: state.execution_id,
            status: state.status === 'completed' ? 'completed' :
                state.status === 'cancelled' ? 'cancelled' :
                    state.current_iteration >= state.max_iterations ? 'timeout' : 'failed',
            goal: state.goal,
            final_state: state,
            final_answer,
            primary_file_path,
            file_content_preview,
            summary: {
                total_iterations: state.current_iteration,
                strategy_changes: state.strategy_changes,
                artifacts_created: state.artifacts,
                criteria_passed: passed.length,
                criteria_failed: failed.length,
                progress_percent: state.progress_percent,
                duration_ms: Date.now() - startTime
            },
            failure_reason: state.status === 'failed'
                ? state.error_history[state.error_history.length - 1]?.error || 'Unknown'
                : undefined,
            suggestions: failed.length > 0
                ? [`${failed.length} criteria not met`, ...failed.map(f => `- ${f.type}: ${JSON.stringify(f.config)}`)]
                : undefined
        };
    }

    private emitProgress(executionId: string, status: string, message: string, data?: any): void {
        this.broadcastGoalEvent('goal:progress', {
            execution_id: executionId,
            status,
            message,
            ...data
        });
    }

    // ========================================================================
    // CONTROL METHODS
    // ========================================================================

    pause(executionId: string): boolean {
        const state = this.executions.get(executionId);
        if (state && state.status === 'executing') {
            state.status = 'paused';
            this.broadcastGoalEvent('goal:paused', { execution_id: executionId });
            return true;
        }
        return false;
    }

    resume(executionId: string): boolean {
        const state = this.executions.get(executionId);
        if (state && state.status === 'paused') {
            state.status = 'executing';
            this.broadcastGoalEvent('goal:resumed', { execution_id: executionId });
            return true;
        }
        return false;
    }

    cancel(executionId: string): boolean {
        const state = this.executions.get(executionId);
        if (state) {
            state.status = 'cancelled';
            agentPool.abort(executionId);   // signal child agents to stop
            this.broadcastGoalEvent('goal:cancelled', { execution_id: executionId });
            return true;
        }
        return false;
    }

    getStatus(executionId: string): ExecutionState | null {
        return this.executions.get(executionId) || null;
    }

    /** Returns all in-memory executions — used by goal:request_sync handler. */
    getActiveExecutions(): Map<string, ExecutionState> {
        return this.executions;
    }

    // ========================================================================
    // DATABASE METHODS
    // ========================================================================

    /**
     * Sanitize ExecutionState before serialization to DB.
     * secureContext holds credentials — must never be persisted.
     */
    private sanitizeStateForDb(state: ExecutionState): ExecutionState {
        if (!state.secureContext) return state;
        const { secureContext: _dropped, ...safe } = state as any;
        return safe as ExecutionState;
    }

    private async saveExecution(state: ExecutionState, userId: string, request: string): Promise<void> {
        try {
            const safeState = this.sanitizeStateForDb(state);
            await db.run(
                `INSERT INTO goal_executions
                 (id, user_id, request, goal, state, status, iterations, max_iterations, artifacts)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    state.execution_id,
                    userId,
                    request,
                    JSON.stringify(state.goal),
                    JSON.stringify(safeState),
                    state.status,
                    state.current_iteration,
                    state.max_iterations,
                    JSON.stringify(state.artifacts)
                ]
            );
        } catch (error) {
            log.error({ err: String(error) }, '[GoalExecutor] Failed to save execution');
        }
    }

    private async updateExecution(state: ExecutionState): Promise<void> {
        try {
            const safeState = this.sanitizeStateForDb(state);
            await db.run(
                `UPDATE goal_executions SET
                 state = ?, status = ?, iterations = ?, artifacts = ?,
                 completed_at = ?
                 WHERE id = ?`,
                [
                    JSON.stringify(safeState),
                    state.status,
                    state.current_iteration,
                    JSON.stringify(state.artifacts),
                    state.completed_at?.toISOString() || null,
                    state.execution_id
                ]
            );
        } catch (error) {
            log.error({ err: String(error) }, '[GoalExecutor] Failed to update execution');
        }
    }
}
// Singleton instance
export const goalOrientedExecutor = new GoalOrientedExecutor();
