/**
 * GoalExtractor — Parses user requests into structured GoalDefinitions.
 * Extracted from GoalOrientedExecutor.ts (Sprint 2: Kill the Monolith).
 */

import {
    GoalDefinition,
    SuccessCriterion,
    ConversationMessage,
    generateId
} from '../../types/goal';
import { modelManager } from '../../services/llm/modelManager';
import { modelRouter } from '../../services/llm/modelRouter';

export class GoalExtractor {

    /**
     * Extract a structured goal from a user's natural language request.
     * Uses LLM to parse the request into success criteria, complexity, and milestones.
     * Falls back to heuristic file inference if LLM fails.
     */
    async extractGoal(
        request: string,
        executionId: string,
        conversationContext?: ConversationMessage[]
    ): Promise<GoalDefinition> {
        // Use a fast model for goal extraction — this is a structured text→JSON task,
        // not reasoning-heavy. Avoids spending 60-90s on a 235B vision model for setup overhead.
        const llm = modelRouter.getAdapterForTask('simple_qa') || modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) throw new Error('No LLM provider available');

        // Build conversation context section if available
        const contextSection = conversationContext && conversationContext.length > 0
            ? `\nCONVERSATION CONTEXT (what was discussed before this goal was triggered):\n` +
            conversationContext
                .slice(-10) // Last 10 messages to keep prompt manageable
                .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 300)}`)
                .join('\n') +
            `\n\nIMPORTANT: Use the conversation context above to understand what "it", "this", "that", etc. refer to in the user request below.\n`
            : '';

        const prompt = `You are a goal analysis expert. Extract a structured goal from the user's request.
${contextSection}
User Request: ${request}

Analyze this request and output ONLY valid JSON:

{
  "description": "Clear, concise description of what user wants",
  "success_criteria": [
    {
      "type": "file_exists" | "file_contains" | "code_compiles" | "tests_pass" | "output_matches" | "custom" | "llm_evaluates",
      "config": {
        "path": "file path if applicable",
        "pattern": "regex pattern if applicable",
        "command": "command to run if custom/tests_pass/code_compiles",
        "expected": "expected output/description for llm_evaluates"
      },
      "weight": 0.0-1.0,
      "required": true/false
    }
  ],
  "acceptance_test": "Human-readable description of what 'done' looks like",
  "estimated_complexity": 1-10,
  "suggested_milestones": ["Step 1", "Step 2", ...],
  "expected_files": ["file1.js", "file2.md"],
  "required_tool_types": ["browser", "shell", "file", "web_search"]
}

REQUIRED_TOOL_TYPES GUIDE — declare which tool categories this goal REQUIRES:
- "browser"    : Goal requires navigating a website, clicking buttons, filling forms, signing up, logging in, submitting. DO NOT use for goals that only need to read/fetch/scrape web content — use "web_search" instead.
- "shell"      : Goal requires running scripts, compiling code, executing commands
- "file"       : Goal only needs to read/write files (no network, no browser)
- "web_search" : Goal needs live web search but NOT browser interaction
- "messaging"  : Goal needs to send messages (Telegram, Discord, etc.)
Include ALL that apply. This is used to detect if the agent cheated (e.g. browser goal completed without using browser tools).
Examples:
- "Sign up for Google Beta, click Become Tester" → ["browser", "file"]
- "Fetch NSE stock prices and write a report" → ["shell", "web_search", "file"]
- "Create a calculator app" → ["shell", "file"]
- "Send a Telegram message with today's weather" → ["web_search", "messaging", "file"]

CRITERION TYPE GUIDE (use the MOST APPROPRIATE type for each check):
- "file_exists": File was created at the specified path
- "file_contains": File exists AND contains content matching a regex pattern
  IMPORTANT: pattern must be a REAL regex, not a plain English description.
  BAD: pattern="numbers"  BAD: pattern="data"  BAD: pattern="fibonacci sequence"
  GOOD: pattern="\\d+"  GOOD: pattern="fibonacci|sequence"  GOOD: pattern="\\[\\d"
  For JSON/CSV output files where you want to verify data quality → use "llm_evaluates" instead.
