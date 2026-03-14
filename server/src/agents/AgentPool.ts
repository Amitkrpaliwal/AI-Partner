import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { modelManager } from '../services/llm/modelManager';
import { modelRouter } from '../services/llm/modelRouter';
import { mcpManager } from '../mcp/MCPManager';
import { agentBus } from './AgentBus';
import { promptLoader } from '../utils/PromptLoader';
import { db } from '../database';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract the first valid JSON object from free-form text.
 * Handles <think>...</think> blocks (DeepSeek/Qwen reasoning models),
 * markdown code fences, and prose-wrapped JSON.
 */
function extractJSONFromText(text: string): any {
    // Strip <think>...</think> reasoning blocks
    let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Strip markdown fences
    clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // Try direct parse
    try { return JSON.parse(clean); } catch { /* fall through */ }
    // Greedy: find largest {...} span (handles trailing text)
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    // Last resort: try each {...} match from right to left
    const all = [...clean.matchAll(/\{[\s\S]*?\}/g)];
    for (let i = all.length - 1; i >= 0; i--) {
        try { return JSON.parse(all[i][0]); } catch { /* continue */ }
    }
    return null;
}


export interface DelegationBudget {
    maxDepth: number;          // 2-5 based on goal complexity (default: 3)
    maxConcurrent: number;     // Resource limits (default: 5)
    totalAgentLimit: number;   // Global cap (default: 10)
    timeoutMs: number;         // Per-agent timeout (default: 120000 = 2min)
}

const DEFAULT_BUDGET: DelegationBudget = {
    maxDepth: 3,
    maxConcurrent: 5,
    totalAgentLimit: 10,
    timeoutMs: 120_000,
};

// Iteration cap per depth: research/analysis agents need more room for web searches + file writes
function childMaxIterations(depth: number): number {
    return depth === 0 ? 20 : 8;
}

export interface AgentProfile {
    id: string;
    name: string;
    slug: string;
    role: string;
    systemPrompt: string;
    toolWhitelist: string[];
    memoryNamespace: string;
    maxIterations: number;
    autoSelectKeywords?: string[];
}

export interface AgentTask {
    id: string;
    parentId: string | null;
    depth: number;
    role: string;
    task: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    result: string | null;
    artifacts: string[];
    startedAt: Date | null;
    completedAt: Date | null;
    agentProfile?: AgentProfile;
}

// ============================================================================
// ROLE-SPECIFIC SYSTEM PROMPTS
// ============================================================================

const ROLE_PROMPTS: Record<string, string> = {
    researcher: `You are a RESEARCH specialist. Your focus is:
- Reading files, searching codebases, and gathering information
- Analyzing existing code structure and patterns
- Summarizing findings clearly and concisely
- You should NOT write or modify files — only read and report
- Use tools: read_file, list_directory, search_files, web_search, web_fetch`,

    coder: `You are a CODE specialist. Your focus is:
- Writing clean, well-structured code
- Creating new files and modifying existing ones
- Following project conventions and patterns
- Running and testing code via shell commands
- Use tools: write_file, read_file, run_command`,

    reviewer: `You are a CODE REVIEWER specialist. Your focus is:
- Reading and analyzing code quality, correctness, and security
- Identifying bugs, anti-patterns, and potential issues
- Suggesting specific, actionable improvements
- You should NOT modify files — only analyze and report
- Use tools: read_file, search_files, list_directory`,

    planner: `You are a PLANNING specialist. Your focus is:
- Breaking down complex goals into clear subtasks
- Identifying dependencies between subtasks
- Determining which tasks can run in parallel vs sequential
- Creating detailed action plans with success criteria
- Respond with structured plans, not implementation`,

    'general assistant': `You are a general-purpose AI agent. You can:
- Read and write files
- Run shell commands
- Search for information
- Delegate sub-tasks to more specialized agents
Focus on completing the task efficiently.`,
};

/**
 * Get the system prompt for a given role, with fallback to general.
 */
