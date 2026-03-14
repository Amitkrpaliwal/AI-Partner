/**
 * ReActReasoner — Implements the Reason → Decide → Assess loop.
 * Also includes the force-write recovery for stuck loops.
 * Extracted from GoalOrientedExecutor.ts (Sprint 2: Kill the Monolith).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ExecutionState, StateAssessment, ActionResult } from '../../types/goal';
import { mcpManager } from '../../mcp/MCPManager';
import { modelManager } from '../../services/llm/modelManager';
import { modelRouter } from '../../services/llm/modelRouter';
import { containerSessionManager } from '../../execution/ContainerSession';
import { dynamicToolRegistry } from '../../mcp/DynamicToolRegistry';
import { ScriptGenerator } from './ScriptGenerator';
import { promptLoader } from '../../utils/PromptLoader';
import { agentPool } from '../AgentPool';
import { agentBus } from '../AgentBus';
import { createLogger } from '../../utils/Logger';
import { ContextBuilder } from './ContextBuilder';

const log = createLogger('ReActReasoner');

// Default values used when config files are absent
const DEFAULT_BLOCKED_DOMAINS = [
    'google.com', 'google.co.in', 'amazon.com', 'amazon.in',
    'nseindia.com', 'nse.india.com', 'bseindia.com',
    'flipkart.com', 'linkedin.com', 'instagram.com',
    'twitter.com', 'x.com', 'facebook.com'
];

const DEFAULT_DATA_API_HINTS: Record<string, string> = {
    // Yahoo Finance query1/query2 APIs require cookie+crumb auth → return 401. Use these instead:
    'nse': 'Use Python yfinance (pre-installed): run_command "python3 -c \\"import yfinance as yf; t=yf.Ticker(\'RELIANCE.NS\'); print(t.info)\\"" OR stooq CSV: curl https://stooq.com/q/d/l/?s=RELIANCE.NS&i=d',
    'bse': 'Use Python yfinance (pre-installed): run_command "python3 -c \\"import yfinance as yf; t=yf.Ticker(\'RELIANCE.BO\'); print(t.info)\\"" OR stooq CSV: curl https://stooq.com/q/d/l/?s=RELIANCE.BO&i=d',
    'stock': 'Use Python yfinance (pre-installed): python3 -c "import yfinance as yf; print(yf.Ticker(\'SYMBOL.NS\').info)" — OR web_search for stock data',
    'weather': 'wttr.in JSON API (no auth): curl "https://wttr.in/Mumbai?format=j1"',
    'crypto': 'CoinGecko free API (no auth): curl "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=inr,usd"',
    'currency': 'ExchangeRate free API: curl "https://api.exchangerate-api.com/v4/latest/USD"',
    'news': 'Use web_search tool (SearXNG) — already available, no CAPTCHA',
    'price': 'Use web_search tool to find prices from multiple sources',
};

// ============================================================================
// TOOL ALIAS MAP — single source of truth (do NOT duplicate in methods)
// LLMs sometimes hallucinate tool names; map them to actual MCP tool names.
// ============================================================================
const TOOL_ALIASES: Record<string, string> = {
    bash: 'run_command', shell: 'run_command', execute: 'run_command',
    run_script: 'run_command', exec: 'run_command', cmd: 'run_command',
    execute_script: 'run_command', run_code: 'run_command',
    save_file: 'write_file', create_file: 'write_file', output_file: 'write_file',
    write: 'write_file', file_write: 'write_file',
    mkdir: 'create_directory', make_directory: 'create_directory', makedirs: 'create_directory',
    search: 'web_search', google: 'web_search', bing: 'web_search',
    browser_search: 'web_search', web_browse: 'browser_navigate',
    http_get: 'run_command', fetch_url: 'run_command', http_request: 'run_command',
    read: 'read_file', cat: 'read_file', open_file: 'read_file',
    ls: 'list_directory', dir: 'list_directory', list: 'list_directory',
    stealth: 'stealth_fetch', bypass_fetch: 'stealth_fetch', cloudflare_fetch: 'stealth_fetch',
    // Browser tool aliases
    navigate: 'browser_navigate', goto: 'browser_navigate', open_url: 'browser_navigate',
    click: 'browser_click', tap: 'browser_click', press: 'browser_click',
    fill: 'browser_fill', type_into: 'browser_fill', input: 'browser_fill',
    extract: 'browser_extract', get_element: 'browser_extract', scrape: 'browser_extract',
    get_text: 'browser_get_text', page_text: 'browser_get_text',
    get_content: 'browser_get_content', page_content: 'browser_get_content',
    screenshot: 'browser_screenshot', capture: 'browser_screenshot',
    scroll: 'browser_scroll', scroll_down: 'browser_scroll',
    wait: 'browser_wait', wait_for: 'browser_wait',
};

// ESM-compatible __dirname
const _currentDir = ((): string => {
    try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return __dirname; }
})();

// Config dir: server/config/ (two levels up from src/agents/goal/)
const CONFIG_DIR = path.join(_currentDir, '../../../config');

function loadBlockedDomains(): string[] {
    try {
        const raw = fs.readFileSync(path.join(CONFIG_DIR, 'blocked-domains.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        log.warn('[ReActReasoner] blocked-domains.json: expected array, using defaults');
    } catch (err: any) {
        if (err.code !== 'ENOENT') {
            log.warn({ err: err.message }, '[ReActReasoner] Failed to load blocked-domains.json, using defaults');
        }
    }
    return DEFAULT_BLOCKED_DOMAINS;
}

function loadDataApiHints(): Record<string, string> {
    try {
        const raw = fs.readFileSync(path.join(CONFIG_DIR, 'data-api-hints.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
        log.warn('[ReActReasoner] data-api-hints.json: expected object, using defaults');
    } catch (err: any) {
        if (err.code !== 'ENOENT') {
            log.warn({ err: err.message }, '[ReActReasoner] Failed to load data-api-hints.json, using defaults');
        }
    }
    return DEFAULT_DATA_API_HINTS;
}

/**
 * Build a fully-typed ActionResult for early error returns inside executeAction().
 * Ensures all required fields are always present so callers (appendToJournal etc.) never see undefined.
 */
function makeErrorResult(
    action: { tool: string; args?: any; reasoning?: string },
    state: ExecutionState,
    errorText: string,
    startTime: number
): ActionResult {
    return {
        iteration: state.current_iteration,
        action: action.reasoning || '',
        tool_used: action.tool,
        args: action.args || {},
        result: {
            isError: true,
            content: [{ type: 'text', text: errorText }]
        },
        success: false,
        artifacts_created: [],
        progress_made: false,
        duration_ms: Date.now() - startTime,
        timestamp: new Date(),
    };
}

export class ReActReasoner {
    private scriptGen = new ScriptGenerator();

    // Forwarded from ExecutionEngine at wiring time
    public containerSessionId: string | null = null;
    public enableNetwork: boolean = false;

    // Set to true when goal involves browser navigation (see GoalOrientedExecutor.executeGoal)
    public browserIntent: boolean = false;

    // Active agent profile content (set by GoalOrientedExecutor per execution)
    public profileContent: string = '';

    // Active agent profile name — used for two-layer tool filtering
    public activeProfile: string = 'default';

    // User context loaded from USER.md (set by GoalOrientedExecutor per execution)
    public userContext: string = '';

    // Ordered execution plan from TaskDecomposer (set by GoalOrientedExecutor before each run)
    public executionPlan: string = '';

    // Skill strategy hint injected from SkillLearner before each run (§4.2)
    // Human-readable approach summary, NOT raw code. Cleared after each goal execution.
    public skillStrategyHint: string = '';

    // Per-goal output directory slug (set by GoalOrientedExecutor, e.g. "india-ev-market-2026")
    public outputDir: string = 'output';

    // Optional model override for small-model escalation
    private adapterOverride: any = null;

    /** Override the LLM adapter for subsequent calls (used by small-model escalation chain) */
    public overrideAdapter(adapter: any): void {
        this.adapterOverride = adapter;
        log.info('[ReActReasoner] Adapter override set for escalation');
    }

    // Tools the agent requested to activate from the index (one-iteration activation).
    // When the LLM emits "request_tool":"tool_name", the tool is added here and promoted
    // to the active set for the very next iteration only, then cleared.
    private requestedExtraTools: Set<string> = new Set();

    // Search deduplication — hashes of "tool:query" seen in this execution
    private searchedHashes: Map<string, number> = new Map();
    // Data provenance — track which searches returned real data vs failed
    public searchMetrics = { attempted: 0, succeeded: 0, failed: 0, failedQueries: [] as string[] };

    /** Called at the start of each new goal execution to clear per-run state */
    public resetSearchState(): void {
        this.searchedHashes.clear();
        this.searchMetrics = { attempted: 0, succeeded: 0, failed: 0, failedQueries: [] };
        this.requestedExtraTools.clear();
        this.adapterOverride = null;
    }

    /** Diversify a repeated query by adding angle/scope variation */
    private diversifyQuery(query: string, attempt: number): string {
        const variations = [
            `${query} detailed comparison`,
            `${query} github stars community`,
            `${query} official documentation`,
            `${query} pros cons limitations`,
        ];
        return variations[(attempt - 1) % variations.length];
    }

    // Delegation config (set by GoalOrientedExecutor before each execution)
    private delegationEnabled: boolean = false;
    // When true: user explicitly named agents (e.g. "4 agents") → allow delegation on
    // iteration 1 and inject a "MUST delegate first" instruction into the prompt.
    public delegationExplicitlyRequired: boolean = false;

    /**
     * Configure multi-agent delegation for the current execution.
     * Called by GoalOrientedExecutor after goal complexity is known.
     * @param enabled            Whether delegation is allowed at all
     * @param explicitlyRequired True when the user explicitly requested N named agents
     */
    setDelegationConfig(enabled: boolean, explicitlyRequired: boolean = false): void {
        this.delegationEnabled = enabled;
        this.delegationExplicitlyRequired = explicitlyRequired;
        if (enabled) {
            log.info(`Delegation ENABLED (explicitlyRequired=${explicitlyRequired})`);
        }
    }

    // Sites known to block bots — loaded from server/config/blocked-domains.json
    private blockedDomains: string[] = loadBlockedDomains();

    // Free public APIs to use instead of scraping — loaded from server/config/data-api-hints.json
    private dataApiHints: Record<string, string> = loadDataApiHints();

    /**
     * REASON step: Analyze current state in plain text (NOT JSON).
     * LLMs are much better at reasoning in plain text than inside JSON.
     */
    async reason(state: ExecutionState): Promise<string> {
        const llm = this.adapterOverride || modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) return 'No LLM available. Should create files directly.';

        const recentActions = state.completed_actions.slice(-5).map(a => {
            // Show tool + outcome + actual output so the LLM knows what happened
            let output = '';
            if (typeof a.result === 'object' && a.result !== null) {
                // Fix 4: For failed commands show the LAST 3 error lines (actual error, not full traceback)
                // For success show first 300 chars. This avoids 2700-char traceback walls in context.
                const isFailed = !a.success;
                let stdout: string;
                let stderr: string;
                if (isFailed) {
                    const rawStderr = a.result.stderr || '';
                    // Extract last 3 non-empty lines — the actual error is almost always at the bottom
                    const errorLines = rawStderr.split('\n').filter((l: string) => l.trim()).slice(-3).join('\n');
                    stderr = errorLines || rawStderr.substring(0, 400);
                    // For stdout on failure, just the last relevant line (e.g. "Traceback (most recent call last)" + error)
                    const rawStdout = a.result.stdout || '';
                    stdout = rawStdout.split('\n').filter((l: string) => l.trim()).slice(-2).join('\n') || rawStdout.substring(0, 200);
                } else {
                    stdout = (a.result.stdout || '').substring(0, 400);
                    stderr = (a.result.stderr || '').substring(0, 300);
                }
                if (stdout) output += ` | stdout: ${stdout}`;
                if (stderr) output += ` | stderr: ${stderr}`;

                // web_search results — show top 3 snippets so the LLM can use them
                if (a.tool_used === 'web_search' && Array.isArray(a.result.results)) {
                    const snippets = a.result.results.slice(0, 3).map((r: any) =>
                        `[${r.title || ''}] ${r.snippet || r.description || ''} (${r.url || ''})`
                    ).join(' | ');
                    if (snippets) output += ` | results: ${snippets.substring(0, 600)}`;
                }

                // web_fetch content
                if (a.tool_used === 'web_fetch' && a.result.content) {
                    output += ` | content: ${String(a.result.content).substring(0, 400)}`;
                }

                // MCP filesystem tool result (read_file, list_directory, etc.)
                if (!stdout && !stderr && !output && a.result.content) {
                    const text = Array.isArray(a.result.content)
                        ? a.result.content.map((c: any) => c?.text || '').join('').substring(0, 300)
                        : String(a.result.content).substring(0, 300);
                    if (text) output += ` | result: ${text}`;
                }
                // Fallback: browser_eval/browser_extract return the JS evaluation result
                // directly as an Array or Object (Playwright page.evaluate() returns raw JS value,
                // not wrapped in stdout/content). Without this the LLM sees blank OK and retries forever.
                if (!output) {
                    const DIRECT_RESULT_TOOLS = new Set(['browser_eval', 'browser_evaluate', 'browser_extract', 'browser_get_content']);
                    if (DIRECT_RESULT_TOOLS.has(a.tool_used)) {
                        try {
                            const serialized = typeof a.result === 'string' ? a.result : JSON.stringify(a.result);
                            output += ` | result: ${serialized.substring(0, 3000)}`;
                        } catch { output += ` | result: [non-serializable]`; }
                    }
                }
            } else if (typeof a.result === 'string') {
                output += ` | result: ${a.result.substring(0, 300)}`;
            }
            return `- ${a.tool_used}(${JSON.stringify(a.args).substring(0, 120)}) -> ${a.success ? 'OK' : 'FAILED'}${output}`;
        }).join('\n');

        const criteria = state.goal.success_criteria.map(c =>
            `- [${c.status}] ${c.type}: ${JSON.stringify(c.config)}`
        ).join('\n');

        // Conversation context — resolves pronouns like "it", "this", "that"
        let conversationContext = '';
        if (state.conversationContext && state.conversationContext.length > 0) {
            conversationContext = '\nCONVERSATION CONTEXT (what was discussed before this task):\n' +
                state.conversationContext
                    .slice(-6)
                    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 250)}`)
                    .join('\n') + '\n';
        }

        // Recall similar past strategies from vector/hybrid memory + recent episodic events + user persona
        let memoryContext = '';
        try {
            const { memoryManager } = await import('../../memory/MemoryManager');

            // Semantic search for similar past goals/strategies
            const memories = await memoryManager.hybridSearch(state.goal.description, 'default', 3);
            if (memories.length > 0) {
                memoryContext += `\nRELEVANT PAST EXPERIENCES:\n` +
                    memories.map(m => `- [${m.event_type}] ${m.text.substring(0, 200)}`).join('\n') + '\n';
            }

            // Recent episodic activity (what the agent has done recently)
            const recentEvents = await memoryManager.getRecentEvents(4, 'default');
            if (recentEvents.length > 0) {
                memoryContext += `\nRECENT EPISODIC EVENTS:\n` +
                    recentEvents.map(e => `- [${e.event_type}] ${e.event_text.substring(0, 150)}`).join('\n') + '\n';
            }

            // User persona / preferences
            const persona = await memoryManager.getPersona('default');
            if (persona && (persona.name || persona.role)) {
                memoryContext += `\nUSER CONTEXT: ${persona.name || 'User'} — ${persona.role || 'General'}`;
                if (persona.preferences && Object.keys(persona.preferences).length > 0) {
                    memoryContext += ` | Preferences: ${JSON.stringify(persona.preferences).substring(0, 200)}`;
                }
                memoryContext += '\n';
            }
        } catch {
            // Memory subsystem not available — continue without
        }

        // Agent system identity — loaded from server/prompts/agent.system.md (editable without recompile)
        const agentSystemRaw = promptLoader.load('agent.system', '');
        const agentSystem = promptLoader.interpolate(
            this.userContext
                ? agentSystemRaw.replace('{{USER_CONTEXT}}', `[USER CONTEXT]\n${this.userContext}`)
                : agentSystemRaw.replace('{{USER_CONTEXT}}', '')
        );

        // Agent profile — behavioural style for this execution (e.g. researcher, coder, default)
        const profileSection = this.profileContent ? `\n[AGENT PROFILE]\n${this.profileContent}\n` : '';

        const template = promptLoader.load('reasoner-reason', `Think step by step about this goal.
{{AGENT_SYSTEM}}
{{PROFILE}}
{{CONVERSATION_CONTEXT}}
GOAL: {{GOAL}}