- "code_compiles": Code compiles/runs without syntax errors (config.command = compile/lint command)
- "tests_pass": Test suite passes (config.command = test command)
- "output_matches": A command produces expected output (config.command + config.expected)
- "llm_evaluates": LLM reviews the output quality against config.expected description (use for subjective quality checks AND for verifying JSON/CSV data content)
- "custom": Arbitrary validation command

RUNTIME SELECTION — CRITICAL:
- Use Python (.py) for: data analysis, financial data, stocks, pandas, yfinance, numpy, matplotlib, CSV, Excel, scraping with requests/BeautifulSoup
- Use Node.js (.js) for: web APIs, REST endpoints, JSON APIs, JavaScript/TypeScript tasks, browser automation
- Match the file extension to the runtime the execution model will actually use — criteria with wrong extension will NEVER pass
- When in doubt: if the task involves data, numbers, or finance → use Python; if it involves web/API → use Node.js

DATA RETRIEVAL STRATEGY — CRITICAL:
- For tasks requiring live data (stocks, weather, news, prices, sports scores):
  * NEVER use yahoo-finance2 npm package — it is NOT installed in the sandbox
  * NEVER call query1.finance.yahoo.com directly — it returns 401 Unauthorized
  * For Indian stock market (NSE/BSE): use Python yfinance: pip install yfinance && python3 -c "import yfinance as yf; ..."
    OR use curl with headers: curl -H "User-Agent: Mozilla/5.0" "https://query2.finance.yahoo.com/v8/finance/chart/RELIANCE.NS"
    OR use the stooq API: https://stooq.com/q/d/l/?s=RELIANCE.NS&i=d (returns CSV, no auth)
  * For weather: use wttr.in API: curl "https://wttr.in/Mumbai?format=j1"
  * For crypto: use CoinGecko: curl "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr"
  * For news/search: use the web_search tool (already available as a tool)
  * Python scripts can use requests, yfinance, pandas (all pre-installed in sandbox)
  * Node.js scripts should use built-in fetch() — NOT require() of uninstalled packages
  * Always include error handling and write results to a file

CRITICAL RULES:
1. Include at least one "file_exists" criterion for the main deliverable file
2. For code creation tasks, include a "file_contains" criterion with key patterns
3. For tasks requesting specific behavior, use "output_matches" to verify it works
4. For subjective quality goals (e.g. "write a good report"), use "llm_evaluates"
5. NEVER use type "custom" with command "echo" — that's a useless check
6. Set required=true for ALL criteria by default. Only use required=false for purely cosmetic/bonus checks that should never block completion.
7. Complexity: 1-3 (simple), 4-6 (medium), 7-10 (complex)
8. Be specific with file paths. Use .py for data/finance/analysis scripts, .js for web/API scripts.
9. "expected_files" should list ALL files that need to be created
10. DELEGATION GOALS: If the request says "delegate to a child agent", "use a sub-agent", "spawn an agent", etc., set estimated_complexity to at least 6. Use "llm_evaluates" with expected="Task delegated and result reported back" as the ONLY success criterion — NEVER use file_exists for a .docx or .txt file.
11. REPORTING GOALS: If the request says "report it back", "report the result", or "find and tell me", the goal is informational — use "llm_evaluates" with expected="Task completed and result reported", NOT a file_exists criterion.
12. RECOMMENDATION/ADVISORY GOALS: If the request says "recommend", "suggest", "which is best", "top stocks", "advise", "what should I", produce a markdown report file. Use file_exists with a DESCRIPTIVE path like "output/nse_stocks_report.md", "output/crypto_report.md", "output/investment_report.md". NEVER use "output/result.txt".
13. FORBIDDEN OUTPUT FILE: NEVER use "output/result.txt" as an expected_files entry or criterion path. It is too generic and will cause validation failures. Always use a descriptive topic-based name.
14. MESSAGING GOALS: If the request says "send to telegram", "send to discord", "send to whatsapp", "message me", "forward to telegram", or similar — the ONLY criterion should be type "messaging" with expected="messaging_send_file called successfully for each file". Set expected_files=[] and estimated_complexity=2. The agent must call messaging_send_file directly — NEVER require the agent to create extra zip/receipt/log files as criteria. DO NOT add file_exists criteria for these goals.