function getRolePrompt(role: string): string {
    // Exact match
    if (ROLE_PROMPTS[role]) return ROLE_PROMPTS[role];

    // Partial match (e.g., "python coder" matches "coder")
    const roleKeys = Object.keys(ROLE_PROMPTS);
    for (const key of roleKeys) {
        if (role.toLowerCase().includes(key)) {
            return ROLE_PROMPTS[key];
        }
    }

    return ROLE_PROMPTS['general assistant'];
}

// ============================================================================
// AGENT POOL
// ============================================================================

export class AgentPool extends EventEmitter {
    private tasks: Map<string, AgentTask> = new Map();
    private activeCount: number = 0;
    private totalSpawned: number = 0;
    private currentBudget: DelegationBudget = { ...DEFAULT_BUDGET };
    /** executionIds whose child agents should stop at the next iteration boundary */
    private abortedExecutions: Set<string> = new Set();
    /** User context injected into every child agent system prompt */
    private userContext: string = '';

    setUserContext(content: string): void {
        this.userContext = content;
    }

    /**
     * Set delegation budget for the current execution context.
     */
    setBudget(budget: Partial<DelegationBudget>): void {
        this.currentBudget = { ...DEFAULT_BUDGET, ...budget };
        console.log(`[AgentPool] Budget updated: depth=${this.currentBudget.maxDepth}, concurrent=${this.currentBudget.maxConcurrent}, timeout=${this.currentBudget.timeoutMs}ms`);
    }

    /**
     * Reset budget to defaults
     */
    resetBudget(): void {
        this.currentBudget = { ...DEFAULT_BUDGET };
    }

    /**
     * Look up a named agent profile by slug or id.
     * Returns null if not found or DB unavailable.
     */
    async lookupProfile(slugOrId: string): Promise<AgentProfile | null> {
        try {
            const row = await db.get(
                `SELECT * FROM agent_profiles WHERE slug = ? OR id = ? LIMIT 1`,
                [slugOrId, slugOrId]
            );
            if (!row) return null;
            return {
                id: row.id,
                name: row.name,
                slug: row.slug || slugOrId,
                role: row.role || 'general assistant',
                systemPrompt: row.system_prompt || '',
                toolWhitelist: JSON.parse(row.tool_whitelist || '[]'),
                memoryNamespace: row.memory_namespace || '',
                maxIterations: row.max_iterations ?? 15,
                autoSelectKeywords: row.auto_select_keywords
                    ? row.auto_select_keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
                    : [],
            };
        } catch {
            return null;
        }
    }