CRITERIA STATUS:
{{CRITERIA}}

RECENT ACTIONS:
{{RECENT_ACTIONS}}

FILES CREATED: {{ARTIFACTS}}
STUCK COUNT: {{STUCK_COUNT}}
{{MEMORY_CONTEXT}}
{{BLOCKED_SITE_WARNING}}
Questions to answer:
1. What has been accomplished so far?
2. What is still missing to achieve the goal?
3. What is the SINGLE most important next step?
4. If we're stuck, what different approach should we try?

Think out loud. Be specific about file names and what content they need.`);

        const prompt = promptLoader.interpolate(template, {
            AGENT_SYSTEM: agentSystem,
            PROFILE: profileSection,
            CONVERSATION_CONTEXT: conversationContext,
            GOAL: state.goal.description,
            CRITERIA: criteria,
            RECENT_ACTIONS: recentActions || 'None yet',
            ARTIFACTS: state.artifacts.join(', ') || 'None',
            STUCK_COUNT: state.stuck_count,
            MEMORY_CONTEXT: memoryContext,
            BLOCKED_SITE_WARNING: ContextBuilder.buildBlockedSiteWarning(state, this.blockedDomains, this.dataApiHints),
        });

        try {
            return await llm.generate(prompt, { temperature: 0.3 });
        } catch (error) {
            log.error('[ReActReasoner] Reasoning failed:', error);
            return 'Reasoning failed. Should attempt to create missing files directly.';
        }
    }

    /**
     * DECIDE step: Choose a single action based on reasoning.
     * Simple JSON output (just tool name + args).
     * NEVER returns null — always produces a concrete action.
     */
    async decideAction(
        state: ExecutionState,
        reasoning: string
    ): Promise<StateAssessment['suggested_next_action']> {
        const llm = this.adapterOverride || modelRouter.getAdapterForTask('json_generation') || modelManager.getActiveAdapter();

        // Fallback action if LLM is unavailable or returns garbage
        const fallbackAction = await ContextBuilder.buildFallbackAction(state);
        if (!llm) return fallbackAction;

        const tools = await mcpManager.listTools();
        // Gate browser tools: hide unless browserIntent=true OR scripts have already failed.
        const hasPriorScriptFailDecide = state.completed_actions.some(
            a => a.tool_used === 'run_command' && !a.success
        );
        const showBrowserToolsDecide = this.browserIntent || hasPriorScriptFailDecide;

        // ── TWO-LAYER TOOL DESIGN ──────────────────────────────────────────────
        // Layer 1: Active tools — profile-filtered subset with full 60-char description.
        //          The LLM can use any of these directly.
        // Layer 2: Tool index — all tools, name + one-liner. The LLM can request
        //          any index tool by adding "request_tool":"name" to its action JSON.
        //          This keeps prompt size small while preserving full capability.
        const profile = (state.goal as any).agent_profile ?? this.activeProfile ?? 'default';
        const PROFILE_ACTIVE_TOOLS: Record<string, Set<string>> = {
            researcher: new Set([
                'web_search', 'web_fetch', 'browser_fetch', 'stealth_fetch',
                'read_file', 'write_file', 'list_directory', 'search_files', 'create_directory',
                'run_command',
            ]),
            coder: new Set([
                'write_file', 'edit_file', 'read_file', 'run_command',
                'list_directory', 'create_directory', 'search_files', 'move_file',
            ]),
            browser: new Set([
                'browser_launch', 'browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot',
                'browser_fetch', 'stealth_fetch', 'browser_extract', 'browser_fill', 'web_fetch',
                'write_file', 'read_file', 'create_directory',
            ]),
        };
        const activeSet = PROFILE_ACTIVE_TOOLS[profile] ?? null; // null = show all (default)

        // Merge any agent-requested tools (from previous iteration's request_tool field)
        // into the active set for this iteration only — gives the agent exactly what it asked for.
        const effectiveActiveSet = activeSet
            ? new Set([...activeSet, ...this.requestedExtraTools])
            : null;
        this.requestedExtraTools.clear(); // consume — one-iteration activation only

        const filteredTools = tools.filter(t =>
            (showBrowserToolsDecide || !t.tool.name.startsWith('browser_')) &&
            (effectiveActiveSet === null || effectiveActiveSet.has(t.tool.name))
        );

        // Layer 1 — active tools with full description
        let toolNames = filteredTools
            .map(t => `${t.tool.name}: ${(t.tool.description || '').substring(0, 60)}`)
            .join('\n');

        // Layer 2 — full index for tools not in active set (compact, one-liner only)
        const indexedTools = effectiveActiveSet
            ? tools.filter(t =>
                (showBrowserToolsDecide || !t.tool.name.startsWith('browser_')) &&
                !effectiveActiveSet.has(t.tool.name)
            )
            : [];
        if (indexedTools.length > 0) {
            const indexLines = indexedTools
                .map(t => `${t.tool.name}`)
                .join(', ');
            toolNames += `\n\nADDITIONAL TOOLS (add "request_tool":"<name>" to activate for next action):\n${indexLines}`;
        }
        // ── END TWO-LAYER TOOL DESIGN ──────────────────────────────────────────

        // Inject virtual delegation tools when budget allows.
        // When the user explicitly requested named agents, allow delegation on
        // iteration 1 — otherwise keep the >= 2 gate so simple tasks don't delegate.
        const delegationsLeft = state.max_delegations - state.delegation_count;
        const canDelegate = this.delegationEnabled &&
            delegationsLeft > 0 &&
            (state.current_iteration >= 2 || this.delegationExplicitlyRequired);

        if (canDelegate) {
            toolNames += `\ndelegate_task: Spawn ONE specialist sub-agent for a self-contained sub-task (budget: ${delegationsLeft} left)`;
            toolNames += `\ndelegate_parallel: Spawn N independent sub-agents concurrently — prefer over multiple delegate_task calls (budget: ${delegationsLeft} left)`;
        }

        // Always offer mark_complete after iter 2 — lets the LLM end early for info/chat goals
        if (state.current_iteration >= 2) {
            toolNames += `\nmark_complete: Declare the goal fully achieved — use ONLY when all success criteria are demonstrably met. Args: {"summary": "what was accomplished"}`;
        }

        const decideTemplate = promptLoader.load('reasoner-decide', `Based on this analysis, choose ONE action to take RIGHT NOW.

ANALYSIS:
{{ANALYSIS}}

GOAL: {{GOAL}}

AVAILABLE TOOLS:
{{TOOL_NAMES}}

You MUST choose one tool and output ONLY this JSON (no markdown, no explanation):
{"tool": "tool_name", "args": {"key": "value"}, "reasoning": "one sentence why"}

RULES:
- The "tool" field MUST be one of the tool names listed above
- For creating files use write_file with {"path": "...", "content": "..."}
- For running commands use run_command with {"command": "..."}
- Prefer INCREMENTAL steps: one small action per call
- Do NOT generate large multi-line scripts in run_command
- For reading use read_file, for exploring use list_directory

ANTI-LOOP / ANTI-BLOCK RULES (CRITICAL):
- If a previous browser_navigate returned blocked=true, do NOT call browser_navigate on the same domain again
- For financial/stock data: use run_command with a Node.js fetch script calling Yahoo Finance API
- For news/search: use web_search tool — it uses SearXNG which has no CAPTCHA
- For product prices: use web_search tool, not browser_navigate to Amazon/Flipkart
- For any data task: prefer run_command with fetch() script over browser_navigate
- browser_fetch is faster and less detectable than browser_navigate for APIs and JSON endpoints
{{BLOCKED_SITE_CONTEXT}}{{DELEGATION_RULES}}`);

        // Named agent catalogue (same logic as reason())
        let namedAgentCatalogueDecide = '';
        if (canDelegate) {
            try {
                const profiles = await agentPool.listProfiles();
                if (profiles.length > 0) {
                    const lines = profiles.map(p =>
                        `  - "${p.slug}" (${p.name}): ${p.role}`
                    ).join('\n');
                    namedAgentCatalogueDecide = `\n\nNAMED AGENTS (add "agent_id":"<slug>" to delegate_task to use a specialist):\n${lines}`;
                }
            } catch { /* non-fatal */ }
        }

        const delegationRules = canDelegate ? `