EXAMPLE for "recommend NSE large cap stocks by sector with valuation":
{
  "description": "Recommend top NSE large-cap stocks per sector based on today's market impact, valuation and fundamentals",
  "success_criteria": [
    { "type": "file_exists", "config": { "path": "output/nse_stocks_report.md" }, "weight": 1.0, "required": true },
    { "type": "file_contains", "config": { "path": "output/nse_stocks_report.md", "pattern": "Banking|IT|Energy|Pharma|FMCG" }, "weight": 0.8, "required": true },
    { "type": "llm_evaluates", "config": { "path": "output/nse_stocks_report.md", "expected": "Contains 5 stock recommendations per sector with P/E, ROE and buy rationale" }, "weight": 0.7, "required": true }
  ],
  "expected_files": ["output/nse_stocks_report.md", "stock_analysis.py"],
  "estimated_complexity": 6
}

EXAMPLE for "send the analysis files to telegram" / "forward these files to telegram":
{
  "description": "Send the generated analysis files to the user via Telegram",
  "success_criteria": [
    { "type": "messaging", "config": { "expected": "messaging_send_file called successfully for each file" }, "weight": 1.0, "required": true }
  ],
  "expected_files": [],
  "estimated_complexity": 2
}

EXAMPLE for "delegate to researcher agent to find the password and report back":
{
  "description": "Delegate file-reading task to researcher child agent and report the found password",
  "success_criteria": [
    { "type": "llm_evaluates", "config": { "expected": "Task delegated to researcher agent and password reported back" }, "weight": 1.0, "required": true }
  ],
  "expected_files": [],
  "estimated_complexity": 6
}

EXAMPLE for "get NSE top gainers and suggest investment":
{
  "description": "Fetch NSE top gainers/losers and generate investment advice",
  "success_criteria": [
    { "type": "file_exists", "config": { "path": "output/nse_analysis.md" }, "weight": 1.0, "required": true },
    { "type": "file_contains", "config": { "path": "output/nse_analysis.md", "pattern": "Top Gainers|Top Losers" }, "weight": 0.8, "required": true },
    { "type": "llm_evaluates", "config": { "path": "output/nse_analysis.md", "expected": "Contains specific stock names, percentage changes, and actionable investment suggestions" }, "weight": 0.7, "required": true }
  ],
  "expected_files": ["output/nse_analysis.md", "fetch_nse.py"],
  "estimated_complexity": 5
}

