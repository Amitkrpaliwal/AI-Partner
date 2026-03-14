// ============================================================================
// GOAL-ORIENTED EXECUTION TYPES
// ============================================================================

/**
 * Success Criterion - How we verify goal completion
 */
export interface SuccessCriterion {
    id: string;
    type: 'file_exists' | 'file_contains' | 'code_compiles' |
    'tests_pass' | 'output_matches' | 'custom' | 'llm_evaluates';
    config: {
        path?: string;              // For file-based checks
        pattern?: string;           // Regex pattern to match
        command?: string;           // For custom validation
        expected?: string;          // Expected output
    };
    weight: number;                 // Importance (0-1)
    required: boolean;              // Must pass for goal completion
    status: 'pending' | 'passed' | 'failed';
    lastChecked?: Date;
    message?: string;               // Validation result message
}

/**
 * Goal Definition - What the user actually wants
 */
export interface GoalDefinition {
    id: string;
    description: string;            // Natural language goal
    success_criteria: SuccessCriterion[];
    acceptance_test?: string;       // Human-readable "done" description
    priority: 'low' | 'medium' | 'high';
    estimated_complexity: number;   // 1-10 scale
    suggested_milestones?: string[];
    /**
     * Tool categories the goal REQUIRES to succeed.
     * Set by GoalExtractor based on goal type. Used by GoalValidator to
     * detect tool-evasion (e.g. browser goal completed without any browser tool).
     * Values: 'browser' | 'shell' | 'file' | 'web_search' | 'messaging'
     */
    required_tool_types?: string[];
}

/**
 * Milestone - High-level progress marker
 */
export interface Milestone {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed';
    criteria_ids: string[];         // Which criteria belong to this milestone
    completed_at?: Date;
}

/**
 * Action Result - What happened on each iteration
 */
export interface ActionResult {
    iteration: number;
    action: string;
    tool_used: string;
    args: any;
    result: any;
    success: boolean;
    artifacts_created: string[];
    progress_made: boolean;         // Did this move us closer to goal?
    duration_ms: number;
    timestamp: Date;
}

/**
 * Error Record - For learning from failures
 */
export interface ErrorRecord {
    iteration: number;
    error: string;
    context: string;
    recovery_attempted: boolean;
    recovery_successful: boolean;
    timestamp: Date;
}

/**
 * Execution State - Current progress
 */
export interface ExecutionState {
    execution_id: string;
    goal: GoalDefinition;
    current_iteration: number;
    max_iterations: number;
    status: 'planning' | 'executing' | 'validating' |
    'replanning' | 'completed' | 'failed' | 'paused' | 'cancelled';

    // Progress tracking
    milestones: Milestone[];
    completed_actions: ActionResult[];
    artifacts: string[];
    progress_percent: number;

    // Adaptation state
    stuck_count: number;            // Consecutive non-progress iterations
    consecutive_read_only: number;  // Consecutive iterations with only read-only tools
    strategy_changes: number;       // Times we've re-planned
    error_history: ErrorRecord[];
    /** Tracks how many times each file path has been read since last write/run_command success */
    file_read_counts: Record<string, number>;
    current_strategy?: string;

    // Multi-agent delegation budget
    delegation_count: number;       // Sub-agents spawned so far this execution
    max_delegations: number;        // Cap (0 = delegation disabled)

    // Timing
    started_at: Date;
    last_progress_at: Date;
    completed_at?: Date;

    /** Conversation history that triggered this goal — used to resolve ambiguous pronouns like "it", "this" */
    conversationContext?: ConversationMessage[];

    /** Running log of what was tried each iteration — gives LLM within-execution memory */
    execution_journal: string[];

    /** Per-goal output directory (relative to workspace root, e.g. "india-ev-market-2026") */
    outputDir: string;

    /** Number of times the human took browser control and released it — if > 0 and still stuck,
     *  scripts should NOT be tried on the same blocked site; agent should give up. */
    human_browser_help_used: number;

    /** Number of times the execution has escalated to a larger model (capped at max_escalations) */
    escalation_count: number;

    /** Maximum model escalations allowed per execution (default 2) */
    max_escalations: number;

    /** Screenshot captured by browser_screenshot, queued for visual analysis in the next LLM reason step.
     *  Cleared after it is consumed by reasonAndDecide(). */
    pending_screenshot?: { base64: string; mimeType: string; savedPath?: string };

    /**
     * Credentials/sensitive data collected via pre-flight request_user_input.
     * Injected into every iteration prompt as [SECURE_CONTEXT] but NEVER written
     * to DB, logs, or conversation history. Dropped when execution ends.
     */
    secureContext?: string;

