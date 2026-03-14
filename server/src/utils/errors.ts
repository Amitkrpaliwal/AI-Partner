/**
 * Structured error taxonomy for the AI Partner agent system.
 *
 * Phase 5.1 — Observability: gives every agent failure a typed category
 * so callers (GoalOrientedExecutor, ReActReasoner, ExecutionEngine) can
 * produce user-facing messages and filter logs without string-matching.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ErrorCategory — coarse-grained classification
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCategory =
    // LLM / reasoning failures
    | 'llm_unavailable'       // No adapter configured or all adapters down
    | 'llm_parse_failure'     // generateJSON returned null / failed to parse
    | 'llm_rate_limit'        // 429 / quota exhausted

    // Tool / MCP execution failures
    | 'tool_not_found'        // Tool name not in MCP registry
    | 'tool_execution'        // MCP tool returned isError=true
    | 'tool_timeout'          // Tool call exceeded timeout

    // Script execution failures
    | 'script_runtime_missing'  // Python/Node.js not found
    | 'script_syntax'           // SyntaxError / IndentationError in generated script
    | 'script_dependency'       // ImportError / ModuleNotFoundError
    | 'script_permission'       // EACCES / permission denied on write

    // Network / external service failures
    | 'network_blocked'       // Cloudflare, CAPTCHA, 403 Forbidden, bot-detected
    | 'network_timeout'       // HTTP timeout / connection refused
    | 'network_rate_limit'    // 429 from external API

    // Docker / sandbox failures
    | 'docker_daemon_down'    // Docker daemon not running
    | 'docker_image_missing'  // Image not found / pull denied
    | 'docker_resource_limit' // OOM / no space left

    // Goal execution loop failures
    | 'goal_timeout'          // Wall-clock execution timeout (Fix 1.3)
    | 'goal_stuck'            // Stuck iterations exhausted without progress
    | 'goal_cancelled'        // Explicitly cancelled by user

    // Persistence / IO failures
    | 'checkpoint_failed'     // saveCheckpoint threw (non-fatal — Fix 1.2)
    | 'artifact_missing'      // Expected artifact not found on checkpoint restore

    // Catch-all
    | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// AgentError — enriched Error subclass
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentErrorOptions {
    /** Typed category for routing / logging */
    category: ErrorCategory;
    /** Freeform context: tool name, file path, iteration number, etc. */
    context?: Record<string, unknown>;
    /** Original error that caused this one */
    cause?: Error | unknown;
}

export class AgentError extends Error {
    readonly category: ErrorCategory;
    readonly context: Record<string, unknown>;
    override readonly cause?: Error | unknown;

    constructor(message: string, options: AgentErrorOptions) {
        super(message);
        this.name = 'AgentError';
        this.category = options.category;
        this.context = options.context ?? {};
        this.cause = options.cause;

        // Preserve V8 stack trace from the original cause when available
        if (options.cause instanceof Error && options.cause.stack) {
            this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
        }
    }

    /** Serialize to a plain object suitable for JSON logs */
    toLogObject(): Record<string, unknown> {
        return {
            name: this.name,
            message: this.message,
            category: this.category,
            context: this.context,
            cause: this.cause instanceof Error ? this.cause.message : String(this.cause ?? ''),
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers — keep call sites terse
// ─────────────────────────────────────────────────────────────────────────────

export function agentError(
    message: string,
    category: ErrorCategory,
    context?: Record<string, unknown>,
    cause?: Error | unknown
): AgentError {
    return new AgentError(message, { category, context, cause });
}

/**
 * Derive an ErrorCategory from a raw error string.
 * Complements `classifyErrorSeverity` in SelfCorrector — this one returns
 * a category (for routing) rather than a severity (for stuck-count logic).
 */
export function categorizeError(errorText: string): ErrorCategory {
    const t = errorText.toLowerCase();

    if (t.includes('modulenotfounderror') || t.includes('importerror') ||
        t.includes('no module named') || t.includes('cannot find module'))
        return 'script_dependency';

    if (t.includes('syntaxerror') || t.includes('indentationerror'))
        return 'script_syntax';

    if (t.includes('eacces') || t.includes('permission denied'))
        return 'script_permission';

    if (t.includes('was not found') || t.includes('is not recognized') ||
        t.includes('command not found') && (t.includes('python') || t.includes('node')))
        return 'script_runtime_missing';

    if (t.includes('captcha') || t.includes('cloudflare') ||
        t.includes('403 forbidden') || t.includes('bot detected') ||
        t.includes('access denied'))
        return 'network_blocked';

    // Check goal-specific timeout BEFORE generic network timeout — "absolute timeout"
    // would otherwise match the generic 'timeout' check below.
    if (t.includes('absolute timeout') || t.includes('execution timeout'))
        return 'goal_timeout';

    if (t.includes('timeout') || t.includes('connection refused') ||
        t.includes('econnrefused'))
        return 'network_timeout';

    if (t.includes('rate limit') || t.includes('429') || t.includes('too many requests'))
        return 'network_rate_limit';

    if (t.includes('cannot connect to the docker daemon') ||
        t.includes('is the docker daemon running'))
        return 'docker_daemon_down';

    if (t.includes('no such image') || t.includes('manifest unknown'))
        return 'docker_image_missing';

    if (t.includes('out of memory') || t.includes('oom') || t.includes('no space left'))
        return 'docker_resource_limit';

    if (t.includes('stuck') || t.includes('exhausted replans'))
        return 'goal_stuck';

    return 'unknown';
}