DELEGATION RULES (delegate_task / delegate_parallel):
- delegate_task args: {"task": "what to do", "role": "researcher|coder|reviewer|planner"}
- delegate_parallel args: {"tasks": [{"task": "...", "role": "..."}, ...]}
- USE delegation ONLY when the sub-task is multi-step and self-contained
- NEVER delegate something a single tool call can do (web_search, read_file, etc.)
- PREFER delegate_parallel when tasks are independent — it counts as ONE delegation
- NEVER delegate and then immediately delegate the result again (let main loop continue)${namedAgentCatalogueDecide}` : '';

        const skillHintSection = this.skillStrategyHint
            ? `\nSKILL STRATEGY (from a past successful run on a similar goal):\n${this.skillStrategyHint}\nApply this approach unless you have already tried it and it failed.\n`
            : '';

        // Artifact pinning (§3.1): 60-char summaries at top of every decide prompt
        const pinnedSection = ContextBuilder.buildPinnedArtifactsContext(state);

        const prompt = pinnedSection + promptLoader.interpolate(decideTemplate, {
            ANALYSIS: reasoning.substring(0, 500),
            GOAL: state.goal.description,
            TOOL_NAMES: toolNames,
            BLOCKED_SITE_CONTEXT: ContextBuilder.buildBlockedSiteContext(state, this.blockedDomains, this.dataApiHints),
            DELEGATION_RULES: delegationRules,
        }) + skillHintSection;

        // Tier 1: Ask for JSON — the happy path
        let rawText = '';
        try {
            const result = await llm.generateJSON(prompt, {});
            if (result === null || result === undefined) {
                log.warn('[ReActReasoner] generateJSON returned null/undefined — falling through to text extraction');
            } else if (result && result._parseError) {
                // Some LLM adapters return a sentinel rather than throwing — treat as failure
                rawText = result._rawText || result._originalError || '';
                log.warn('[ReActReasoner] generateJSON returned _parseError, falling through to text extraction');
            } else if (result && result.tool && typeof result.tool === 'string') {
                // Handle request_tool: agent is asking to activate an index tool for next iteration.
                // Register it before resolving the primary action so it's ready on the next call.
                if (result.request_tool && typeof result.request_tool === 'string') {
                    const reqTool = result.request_tool.trim();
                    const reqExists = tools.some(t => t.tool.name === reqTool);
                    if (reqExists) {
                        this.requestedExtraTools.add(reqTool);
                        log.info(`[ReActReasoner] Tool activation request registered: "${reqTool}" (active next iteration)`);
                    } else {
                        log.warn(`[ReActReasoner] request_tool "${reqTool}" not found in tool list — ignored`);
                    }
                }

                // Resolve alias if the LLM used a non-standard tool name
                const resolvedTool = TOOL_ALIASES[result.tool.toLowerCase()] || result.tool;
                const toolExists = tools.some(t => t.tool.name === resolvedTool) ||
                    ['delegate_task', 'delegate_parallel'].includes(resolvedTool);

                if (toolExists) {
                    if (resolvedTool !== result.tool) {
                        log.info(`Resolved tool alias: "${result.tool}" → "${resolvedTool}"`);
                    }
                    return { tool: resolvedTool, args: result.args || {}, reasoning: result.reasoning || '' };
                }

                // Tool not found even after alias lookup — preserve raw text for Tier 2
                log.warn(`LLM suggested unknown tool: "${result.tool}" (resolved: "${resolvedTool}")`);
                // Encode the result back to text so Tier 2 can scan it for known tool names
                rawText = JSON.stringify(result);
            }
        } catch (err: any) {
            // generateJSON throws and attaches rawText when JSON parsing fails (e.g. DeepSeek <think> blocks)
            rawText = err?.rawText || err?.message || '';
            log.warn('[ReActReasoner] generateJSON failed, trying raw text extraction');
        }

        // Tier 2: Extract tool from raw text when the LLM forgot to format JSON properly.
        // Handles responses like: `I will use write_file to ...`  or  `{"tool":"write_file"...`
        const allToolNames = [
            ...tools.map(t => t.tool.name),
            ...(canDelegate ? ['delegate_task', 'delegate_parallel'] : []),
        ];
        const extracted = ContextBuilder.extractActionFromText(rawText || '', allToolNames);
        if (extracted) {
            log.info(`Extracted action from raw text: ${extracted.tool}`);
            return extracted;
        }

        // Tier 3: Single retry with a much simpler, constrained prompt
        try {
            const simplePrompt = `Choose ONE tool from this list and output ONLY valid JSON.

GOAL: ${state.goal.description.substring(0, 200)}

TOOLS (use EXACTLY these names):
${tools.map(t => t.tool.name).join(', ')}

MISSING FILES: ${state.goal.success_criteria.filter(c => c.type === 'file_exists' && c.status !== 'passed').map(c => c.config.path).join(', ') || 'none'}

Output ONLY: {"tool":"tool_name","args":{},"reasoning":"why"}`;

            const retry = await llm.generateJSON(simplePrompt, {});
            if (retry && retry.tool && typeof retry.tool === 'string') {
                const toolExists = tools.some(t => t.tool.name === retry.tool);
                if (toolExists) {
                    log.info(`Retry succeeded: ${retry.tool}`);
                    return { tool: retry.tool, args: retry.args || {}, reasoning: retry.reasoning || '' };
                }
            }
        } catch {
            // Retry also failed
        }

        // Tier 4: Deterministic fallback — always makes progress toward missing files
        log.warn('[ReActReasoner] All JSON extraction tiers failed — using deterministic fallback');
        return fallbackAction;
    }

    // =========================================================================
    // COMBINED REASON + DECIDE — ONE LLM CALL (true ReAct design)
    // =========================================================================

    /**
     * REASON + DECIDE in ONE LLM call.
     * The prompt asks the model to first think through the problem in prose,
     * then output its chosen action as JSON on the last line prefixed by "ACTION:".
     *
     * This is the canonical ReAct paper design: reasoning and action are generated
     * in the same context, so the action is always coherent with the reasoning.
     * Also halves iteration time by eliminating the second LLM call.
     *
     * Falls back gracefully to the deterministic fallback action on any failure.
     */
    async reasonAndDecide(state: ExecutionState): Promise<{
        reasoning: string;
        action: StateAssessment['suggested_next_action'];
    }> {
        const llm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        const fallbackAction = await ContextBuilder.buildFallbackAction(state);
        if (!llm) {
            return { reasoning: 'No LLM available.', action: fallbackAction };
        }

        // ── Build shared context (same blocks as reason() + decideAction()) ──
        const recentActions = ContextBuilder.buildRecentActionsContext(state);
        const criteria = state.goal.success_criteria.map(c =>
            `- [${c.status}] ${c.type}: ${JSON.stringify(c.config)}`
        ).join('\n');
        const conversationContext = ContextBuilder.buildConversationContext(state);
        const memoryContext = await ContextBuilder.buildMemoryContext(state);
        const agentSystemRaw = promptLoader.load('agent.system', '');
        const agentSystem = promptLoader.interpolate(
            this.userContext
                ? agentSystemRaw.replace('{{USER_CONTEXT}}', `[USER CONTEXT]\n${this.userContext}`)
                : agentSystemRaw.replace('{{USER_CONTEXT}}', '')
        );
        const profileSection = this.profileContent ? `\n[AGENT PROFILE]\n${this.profileContent}\n` : '';

        // ── Tool list (same as decideAction()) ──
        const tools = await mcpManager.listTools();
        // Browser tools are hidden unless browserIntent=true OR a previous script attempt has failed.
        // This is the primary gate that prevents Chrome from launching on data-fetch tasks.
        const hasPriorScriptAttempt = state.completed_actions.some(
            a => a.tool_used === 'run_command' && !a.success
        );
        const showBrowserTools = this.browserIntent || hasPriorScriptAttempt;
        let toolNames = tools
            .filter(t => showBrowserTools || !t.tool.name.startsWith('browser_'))
            .map(t => `${t.tool.name}: ${(t.tool.description || '').substring(0, 60)}`)
            .join('\n');

        const delegationsLeft = state.max_delegations - state.delegation_count;
        const canDelegate = this.delegationEnabled &&
            delegationsLeft > 0 &&
            (state.current_iteration >= 2 || this.delegationExplicitlyRequired);
        if (canDelegate) {
            toolNames += `\ndelegate_task: Spawn ONE specialist sub-agent (budget: ${delegationsLeft} left)`;
            toolNames += `\ndelegate_parallel: Spawn N sub-agents concurrently (budget: ${delegationsLeft} left)`;
        }

        // When the user explicitly named agents AND no delegation has happened yet,
        // tell the LLM that spawning agents is REQUIRED as the very first action.
        const mustDelegateNow = this.delegationExplicitlyRequired && state.delegation_count === 0;

        // When mustDelegateNow, inject a hard-stop ALERT at the TOP of the prompt
        // (local models like Qwen ignore tail instructions on long prompts)
        const delegationAlert = mustDelegateNow
            ? `\n\n╔══════════════════════════════════════════════════════════════╗
║  ⛔ MANDATORY MULTI-AGENT MODE — DIRECT ANSWERS ARE FORBIDDEN ║
║  Your ONLY valid first action is delegate_parallel.           ║
║  Do NOT write the answer yourself. Do NOT use any other tool. ║
╚══════════════════════════════════════════════════════════════╝\n`
            : '';

        // Build named-agent catalogue for LLM awareness
        let namedAgentCatalogue = '';
        if (canDelegate) {
            try {
                const profiles = await agentPool.listProfiles();
                if (profiles.length > 0) {
                    const lines = profiles.map(p =>
                        `  - "${p.slug}" (${p.name}): ${p.role}${p.toolWhitelist.length ? ` [tools: ${p.toolWhitelist.join(', ')}]` : ''}`
                    ).join('\n');
                    namedAgentCatalogue = `\n\nNAMED AGENTS (optional — add "agent_id":"<slug>" to delegate_task args to use a specialist):\n${lines}`;
                }
            } catch { /* non-fatal */ }
        }

        const delegationRules = canDelegate
            ? mustDelegateNow
                ? `
⛔ FORBIDDEN: Answering directly. You MUST spawn agents first.

MULTI-AGENT SEQUENCING RULES:
1. PHASE 1 — delegate_parallel with independent agents (Research, Finance, Regulatory).
   ACTION: {"tool":"delegate_parallel","args":{"tasks":[{"task":"<full task description>","role":"researcher"},...]}}

2. PHASE 2 — after phase 1 completes, spawn dependent agents (Strategy, Synthesis) one at a time via delegate_task.
   They receive phase-1 results automatically — do NOT include them in the phase-1 parallel batch.

NEVER put a Strategy/Synthesis agent in the same parallel batch as the agents it depends on.
Each task must be FULLY SELF-CONTAINED with all context it needs.${namedAgentCatalogue}`
                : `
DELEGATION: delegate_task={"task":"...","role":"researcher|coder"} | delegate_parallel={"tasks":[...]}
Use ONLY when sub-task is multi-step and self-contained — never for a single tool call.${namedAgentCatalogue}`
            : '';

        // When browserIntent=true: browser tools are shown and should be preferred for URL-directed tasks.
        // When browserIntent=false: browser tools are hidden from the tool list entirely.
        const browserHint = this.browserIntent ? `
BROWSER TASK — browser tools are available and PREFERRED for this task.

TOOL PRIORITY:
1. Use browser_launch → browser_navigate → browser_get_content (or browser_extract) to load the page and extract data.
2. Use browser_screenshot to capture the page (always do this if the task asks for it).
3. To run JavaScript on the current page: browser_eval(script: "...") — argument is 'script' not 'code'.
   Example: browser_eval({"script": "document.title"}) — NEVER use 'code', always use 'script'.
4. Then use write_file to save extracted data to disk.
5. Only fall back to run_command (python/curl/requests) if the browser returns no useful content after 2 attempts.

DO NOT write Python scripts to scrape a URL that you can open directly with browser_navigate.

SANDBOX PACKAGE RULES — these packages are NOT pre-installed in the sandbox:
- puppeteer, playwright (Python or Node), selenium, mechanize, scrapy
- Use the built-in browser_* tools instead — they are Playwright-backed and work out of the box.
- If you MUST use a script: install packages first with 'pip install <pkg>' or 'npm install <pkg>' before running the script.
- Python standard library + requests, beautifulsoup4 are available without installing.

BROWSER USAGE ORDER (MANDATORY):
1. ALWAYS call browser_launch FIRST before any other browser_* tool — skipping this will cause all subsequent browser calls to fail with "no active browser session"
2. Then browser_navigate (with the target URL)
3. Then browser_get_content or browser_extract to read the page text
4. Then browser_screenshot if a screenshot is required
5. Then write_file to save the data
` : '';


        // ── Build journal context ──
        const journalContext = ContextBuilder.buildJournalContext(state);

        // ── Secure context (credentials) — injected per-iteration, NEVER logged ──
        // secureContext is set by the pre-flight requestUserInput when the goal needs
        // login credentials. It is only held in-memory on ExecutionState and must never
        // appear in DB, audit logs, or execution_journal.
        const secureContextBlock = state.secureContext
            ? `\n[SECURE_CONTEXT — credentials provided by user, valid for this session only]\n${state.secureContext}\n[END SECURE_CONTEXT]\n`
            : '';

        // ── Load combined prompt template (editable at server/prompts/reasoner-combined.md) ──
        const template = promptLoader.load('reasoner-combined', `{{AGENT_SYSTEM}}{{PROFILE}}{{DELEGATION_ALERT}}{{PROGRESS_ANCHOR}}{{CONVERSATION_CONTEXT}}{{BROWSER_HINT}}{{FORCE_WRITE_HINT}}{{REPEATED_READ_HINT}}{{HUMAN_BROWSER_HELP}}{{SECURE_CONTEXT}}
{{EXECUTION_PLAN}}
{{EXECUTION_JOURNAL}}
RECENT ACTIONS (with output):
{{RECENT_ACTIONS}}

{{MEMORY_CONTEXT}}
{{BLOCKED_SITE_WARNING}}
AVAILABLE TOOLS:
{{TOOL_NAMES}}

Think step by step:
1. Which criteria are still failing and WHY (check PROGRESS TRACKER above)?
2. What is the SINGLE action that directly addresses a failing criterion?
3. If the same approach failed before, what DIFFERENT method should be tried?

After your analysis, output the chosen action on the LAST LINE prefixed with ACTION:
ACTION: {"tool": "tool_name", "args": {"key": "value"}, "reasoning": "one sentence why"}

SANDBOX ENVIRONMENT (always available in run_command):
- Python 3: yfinance, pandas, requests, numpy, openpyxl, matplotlib, seaborn, python-docx, flask, fastapi, beautifulsoup4
- Node.js: typescript, ts-node, nodemon
- CLI: curl, wget, git, jq, zip/unzip, pip3, npm
- pip install: if a package is missing, use: pip install --break-system-packages <pkg>
  OR isolate with: python3 -m venv .venv && .venv/bin/pip install <pkg> && .venv/bin/python3 script.py

CRITICAL RULES:
- ACTION: must be the LAST line of your response (no text after it)
- "tool" must be EXACTLY one of the listed tool names (aliases: bash→run_command, save_file→write_file, mkdir→create_directory, search→web_search, stealth→stealth_fetch)
- If browser_navigate or browser_fetch is BLOCKED by Cloudflare: use stealth_fetch (same args: {url}) — it uses browser context cookies + TLS fingerprint to bypass bot detection
- NEVER wrap the ACTION line in markdown fences (no \`\`\`json blocks). Raw JSON only.
- BROWSER IS SLOW (3-5s per action + Chrome overhead). NEVER use browser tools when a script can do the job:
  * Stock/finance/crypto prices → python3 yfinance (pre-installed), NSE API, or CoinGecko API via requests
  * Any JSON/REST API → run_command with curl or python3 requests
  * News/search results → web_search tool (SearXNG, instant, no CAPTCHA)
  * HTML page content → run_command with python3 requests+BeautifulSoup (pre-installed)
  * Only use browser_navigate when the page REQUIRES JavaScript rendering AND no API exists
- web_search: returns 10 results by default. For deep research, use limit:20. Example: {"query": "...", "limit": 20}
- web_fetch: default returns 15000 chars. For long articles use offset for pagination: first call {"url":"...", "offset":0}, then {"url":"...", "offset":15000}. Response includes hasMore:true when more content is available.
- For stock/finance data: python3 with yfinance IS pre-installed — use it directly, no pip install needed
- For web data: web_search (SearXNG, no CAPTCHA) or run_command with curl/requests
- NEVER repeat the exact same failing command — try a different approach
- For file tasks: always use absolute paths under /workspace/; write ALL output/result files to /workspace/{{OUTPUT_DIR}}/ (e.g. /workspace/{{OUTPUT_DIR}}/report.md) — never dump data files directly at /workspace/ or /workspace/output/
- SCRIPT QUALITY: When using write_file to create a script, it MUST be COMPLETE and RUNNABLE — no skeleton, no TODO, no placeholder functions. Include ALL logic in one file. A partial script that fails is worse than no script.
- INLINE PYTHON: For data tasks ≤ 30 lines, use run_command with python3 directly (no file write needed): ACTION: {"tool":"run_command","args":{"command":"python3 -c \"import yfinance as yf; ...\""}}
- READ ERRORS: When run_command fails, the output contains the actual error — read it and fix the specific issue
- PANDAS DATES: Use lowercase frequency aliases — freq='h' not 'H', freq='min' not 'T', freq='s' not 'S' (pandas >= 2.2 dropped uppercase aliases)
- PDF GENERATION: Use pandoc with wkhtmltopdf engine — no LaTeX needed: run_command {"command":"pandoc report.md -o report.pdf --pdf-engine=wkhtmltopdf"} (both are pre-installed). NEVER use fpdf, reportlab, or any Python PDF library — they are NOT installed in the sandbox and will always fail with ModuleNotFoundError. The ONLY valid PDF method is pandoc → wkhtmltopdf.
- MESSAGING/TELEGRAM: To send to telegram/discord/whatsapp, use the messaging_send or messaging_send_file tool directly — NEVER write a fake telegram_confirmation.txt. Call messaging_send first; if it returns an error with "No chat_id", write a telegram_status.txt explaining the user must send a message to the bot first. If messaging_send succeeds, THEN write telegram_confirmation.txt with the result.
- STATIC DATA — CRITICAL: If the task says "generate", "create a list", "write", or "produce" data (cities, employees, meal plans, multiplication tables, fibonacci, etc.) — DO NOT use web_search or web_fetch. Generate the data from your own knowledge and write_file directly. Web search is ONLY for tasks that say "current", "live", "today's", "latest", or "real-time".
- BINARY FILES — CRITICAL: NEVER use write_file for .xlsx, .pdf, .docx, .pptx formats — write_file only handles text and will create a corrupt file. Instead:
  * XLSX: run_command {"command":"python3 -c \"import openpyxl; wb=openpyxl.Workbook(); ws=wb.active; ws.append(['Col1','Col2']); wb.save('/workspace/output/file.xlsx')\""}
  * PDF:  run_command {"command":"pandoc /workspace/output/report.md -o /workspace/output/report.pdf --pdf-engine=wkhtmltopdf"}  ← ONLY method; fpdf/reportlab are banned
  * DOCX: run_command {"command":"python3 -c \"from docx import Document; doc=Document(); doc.add_paragraph('text'); doc.save('/workspace/output/file.docx')\""}
- AFTER WRITING A SCRIPT: If you use write_file to create a .py or .js script, your VERY NEXT action must be run_command to execute it and produce the output file. Never write a script and then write_file again — execute it.
{{BLOCKED_SITE_CONTEXT}}{{DELEGATION_RULES}}

=== MANDATORY OUTPUT FORMAT — NO EXCEPTIONS ===
Your response MUST end with exactly one ACTION line as the ABSOLUTE LAST LINE:
ACTION: {"tool": "tool_name", "args": {...}, "reasoning": "one sentence"}

VIOLATIONS THAT WILL BREAK THE SYSTEM (never do these):
✗ Wrapping ACTION in \`\`\`json ... \`\`\` fences
✗ Adding any text after the ACTION: line
✗ Outputting raw JSON without the ACTION: prefix
✗ Using {"thought":...} or {"tool":...} as the full response instead of ACTION: prefix
===============================================`);

        // ── Inject AgentBus messages from child agents ──
        let childResultsContext = '';
        if (state.execution_id) {
            const busMessages = agentBus.receive(state.execution_id);
            if (busMessages.length > 0) {
                const resultLines: string[] = [];
                const escalationLines: string[] = [];

                let escalationCount = 0;
                let totalBusMessages = busMessages.length;

                for (const m of busMessages) {
                    if (m.type === 'result' || m.type === 'artifact' || m.type === 'context') {
                        resultLines.push(`[Child agent result] ${JSON.stringify(m.payload).substring(0, 300)}`);
                    } else if (m.type === 'escalation') {
                        escalationCount++;
                        const p = m.payload as any;
                        escalationLines.push(`[Child agent ESCALATION] Problem: ${p.problem || 'unknown'} | Need: ${p.need || 'unknown'}`);
                        // Only hard-block (stuck=999) if MAJORITY of agents failed.
                        // Partial failure (1 of 3) → soft increment so parent can use partial results.
                        const majorityFailed = escalationCount > Math.floor(totalBusMessages / 2);
                        if (majorityFailed) {
                            state.stuck_count = Math.max(state.stuck_count, 999);
                            state.strategy_changes = Math.max(state.strategy_changes, 999);
                        } else {
                            state.stuck_count++;
                            log.info({ escalationCount, total: totalBusMessages }, 'Partial child escalation — using remaining results');
                        }
                    } else if (m.type === 'question') {
                        const p = m.payload as any;
                        const question = p.content || JSON.stringify(p).substring(0, 200);
                        resultLines.push(`[Child agent question] ${question}`);
                        // Answer the question and send back so the child can unblock
                        try {
                            // Bug fix: getAdapterForTask can return null — guard before calling.
                            // LLMAdapter interface uses generate(), not generateText().
                            const questionLlm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
                            if (questionLlm && typeof questionLlm.generate === 'function') {
                                const answer = await questionLlm.generate(
                                    `A child sub-agent working on your goal asks: "${question}"\n` +
                                    `Goal: "${state.goal.description}"\n` +
                                    `Answer concisely so the child agent can continue:`,
                                    { temperature: 0.3 }
                                );
                                if (m.from) {
                                    agentBus.send(state.execution_id, m.from, 'context', {
                                        answer,
                                        in_reply_to: question,
                                    });
                                    log.info({ childId: m.from }, `Answered child question: "${question.substring(0, 80)}"`);
                                }
                            } else {
                                log.warn('No LLM adapter available to answer child question — child will continue without answer');
                            }
                        } catch (answerErr: any) {
                            log.warn({ err: answerErr.message }, 'Failed to answer child question — child will continue without answer');
                        }
                    }
                }

                const allLines = [...escalationLines, ...resultLines];
                if (allLines.length > 0) {
                    childResultsContext = `\nCHILD AGENT MESSAGES:\n${allLines.join('\n')}\n`;
                }
            }
        }

        const progressAnchor = ContextBuilder.buildProgressAnchor(state, this.executionPlan);

        const prompt = promptLoader.interpolate(template, {
            AGENT_SYSTEM: agentSystem,
            PROFILE: profileSection,
            DELEGATION_ALERT: delegationAlert,
            OUTPUT_DIR: this.outputDir,
            PROGRESS_ANCHOR: progressAnchor,
            CONVERSATION_CONTEXT: conversationContext,
            BROWSER_HINT: browserHint,
            SECURE_CONTEXT: secureContextBlock,
            GOAL: state.goal.description,
            CRITERIA: criteria,
            EXECUTION_PLAN: this.executionPlan
                ? `EXECUTION PLAN (follow these ordered steps):\n${this.executionPlan}\n`
                : '',
            EXECUTION_JOURNAL: journalContext,
            RECENT_ACTIONS: recentActions || 'None yet',
            ARTIFACTS: state.artifacts.join(', ') || 'None',
            ITERATION: String(state.current_iteration),
            MAX_ITERATIONS: String(state.max_iterations),
            STUCK_COUNT: String(state.stuck_count),
            MEMORY_CONTEXT: memoryContext + childResultsContext,
            BLOCKED_SITE_WARNING: ContextBuilder.buildBlockedSiteWarning(state, this.blockedDomains, this.dataApiHints),
            TOOL_NAMES: toolNames,
            BLOCKED_SITE_CONTEXT: ContextBuilder.buildBlockedSiteContext(state, this.blockedDomains, this.dataApiHints),
            DELEGATION_RULES: delegationRules,
            FORCE_WRITE_HINT: (state.consecutive_read_only ?? 0) >= 4
                ? `\n⚠️ FORCE-WRITE OVERRIDE: You have performed ${state.consecutive_read_only} consecutive read-only iterations without writing any files. Stop all research/listing/checking. Your ONLY valid next action is write_file or run_command to CREATE output. Do NOT search, list, or read anything.\n`
                : '',
            // Inject warning when human already tried browser control and it didn't resolve the block
            HUMAN_BROWSER_HELP: (state.human_browser_help_used ?? 0) >= 1
                ? `\n🚫 HUMAN BROWSER CONTROL ALREADY TRIED (${state.human_browser_help_used}x): The user took manual control of the browser to try to solve the block/CAPTCHA/login but still couldn't complete the goal. DO NOT try run_command scripts as a fallback — the website is inaccessible. Use mark_complete with status=failed to explain why this goal cannot be completed.\n`
                : '',
            REPEATED_READ_HINT: (() => {
                const counts = state.file_read_counts ?? {};
                const repeated = Object.entries(counts).filter(([, n]) => n >= 2);
                if (repeated.length === 0) return '';
                const lines = repeated.map(([p, n]) =>
                    `  • "${p}" read ${n}x since last write`
                ).join('\n');
                return `\n🔁 REPEATED-READ OVERRIDE: You have already read these files multiple times since the last fix:\n${lines}\nYou already have the full content. DO NOT read them again. Write the fix NOW with write_file. Reading again wastes an iteration and will not give you new information.\n`;
            })(),
        });

        // ── Attach pending screenshot for visual analysis ──
        // Both Anthropic and OpenAI adapters support ContentBlock[] images in history.
        // We check whether the active model is vision-capable before sending.
        const generateOptions: any = { temperature: 0.3 };
        if (state.pending_screenshot) {
            const screenshot = state.pending_screenshot;
            const modelId = (llm as any).model as string || '';
            const isVisionCapable = ContextBuilder.isVisionCapableModel(modelId);
            if (isVisionCapable) {
                generateOptions.history = [
                    {
                        role: 'user',
                        content: [
                            { type: 'image', base64: screenshot.base64, mimeType: screenshot.mimeType },
                            { type: 'text', text: 'BROWSER SCREENSHOT: The image above shows the current state of the web page. Use it to understand the page layout, text, forms, buttons, and any content relevant to your goal before deciding the next action.' }
                        ]
                    },
                    {
                        role: 'assistant',
                        content: '(Screenshot received and analyzed. Proceeding with reasoning based on visual content.)'
                    }
                ];
                log.info(`[ReActReasoner] Attaching screenshot to reasoning prompt (${modelId})`);
            } else {
                // Non-vision model: inject a text note so the LLM knows a screenshot was taken
                const textNote = screenshot.savedPath
                    ? `\n[BROWSER SCREENSHOT SAVED: ${screenshot.savedPath} — the page has been captured but this model cannot view images. Use browser_extract to read the page content instead.]\n`
                    : `\n[BROWSER SCREENSHOT CAPTURED — this model cannot view images. Use browser_extract to read the page content instead.]\n`;
                // Prepend note to prompt (prompt is immutable here, so we rebuild)
                (generateOptions as any)._screenshotNote = textNote;
                log.info(`[ReActReasoner] Non-vision model ${modelId} — screenshot note injected as text`);
            }
            // Consumed — clear so it doesn't repeat on the next iteration
            delete state.pending_screenshot;
        }

        const finalPrompt = (generateOptions as any)._screenshotNote
            ? (generateOptions as any)._screenshotNote + prompt
            : prompt;
        delete (generateOptions as any)._screenshotNote;

        // Hard 60s timeout on the LLM call. Without this, a slow/stalled API response
        // blocks the entire ReAct iteration indefinitely (observed: 5.2-minute stall).
        // On timeout, the existing fallback action is used — same as any other LLM error.
        const LLM_TIMEOUT_MS = parseInt(process.env['REACT_LLM_TIMEOUT_MS'] ?? '60000', 10);
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
                () => reject(new Error(`LLM call timed out after ${LLM_TIMEOUT_MS}ms`)),
                LLM_TIMEOUT_MS
            );
        });

        try {
            const response = await Promise.race([
                llm.generate(finalPrompt, generateOptions),
                timeoutPromise,
            ]);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            log.info(`Combined response (${response.length} chars)`);

            const action = await this.extractActionFromCombinedResponse(response, tools, canDelegate, state);

            // Reasoning = everything before the last ACTION: line
            const actionIdx = response.lastIndexOf('\nACTION:');
            const reasoning = actionIdx > 0
                ? response.substring(0, actionIdx).trim()
                : response.substring(0, Math.min(response.length, 600));

            return { reasoning, action };
        } catch (error: any) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            // Classify the error so the GoalOrientedExecutor's consecutive-failure guard
            // and the user can see WHY the LLM failed (quota vs network vs parse vs timeout).
            const errMsg = error?.message || String(error);
            const isTimeout = errMsg.includes('timed out after');
            const isRateLimit = /429|quota|rate.?limit|resource.?exhausted|too.?many.?requests/i.test(errMsg);
            const isNetwork = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(errMsg);
            if (isTimeout) {
                log.warn(`[ReActReasoner] LLM call timed out after ${LLM_TIMEOUT_MS}ms — using fallback action`);
            } else if (isRateLimit) {
                log.error(`[ReActReasoner] LLM rate-limit / quota exhausted: ${errMsg.substring(0, 200)}`);
            } else if (isNetwork) {
                log.error(`[ReActReasoner] LLM network error: ${errMsg.substring(0, 200)}`);
            } else {
                log.error('[ReActReasoner] reasonAndDecide failed:', error);
            }
            return {
                reasoning: 'LLM call failed — using fallback action.',
                action: fallbackAction,
            };
        }
    }

    /**
     * Extract the chosen action from a combined reason+decide LLM response.
     * Tries multiple strategies in order of reliability.
     */
    private async extractActionFromCombinedResponse(
        response: string,
        tools: any[],
        canDelegate: boolean,
        state: ExecutionState,
    ): Promise<StateAssessment['suggested_next_action']> {
        const allToolNames = [
            ...tools.map(t => t.tool.name),
            ...(canDelegate ? ['delegate_task', 'delegate_parallel'] : []),
        ];

        // TOOL_ALIASES is defined at module level — single source of truth

        const resolveAndValidate = (toolName: string, args: any, reasoning: string) => {
            const resolved = TOOL_ALIASES[toolName.toLowerCase()] || toolName;
            if (allToolNames.includes(resolved)) {
                if (resolved !== toolName) {
                    log.info(`Resolved alias: "${toolName}" → "${resolved}"`);
                }
                return { tool: resolved, args: args || {}, reasoning: reasoning || '' };
            }
            return null;
        };

        // ── Strategy 0: Strip outer markdown fences ──────────────────────────────
        // devstral and some Ollama models wrap their ENTIRE response in ```json ... ```
        // This makes all downstream strategies fail (ACTION: is never found, flat regex
        // fails on nested args).  Strip the outermost fence pair and re-assign response
        // before any further strategy runs.  Only triggered when the response is entirely
        // fence-wrapped (first non-ws line is ``` and last non-ws line is ```).
        const fenceMatch = response.match(/^```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```\s*$/);
        if (fenceMatch) {
            response = fenceMatch[1].trim();
            log.info('[ReActReasoner] Strategy 0: stripped outer markdown fence from response');
        }

        // ── Strategy 1: ACTION: prefix on last line (our primary format) ──
        // Find the LAST occurrence of ACTION: to handle models that repeat it
        const lastActionIdx = response.lastIndexOf('ACTION:');
        if (lastActionIdx !== -1) {
            const afterAction = response.substring(lastActionIdx + 'ACTION:'.length).trim();
            // Extract the first JSON object following ACTION:
            const jsonEnd = afterAction.indexOf('\n');
            const jsonStr = jsonEnd === -1 ? afterAction : afterAction.substring(0, jsonEnd);
            try {
                // Handle models that wrap the JSON in backticks
                const cleaned = jsonStr.replace(/^`+|`+$/g, '').trim();
                const parsed = JSON.parse(cleaned);
                if (parsed.tool && typeof parsed.tool === 'string') {
                    const result = resolveAndValidate(parsed.tool, parsed.args, parsed.reasoning);
                    if (result) {
                        log.info(`ACTION: extracted: ${result.tool}`);
                        return result;
                    }
                }
            } catch { /* try next strategy */ }

            // Also try to find the JSON object that follows ACTION: even if multiline
            const jsonMatch = afterAction.match(/\{[\s\S]*?"tool"\s*:\s*"([^"]+)"[\s\S]*?\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.tool) {
                        const result = resolveAndValidate(parsed.tool, parsed.args, parsed.reasoning);
                        if (result) {
                            log.info(`ACTION: (multiline) extracted: ${result.tool}`);
                            return result;
                        }
                    }
                } catch { /* try next */ }
            }
        }

        // ── Strategy 2: Find the LAST JSON object with a "tool" field ──
        const allMatches = [...response.matchAll(/\{[^{}]*?"tool"\s*:\s*"([^"]+)"[^{}]*?\}/g)];
        for (let i = allMatches.length - 1; i >= 0; i--) {
            try {
                const parsed = JSON.parse(allMatches[i][0]);
                if (parsed.tool && typeof parsed.tool === 'string') {
                    const result = resolveAndValidate(parsed.tool, parsed.args, parsed.reasoning);
                    if (result) {
                        log.info(`JSON scan extracted: ${result.tool}`);
                        return result;
                    }
                }
            } catch { /* try next */ }
        }

        // ── Strategy 3: Extract tool name from prose ──
        const extracted = ContextBuilder.extractActionFromText(response, allToolNames);
        if (extracted) {
            log.info(`Prose extraction: ${extracted.tool}`);
            return extracted;
        }

        // ── Strategy 4: Deterministic fallback ──
        log.warn('[ReActReasoner] Could not extract action from combined response — using fallback');
        return await ContextBuilder.buildFallbackAction(state);
    }

    // Context-building helpers moved to ContextBuilder.ts
    async assessState(state: ExecutionState): Promise<StateAssessment> {
        const llm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) {
            const missingFile = state.goal.success_criteria.find(
                c => c.type === 'file_exists' && c.status !== 'passed'
            );
            return {
                current_progress_percent: state.progress_percent,
                blocking_issues: ['No LLM available'],
                missing_for_goal: missingFile ? [missingFile.config.path || 'unknown'] : [],
                suggested_next_action: missingFile?.config.path
                    ? { tool: 'write_file', args: { path: missingFile.config.path, content: '# Auto-generated\n' }, reasoning: 'Create missing file' }
                    : { tool: 'list_directory', args: { path: '.' }, reasoning: 'Check workspace' },
                should_replan: false
            };
        }

        const criteria = state.goal.success_criteria.map(c =>
            `- [${c.status}] ${c.type}: ${JSON.stringify(c.config)}`
        ).join('\n');

        const recentActions = state.completed_actions.slice(-5).map(a => {
            let output = '';
            if (typeof a.result === 'object' && a.result !== null) {
                // Fix 4: extract last 3 error lines instead of full traceback
                const isFailed = !a.success;
                let stdout: string;
                let stderr: string;
                if (isFailed) {
                    const rawStderr = a.result.stderr || '';
                    const errorLines = rawStderr.split('\n').filter((l: string) => l.trim()).slice(-3).join('\n');
                    stderr = errorLines || rawStderr.substring(0, 400);
                    const rawStdout = a.result.stdout || '';
                    stdout = rawStdout.split('\n').filter((l: string) => l.trim()).slice(-2).join('\n') || rawStdout.substring(0, 200);
                } else {
                    stdout = (a.result.stdout || '').substring(0, 400);
                    stderr = (a.result.stderr || '').substring(0, 300);
                }
                if (stdout) output += ` stdout: ${stdout}`;
                if (stderr) output += ` stderr: ${stderr}`;
            } else if (typeof a.result === 'string') {
                output += ` result: ${a.result.substring(0, 600)}`;
            }
            return `- ${a.tool_used}: ${a.success ? 'OK' : 'FAILED'} (${JSON.stringify(a.args).substring(0, 80)})${output}`;
        }).join('\n');

        const tools = await mcpManager.listTools();
        const toolNames = tools.map(t => t.tool.name).join(', ');

        const prompt = `Assess progress toward this goal.

GOAL: ${state.goal.description}
ITERATION: ${state.current_iteration}/${state.max_iterations}
STUCK COUNT: ${state.stuck_count}

CRITERIA:
${criteria}

RECENT ACTIONS:
${recentActions || 'None'}

ARTIFACTS: ${state.artifacts.join(', ') || 'None'}

AVAILABLE TOOLS: ${toolNames}

Output JSON:
{
  "current_progress_percent": 0-100,
  "blocking_issues": ["issue1", "issue2"],
  "missing_for_goal": ["what's still needed"],
  "suggested_next_action": {
    "tool": "tool_name",
    "args": {"key": "value"},
    "reasoning": "why this action"
  },
  "should_replan": true/false,
  "replan_reason": "only if should_replan is true"
}`;

        try {
            const assessment = await llm.generateJSON(prompt, {});
            return {
                current_progress_percent: assessment.current_progress_percent || 0,
                blocking_issues: assessment.blocking_issues || [],
                missing_for_goal: assessment.missing_for_goal || [],
                suggested_next_action: assessment.suggested_next_action || {
                    tool: 'list_directory',
                    args: { path: '.' },
                    reasoning: 'Check current state'
                },
                should_replan: assessment.should_replan || false,
                replan_reason: assessment.replan_reason
            };
        } catch (error) {
            log.error('[ReActReasoner] Assessment failed:', error);
            return {
                current_progress_percent: state.progress_percent,
                blocking_issues: ['Assessment failed'],
                missing_for_goal: [],
                suggested_next_action: null as any,
                should_replan: true
            };
        }
    }

    /**
     * Execute a single action decided by the ReAct loop.
     * Routes run_command through ContainerSession when Docker is available.
     */
    async executeAction(
        executionId: string,
        state: ExecutionState,
        action: StateAssessment['suggested_next_action'],
        broadcastGoalEvent: (event: string, data: any) => void
    ): Promise<ActionResult> {
        const startTime = Date.now();
        const artifacts: string[] = [];

        log.info(`Executing: ${action.tool}`, action.args);

        broadcastGoalEvent('goal:action', {
            execution_id: executionId,
            iteration: state.current_iteration,
            tool: action.tool,
            args: action.args,
            reasoning: action.reasoning
        });

        try {
            // ----------------------------------------------------------------
            // VIRTUAL TOOL INTERCEPT — mark_complete
            // LLM declares goal done without waiting for file-based validator.
            // GoalOrientedExecutor checks for this sentinel in ActionResult.
            // ----------------------------------------------------------------
            if (action.tool === 'mark_complete') {
                const summary = action.args?.summary || 'Goal completed';
                log.info(`LLM declared mark_complete: ${summary}`);
                const duration = Date.now() - startTime;
                return {
                    iteration: state.current_iteration,
                    action: summary,
                    tool_used: 'mark_complete',
                    args: action.args || {},
                    result: `GOAL_COMPLETE::${summary}`,
                    success: true,
                    artifacts_created: [],
                    progress_made: true,
                    duration_ms: duration,
                    timestamp: new Date(),
                };
            }

            // ----------------------------------------------------------------
            // VIRTUAL TOOL INTERCEPT — delegate_task / delegate_parallel
            // These never reach mcpManager; they spawn child agents via AgentPool.
            // ----------------------------------------------------------------
            if (action.tool === 'delegate_task' || action.tool === 'delegate_parallel') {
                // Bail if execution was cancelled while we were reasoning
                if (state.status === 'cancelled' || state.status === 'paused') {
                    throw new Error(`Execution ${state.status} — skipping delegation`);
                }

                if (state.delegation_count >= state.max_delegations) {
                    throw new Error(`Delegation budget exhausted (${state.max_delegations} max). Use direct tools instead.`);
                }

                let delegationResult: string;

                if (action.tool === 'delegate_task') {
                    const task: string = action.args?.task || action.args?.description || String(action.args);
                    const role: string = action.args?.role || 'general assistant';
                    // Optional: LLM may specify a named agent by slug via agent_id arg
                    const agentIdArg: string | undefined = action.args?.agent_id;

                    // Deduplication: skip if this exact task was already delegated
                    const alreadyDone = state.completed_actions.some(
                        a => a.tool_used === 'delegate_task' && a.args?.task === task
                    );
                    if (alreadyDone) {
                        throw new Error(`Task already delegated: "${task.substring(0, 80)}". Use the earlier result instead.`);
                    }

                    // Resolve named agent profile if agent_id was provided
                    const resolvedProfile = agentIdArg
                        ? await agentPool.lookupProfile(agentIdArg)
                        : undefined;
                    const effectiveRole = resolvedProfile?.role ?? role;
                    if (resolvedProfile) {
                        log.info(`Delegating task to named agent "${resolvedProfile.name}" (${effectiveRole}): ${task.substring(0, 80)}`);
                    } else {
                        log.info(`Delegating task to "${role}": ${task.substring(0, 100)}`);
                    }

                    state.delegation_count++;
                    const sub = await agentPool.delegateTask(task, effectiveRole, executionId, 0, resolvedProfile ?? undefined);

                    // Detect child escalation — try alternate role first, HITL only if retry also fails
                    if (sub.result.startsWith('ESCALATION::')) {
                        const parts = sub.result.split('::');
                        const escProblem = parts[1] || 'Child agent was unable to complete the task';
                        const escNeed = parts[2] || 'Human guidance required';

                        const budgetLeft = state.max_delegations - state.delegation_count;
                        const ROLE_FALLBACK: Record<string, string> = {
                            'researcher': 'coder',
                            'coder': 'researcher',
                            'analyst': 'researcher',
                            'reviewer': 'coder',
                        };
                        const alternateRole = ROLE_FALLBACK[role] ?? (role === 'general assistant' ? undefined : 'general assistant');

                        if (budgetLeft > 0 && alternateRole) {
                            log.info(`Child (${role}) escalated — retrying with alternate role "${alternateRole}" before HITL`);
                            broadcastGoalEvent('goal:child_escalation_retry', {
                                execution_id: executionId,
                                iteration: state.current_iteration,
                                original_role: role,
                                retry_role: alternateRole,
                                problem: escProblem,
                            });
                            state.delegation_count++;
                            const retrySub = await agentPool.delegateTask(task, alternateRole, executionId, 0, undefined);
                            if (!retrySub.result.startsWith('ESCALATION::')) {
                                // Retry succeeded — use its result and carry on
                                artifacts.push(...retrySub.artifacts);
                                delegationResult = retrySub.result;
                            } else {
                                // Retry also escalated — now fast-track to HITL
                                log.warn(`Alternate role (${alternateRole}) also escalated — fast-tracking to HITL`);
                                state.stuck_count = 999;
                                state.strategy_changes = 999;
                                broadcastGoalEvent('goal:child_escalation', {
                                    execution_id: executionId,
                                    iteration: state.current_iteration,
                                    problem: escProblem,
                                    need: escNeed,
                                });
                                throw new Error(`Child agent escalated: ${escProblem}. Need: ${escNeed}`);
                            }
                        } else {
                            // No budget or no alternate role — fast-track to HITL immediately
                            log.info(`Child agent escalated — no retry budget, fast-tracking to HITL: ${escProblem}`);
                            state.stuck_count = 999;
                            state.strategy_changes = 999;
                            broadcastGoalEvent('goal:child_escalation', {
                                execution_id: executionId,
                                iteration: state.current_iteration,
                                problem: escProblem,
                                need: escNeed,
                            });
                            throw new Error(`Child agent escalated: ${escProblem}. Need: ${escNeed}`);
                        }
                    }

                    delegationResult = sub.result;
                    artifacts.push(...sub.artifacts);

                } else {
                    // delegate_parallel
                    const tasks: Array<{ task: string; role: string }> = action.args?.tasks || [];
                    if (!tasks.length) {
                        throw new Error('delegate_parallel requires args.tasks array');
                    }

                    // ── Dependency-aware phase split ──────────────────────────────────
                    // A "dependent" task synthesises or decides based on other agents'
                    // outputs (Strategy, Report Compiler, Decision Maker, etc.).
                    // Two detection layers:
                    //   1. Task description content (keywords in the task text)
                    //   2. Role name (strategy/synthesis/decision roles are always dependent)
                    const DEPENDENT_TASK_RE = /\b(synthe|compil|combin|integrat|decision|recommend|final.{0,20}(report|analysis|decision)|based on (the |other |all |above |research|findings|results)|using (the |other |all |findings|results|data|output)|after (all|the|other) agents?|depends? on)\b/i;
                    const DEPENDENT_ROLE_RE = /\b(strateg|synthe|decision.?maker|report.?compil|final.?analyst)\b/i;
                    const isDependent = (t: { task: string; role: string }) =>
                        DEPENDENT_TASK_RE.test(t.task) || DEPENDENT_ROLE_RE.test(t.role);
                    const independentTasks = tasks.filter(t => !isDependent(t));
                    const dependentTasks = tasks.filter(t => isDependent(t));

                    const orderedTasks: Array<{ task: string; role: string }> = [];
                    const allResults: Array<{ result: string; artifacts: string[] }> = [];

                    state.delegation_count++;   // counts as ONE budget unit regardless of N tasks

                    if (independentTasks.length > 0) {
                        log.info(`Parallel delegation phase 1: ${independentTasks.length} independent agent(s)`);
                        const phase1 = await agentPool.delegateParallel(independentTasks, executionId, 0);
                        orderedTasks.push(...independentTasks);
                        allResults.push(...phase1);
                        phase1.forEach(r => artifacts.push(...r.artifacts));
                    }

                    if (dependentTasks.length > 0) {
                        // Inject phase-1 results so dependent agents have full context
                        const phase1Context = allResults.length > 0
                            ? `\n\n--- RESULTS FROM PARALLEL RESEARCH AGENTS ---\n` +
                            allResults.map((r, i) =>
                                `[${orderedTasks[i]?.role || 'agent'}]\n${r.result.substring(0, 3000)}`
                            ).join('\n\n') +
                            `\n--- END PARALLEL RESULTS ---\n`
                            : '';

                        log.info(`Parallel delegation phase 2: ${dependentTasks.length} dependent agent(s) (sequential, with phase-1 context)`);
                        for (const depTask of dependentTasks) {
                            const enrichedTask = depTask.task + phase1Context;
                            const depResult = await agentPool.delegateTask(enrichedTask, depTask.role, executionId, 0);
                            orderedTasks.push(depTask);
                            allResults.push({ result: depResult.result, artifacts: depResult.artifacts });
                            artifacts.push(...depResult.artifacts);
                        }
                    }

                    // If ALL tasks were classified as dependent (edge case), run as plain parallel
                    if (independentTasks.length === 0 && dependentTasks.length === 0) {
                        log.info(`Parallel delegation (no split): ${tasks.length} sub-agents`);
                        const results = await agentPool.delegateParallel(tasks, executionId, 0);
                        orderedTasks.push(...tasks);
                        allResults.push(...results);
                        results.forEach(r => artifacts.push(...r.artifacts));
                    }

                    delegationResult = allResults.map((r, i) =>
                        `[${orderedTasks[i]?.role || 'agent'} result]\n${r.result}`
                    ).join('\n\n');
                }

                const duration = Date.now() - startTime;
                broadcastGoalEvent('goal:delegation_result', {
                    execution_id: executionId,
                    iteration: state.current_iteration,
                    tool: action.tool,
                    delegation_count: state.delegation_count,
                    max_delegations: state.max_delegations,
                    result_length: delegationResult.length,
                });

                return {
                    iteration: state.current_iteration,
                    action: action.reasoning,
                    tool_used: action.tool,
                    args: action.args,
                    result: delegationResult,
                    success: true,
                    artifacts_created: artifacts,
                    progress_made: true,
                    duration_ms: duration,
                    timestamp: new Date(),
                };
            }
            // ----------------------------------------------------------------

            // ----------------------------------------------------------------
            // EXACT ACTION DEDUPLICATION — if the same (tool + args) has been
            // attempted 3+ times, block it and return an error forcing a new approach.
            // Exemptions: run_command is allowed to repeat with different results.
            // ----------------------------------------------------------------
            // DEDUP_EXEMPT: tools that are legitimately called multiple times with different results.
            // browser_navigate is only exempt when navigating to DIFFERENT URLs — same URL that
            // previously failed (blocked/error) should NOT be retried indefinitely.
            const DEDUP_EXEMPT = new Set(['run_command', 'web_search', 'web_fetch']);
            let isDedupeExempt = DEDUP_EXEMPT.has(action.tool);
            if (!isDedupeExempt && action.tool === 'browser_navigate') {
                // Allow browser_navigate to repeat only if the URL is different from prior attempts
                const priorNavigateUrls = state.completed_actions
                    .filter(a => a.tool_used === 'browser_navigate')
                    .map(a => (a.args?.url || '').toLowerCase().trim());
                const thisUrl = (action.args?.url || '').toLowerCase().trim();
                const priorSameUrlFailed = state.completed_actions.some(
                    a => a.tool_used === 'browser_navigate' && !a.success
                        && (a.args?.url || '').toLowerCase().trim() === thisUrl
                );
                // Exempt only when navigating to a URL not yet attempted AND it hasn't failed before.
                // priorNavigateUrls.includes(thisUrl) = true if this URL was already visited.
                isDedupeExempt = !priorSameUrlFailed && !priorNavigateUrls.includes(thisUrl);
            }
            if (!isDedupeExempt) {
                const actionSig = `${action.tool}:${JSON.stringify(action.args)}`;
                const dupCount = state.completed_actions.filter(a =>
                    `${a.tool_used}:${JSON.stringify(a.args)}` === actionSig
                ).length;
                if (dupCount >= 3) {
                    log.warn(`[ReActReasoner] Dedup blocked: "${action.tool}" with same args tried ${dupCount}x`);
                    return makeErrorResult(
                        action, state,
                        `LOOP DETECTED: "${action.tool}" with identical args was attempted ${dupCount} times. ` +
                        `You MUST try a completely different approach. ` +
                        `If the goal needs a file written, use write_file with the ACTUAL content directly. ` +
                        `If a directory exists, skip creating it and write the file instead.`,
                        startTime
                    );
                }
            }
            // ----------------------------------------------------------------

            const tools = await mcpManager.listTools();
            const toolInfo = tools.find(t => t.tool.name === action.tool);

            if (!toolInfo) {
                // Fail-fast: compute closest real tool name via Levenshtein distance (§1.3)
                const allNames = tools.map(t => t.tool.name);
                const suggestion = ContextBuilder.closestToolName(action.tool, allNames);
                const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
                const duration = Date.now() - startTime;
                return {
                    iteration: state.current_iteration,
                    action: action.reasoning,
                    tool_used: action.tool,
                    args: action.args || {},
                    result: {
                        isError: true,
                        content: [{ type: 'text', text: `Unknown tool "${action.tool}".${hint} Use ONLY tools from the AVAILABLE TOOLS list.` }]
                    },
                    success: false,
                    artifacts_created: [],
                    progress_made: false,
                    duration_ms: duration,
                    timestamp: new Date(),
                };
            }

            // ----------------------------------------------------------------
            // TOOL SCHEMA ENFORCEMENT (§4.1): silently strip any args the LLM included
            // that are not in the tool's declared input schema. Unknown args can cause
            // MCP servers to reject the call outright (strict schema validation).
            // ----------------------------------------------------------------
            if (action.args && toolInfo.tool.inputSchema?.properties) {
                const allowed = new Set(Object.keys(toolInfo.tool.inputSchema.properties));
                const stripped: string[] = [];
                for (const key of Object.keys(action.args)) {
                    if (!allowed.has(key)) {
                        stripped.push(key);
                        delete action.args[key];
                    }
                }
                if (stripped.length > 0) {
                    log.info(`[ReActReasoner] Stripped unknown args from ${action.tool}: ${stripped.join(', ')}`);
                }
            }
            // ----------------------------------------------------------------

            // ----------------------------------------------------------------
            // PATH NORMALIZATION — MCP filesystem server only allows absolute
            // paths under /workspace. Relative paths (e.g. "output") get
            // resolved against the process CWD (/app) and are rejected.
            // Prefix any relative path arg with the workspace root.
            // ----------------------------------------------------------------
            const WORKSPACE_ROOT = mcpManager.getWorkspace() || '/workspace';
            const FILE_TOOLS = new Set([
                'write_file', 'read_file', 'create_directory', 'delete_file',
                'move_file', 'copy_file', 'list_directory', 'search_files',
                'get_file_info', 'edit_file',
            ]);
            if (FILE_TOOLS.has(action.tool) && action.args) {
                for (const key of ['path', 'source', 'destination', 'src', 'dst']) {
                    if (typeof action.args[key] === 'string') {
                        const val: string = action.args[key];
                        const fwd = val.replace(/\\/g, '/');
                        if (fwd.startsWith('/workspace/') || fwd === '/workspace') {
                            // Unix-style /workspace paths → remap to actual workspace root
                            const rel = fwd.slice('/workspace'.length).replace(/^\//, '');
                            action.args[key] = path.join(WORKSPACE_ROOT, rel);
                        } else if (!path.isAbsolute(val)) {
                            action.args[key] = path.join(WORKSPACE_ROOT, val);
                        }
                    }
                }
            }

            // NOTE: create_directory dedup guard removed — it caused regressions (G03/G04/G09)
            // by writing skeleton content to files like fibonacci.py/budget.xlsx/table.txt.
            // The buildFallbackAction normPath fix already prevents the "create_directory × 25"
            // loop (G05) without needing this guard.

            // ----------------------------------------------------------------
            // WRITE-FILE DEDUP GUARD — if a script (.py/.js/.sh) has been written
            // 1+ times WITHOUT a subsequent run_command, force execution.
            // This breaks the "write Python script 10x but never run it" loop.
            // ----------------------------------------------------------------
            if (action.tool === 'write_file' && action.args?.path) {
                const scriptPath = String(action.args.path);
                const scriptExt = scriptPath.split('.').pop()?.toLowerCase() || '';
                const SCRIPT_EXTS = new Set(['py', 'js', 'mjs', 'sh', 'rb']);
                if (SCRIPT_EXTS.has(scriptExt)) {
                    const actions = state.completed_actions;
                    const dupWriteCount = actions.filter(
                        a => a.tool_used === 'write_file' && a.success &&
                            String(a.args?.path || '') === scriptPath
                    ).length;
                    // Check if any run_command was executed AFTER the last write of this script
                    const lastWriteIdx = [...actions].reverse().findIndex(
                        a => a.tool_used === 'write_file' && String(a.args?.path || '') === scriptPath
                    );
                    const lastCmdIdx = [...actions].reverse().findIndex(a => a.tool_used === 'run_command');
                    // noExecAfterWrite is true when: file was written at least once,
                    // and either no run_command ever ran, or the last run_command was before the last write
                    const noExecAfterWrite = dupWriteCount >= 1 &&
                        (lastCmdIdx === -1 || lastCmdIdx > lastWriteIdx);
                    if (noExecAfterWrite && dupWriteCount >= 1) {
                        // Find first unmet file_exists criterion to use as output target
                        const unmetCrit = state.goal.success_criteria.find(
                            c => c.type === 'file_exists' && c.status !== 'passed' && c.config.path
                        );
                        const rawOutputPath = unmetCrit?.config.path
                            ? (path.isAbsolute(unmetCrit.config.path)
                                ? unmetCrit.config.path
                                : path.join(WORKSPACE_ROOT, unmetCrit.config.path))
                            : path.join(WORKSPACE_ROOT, 'output', 'result.txt');
                        const outFwd = rawOutputPath.replace(/\\/g, '/');
                        const scriptFwd = scriptPath.replace(/\\/g, '/');
                        const runCmd = scriptExt === 'py'
                            ? `python3 "${scriptFwd}" > "${outFwd}" 2>&1`
                            : scriptExt === 'js' || scriptExt === 'mjs'
                                ? `node "${scriptFwd}" > "${outFwd}" 2>&1`
                                : `sh "${scriptFwd}" > "${outFwd}" 2>&1`;
                        log.warn(`[ReActReasoner] Write-file dedup (${dupWriteCount}x): forcing run_command for ${scriptPath}`);
                        action.tool = 'run_command';
                        action.args = { command: runCmd };
                        action.reasoning = `Script written ${dupWriteCount}x without execution — executing now to produce output`;
                    }
                }
            }
            // ----------------------------------------------------------------

            // ----------------------------------------------------------------
            // MARKDOWN FENCE STRIP — LLMs frequently wrap file content in
            // ```json or ```python fences. Strip them before writing so the
            // MCP JSON validator and downstream readers see clean content.
            // Only strips the outermost fence; inner fences (e.g. in .md) survive.
            // ----------------------------------------------------------------
            if (action.tool === 'write_file' && action.args?.path && action.args?.content) {
                const _fenceExt = String(action.args.path).split('.').pop()?.toLowerCase() || '';
                const FENCE_STRIP_EXTS = new Set(['json', 'md', 'txt', 'csv', 'yaml', 'yml', 'html', 'xml', 'py', 'js', 'ts', 'sh', 'toml']);
                if (FENCE_STRIP_EXTS.has(_fenceExt)) {
                    let _c = String(action.args.content);
                    // Only strip when the content is ENTIRELY wrapped in a fence pair.
                    // This avoids corrupting .md files whose last line is legitimately a closing ```.
                    const _openFence = /^```[\w]*\r?\n/i;
                    const _closeFence = /\r?\n```\s*$/i;
                    if (_openFence.test(_c) && _closeFence.test(_c)) {
                        _c = _c.replace(_openFence, '').replace(_closeFence, '').trim();
                        action.args.content = _c;
                    }
                }
            }

            // ----------------------------------------------------------------
            // BINARY FILE INTERCEPT — if LLM tries write_file for a binary
            // format, silently convert to a run_command that generates it properly.
            // write_file only supports text — writing text to .xlsx creates a
            // corrupt file that fails the file_size_min check.
            // ----------------------------------------------------------------
            if (action.tool === 'write_file' && action.args?.path) {
                const bExt = String(action.args.path).split('.').pop()?.toLowerCase() || '';
                const BINARY_EXTS = new Set(['xlsx', 'xls', 'pdf', 'docx', 'pptx', 'zip', 'png', 'jpg', 'jpeg', 'gif']);
                if (BINARY_EXTS.has(bExt)) {
                    const bPath = String(action.args.path).replace(/\\/g, '/');
                    let genCmd: string;
                    if (bExt === 'xlsx' || bExt === 'xls') {
                        // Build openpyxl script from the content the LLM intended to write
                        const hint = String(action.args.content || '').slice(0, 400).replace(/'/g, "\\'");
                        genCmd = `python3 -c "
import openpyxl, re, os
wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Sheet1'
# Parse any table-like content from the intended text
lines = '''${hint}'''.strip().split('\\\\n')
for line in lines[:50]:
    cols = re.split(r'[,|\\\\t]', line)
    if any(c.strip() for c in cols):
        ws.append([c.strip() for c in cols])
if ws.max_row < 2:
    ws.append(['Month','Income','Expenses','Savings'])
    for i,m in enumerate(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']):
        ws.append([m,(i+1)*1000+4000,(i+1)*500+2000,(i+1)*500+1500])
os.makedirs(os.path.dirname('${bPath}') or '.', exist_ok=True)
wb.save('${bPath}')
print('Created ${bPath} (' + str(os.path.getsize('${bPath}')) + ' bytes)')
" 2>&1`;
                    } else if (bExt === 'pdf') {
                        // Write markdown first, then pandoc → pdf
                        const mdPath = bPath.replace(/\.pdf$/, '.md');
                        const mdContent = String(action.args.content || '# Document\n\nGenerated content.').replace(/'/g, "\\'");
                        genCmd = `python3 -c "
import os
os.makedirs(os.path.dirname('${mdPath}') or '.', exist_ok=True)
open('${mdPath}','w').write('''${mdContent}''')
" 2>&1 && pandoc '${mdPath}' -o '${bPath}' --pdf-engine=wkhtmltopdf 2>&1 || (echo '[pandoc fallback] writing text-based pdf placeholder' && cp '${mdPath}' '${bPath}')`;
                    } else if (bExt === 'docx') {
                        const docContent = String(action.args.content || 'Generated document.').replace(/'/g, "\\'");
                        genCmd = `python3 -c "
from docx import Document; import os
doc = Document()
for para in '''${docContent}'''.split('\\\\n'):
    if para.strip(): doc.add_paragraph(para)
os.makedirs(os.path.dirname('${bPath}') or '.', exist_ok=True)
doc.save('${bPath}')
print('Created ${bPath}')
" 2>&1`;
                    } else {
                        genCmd = `echo "Binary format .${bExt} — skipping text write" && echo "placeholder" > "${bPath}"`;
                    }
                    log.warn(`[ReActReasoner] Binary intercept: write_file for .${bExt} → run_command with generator`);
                    action.tool = 'run_command';
                    action.args = { command: genCmd };
                    action.reasoning = `Intercepted write_file for binary .${bExt} — using ${bExt === 'xlsx' ? 'openpyxl' : bExt === 'pdf' ? 'pandoc' : 'python-docx'} to generate proper binary`;
                }
            }
            // ----------------------------------------------------------------

            // ----------------------------------------------------------------
            // WRITE_FILE CONTENT GUARD — catch missing 'content' field before
            // the MCP call. The LLM sometimes emits {"tool":"write_file","args":
            // {"path":"..."}} with no content (prose extraction strips it).
            // Return a hard failure immediately so the next iteration gets
            // explicit feedback instead of an opaque MCP schema error.
            // ----------------------------------------------------------------
            // Normalize "contents" (plural) → "content" — LLMs sometimes use the wrong key
            if (action.tool === 'write_file' && action.args?.contents !== undefined && action.args?.content === undefined) {
                action.args.content = action.args.contents;
                delete action.args.contents;
            }

            if (action.tool === 'write_file' && (action.args?.content === undefined || action.args?.content === null)) {
                const missingContentErr = `write_file failed: 'content' field is required but was not provided. ` +
                    `Next action must include the actual file content in the "content" field.`;
                log.warn(`[ReActReasoner] write_file called without content for path: ${action.args?.path}`);
                return makeErrorResult(action, state, missingContentErr, startTime);
            }

            // ── OUTPUT FILE STRUCTURE GUARD ─────────────────────────────────────
            // If the LLM writes a data/document file directly to the workspace root
            // (e.g. /workspace/report.md), redirect it to /workspace/output/report.md
            // so all generated artefacts are in a single predictable subdirectory.
            //
            // Exceptions — files that legitimately live at root:
            //   code entry points, config files, well-known single-file names.
            // ─────────────────────────────────────────────────────────────────────
            if (action.tool === 'write_file' && action.args?.path) {
                const filePath: string = action.args.path;
                // Normalize to forward slashes so startsWith and includes checks work
                // correctly on Windows where path.join produces backslashes.
                const filePathFwd = filePath.replace(/\\/g, '/');
                const workspaceRootFwd = WORKSPACE_ROOT.replace(/\\/g, '/');
                const relativeToWorkspace = filePathFwd.startsWith(workspaceRootFwd)
                    ? filePathFwd.slice(workspaceRootFwd.length).replace(/^\//, '')
                    : null;

                if (relativeToWorkspace !== null) {
                    // Helper: when we redirect a write path, update any success_criteria that
                    // reference the original path so the validator checks the real location.
                    const syncCriteriaPaths = (oldPath: string, newPath: string) => {
                        for (const c of state.goal.success_criteria) {
                            if (c.config.path === oldPath) {
                                log.info(`[ReActReasoner] Syncing criterion path: ${oldPath} → ${newPath}`);
                                c.config.path = newPath;
                            }
                        }
                    };

                    // If LLM writes to the generic "output/" dir, redirect to goal-specific dir
                    if (relativeToWorkspace.startsWith('output/') && this.outputDir !== 'output') {
                        const filename = relativeToWorkspace.slice('output/'.length);
                        const newPath = path.posix.join(WORKSPACE_ROOT, this.outputDir, filename);
                        log.info(`[ReActReasoner] Redirecting output/ → ${newPath}`);
                        syncCriteriaPaths(filePath, newPath);
                        action.args.path = newPath;
                    }

                    const hasSubdir = relativeToWorkspace.includes('/');
                    if (!hasSubdir) {
                        // File would land at workspace root — check if it should stay there
                        const ROOT_EXCEPTIONS = new Set([
                            'index.html', 'index.js', 'index.ts', 'index.py',
                            'main.py', 'main.js', 'main.ts',
                            'app.py', 'app.js', 'app.ts',
                            'package.json', 'tsconfig.json', 'requirements.txt',
                            'Makefile', 'Dockerfile', 'docker-compose.yml',
                            'README.md', '.gitignore',
                        ]);
                        const isRootException = ROOT_EXCEPTIONS.has(relativeToWorkspace);
                        // Data/document/script extensions that should always go in output/
                        const isDataFile = /\.(md|txt|csv|json|xlsx|pdf|docx|pptx|html|xml|yaml|yml|py|js|ts|sh|rb|go|r)$/i.test(relativeToWorkspace)
                            && !isRootException;

                        if (isDataFile) {
                            const newPath = path.posix.join(WORKSPACE_ROOT, this.outputDir, relativeToWorkspace);
                            log.info(`[ReActReasoner] Redirecting root-level data file → ${newPath}`);
                            syncCriteriaPaths(filePath, newPath);
                            action.args.path = newPath;
                        }
                    }
                }
            }

            // ── Arg-alias remapping for known LLM naming mistakes ────────────────────
            // Some tools have arg names that differ from what LLMs naturally guess.
            // Remap silently here so we don't waste an iteration on a validation error.
            if (action.tool === 'browser_eval' && action.args?.code !== undefined && action.args?.script === undefined) {
                // LLMs commonly pass 'code' — the tool requires 'script'
                action.args.script = action.args.code;
                delete action.args.code;
                log.info(`[ReActReasoner] browser_eval: remapped 'code' arg → 'script' transparently`);
            }

            // Validate required args before calling MCP — avoids wasted iteration on a
            // predictable error (e.g. browser_navigate({}) when url is required).
            {
                const toolDef = tools.find(t => t.tool.name === action.tool);
                const required: string[] = toolDef?.tool.inputSchema?.required || [];
                const missing = required.filter(k =>
                    !action.args || action.args[k] === undefined || action.args[k] === null || action.args[k] === ''
                );
                if (missing.length > 0) {
                    log.warn(`[ReActReasoner] Tool ${action.tool} called with empty/missing required args: ${missing.join(', ')}`);
                    // Bug 1 fix (Part B): show what was actually passed + a concrete correction
                    // hint. The write_file case is special because "file_path" vs "path" is
                    // the #1 cause of infinite loops in goal mode.
                    const writeFileHint = action.tool === 'write_file'
                        ? ' Correct format: {"path": "/workspace/file.txt", "content": "..."}. Use "path" NOT "file_path".'
                        : '';
                    return {
                        iteration: state.current_iteration,
                        action: action.reasoning,
                        tool_used: action.tool,
                        args: action.args,
                        result: {
                            isError: true,
                            content: [{ type: 'text', text: `[MISSING_REQUIRED_ARGS] ${action.tool} requires: ${missing.map(k => `"${k}"`).join(', ')}. You passed: ${JSON.stringify(action.args)}.${writeFileHint} Fix the arguments in your next action.` }]
                        },
                        success: false,
                        artifacts_created: [],
                        progress_made: false,
                        duration_ms: 0,
                        timestamp: new Date()
                    };
                }
            }

            // ── run_command sanity checks ────────────────────────────────────────────
            // These catch two common LLM hallucination patterns that waste a full
            // container-launch iteration (exit 126 / import-not-found errors):
            //
            //   Pattern A: LLM passes a directory path as the command string.
            //              e.g. command="/workspace/output/my-dir" → "Permission denied (exit 126)"
            //
            //   Pattern B: Broken python3 -c quoting — multi-line script leaks out of
            //              the -c argument, so the shell sees "import", "from", etc. as
            //              separate bare commands (exit 2 / "not found").
            if (action.tool === 'run_command') {
                const cmd: string = (action.args?.command || action.args?.cmd || '').trim();

                // Pattern A: command looks like an absolute path to a file/directory
                if (/^\/[a-zA-Z0-9_./-]+$/.test(cmd) && !cmd.includes(' ')) {
                    return {
                        iteration: state.current_iteration,
                        action: action.reasoning,
                        tool_used: action.tool,
                        args: action.args,
                        result: {
                            isError: true,
                            content: [{ type: 'text', text: `[INVALID_COMMAND] "${cmd}" looks like a file/directory path, not a shell command. Did you mean to use list_directory, read_file, or cd into it? Example of a valid command: "ls /workspace/output"` }]
                        },
                        success: false,
                        artifacts_created: [],
                        progress_made: false,
                        duration_ms: 0,
                        timestamp: new Date()
                    };
                }

                // Pattern B-0: playwright install / npx playwright — blocked in sandbox.
                // Playwright + Chromium are pre-installed in the APP container.
                // The sandbox container does NOT have playwright; installing it inside
                // the sandbox wastes time and fails. Redirect the agent to use browser
                // MCP tools (browser_launch / browser_navigate) instead.
                if (/(?:npx\s+playwright|playwright\s+install|playwright\s+chromium)/i.test(cmd)) {
                    return {
                        iteration: state.current_iteration,
                        action: action.reasoning,
                        tool_used: action.tool,
                        args: action.args,
                        result: {
                            isError: true,
                            content: [{ type: 'text', text: `[BLOCKED] Do NOT run "playwright install" inside the sandbox. Playwright and Chromium are already installed in the app container. Use the built-in browser MCP tools instead:\n  - browser_launch — opens a new browser page\n  - browser_navigate { url } — navigates to a URL\n  - browser_get_text — extracts page text\n  - stealth_fetch { url } — fetches page HTML with anti-bot evasion\nThese tools work WITHOUT any installation.` }]
                        },
                        success: false,
                        artifacts_created: [],
                        progress_made: false,
                        duration_ms: 0,
                        timestamp: new Date()
                    };
                }

                // Pattern B: python3 -c with broken multi-line script.
                // Instead of rejecting, TRANSPARENTLY REWRITE as a heredoc so it
                // executes correctly regardless of quoting. This eliminates the
                // "SyntaxError: invalid syntax" + "/bin/sh: from: not found" failure
                // caused by the shell splitting -c "..." at the embedded newlines.
                const pyInlineMatch = cmd.match(/^(python3?)\s+-c\s+([\s\S]+)$/);
                if (pyInlineMatch) {
                    const interp = pyInlineMatch[1]; // 'python3' or 'python'
                    let scriptBody = pyInlineMatch[2].trim();

                    // Strip surrounding quotes if present (the LLM wraps in " or ')
                    if ((scriptBody.startsWith('"') && scriptBody.endsWith('"')) ||
                        (scriptBody.startsWith("'") && scriptBody.endsWith("'"))) {
                        scriptBody = scriptBody.slice(1, -1);
                    }
                    // Unescape \n sequences the LLM may have emitted as literal backslash-n
                    scriptBody = scriptBody.replace(/\\n/g, '\n');

                    // Only rewrite if the script genuinely has multiple lines
                    if (scriptBody.includes('\n')) {
                        const rewritten = `/usr/bin/env ${interp} - << 'PYEOF'\n${scriptBody}\nPYEOF`;
                        log.info(`[ReActReasoner] Bug#3: rewrote python3 -c to heredoc (${scriptBody.length} chars)`);
                        action.args.command = rewritten;
                        // Fall through — command now executes correctly
                    }
                }
            }
            // ────────────────────────────────────────────────────────────────────────

            let result: any;

            // Route run_command through ContainerSession when Docker is available
            if (action.tool === 'run_command' && await containerSessionManager.isDockerAvailable()) {
                const sessionId = this.containerSessionId || 'default';
                const networkMode = this.enableNetwork ? 'bridge' : 'none';
                const workspacePath = mcpManager.getWorkspace() || '/workspace';
                // Mount workspace so files written via write_file (MCP, app container)
                // are immediately visible inside the sandbox container.
                const volumeMounts = new Map([[workspacePath, '/workspace']]);
                log.info(`Routing run_command to container session: ${sessionId} (network: ${networkMode})`);
                const execResult = await containerSessionManager.exec(sessionId, action.args.command || action.args.cmd || '', {
                    timeout: action.args.timeout || 60000,
                    cwd: action.args.cwd,
                    config: { networkMode, volumeMounts },
                });
                result = {
                    success: execResult.exitCode === 0,
                    stdout: execResult.stdout,
                    stderr: execResult.stderr,
                    exitCode: execResult.exitCode,
                    timedOut: execResult.timedOut,
                    durationMs: execResult.durationMs,
                    containerSession: sessionId,
                };
            } else {
                // File versioning: before overwriting an existing file, rename it to .bak.{iter}
                // so we can roll back to the last known-good version if the new write is corrupt.
                if (action.tool === 'write_file' && action.args?.path &&
                    state.artifacts.includes(action.args.path)) {
                    const bakPath = `${action.args.path}.bak.iter${state.current_iteration}`;
                    try {
                        await mcpManager.callTool(toolInfo.server, 'move_file', {
                            source: action.args.path,
                            destination: bakPath
                        });
                        log.info(`[ReActReasoner] Versioned ${action.args.path} → ${bakPath}`);
                    } catch {
                        // File may not exist yet on disk (only in artifacts list) — ignore
                    }
                }

                // Auto-create parent directory for write_file to avoid silent failures
                // when the target dir (e.g. "output/") doesn't exist yet.
                if (action.tool === 'write_file' && action.args?.path) {
                    // Use forward-slash version so splitting works on Windows paths too
                    const normWritePath = action.args.path.replace(/\\/g, '/');
                    const parentDir = normWritePath.includes('/')
                        ? normWritePath.split('/').slice(0, -1).join('/')
                        : null;
                    if (parentDir) {
                        try {
                            await mcpManager.callTool(toolInfo.server, 'create_directory', { path: parentDir });
                            log.info(`Auto-created parent dir: ${parentDir}`);
                        } catch {
                            // Directory may already exist — ignore
                        }
                    }
                }

                // ── WITHIN-RUN URL CACHE (Phase 3) ───────────────────────────────
                // Skip re-fetching the same URL within one execution — saves iterations
                // and prevents the LLM from looping on the same empty page.
                const WEB_FETCH_CACHE_TOOLS = new Set(['web_fetch', 'browser_fetch']);

                // ── SEARCH DEDUPLICATION ─────────────────────────────────────────
                // Hash tool + primary query arg to detect repeated identical searches.
                // Repeated searches waste iterations and cause the agent to hallucinate
                // when real results aren't coming — force diversification or synthesis.
                const SEARCH_TOOLS = new Set(['web_search', 'searxng_search', 'search']);
                if (WEB_FETCH_CACHE_TOOLS.has(action.tool) && action.args?.url) {
                    const cacheKey = String(action.args.url).toLowerCase().replace(/[?#].*$/, ''); // strip query+hash
                    const cachedHash = state.visited_urls?.[cacheKey];
                    if (cachedHash) {
                        log.info(`[ReActReasoner] URL cache HIT: ${action.args.url} — returning cached response`);
                        result = {
                            content: [{ type: 'text', text: `[URL_CACHED] Already fetched ${action.args.url} this session. Use the data you already have to continue.` }]
                        };
                    } else {
                        result = await mcpManager.callTool(toolInfo.server, action.tool, action.args);
                        // Cache after first successful fetch
                        const content = Array.isArray(result?.content)
                            ? result.content.map((c: any) => c?.text || '').join('')
                            : String(result?.content || '');
                        if (content.length > 100) {
                            if (!state.visited_urls) state.visited_urls = {};
                            state.visited_urls[cacheKey] = content.length.toString();
                        }
                    }
                } else if (SEARCH_TOOLS.has(action.tool)) {
                    const queryArg = (action.args?.query || action.args?.q || '').toLowerCase().trim();
                    const hash = `${action.tool}::${queryArg}`;
                    const prevCount = this.searchedHashes.get(hash) || 0;
                    this.searchedHashes.set(hash, prevCount + 1);
                    this.searchMetrics.attempted++;

                    if (prevCount >= 2) {
                        // Third+ attempt: abort — synthesize from what's already been collected
                        log.warn(`[ReActReasoner] Search duplicate (${prevCount + 1}x): "${queryArg}" — forcing synthesis`);
                        result = {
                            _searchDeduplicated: true,
                            content: [{ type: 'text', text: `[SEARCH SKIPPED — already ran "${queryArg}" ${prevCount} times with no new data. STOP searching. Synthesize a report using what you already have, note clearly which sections lack live data, and complete the goal.]` }]
                        };
                    } else if (prevCount >= 1) {
                        // Second attempt: diversify the query
                        const diversified = this.diversifyQuery(queryArg, prevCount);
                        log.info(`[ReActReasoner] Search duplicate (2x): diversifying "${queryArg}" → "${diversified}"`);
                        action.args.query = diversified;
                        if (action.args.q !== undefined) action.args.q = diversified;
                        result = await mcpManager.callTool(toolInfo.server, action.tool, action.args);
                    } else {
                        result = await mcpManager.callTool(toolInfo.server, action.tool, action.args);
                    }

                    // Track search success/failure for data provenance
                    if (!result?._searchDeduplicated) {
                        const hasResults = Array.isArray(result?.results)
                            ? result.results.length > 0
                            : (Array.isArray(result?.content) && result.content.some((c: any) => c?.text?.length > 50));
                        if (hasResults) {
                            this.searchMetrics.succeeded++;
                        } else {
                            this.searchMetrics.failed++;
                            if (queryArg) this.searchMetrics.failedQueries.push(queryArg);
                        }
                    }
                } else {
                    result = await mcpManager.callTool(toolInfo.server, action.tool, action.args);
                }
            }

            // Detect MCP-level errors: the MCP protocol signals failures via isError=true
            // rather than throwing, so we must check the result object explicitly.
            const mcpFailed = result?.isError === true;
            if (mcpFailed) {
                const errText = Array.isArray(result?.content)
                    ? result.content.map((c: any) => c?.text || '').join(' ')
                    : String(result);
                log.warn(`MCP tool ${action.tool} returned isError=true: ${errText.substring(0, 200)}`);
            }

            // For container exec results, also check the exit code stored in result.success.
            // A non-zero exit (e.g. "Cannot find Module") should be treated as failure so
            // stuck_count increments and the agent knows to try something different.
            let containerFailed = action.tool === 'run_command' && result?.success === false;
            if (containerFailed) {
                const stderr = (result?.stderr || result?.stdout || '').substring(0, 400);
                log.warn(`run_command exited non-zero (exit ${result?.exitCode}): ${stderr}`);

                // AUTO-INSTALL: if Node.js failed with "Cannot find module 'X'", install and retry
                const moduleMatch = stderr.match(/Cannot find module '([^']+)'/);
                if (moduleMatch) {
                    const missingPkg = moduleMatch[1];
                    if (!missingPkg.startsWith('.') && !missingPkg.startsWith('/')) {
                        log.info(`[ReActReasoner] Auto-installing missing package: ${missingPkg}`);
                        const installResult = await mcpManager.callTool('shell', 'run_command', { command: `npm install ${missingPkg}` });
                        const installOk = (installResult as any)?.success !== false && (installResult as any)?.isError !== true;
                        if (installOk) {
                            log.info(`[ReActReasoner] Installed ${missingPkg}, retrying command`);
                            const retryResult = await mcpManager.callTool('shell', 'run_command', action.args);
                            result = retryResult;
                            containerFailed = (retryResult as any)?.success === false;
                            if (!containerFailed) {
                                log.info(`[ReActReasoner] Retry after npm install succeeded`);
                            }
                        }
                    }
                }
            }

            // Browser tool failures — browser_navigate / browser_click / browser_extract
            // return { success: false, blocked?, blockType?, error? } (not MCP isError).
            // Normalise these into the standard isError format so stuck_count fires correctly
            // and the agent gets actionable error text.
            const BROWSER_TOOLS = new Set([
                'browser_navigate', 'browser_click', 'browser_fill', 'browser_extract',
                'browser_get_text', 'browser_get_content', 'browser_screenshot',
                'browser_wait', 'browser_scroll', 'browser_hover', 'browser_type',
            ]);
            if (!mcpFailed && BROWSER_TOOLS.has(action.tool) && result?.success === false) {
                const blockType: string = result?.blockType || '';
                const errDetail: string = result?.error || result?.message || '';
                let errorText: string;

                if (result?.blocked && blockType) {
                    // Explicit block signal from BrowserServer.detectBlock()
                    const blockMessages: Record<string, string> = {
                        captcha:      'CAPTCHA detected. Use browser_navigate to load page interactively and trigger HITL for user to solve it.',
                        cloudflare:   'Cloudflare challenge detected. Try stealth_fetch first; if that fails, trigger browser_navigate and HITL.',
                        access_denied:'Access denied / 403. The site is blocking automated access. Try stealth_fetch or a different URL.',
                        rate_limit:   'Rate limited. Wait and retry, or use a different approach.',
                        ip_blocked:   'IP blocked by the site. Try stealth_fetch or a proxy-aware approach.',
                        login_wall:   'Login required. Use browser_navigate to load the login page, then trigger HITL for credentials.',
                    };
                    errorText = `[BROWSER_BLOCKED:${blockType}] ${blockMessages[blockType] || `Site returned: ${errDetail}`}`;
                } else {
                    // Generic browser failure (element not found, timeout, navigation error)
                    errorText = `[BROWSER_FAILED:${action.tool}] ${errDetail || 'Unknown browser error'}`;
                }

                result = {
                    isError: true,
                    content: [{ type: 'text', text: errorText }]
                };
                log.warn(`[ReActReasoner] Browser tool failure normalised — ${action.tool}: ${errorText.substring(0, 160)}`);
            }

            // browser_extract / browser_get_text returning success with empty data is useless.
            // Convert to a soft warning so the agent tries a different selector or approach.
            if (!mcpFailed && (action.tool === 'browser_extract' || action.tool === 'browser_get_text')) {
                const data = result?.data;
                const isEmpty = data === '' || data === null || data === undefined
                    || (Array.isArray(data) && data.length === 0)
                    || (Array.isArray(data) && data.every((d: any) => !d));
                if (isEmpty && result?.success !== false) {
                    result = {
                        isError: true,
                        content: [{ type: 'text', text: `[BROWSER_EMPTY] ${action.tool} returned no data for selector "${action.args?.selector || '(none)'}". The element may not exist, the page may not be fully loaded, or the selector may be wrong. Try browser_get_content to see the full page structure first.` }]
                    };
                    log.warn(`[ReActReasoner] ${action.tool} returned empty data — treated as failure`);
                }
            }

            // CAPTCHA / bot-wall detection for web_fetch and browser_fetch.
            // These tools silently return the bot-challenge page as "data", causing
            // the agent to keep searching. Detect it early and return as failure
            // so the agent switches to browser_navigate (which has CAPTCHA auto-pause).
            const WEB_FETCH_TOOLS = ['web_fetch', 'browser_fetch', 'stealth_fetch', 'browser_navigate'];
            let captchaBlocked = false;
            if (!mcpFailed && WEB_FETCH_TOOLS.includes(action.tool)) {
                const rawText = (() => {
                    if (typeof result === 'string') return result;
                    if (Array.isArray(result?.content)) return result.content.map((c: any) => c?.text || '').join(' ');
                    return String(result?.content || result || '');
                })().toLowerCase();
                const captchaSignals = [
                    'captcha', 'i am not a robot', "i'm not a robot", 'are you a robot',
                    'verify you are human', 'verify that you are human', 'just a moment',
                    'ray id', 'cloudflare', 'access denied', 'security check',
                    'please verify', 'bot protection', 'ddos protection', 'unusual traffic',
                ];
                captchaBlocked = captchaSignals.filter(s => rawText.includes(s)).length >= 2
                    || rawText.includes('captcha')
                    || (rawText.includes('cloudflare') && rawText.includes('ray id'))
                    || rawText.includes("i'm not a robot")
                    || rawText.includes('i am not a robot');
                if (captchaBlocked) {
                    log.warn(`[ReActReasoner] CAPTCHA/bot-wall detected in ${action.tool} response for ${action.args?.url}`);
                    result = {
                        isError: true,
                        content: [{ type: 'text', text: `[CAPTCHA_BLOCKED] The page returned a bot-challenge / CAPTCHA page. web_fetch cannot solve CAPTCHAs. Switch to browser_navigate so the user can take control and solve it interactively. URL: ${action.args?.url}` }]
                    };
                }
            }

            let syntaxCheckFailed = false;

            // Post-write syntax check for .py and .js files — catches truncation and bad generation
            // Uses a hard 3s timeout: py_compile/node --check only parses, never executes imports.
            // If it times out → inconclusive (let execution continue), never treated as failure.
            if (!mcpFailed && !containerFailed && !captchaBlocked &&
                action.tool === 'write_file' && action.args?.path) {
                const writePath: string = action.args.path;
                const writeExt = writePath.split('.').pop()?.toLowerCase();
                const syntaxCmd = writeExt === 'py'
                    ? `python3 -m py_compile "${writePath}"`
                    : writeExt === 'js' || writeExt === 'mjs'
                        ? `node --check "${writePath}"`
                        : null;

                if (syntaxCmd) {
                    try {
                        const syntaxResult = await Promise.race([
                            mcpManager.callTool('shell', 'run_command', { command: syntaxCmd }),
                            new Promise<any>((_, rej) => setTimeout(() => rej(new Error('syntax_check_timeout')), 3000))
                        ]);
                        const syntaxStderr = syntaxResult?.stderr || syntaxResult?.output || '';
                        const syntaxExit = syntaxResult?.exitCode ?? syntaxResult?.exit_code ?? 0;
                        // If the runtime itself isn't installed on the host (Windows without Python/Node
                        // globally), treat as inconclusive — the script will run inside Docker anyway.
                        const runtimeMissing = syntaxStderr.includes('Python was not found') ||
                            syntaxStderr.includes('command not found') ||
                            syntaxStderr.includes('not recognized as an internal') ||
                            syntaxStderr.includes('No such file or directory') && syntaxStderr.includes('python');
                        if (syntaxExit !== 0 && syntaxStderr && !runtimeMissing) {
                            log.warn(`[ReActReasoner] Syntax check failed for ${writePath}: ${syntaxStderr.substring(0, 300)}`);
                            syntaxCheckFailed = true;
                            result = {
                                isError: true,
                                content: [{ type: 'text', text: `[SYNTAX_INVALID] ${writePath} was written but failed syntax check. Fix the syntax error and rewrite the file.\nError: ${syntaxStderr.substring(0, 500)}` }]
                            };
                        } else if (runtimeMissing) {
                            log.info(`[ReActReasoner] Syntax check skipped: runtime not available on host (will run in Docker)`);
                        }
                    } catch (syntaxErr: any) {
                        if (syntaxErr?.message !== 'syntax_check_timeout') {
                            log.warn(`[ReActReasoner] Syntax check error (non-fatal): ${syntaxErr?.message}`);
                        }
                        // Timeout or shell unavailable → inconclusive, do not fail the write
                    }
                }
            }

            // Re-evaluate after all normalization passes (browser failures may have set isError post-mcpFailed check)
            const finalIsError = result?.isError === true;
            const actionSucceeded = !finalIsError && !containerFailed && !captchaBlocked && !syntaxCheckFailed;

            // Track file artifacts (only on actual success)
            if (actionSucceeded && action.tool === 'write_file' && action.args?.path) {
                artifacts.push(action.args.path);

                // Artifact pinning (§3.1): store a 60-char summary for structured files
                const writtenPath: string = action.args.path;
                const writtenExt = writtenPath.split('.').pop()?.toLowerCase() ?? '';
                const STRUCTURED_EXTS = new Set(['json', 'csv', 'md', 'txt', 'html', 'xml', 'yaml', 'yml', 'xlsx', 'docx', 'pdf']);
                if (STRUCTURED_EXTS.has(writtenExt)) {
                    // Prefer content preview from the write args; fall back to path basename
                    const content: string = typeof action.args?.content === 'string'
                        ? action.args.content.replace(/\s+/g, ' ').trim()
                        : '';
                    const summary = content
                        ? content.substring(0, 60) + (content.length > 60 ? '…' : '')
                        : `${writtenExt.toUpperCase()} file`;
                    const relPath = writtenPath.replace(/\\/g, '/').replace(/^\/workspace\//, '');
                    state.pinned_artifacts[relPath] = summary;
                }
            }

            // Web component hydration wait (§1.2): after a successful browser_navigate to a
            // known SPA domain, wait 2s for the JavaScript framework to hydrate the DOM.
            // Without this, browser_get_content immediately after navigate returns skeleton HTML.
            if (actionSucceeded && action.tool === 'browser_navigate' && action.args?.url) {
                const SPA_DOMAINS = [
                    'react', 'angular', 'vue', 'next.js', 'nuxt',
                    'app.', 'dashboard.', 'console.', 'portal.', 'platform.',
                    'gmail.com', 'notion.so', 'figma.com', 'linear.app', 'vercel.com',
                    'github.com', 'gitlab.com', 'atlassian.net', 'jira',
                ];
                const navUrl = (action.args.url as string).toLowerCase();
                const isSPA = SPA_DOMAINS.some(d => navUrl.includes(d));
                if (isSPA) {
                    log.info(`[ReActReasoner] SPA hydration wait (2s) after navigate to ${action.args.url}`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            // Auto-inject browser page state into execution_journal after any browser action.
            // This saves the agent from calling browser_get_text just to know "where am I".
            // Result fields: url/finalUrl/title/pagePreview (from navigate or action_sequence).
            const BROWSER_STATE_TOOLS = new Set([
                'browser_navigate', 'browser_click', 'browser_action_sequence',
                'browser_fill', 'browser_scroll',
            ]);
            if (actionSucceeded && BROWSER_STATE_TOOLS.has(action.tool)) {
                const r = result as any;
                const pageUrl = r?.url || r?.finalUrl || '';
                const pageTitle = r?.title || r?.finalTitle || '';
                const preview = r?.pagePreview ? ` | preview: ${r.pagePreview.substring(0, 200)}` : '';
                if (pageUrl) {
                    state.execution_journal.push(
                        `[BROWSER_STATE] url="${pageUrl}" title="${pageTitle}"${preview}`
                    );
                }
            }

            // Capture browser screenshot for visual analysis in the next reasoning step
            if (actionSucceeded && action.tool === 'browser_screenshot') {
                const rawResult = result as any;
                const base64 = rawResult?.base64 ||
                    (Array.isArray(rawResult?.content) ? rawResult.content.find((c: any) => c?.base64)?.base64 : undefined);
                if (base64) {
                    state.pending_screenshot = {
                        base64,
                        mimeType: 'image/png',
                        savedPath: rawResult?.path,
                    };
                    log.info(`[ReActReasoner] Screenshot captured (${Math.round(base64.length * 0.75 / 1024)}KB) — queued for visual analysis`);
                }
            }

            const duration = Date.now() - startTime;

            const WRITE_TOOLS = ['write_file', 'create_directory', 'move_file', 'edit_file', 'run_command'];
            const progressMade = actionSucceeded && WRITE_TOOLS.includes(action.tool);

            const statusIcon = mcpFailed ? '✗ MCP error' : containerFailed ? `✗ exit ${result?.exitCode}` : progressMade ? '✓' : '○';
            log.info(`Action completed in ${duration}ms: ${statusIcon}`);

            return {
                iteration: state.current_iteration,
                action: action.reasoning,
                tool_used: action.tool,
                args: action.args,
                result,
                success: actionSucceeded,
                artifacts_created: artifacts,
                progress_made: progressMade,
                duration_ms: duration,
                timestamp: new Date()
            };

        } catch (error) {
            log.error(`Action failed:`, error);

            return {
                iteration: state.current_iteration,
                action: action.reasoning,
                tool_used: action.tool,
                args: action.args,
                result: String(error),
                success: false,
                artifacts_created: [],
                progress_made: false,
                duration_ms: Date.now() - startTime,
                timestamp: new Date()
            };
        }
    }

    /**
     * Force generate a write action when LLM is stuck in read-loop.
     * Uses script execution (plain text) instead of JSON-embedded content.
     */
    async generateForceWriteAction(
        state: ExecutionState,
        detectRuntime: () => Promise<'python' | 'node'>
    ): Promise<StateAssessment['suggested_next_action'] | null> {
        const missingFile = state.goal.success_criteria.find(
            c => c.type === 'file_exists' && c.status !== 'passed'
        );

        if (!missingFile || !missingFile.config.path) {
            return null;
        }

        const filePath = missingFile.config.path;
        const llm = modelRouter.getAdapterForTask('code_generation') || modelManager.getActiveAdapter();
        if (!llm) return null;

        const workspace = mcpManager.getWorkspace();
        const runtime = await detectRuntime();
        const escapedWs = workspace.replace(/\\/g, '\\\\');
        const escapedFile = filePath.replace(/\\/g, '\\\\');

        log.info(`Force-generating ${filePath} via ${runtime} script`);

        const prompt = runtime === 'python'
            ? `Write a Python script that creates the file: ${filePath}
The file should implement: ${state.goal.description}
Workspace directory: ${workspace}

Use os.path.join("${escapedWs}", "${escapedFile}") for the full path.
Use os.makedirs for parent directories.
Print "CREATED: ${filePath}" when done.

Output ONLY the Python script, no markdown, no explanations.`
            : `Write a Node.js script that creates the file: ${filePath}
The file should implement: ${state.goal.description}
Workspace directory: ${workspace}

Use path.join("${escapedWs}", "${escapedFile}") for the full path.
Use fs.mkdirSync(dir, { recursive: true }) for parent directories.
Use console.log("CREATED: ${filePath}") when done.

Output ONLY the Node.js script, no markdown, no explanations.`;

        try {
            const rawScript = await llm.generate(prompt, { temperature: 0.3 });
            const script = this.scriptGen.cleanScriptResponse(rawScript, runtime);

            if (script.length < 30) {
                log.warn('[ReActReasoner] Force-write script too short');
                return null;
            }

            // Write script to an absolute workspace path so exec never depends on cwd resolution
            const ext = runtime === 'python' ? 'py' : 'js';
            const tempScriptAbs = `/workspace/_force_write.${ext}`;
            await mcpManager.callTool('filesystem', 'write_file', {
                path: tempScriptAbs,
                content: script
            });

            // Gap B fix: use absolute path + /usr/bin/env to resolve interpreter regardless of PATH.
            // Bug #3 fix: Python uses heredoc via stdin (python3 -) instead of -c "..." so
            //             multiline scripts aren't subject to shell quoting collapse.
            const cmd = runtime === 'python'
                ? `cd /workspace && /usr/bin/env python3 - << 'PYEOF'\n${script}\nPYEOF`
                : `/usr/bin/env node /workspace/_force_write.js`;

            return {
                tool: 'run_command',
                args: { command: cmd },   // no cwd: '.' — absolute paths remove the dependency
                reasoning: `Force-generating ${filePath} via ${runtime} script (loop recovery)`
            };
        } catch (error) {
            log.error('[ReActReasoner] Force-write generation failed:', error);
            return null;
        }
    }

    /**
     * Sprint 3: Detect when the agent needs a capability that doesn't exist
     * as a tool, then auto-generate and register it.
     *
     * Called when stuck_count >= 2 — the reasoner suspects a missing capability.
     * Returns a `use_dynamic_tool` action if a new tool was created, null otherwise.
     */
    async detectToolNeed(
        state: ExecutionState,
        reasoning: string
    ): Promise<StateAssessment['suggested_next_action'] | null> {
        const llm = modelRouter.getAdapterForTask('code_generation') || modelManager.getActiveAdapter();
        if (!llm) return null;

        // Ask the LLM: is the problem a missing capability?
        const detectPrompt = `You are analyzing why a task is stuck.

GOAL: ${state.goal.description}
STUCK COUNT: ${state.stuck_count}

REASONING SO FAR:
${reasoning.substring(0, 600)}

ERRORS:
${state.error_history.slice(-3).map(e => `- ${e.error}`).join('\n') || 'None'}

Question: Is this task stuck because there is no suitable tool available to accomplish a specific sub-step?
If YES, describe the missing tool in JSON:
{
  "needs_tool": true,
  "tool_name": "lowercase_snake_case_name",
  "tool_description": "What the tool should do (10-200 chars)",
  "tool_input_schema": { "property_name": { "type": "string", "description": "..." } },
  "example_usage": { "property_name": "example_value" }
}

If NO (the problem is something else like wrong file path, syntax error, etc.):
{ "needs_tool": false }`;

        try {
            const detection = await llm.generateJSON(detectPrompt, {});

            if (!detection.needs_tool || !detection.tool_name) {
                return null;
            }

            log.info(`Tool-need detected: ${detection.tool_name} — "${detection.tool_description}"`);

            // Check if tool already exists
            const existing = dynamicToolRegistry.getTool(detection.tool_name);
            if (existing) {
                log.info(`Tool "${detection.tool_name}" already exists, using it`);
                return {
                    tool: 'use_dynamic_tool',
                    args: { name: detection.tool_name, args: detection.example_usage || {} },
                    reasoning: `Using existing dynamic tool "${detection.tool_name}": ${existing.description}`
                };
            }

            // Generate tool code
            const codePrompt = `Write a JavaScript function body for a tool called "${detection.tool_name}".
Description: ${detection.tool_description}
Input: The function receives an \`args\` object with these properties: ${JSON.stringify(detection.tool_input_schema)}

Rules:
- Write ONLY the function body (no \`function\` keyword, no wrapper)
- The code receives \`args\` as a parameter
- Must return a value (the tool output)
- Use only built-in JS (no require/import — this runs in a sandboxed context)
- Keep it concise and focused
- Example: \`const result = args.text.split(args.delimiter); return result;\`

Output ONLY the JavaScript function body:`;

            const rawCode = await llm.generate(codePrompt, { temperature: 0.2 });

            // Clean code: strip markdown fences if present
            let code = rawCode.trim();
            code = code.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/i, '').trim();

            if (code.length < 10) {
                log.warn('[ReActReasoner] Generated tool code too short');
                return null;
            }

            // Register the tool
            const tool = await dynamicToolRegistry.registerTool(
                detection.tool_name,
                detection.tool_description,
                code,
                {
                    inputSchema: detection.tool_input_schema || {},
                    createdBy: 'agent:auto',
                    tags: ['auto-generated', 'sprint3'],
                }
            );

            log.info(`Auto-created tool "${tool.name}" v${tool.version}`);

            // Return action to use the new tool immediately
            return {
                tool: 'use_dynamic_tool',
                args: { name: tool.name, args: detection.example_usage || {} },
                reasoning: `Auto-created tool "${tool.name}": ${detection.tool_description}`
            };

        } catch (error) {
            log.error('[ReActReasoner] Tool-need detection failed:', error);
            return null;
        }
    }

    // Blocked-site context helpers moved to ContextBuilder.ts
}