    /**
     * Artifact pinning (§3.1): 60-char summaries of written structured files.
     * Key = relative path, Value = summary string (≤60 chars).
     * Always injected at the top of every LLM call so the agent remembers what it created.
     */
    pinned_artifacts: Record<string, string>;

    /**
     * Within-run URL cache (Phase 3): URLs fetched this execution with their content hash.
     * web_fetch / browser_navigate to an already-visited URL returns cached content.
     * Key = url, Value = short content hash for validation.
     */
    visited_urls: Record<string, string>;

    /**
     * Per-iteration performance metrics (Fix 5.2).
     * Populated at the end of every ReAct loop iteration.
     * Exposed in GET /api/autonomous/goal/:id so dashboards can show iteration latency.
     */
    timing_metrics: Array<{
        iteration: number;
        duration_ms: number;
        tool: string;
        success: boolean;
    }>;

    /**
     * Consecutive-failure streak per criterion ID (A3 fix).
     * Tracks how many iterations in a row each required criterion has failed.
     * When streak >= 2, stuck-criterion detection injects a targeted recovery hint.
     * Not persisted to checkpoint — resets naturally on execution restart.
     * Key = criterion.id, Value = consecutive fail count.
     */
    criterionFailStreak: Record<string, number>;
}

/**
 * Execution Options
 */
export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface GoalExecutionOptions {
    max_iterations?: number;        // Default: adaptive (10-100)
    max_stuck_iterations?: number;  // Before re-planning (default: 3)
    max_strategy_changes?: number;  // Before giving up (default: 3)
    timeout_ms?: number;            // Overall timeout
    enable_hitl?: boolean;          // Human approval for risky actions
    validation_interval?: number;   // Check criteria every N iterations (default: 1)
    enableNetwork?: boolean;        // Allow network access in container (default: false)
    /** Recent conversation messages to give the goal executor context about what was discussed */
    conversationContext?: ConversationMessage[];
    /** Agent profile to use: 'default' | 'researcher' | 'coder' (auto-detected if omitted) */
    profile?: string;
    /** Per-call approval mode override — wins over config if provided */
    approvalMode?: 'none' | 'script' | 'all';
    /** HTTP request ID for tracing — binds goal execution logs to the originating request */
    requestId?: string;
    /** The original chat session conversation ID to bind events and final output back to the chat history */
    conversationId?: string;
    /** Force a specific output directory slug (used by retry to reuse the same folder) */
    outputDirOverride?: string;
}

/**
 * Goal Execution Result
 */
export interface GoalExecutionResult {
    execution_id: string;
    status: 'completed' | 'failed' | 'cancelled' | 'timeout';
    goal: GoalDefinition;
    final_state: ExecutionState;
    /** Human-readable result text — shown in the Goal panel after completion */
    final_answer?: string;
    /** Path to the primary output file (the most useful deliverable) */
    primary_file_path?: string;
    /** First ~8 KB of the primary output file, for inline display in the panel */
    file_content_preview?: string;
    summary: {
        total_iterations: number;
        strategy_changes: number;
        artifacts_created: string[];
        criteria_passed: number;
        criteria_failed: number;
        progress_percent: number;
        duration_ms: number;
    };
    failure_reason?: string;
    suggestions?: string[];
    searchMetrics?: any;
}

/**
 * Validation Result
 */
export interface ValidationResult {
    complete: boolean;
    passed: SuccessCriterion[];
    failed: SuccessCriterion[];
    score: number;                  // 0-100 weighted score
    details: {
        criterion_id: string;
        passed: boolean;
        message: string;
    }[];
}

/**
 * State Assessment - LLM analysis of current progress
 */
export interface StateAssessment {
    current_progress_percent: number;
    blocking_issues: string[];
    missing_for_goal: string[];
    suggested_next_action: {
        tool: string;
        args: any;
        reasoning: string;
    };
    should_replan: boolean;
    replan_reason?: string;
}

/**
 * Re-planning Result
 */
export interface ReplanResult {
    new_strategy: string;
    first_action: {
        tool: string;
        args: any;
    };
    why_different: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate adaptive max iterations based on goal complexity.
 * Simple goals  (complexity 1-3): 10 iterations  — fast fail if structurally broken
 * Medium goals  (complexity 4-6): 20 iterations  — enough for multi-step data + file tasks
 * Complex goals (complexity 7-10): 39 iterations — deep research, multi-agent, browser tasks
 */
export function calculateMaxIterations(complexity: number, _criteriaCount: number): number {
    if (complexity <= 3) return 10;
    if (complexity <= 6) return 20;
    return 39;
}

/**
 * Generate unique ID for goals/criteria
 */
export function generateId(prefix: string = 'id'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