    /**
     * Create or update an agent profile from a natural-language description.
     * Uses the LLM to generate systemPrompt and autoSelectKeywords.
     * Returns the saved profile or null on failure.
     */
    async createProfileFromDescription(name: string, description: string): Promise<AgentProfile | null> {
        try {
            const llm = modelRouter.getAdapterForTask('simple_qa') || modelManager.getActiveAdapter();
            if (!llm) return null;

            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const prompt = `You are configuring an AI agent profile. Given the agent name and description below, generate a JSON object with exactly these fields:
- "role": one sentence describing the agent's primary function (e.g. "Financial data researcher specializing in Indian stock markets")
- "systemPrompt": 3-6 sentences of focused instructions for this agent. Be specific about what it should and should NOT do.
- "autoSelectKeywords": array of 3-8 lowercase keywords/phrases that, when present in a user message, should auto-route to this agent (e.g. ["nse", "stock price", "sensex"])
- "toolWhitelist": array of MCP tool names this agent should prefer. Use [] for no restriction.

Agent name: "${name}"
Description: "${description}"

Return ONLY the JSON object, no prose or markdown fences.`;

            const raw = await llm.generate(prompt, { temperature: 0.2, maxTokens: 400 });
            const parsed = extractJSONFromText(raw);
            if (!parsed) return null;

            const id = randomUUID();
            await db.run(
                `INSERT OR REPLACE INTO agent_profiles
                 (id, name, slug, role, system_prompt, tool_whitelist, memory_namespace, max_iterations, auto_select_keywords)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id, name, slug,
                    parsed.role || description,
                    parsed.systemPrompt || '',
                    JSON.stringify(parsed.toolWhitelist || []),
                    slug,
                    15,
                    (parsed.autoSelectKeywords || []).join(', '),
                ]
            );

            return {
                id, name, slug,
                role: parsed.role || description,
                systemPrompt: parsed.systemPrompt || '',
                toolWhitelist: parsed.toolWhitelist || [],
                memoryNamespace: slug,
                maxIterations: 15,
                autoSelectKeywords: parsed.autoSelectKeywords || [],
            };
        } catch {
            return null;
        }
    }

    /**
     * List all agent profiles (for prompt injection).
     */
    async listProfiles(): Promise<AgentProfile[]> {
        try {
            const rows = await db.all('SELECT * FROM agent_profiles ORDER BY name ASC');
            return rows.map(row => ({
                id: row.id,
                name: row.name,
                slug: row.slug || '',
                role: row.role || 'general assistant',
                systemPrompt: row.system_prompt || '',
                toolWhitelist: JSON.parse(row.tool_whitelist || '[]'),
                memoryNamespace: row.memory_namespace || '',
                maxIterations: row.max_iterations ?? 15,
                autoSelectKeywords: row.auto_select_keywords
                    ? row.auto_select_keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
                    : [],
            }));
        } catch {
            return [];
        }
    }

    /**
     * Delegate a task to a child agent.
     * The child agent uses the LLM to reason about and execute the task.
     */
    async delegateTask(
        task: string,
        role: string = 'general assistant',
        parentId: string | null = null,
        depth: number = 0,
        agentProfile?: AgentProfile
    ): Promise<{ id: string; result: string; artifacts: string[] }> {
        const budget = this.currentBudget;

        if (depth >= budget.maxDepth) {
            return {
                id: 'blocked',
                result: `Delegation blocked: max depth (${budget.maxDepth}) reached. Execute this task directly instead.`,
                artifacts: []
            };
        }

        if (this.activeCount >= budget.maxConcurrent) {
            return {
                id: 'blocked',
                result: `Delegation blocked: too many concurrent agents (${budget.maxConcurrent}). Wait for others to complete.`,
                artifacts: []
            };
        }

        if (this.totalSpawned >= budget.totalAgentLimit) {
            return {
                id: 'blocked',
                result: `Delegation blocked: total agent limit (${budget.totalAgentLimit}) reached for this execution.`,
                artifacts: []
            };
        }

        const agentTask: AgentTask = {
            id: randomUUID(),
            parentId,
            depth,
            role,
            task,
            status: 'pending',
            result: null,
            artifacts: [],
            startedAt: null,
            completedAt: null,
            agentProfile,
        };

        this.tasks.set(agentTask.id, agentTask);
        this.totalSpawned++;

        // Register on agent bus
        agentBus.registerAgent(agentTask.id, parentId);

        this.emit('agent:spawned', { id: agentTask.id, role, task, depth });

        try {
            agentTask.status = 'running';
            agentTask.startedAt = new Date();
            this.activeCount++;

            const profileLabel = agentProfile ? ` profile="${agentProfile.name}"` : '';
            console.log(`[AgentPool] Spawned agent ${agentTask.id.substring(0, 8)} (depth=${depth}, role="${role}"${profileLabel}, active=${this.activeCount}/${budget.maxConcurrent})`);

            // Race between execution and timeout
            const result = await Promise.race([
                this.runChildAgent(agentTask),
                this.timeoutPromise(budget.timeoutMs, agentTask.id)
            ]);

            agentTask.status = 'completed';
            agentTask.result = result.response;
            agentTask.artifacts = result.artifacts;
            agentTask.completedAt = new Date();

            // Notify parent via bus
            if (parentId) {
                agentBus.send(agentTask.id, parentId, 'result', {
                    task: agentTask.task,
                    result: result.response,
                    artifacts: result.artifacts
                });
            }

            this.emit('agent:completed', {
                id: agentTask.id,
                result: result.response,
                artifacts: result.artifacts
            });

            console.log(`[AgentPool] Agent ${agentTask.id.substring(0, 8)} completed: ${result.response.substring(0, 100)}`);

            return {
                id: agentTask.id,
                result: result.response,
                artifacts: result.artifacts
            };
        } catch (error: any) {
            agentTask.status = 'failed';
            agentTask.result = `Agent failed: ${error.message}`;
            agentTask.completedAt = new Date();

            // Escalate failure to parent via bus
            if (parentId) {
                agentBus.send(agentTask.id, parentId, 'escalation', {
                    task: agentTask.task,
                    error: error.message
                });
            }

            this.emit('agent:failed', { id: agentTask.id, error: error.message });

            return {
                id: agentTask.id,
                result: `Agent failed: ${error.message}`,
                artifacts: []
            };
        } finally {
            this.activeCount--;
            agentBus.unregisterAgent(agentTask.id);
        }
    }

    /**
     * Execute multiple tasks in parallel (for independent subtasks).
     * Returns results in the same order as input tasks.
     */
    async delegateParallel(
        tasks: Array<{ task: string; role: string }>,
        parentId: string | null = null,
        depth: number = 0
    ): Promise<Array<{ id: string; result: string; artifacts: string[] }>> {
        console.log(`[AgentPool] Parallel delegation: ${tasks.length} tasks at depth ${depth}`);

        // Cap parallel execution to budget
        const maxParallel = Math.min(tasks.length, this.currentBudget.maxConcurrent - this.activeCount);
        if (maxParallel <= 0) {
            // Fall back to sequential if no parallel slots
            const results: Array<{ id: string; result: string; artifacts: string[] }> = [];
            for (const t of tasks) {
                results.push(await this.delegateTask(t.task, t.role, parentId, depth));
            }
            return results;
        }

        // Execute in batches using Promise.allSettled so a single failure doesn't
        // cancel all sibling agents. Failed agents return an ESCALATION signal so the
        // parent loop can propagate the failure explicitly instead of swallowing it.
        const results: Array<{ id: string; result: string; artifacts: string[] }> = [];
        for (let i = 0; i < tasks.length; i += maxParallel) {
            const batch = tasks.slice(i, i + maxParallel);
            const settled = await Promise.allSettled(
                batch.map(t => this.delegateTask(t.task, t.role, parentId, depth))
            );
            for (const outcome of settled) {
                if (outcome.status === 'fulfilled') {
                    results.push(outcome.value);
                } else {
                    // Rejected: wrap the error as an ESCALATION signal so the parent
                    // orchestrator increments stuck_count and knows to handle the failure.
                    const reason = outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason);
                    console.warn(`[AgentPool] Parallel sub-agent failed: ${reason}`);
                    results.push({
                        id: `failed_${Date.now()}`,
                        result: `ESCALATION::${JSON.stringify({ problem: reason, need: 'alternative approach or skip' })}`,
                        artifacts: [],
                    });
                }
            }
        }

        return results;
    }

    /**
     * Timeout promise for enforcing per-agent time limits.
     */
    private timeoutPromise(
        ms: number,
        agentId: string
    ): Promise<{ response: string; artifacts: string[] }> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Agent ${agentId.substring(0, 8)} timed out after ${ms}ms`));
            }, ms);
        });
    }

    /**
     * Run a child agent with its own OODA loop
     */
    private async runChildAgent(
        agentTask: AgentTask
    ): Promise<{ response: string; artifacts: string[] }> {
        // Route to reasoning model for child agent tasks
        const llm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) {
            return { response: 'No LLM available', artifacts: [] };
        }

        const workspace = mcpManager.getWorkspace();
        const artifacts: string[] = [];
        const history: { role: string; content: string }[] = [];

        const profile = agentTask.agentProfile;
        // Named profile overrides generic role prompt; falls back to role-based default
        const rolePrompt = (profile?.systemPrompt && profile.systemPrompt.trim())
            ? profile.systemPrompt
            : getRolePrompt(agentTask.role);
        const budget = this.currentBudget;
        const canSubDelegate = agentTask.depth < budget.maxDepth - 1;

        // Fetch tool list so the agent knows what it can actually call.
        // Without this, agents say "I cannot access tools" because they don't know tool names.
        let toolCatalogue = '';
        try {
            const allTools = await mcpManager.listTools();
            // Apply tool whitelist from named profile (empty list = all tools allowed)
            const filteredTools = (profile?.toolWhitelist?.length)
                ? allTools.filter(t => profile.toolWhitelist.includes(t.tool.name))
                : allTools;
            if (filteredTools.length > 0) {
                const toolLines = filteredTools.map(t =>
                    `  - ${t.tool.name}: ${(t.tool.description || '').substring(0, 90)}`
                ).join('\n');
                toolCatalogue = `\n\nAVAILABLE TOOLS (use these EXACT names in action="tool"):\n${toolLines}\n\nKey capabilities you have:\n  - web_search or search_web: Search the internet\n  - browser_navigate / browser_get_text: Browse URLs\n  - read_text_file / write_file / list_directory: Workspace filesystem\n  - run_command: Execute shell commands\nALWAYS try tools before escalating — they ARE available.`;
            }
        } catch (_) { /* non-fatal */ }

        const userContextBlock = this.userContext
            ? `\n[USER CONTEXT — always follow these conventions]\n${this.userContext}\n`
            : '';

        const systemPromptTemplate = `${rolePrompt}${userContextBlock}

**Current date: {{CURRENT_DATE}}, {{CURRENT_TIME}}** — use this for any searches or time-sensitive reasoning.

You have been delegated a specific task by a parent agent. Focus ONLY on this task.
Workspace: ${workspace}
${profile ? `Agent workspace directory: ${workspace}/agents/${profile.slug}/ (store your output files here; create the directory first if needed)` : ''}Agent ID: ${agentTask.id.substring(0, 8)}
Depth: ${agentTask.depth}/${budget.maxDepth - 1}
${toolCatalogue}

Available actions (respond with JSON):
1. Use a tool: {"action": "tool", "tool": "<name>", "args": {...}, "reasoning": "why"}
${canSubDelegate
                ? '2. Delegate to sub-agent: {"action": "delegate", "task": "sub-task description", "role": "specialist role", "reasoning": "why"}'
                : '2. [DELEGATION DISABLED at this depth — use direct tools only]'}
3. Send message to parent: {"action": "message", "content": "question or status update", "type": "question|status"}
4. Complete the task: {"action": "complete", "response": "result summary", "reasoning": "why done"}
5. Escalate to parent: {"action": "escalate", "problem": "clear description of what is blocked or missing", "need": "what information or resource is required to proceed"}

SEARCH FALLBACK RULE — CRITICAL:
If web_search returns no results, times out, or errors after 2 attempts:
  → STOP retrying search. Do NOT escalate.
  → Instead: write a comprehensive analysis file using your own training knowledge.
  → Mark the content with: "Note: Based on training data (web search unavailable at runtime)"
  → Then complete the task with: {"action": "complete", "response": "Report written using training knowledge"}
Your training knowledge is VALUABLE and sufficient for market analysis, regulatory context, and financial assessment.
A report from training data is far better than an escalation that blocks the whole pipeline.

ESCALATION RULES — escalate (action 5) ONLY when:
- A required credential, API key, or secret is missing and cannot be obtained
- You have tried 3+ different approaches and ALL failed with the same root cause
- The task is fundamentally impossible without human intervention
Do NOT escalate because web search failed — use your training knowledge instead.

Be concise and focused. Complete the task in as few steps as possible.
${!canSubDelegate ? 'IMPORTANT: You are at maximum delegation depth. Do NOT attempt to delegate.' : ''}`;

        const systemPrompt = promptLoader.interpolate(systemPromptTemplate);
        // Named profiles can define their own iteration budget
        const maxIter = profile?.maxIterations ?? childMaxIterations(agentTask.depth);
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;

        for (let i = 0; i < maxIter; i++) {
            // Check if parent execution was cancelled
            const parentExecutionId = agentTask.parentId || '';
            if (this.abortedExecutions.has(parentExecutionId)) {
                console.log(`[AgentPool] Agent ${agentTask.id.substring(0, 8)} stopping — parent execution aborted`);
                return { response: 'Stopped: parent execution was cancelled.', artifacts };
            }

            // Check for incoming messages from other agents
            const incomingMessages = agentBus.receive(agentTask.id);
            let contextAppend = '';
            if (incomingMessages.length > 0) {
                // Separate escalations from informational messages
                const escalations = incomingMessages.filter(m => m.type === 'escalation');
                const infoMessages = incomingMessages.filter(m => m.type !== 'escalation');

                // Regular info messages → append as context (existing behaviour)
                if (infoMessages.length > 0) {
                    contextAppend = '\n\nMessages from other agents:\n' +
                        infoMessages.map(m =>
                            `[${m.type}] from ${m.from.substring(0, 8)}: ${JSON.stringify(m.payload)}`
                        ).join('\n');
                }

                // Escalations from child agents → treat as failures, force action
                if (escalations.length > 0) {
                    const latestEsc = escalations[escalations.length - 1];
                    const problem = latestEsc.payload?.problem || 'Sub-agent could not complete task';
                    const need = latestEsc.payload?.need || 'Unknown resource or permission required';
                    console.warn(`[AgentPool] Agent ${agentTask.id.substring(0, 8)} received child escalation: ${problem}`);
                    // Bump failure counter — 2 escalations ≈ 3 normal failures → triggers auto-escalate
                    consecutiveFailures += 2;
                    contextAppend += `\n\nURGENT — A sub-agent you delegated to has escalated a blocking problem:\n` +
                        `PROBLEM: ${problem}\n` +
                        `WHAT IS NEEDED: ${need}\n` +
                        `You MUST either: (a) solve this directly with available tools, or ` +
                        `(b) escalate to your own parent using action=escalate if you also cannot resolve it.`;
                }
            }

            const prompt = i === 0
                ? `TASK: ${agentTask.task}\n\nAnalyze the task and decide your first action.${contextAppend}`
                : `Continue working on the task. What's your next action?${contextAppend}`;

            try {
                const response = await llm.generateJSON(prompt, {}, {
                    systemPrompt,
                    history,
                    temperature: 0.3
                });

                if (!response || response._parseError) {
                    history.push(
                        { role: 'user', content: prompt },
                        { role: 'assistant', content: 'Failed to generate valid JSON action.' }
                    );
                    continue;
                }

                // Handle completion
                if (response.action === 'complete') {
                    return {
                        response: response.response || 'Task completed',
                        artifacts
                    };
                }

                // Handle messaging to parent/other agents
                if (response.action === 'message') {
                    const msgType = response.type === 'question' ? 'question' : 'status';
                    agentBus.send(agentTask.id, 'parent', msgType, {
                        content: response.content || response.message || ''
                    });

                    // If this was a question, wait up to 5 seconds for parent's answer
                    // before continuing — prevents the child from looping on the same gap
                    let parentAnswer: string | null = null;
                    if (msgType === 'question') {
                        for (let attempt = 0; attempt < 10; attempt++) {
                            await new Promise(r => setTimeout(r, 500));
                            const replies = agentBus.peek(agentTask.id);
                            const contextMsg = replies.find(r => r.type === 'context');
                            if (contextMsg) {
                                agentBus.receive(agentTask.id); // consume it
                                parentAnswer = (contextMsg.payload as any).answer || null;
                                break;
                            }
                        }
                    }

                    history.push(
                        { role: 'user', content: prompt },
                        { role: 'assistant', content: `Sent ${msgType} to parent: ${response.content}` },
                        ...(parentAnswer
                            ? [{ role: 'user' as const, content: `Parent answered: ${parentAnswer}` }]
                            : [])
                    );
                    continue;
                }

                // Handle explicit escalation to parent
                if (response.action === 'escalate') {
                    const problem = response.problem || 'Unable to complete task — blocked';
                    const need = response.need || 'Guidance or missing resource needed';
                    console.log(`[AgentPool] Agent ${agentTask.id.substring(0, 8)} escalating to parent: ${problem}`);
                    agentBus.send(agentTask.id, 'parent', 'escalation', {
                        problem, need, iteration: i, agentId: agentTask.id
                    });
                    return {
                        response: `ESCALATION::${problem}::${need}`,
                        artifacts
                    };
                }

                // Handle delegation (blocked when at maxDepth — delegateTask returns a blocked message)
                if (response.action === 'delegate') {
                    const subResult = await this.delegateTask(
                        response.task,
                        response.role || 'sub-agent',
                        agentTask.id,
                        agentTask.depth + 1
                    );
                    history.push(
                        { role: 'user', content: prompt },
                        { role: 'assistant', content: `Delegated: ${response.task}` },
                        { role: 'user', content: `Sub-agent result: ${subResult.result}` }
                    );
                    artifacts.push(...subResult.artifacts);
                    continue;
                }

                // Handle tool use
                if (response.action === 'tool' && response.tool) {
                    try {
                        // Determine which server owns this tool
                        const tools = await mcpManager.listTools();
                        const toolEntry = tools.find(t => t.tool.name === response.tool);

                        if (toolEntry) {
                            const result = await mcpManager.callTool(
                                toolEntry.server,
                                response.tool,
                                response.args || {}
                            );
                            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

                            // Track file artifacts
                            if (response.tool === 'write_file' && response.args?.path) {
                                artifacts.push(response.args.path);
                                // Broadcast artifact creation to all agents
                                agentBus.send(agentTask.id, 'broadcast', 'artifact', {
                                    path: response.args.path,
                                    action: 'created'
                                });
                            }

                            // Successful tool call — reset failure counter
                            consecutiveFailures = 0;

                            history.push(
                                { role: 'user', content: prompt },
                                { role: 'assistant', content: `Used ${response.tool}: ${response.reasoning || ''}` },
                                { role: 'user', content: `Tool result: ${resultStr.substring(0, 500)}` }
                            );
                        } else {
                            consecutiveFailures++;
                            history.push(
                                { role: 'user', content: prompt },
                                { role: 'assistant', content: `Tried ${response.tool} but tool not found` }
                            );
                        }
                    } catch (toolError: any) {
                        consecutiveFailures++;
                        history.push(
                            { role: 'user', content: prompt },
                            { role: 'assistant', content: `Tool ${response.tool} failed: ${toolError.message}` }
                        );
                    }

                    // Auto-escalate after too many consecutive failures
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        const lastErrors = history.slice(-6).filter(h => h.role === 'user' && h.content.startsWith('Tool')).map(h => h.content).join('; ');
                        const problem = `Repeated tool failures (${consecutiveFailures} in a row): ${lastErrors.substring(0, 200)}`;
                        const need = 'Check that required tools, files, and permissions are available';
                        console.log(`[AgentPool] Agent ${agentTask.id.substring(0, 8)} auto-escalating after ${consecutiveFailures} consecutive failures`);
                        agentBus.send(agentTask.id, 'parent', 'escalation', {
                            problem, need, iteration: i, agentId: agentTask.id, autoEscalated: true
                        });
                        return {
                            response: `ESCALATION::${problem}::${need}`,
                            artifacts
                        };
                    }

                    continue;
                }

                // Unknown action
                history.push(
                    { role: 'user', content: prompt },
                    { role: 'assistant', content: JSON.stringify(response).substring(0, 200) }
                );
            } catch (error: any) {
                // generateJSON threw after all retries — try to salvage from rawText
                // (Ollama adapter attaches the raw model output as error.rawText)
                const rawText: string = error.rawText || '';
                const salvaged = rawText ? extractJSONFromText(rawText) : null;

                if (salvaged && salvaged.action) {
                    // We got a valid action from the raw text — requeue it for processing
                    // by pushing a synthetic good response into the loop iteration.
                    // Simplest path: push the salvaged response to history and continue.
                    // The next iteration will pick up with correct context.
                    history.push(
                        { role: 'user', content: prompt },
                        { role: 'assistant', content: JSON.stringify(salvaged) }
                    );
                    // Process salvaged action inline rather than looping again
                    if (salvaged.action === 'complete') {
                        return { response: salvaged.response || 'Task completed', artifacts };
                    }
                    if (salvaged.action === 'escalate') {
                        const problem = salvaged.problem || 'Unable to complete task';
                        const need = salvaged.need || 'Guidance required';
                        console.log(`[AgentPool] Agent ${agentTask.id.substring(0, 8)} escalating (salvaged): ${problem}`);
                        agentBus.send(agentTask.id, 'parent', 'escalation', { problem, need, iteration: i, agentId: agentTask.id });
                        return { response: `ESCALATION::${problem}::${need}`, artifacts };
                    }
                    if (salvaged.action === 'tool' && salvaged.tool) {
                        try {
                            const tools = await mcpManager.listTools();
                            const toolEntry = tools.find(t => t.tool.name === salvaged.tool);
                            if (toolEntry) {
                                const result = await mcpManager.callTool(toolEntry.server, salvaged.tool, salvaged.args || {});
                                history.push({ role: 'user', content: `Tool result: ${JSON.stringify(result).substring(0, 800)}` });
                                consecutiveFailures = 0;
                            } else {
                                history.push({ role: 'user', content: `Tool "${salvaged.tool}" not found` });
                                consecutiveFailures++;
                            }
                        } catch (toolErr: any) {
                            history.push({ role: 'user', content: `Tool error: ${toolErr.message}` });
                            consecutiveFailures++;
                        }
                        continue;
                    }
                } else {
                    consecutiveFailures++;
                    history.push(
                        { role: 'user', content: prompt },
                        { role: 'assistant', content: `JSON parsing failed. Please respond with ONLY a JSON action object, no explanations. Example: {"action":"tool","tool":"web_search","args":{"query":"your search"},"reasoning":"why"}` }
                    );
                }
            }
        }

        // Max iterations reached — escalate so parent knows child was exhausted
        const problem = `Reached maximum iterations (${maxIter}) without completing the task`;
        const need = 'Task may need to be broken down differently or requires information not available to this agent';
        console.log(`[AgentPool] Agent ${agentTask.id.substring(0, 8)} exhausted iterations — escalating`);
        agentBus.send(agentTask.id, 'parent', 'escalation', {
            problem, need, iteration: maxIter, agentId: agentTask.id, autoEscalated: true
        });
        return {
            response: `ESCALATION::${problem}::${need}`,
            artifacts
        };
    }

    /**
     * Get all tasks (for monitoring)
     */
    getTasks(): AgentTask[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get active task count
     */
    getActiveCount(): number {
        return this.activeCount;
    }

    /**
     * Get task by ID
     */
    getTask(id: string): AgentTask | undefined {
        return this.tasks.get(id);
    }

    /**
     * Get task hierarchy (tree structure for monitoring)
     */
    getTaskTree(): any[] {
        const roots = Array.from(this.tasks.values()).filter(t => !t.parentId);
        return roots.map(root => this.buildTaskNode(root));
    }

    private buildTaskNode(task: AgentTask): any {
        const children = Array.from(this.tasks.values())
            .filter(t => t.parentId === task.id)
            .map(child => this.buildTaskNode(child));

        return {
            id: task.id,
            role: task.role,
            task: task.task.substring(0, 100),
            status: task.status,
            depth: task.depth,
            children
        };
    }

    /**
     * Get total spawned count for the current execution
     */
    getTotalSpawned(): number {
        return this.totalSpawned;
    }

    /**
     * Reset spawn counter (call at start of new execution)
     */
    resetSpawnCounter(): void {
        this.totalSpawned = 0;
    }

    /**
     * Signal all child agents spawned under executionId to stop at the next
     * iteration boundary. Called by GoalOrientedExecutor.cancel().
     */
    abort(executionId: string): void {
        this.abortedExecutions.add(executionId);
        console.log(`[AgentPool] Abort signalled for execution: ${executionId}`);
    }

    /**
     * Clear abort signal (call at start of new execution so old IDs don't linger).
     */
    clearAbort(executionId: string): void {
        this.abortedExecutions.delete(executionId);
    }

    /** Check if an execution has been aborted */
    isAborted(executionId: string): boolean {
        return this.abortedExecutions.has(executionId);
    }
}

export const agentPool = new AgentPool();