EXAMPLE for "create a calculator app with tests":
{
  "description": "Create a calculator application with unit tests",
  "success_criteria": [
    { "type": "file_exists", "config": { "path": "calculator/calc.js" }, "weight": 1.0, "required": true },
    { "type": "file_exists", "config": { "path": "calculator/calc.test.js" }, "weight": 0.8, "required": true },
    { "type": "file_contains", "config": { "path": "calculator/calc.js", "pattern": "function (add|subtract|multiply|divide)|exports\\." }, "weight": 0.6, "required": true },
    { "type": "code_compiles", "config": { "command": "node -e \"require('./calculator/calc')\"" }, "weight": 0.5, "required": true }
  ],
  "expected_files": ["calculator/calc.js", "calculator/calc.test.js"],
  "estimated_complexity": 4
}`;

        try {
            const result = await llm.generateJSON(prompt, {});

            const goal: GoalDefinition = {
                id: `goal_${executionId}`,
                description: result.description || request,
                success_criteria: (result.success_criteria || []).map((c: any, i: number) => ({
                    id: generateId('criterion'),
                    type: c.type || 'file_exists',
                    config: c.config || {},
                    weight: c.weight || 1.0,
                    required: c.required !== false,
                    status: 'pending' as const
                })),
                acceptance_test: result.acceptance_test,
                priority: 'medium',
                estimated_complexity: result.estimated_complexity || 5,
                suggested_milestones: result.suggested_milestones || [],
                required_tool_types: Array.isArray(result.required_tool_types)
                    ? result.required_tool_types.map((t: any) => String(t).toLowerCase())
                    : []
            };

            // Normalize hallucinated slug-prefix paths (LLM sometimes uses goal-title as directory)
            // e.g. "navigate-moneycontrol-com-search-reliance-gax3/price.txt" → "price.txt"
            const STANDARD_DIRS = new Set(['output', 'src', 'data', 'results', 'reports', 'files',
                'downloads', 'uploads', 'build', 'dist', 'tmp', 'temp', 'workspace', 'app', 'calculator',
                'project', 'code', 'scripts', 'analysis', 'research']);
            for (const c of goal.success_criteria) {
                if (c.config?.path && typeof c.config.path === 'string') {
                    const filePath: string = c.config.path;
                    if (!filePath.startsWith('/')) {
                        const parts = filePath.split('/');
                        if (parts.length >= 2) {
                            const firstDir = parts[0].toLowerCase();
                            // Strip if it looks like a goal slug (3+ hyphens or ends with 3-5 char random suffix)
                            const isSlug = !STANDARD_DIRS.has(firstDir) &&
                                (firstDir.split('-').length >= 3 || /^.+-[a-z0-9]{3,5}$/.test(firstDir));
                            if (isSlug) {
                                const normalized = parts.slice(1).join('/') || parts[parts.length - 1];
                                console.warn(`[GoalExtractor] Normalized slug-prefix path: ${filePath} → ${normalized}`);
                                c.config.path = normalized;
                            }
                        }
                    }
                }
            }

            // Binary file extensions where plain-text pattern search is meaningless.
            // XLSX, DOCX, PPTX, PDF are ZIP/binary formats — file_contains will never
            // match any text pattern inside them. Convert to llm_evaluates instead.
            // Also strip path from any llm_evaluates criteria pointing to binary files
            // (the validator would try to read binary content as text, producing garbage).
            // Binary file extensions where plain-text pattern search is meaningless.
            // XLSX, DOCX, PPTX, PDF are ZIP/binary formats — file_contains will never
            // match any text pattern inside them. Convert to llm_evaluates with the path
            // preserved so GoalValidator.readFileAsText() can extract real text via pdf-parse/mammoth.
            const BINARY_EXTENSIONS = new Set(['xlsx', 'xls', 'docx', 'pptx', 'pdf', 'odt', 'ods', 'odp']);
            goal.success_criteria = goal.success_criteria.map(c => {
                if (c.type === 'file_contains' && c.config.path) {
                    const ext = c.config.path.split('.').pop()?.toLowerCase() ?? '';
                    if (BINARY_EXTENSIONS.has(ext)) {
                        // Convert to llm_evaluates — GoalValidator will extract text via pdf-parse/mammoth
                        console.warn(`[GoalExtractor] Converting file_contains→llm_evaluates for binary file: ${c.config.path}`);
                        return {
                            ...c,
                            type: 'llm_evaluates' as const,
                            config: {
                                path: c.config.path,  // keep path — GoalValidator.readFileAsText handles binary
                                expected: `The ${ext.toUpperCase()} file at ${c.config.path} contains content matching: ${c.config.pattern}`
                            }
                        };
                    }
                }
                return c;
            });

            // ── WORD-ONLY PATTERN NORMALIZATION ───────────────────────────────────
            // LLMs sometimes generate file_contains criteria with plain English words
            // as patterns ("numbers", "data", "values", "results") instead of proper regex.
            // These never match actual JSON/CSV content and cause correct agent output to
            // fail validation silently. Convert them to llm_evaluates so the check is
            // semantic rather than brittle string matching.
            const DATA_EXTENSIONS = new Set(['json', 'csv', 'tsv', 'xml', 'yaml', 'yml']);
            const HAS_REGEX_CHARS = /[|\\^$*+?.()\[\]{}\d]/;
            goal.success_criteria = goal.success_criteria.map(c => {
                if (c.type === 'file_contains' && c.config.path && c.config.pattern) {
                    const ext = c.config.path.split('.').pop()?.toLowerCase() ?? '';
                    const pattern = String(c.config.pattern);
                    const isDataFile = DATA_EXTENSIONS.has(ext);
                    const isWordOnly = !HAS_REGEX_CHARS.test(pattern) && pattern.trim().split(/\s+/).length <= 3;
                    if (isDataFile && isWordOnly) {
                        console.warn(`[GoalExtractor] Converting word-only file_contains→llm_evaluates for data file: ${c.config.path} pattern="${pattern}"`);
                        return {
                            ...c,
                            type: 'llm_evaluates' as const,
                            config: {
                                path: c.config.path,
                                expected: `The ${ext.toUpperCase()} file at ${c.config.path} contains the expected data: ${pattern}`
                            }
                        };
                    }
                }
                return c;
            });
            // ── END WORD-ONLY PATTERN NORMALIZATION ───────────────────────────────

            // Filter out useless criteria (echo commands, empty configs, forbidden generic paths)
            goal.success_criteria = goal.success_criteria.filter(c => {
                if (c.type === 'custom' && c.config.command && /^echo\s/.test(c.config.command)) {
                    console.warn('[GoalExtractor] Filtered out useless echo criterion');
                    return false;
                }
                // Strip the forbidden generic output/result.txt — it causes infinite loops because
                // the agent writes a meaningful file elsewhere and this check never passes.
                if (c.type === 'file_exists' && c.config.path === 'output/result.txt') {
                    console.warn('[GoalExtractor] Filtered out forbidden generic criterion: output/result.txt');
                    return false;
                }
                if (c.type === 'custom' && !c.config.command && !c.config.path) {
                    console.warn('[GoalExtractor] Filtered out empty custom criterion');
                    return false;
                }
                return true;
            });

            // ── BEHAVIORAL CRITERION AUDIT ─────────────────────────────────────────
            // Drop custom criteria whose descriptions are behavioral/temporal — they
            // describe INTENT ("task paused", "user confirmed") that runCustomValidation()
            // can never evaluate (no command, no path → always returns false).
            // Without this filter, these criteria cause the LLM to re-trigger HITL on
            // every iteration (infinite loop). Rule-based: 100% model-independent.
            const BEHAVIORAL_KEYWORDS = [
                'waited', 'paused', 'confirmed', 'notification fired',
                'after user', 'before proceeding', 'sent telegram',
                'user confirmed', 'user responded', 'user input',
                'asked user', 'human review', 'awaiting'
            ];
            const isBehavioral = (desc: string) =>
                BEHAVIORAL_KEYWORDS.some(kw => desc.toLowerCase().includes(kw));

            const preBehaviorCount = goal.success_criteria.length;
            goal.success_criteria = goal.success_criteria.filter(c => {
                if (c.type === 'custom') {
                    const desc = c.config?.expected || c.config?.pattern || '';
                    if (isBehavioral(desc)) {
                        console.warn(`[GoalExtractor] Dropped behavioral criterion (unvalidatable): "${desc.substring(0, 80)}"`);
                        return false;
                    }
                }
                return true;
            });
            if (goal.success_criteria.length < preBehaviorCount) {
                console.log(`[GoalExtractor] Behavioral audit removed ${preBehaviorCount - goal.success_criteria.length} unvalidatable criterion/criteria`);
            }
            // ── END BEHAVIORAL CRITERION AUDIT ────────────────────────────────────

            // If LLM gave us expected_files, generate file_exists criteria from them
            if (result.expected_files && Array.isArray(result.expected_files)) {
                for (const filePath of result.expected_files) {
                    const alreadyHas = goal.success_criteria.some(
                        c => c.type === 'file_exists' && c.config.path === filePath
                    );
                    if (!alreadyHas) {
                        goal.success_criteria.push({
                            id: generateId('criterion'),
                            type: 'file_exists',
                            config: { path: filePath },
                            weight: 1.0,
                            required: true,
                            status: 'pending'
                        });
                    }
                }
            }

            // Ensure at least one REAL criterion (not echo)
            if (goal.success_criteria.length === 0) {
                const inferredFiles = this.inferExpectedFiles(request);
                for (const filePath of inferredFiles) {
                    goal.success_criteria.push({
                        id: generateId('criterion'),
                        type: 'file_exists',
                        config: { path: filePath },
                        weight: 1.0,
                        required: true,
                        status: 'pending'
                    });
                }

                // If we still have nothing, use llm_evaluates — far better than a hard-coded filename
                if (goal.success_criteria.length === 0) {
                    goal.success_criteria.push({
                        id: generateId('criterion'),
                        type: 'llm_evaluates',
                        config: { expected: 'Task completed successfully and output produced' },
                        weight: 1.0,
                        required: true,
                        status: 'pending'
                    });
                }
            }

            // Auto-inject screenshot criterion for browser action-completion goals.
            // "Action-completion" = the goal requires the agent to DO something on a website
            // (sign up, submit, click, purchase, enroll) — NOT just scrape or monitor.
            // A screenshot is the only hard evidence that can't be faked without actually
            // opening a browser. If the screenshot file is missing → hard fail.
            const isBrowserGoal = (goal.required_tool_types || []).includes('browser');
            const ACTION_COMPLETION_RE = /\b(sign[\s-]?up|register|enroll|enrol|book(?:ing)?|purchas|order|submit|apply|click|fill[\s-]?in|log[\s-]?in|create[\s-]+account|become[\s-]+tester|join[\s-]+beta|opt[\s-]+in)\b/i;
            const isActionCompletion = ACTION_COMPLETION_RE.test(request);
            if (isBrowserGoal && isActionCompletion) {
                const alreadyHasScreenshot = goal.success_criteria.some(
                    c => c.config?.path && /screenshot|\.png$/i.test(c.config.path)
                );
                if (!alreadyHasScreenshot) {
                    goal.success_criteria.push({
                        id: generateId('criterion'),
                        type: 'file_exists',
                        config: { path: 'confirmation_screenshot.png' },
                        weight: 1.0,
                        required: true,
                        status: 'pending'
                    });
                    console.log('[GoalExtractor] Auto-injected screenshot criterion for browser action-completion goal');
                }
            }

            // Auto-inject package.json devDependencies constraint when prompt explicitly names a test framework.
            // This gives the agent an enforceable criterion to add the framework to devDependencies —
            // more reliable than detecting "Test Suites:" in expected output strings (fragile, framework-specific).
            const hasTestsPass = goal.success_criteria.some(c => c.type === 'tests_pass');
            if (hasTestsPass) {
                const TEST_FRAMEWORK_RE = /\b(jest|mocha|vitest|jasmine|ava|tape)\b/i;
                const frameworkMatch = request.match(TEST_FRAMEWORK_RE);
                if (frameworkMatch) {
                    const framework = frameworkMatch[1].toLowerCase();
                    const alreadyHasFrameworkCheck = goal.success_criteria.some(
                        c => c.type === 'file_contains' &&
                            c.config.path === 'package.json' &&
                            String(c.config.pattern || '').includes(framework)
                    );
                    if (!alreadyHasFrameworkCheck) {
                        goal.success_criteria.push({
                            id: generateId('criterion'),
                            type: 'file_contains',
                            config: {
                                path: 'package.json',
                                pattern: `"${framework}"`,
                            },
                            weight: 0.8,
                            required: true,
                            status: 'pending'
                        });
                        console.log(`[GoalExtractor] Auto-injected devDependencies criterion for test framework: ${framework}`);
                    }
                }
            }

            console.log(`[GoalExtractor] Final criteria count: ${goal.success_criteria.length}, required_tool_types: [${(goal.required_tool_types || []).join(', ')}]`);
            goal.success_criteria.forEach((c, i) => {
                console.log(`[GoalExtractor]   ${i + 1}. ${c.type}: ${JSON.stringify(c.config)}`);
            });

            return goal;
        } catch (error) {
            console.error('[GoalExtractor] Goal extraction failed:', error);

            // Return a goal with file-based criteria inferred from request
            const inferredFiles = this.inferExpectedFiles(request);
            const criteria: SuccessCriterion[] = inferredFiles.length > 0
                ? inferredFiles.map(f => ({
                    id: generateId('criterion'),
                    type: 'file_exists' as const,
                    config: { path: f },
                    weight: 1.0,
                    required: true,
                    status: 'pending' as const
                }))
                : [{
                    id: generateId('criterion'),
                    type: 'llm_evaluates' as const,
                    config: { expected: 'Task completed successfully and output produced' },
                    weight: 1.0,
                    required: true,
                    status: 'pending' as const
                }];

            return {
                id: `goal_${executionId}`,
                description: request,
                success_criteria: criteria,
                priority: 'medium',
                estimated_complexity: 5
            };
        }
    }

    /**
     * Infer expected file paths from the user's request text
     * when LLM extraction fails or returns no criteria.
     */
    inferExpectedFiles(request: string): string[] {
        const files: string[] = [];
        const lower = request.toLowerCase();

        // "report it back", "report back to you", "report the result to" — verb usage, NOT a file
        const reportAsVerb = /\breport(?:s|ed|ing)?\s+(it|back|the\s+result|to\s+you)\b/.test(lower);

        // Documents / reports — check BEFORE generic code keywords
        if (lower.includes('excel') || lower.includes('xlsx') || lower.includes('spreadsheet')) {
            files.push('output/report.xlsx');
        } else if (lower.includes('word') || lower.includes('docx') || lower.includes('document')) {
            files.push('output/report.docx');
        } else if (lower.includes('pdf')) {
            files.push('output/report.pdf');
        } else if (lower.includes('csv')) {
            files.push('output/data.csv');
        } else if (!reportAsVerb && (lower.includes('report') || lower.includes('analysis') || lower.includes('analyse') || lower.includes('analyze')
            || lower.includes('recommend') || lower.includes('suggest') || lower.includes('advise') || lower.includes('top stocks'))) {
            // Generic report/recommendation → markdown
            // Skip when "report" is used as a verb ("report it back", "report to you")
            const subject = lower.includes('stock') || lower.includes('nse') || lower.includes('bse') ? 'nse_stocks'
                : lower.includes('crypto') ? 'crypto'
                    : lower.includes('weather') ? 'weather'
                        : lower.includes('recommend') || lower.includes('suggest') ? 'recommendations'
                            : 'analysis';
            files.push(`output/${subject}_report.md`);
        } else if (lower.includes('trading') || lower.includes('strategy') || lower.includes('agent')) {
            if (lower.includes('momentum')) files.push('agents/momentum_agent.js');
            if (lower.includes('mean reversion') || lower.includes('reversion')) files.push('agents/mean_reversion_agent.js');
            if (lower.includes('arbitrage')) files.push('agents/arbitrage_agent.js');

            if (files.length === 0) {
                files.push('agents/trading_agent_1.js');
                files.push('agents/trading_agent_2.js');
                files.push('agents/trading_agent_3.js');
            }
        } else if (lower.includes('website') || lower.includes('html') || lower.includes('webpage')) {
            files.push('index.html');
            if (lower.includes('css') || lower.includes('style')) files.push('styles.css');
            if (lower.includes('js') || lower.includes('javascript')) files.push('script.js');
        } else if (lower.includes('api') || lower.includes('server') || lower.includes('backend')) {
            files.push('server.js');
        } else if (lower.includes('script') || lower.includes('automate')) {
            files.push('script.js');
        } else if (lower.includes('dashboard')) {
            files.push('dashboard/index.html');
            files.push('dashboard/app.js');
        }

        return files;
    }
}
