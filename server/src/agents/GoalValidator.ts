import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
    SuccessCriterion,
    GoalDefinition,
    ValidationResult
} from '../types/goal';
import { configManager } from '../services/ConfigManager';
import { isCommandSafe, logSecurityEvent } from '../utils/security';
import { modelManager } from '../services/llm/modelManager';
import { modelRouter } from '../services/llm/modelRouter';

const execAsync = promisify(exec);

// ============================================================================
// GOAL VALIDATOR
// Validates success criteria to determine if goals are achieved
// ============================================================================

export class GoalValidator extends EventEmitter {
    private workspaceDir: string;

    // Gap C + Bug #2b: mtime cache for llm_evaluates.
    // Key: `${filePath}::${criterionId}` — each criterion on each file tracked independently.
    // Value: { mtime (ms epoch), result {passed, message} }
    // When file mtime is unchanged since last LLM eval → return cached result (0 extra LLM calls).
    // When mtime changes (agent wrote new content) → re-evaluate and update cache.
    private readonly _llmEvalCache: Map<string, { mtime: number; result: { passed: boolean; message: string } }> = new Map();

    /**
     * Set by GoalOrientedExecutor before the iteration loop starts.
     * Used to reject stale pre-run files from ghost-passing file_exists criteria.
     * 0 = not set (feature disabled, all files pass regardless of mtime).
     */
    public executionStartTime: number = 0;

    constructor() {
        super();
        this.workspaceDir = configManager.getWorkspaceDir();
    }

    /**
     * Update workspace directory
     */
    setWorkspace(dir: string): void {
        this.workspaceDir = dir;
    }

    /**
     * Set the per-execution project output directory.
     * Called by GoalOrientedExecutor after the output slug dir is created.
     * checkTestsPass / checkOutputMatches use this as cwd so npm test
     * executes from the actual project subdirectory, not the workspace root.
     */
    setOutputDir(dir: string): void {
        this.outputDir = dir;
    }

    /**
     * Validate a single criterion
     */
    async validateCriterion(criterion: SuccessCriterion, executionContext?: string): Promise<{
        passed: boolean;
        message: string;
    }> {
        try {
            switch (criterion.type) {
                case 'file_exists':
                    return await this.checkFileExists(criterion.config.path!);

                case 'file_contains':
                    return await this.checkFileContains(
                        criterion.config.path!,
                        criterion.config.pattern!
                    );

                case 'code_compiles':
                    return await this.checkCodeCompiles(criterion.config.command);

                case 'tests_pass':
                    return await this.checkTestsPass(criterion.config.command);

                case 'output_matches':
                    return await this.checkOutputMatches(
                        criterion.config.command!,
                        criterion.config.expected!
                    );

                case 'custom':
                    return await this.runCustomValidation(criterion.config);

                case 'llm_evaluates':
                    return await this.checkLLMEvaluates(
                        criterion.config.expected || criterion.config.pattern || 'Is this goal complete?',
                        criterion.config.path,
                        executionContext
                    );

                case 'messaging':
                    // Validate by asking the LLM if the messaging tool was called successfully.
                    // messaging_send / messaging_send_file write a receipt file on success.
                    return await this.checkLLMEvaluates(
                        criterion.config.expected || 'messaging_send or messaging_send_file was called and returned success',
                        undefined,
                        executionContext
                    );

                default:
                    return { passed: false, message: `Unknown criterion type: ${criterion.type}` };
            }
        } catch (error) {
            return {
                passed: false,
                message: `Validation error: ${error}`
            };
        }
    }

    /**
     * Validate all criteria for a goal.
     *
     * @param iterationContext  Optional {current, max} to gate expensive criterion types:
     *   - file_exists:      always runs (zero cost)
     *   - content_contains: skipped before iteration 3 (unless isEarlyCheck)
     *   - llm_evaluates:    skipped before 40% of maxIterations (unless isEarlyCheck)
     *   Iteration 3 always runs all types once as a derailment-detection pass.
     * @param actualToolsUsed  List of tool names actually called during execution.
     *   Used for the tool-evasion gate (Option B): if the goal declares required_tool_types
     *   including 'browser' but no browser_* tools were used, llm_evaluates auto-fails.
     */
    async validateGoal(
        goal: GoalDefinition,
        executionContext?: string,
        iterationContext?: { current: number; max: number },
        actualToolsUsed?: string[]
    ): Promise<ValidationResult> {
        console.log(`[GoalValidator] Validating goal: ${goal.description}`);

        // ── Option B: Tool-Evasion Gate ───────────────────────────────────────
        // If the goal declared required_tool_types including 'browser' but the
        // agent never called any browser_* tool, auto-fail all llm_evaluates.
        // Grace period: skip the check for the first 30% of iterations so the
        // agent can legitimately use web_search to discover URLs before navigating.
        // Only fires if the agent COMPLETES without ever touching a browser_* tool.
        let browserEvasionDetected = false;
        if (actualToolsUsed && actualToolsUsed.length > 0) {
            const requiresBrowser = (goal.required_tool_types || []).includes('browser');
            if (requiresBrowser) {
                // stealth_fetch and web_fetch are browser-backed tools that satisfy
                // the browser requirement for research/data-fetch goals.
                const usedBrowserTool = actualToolsUsed.some(t =>
                    t.startsWith('browser_') || t === 'stealth_fetch' || t === 'web_fetch'
                );
                // Only flag evasion for goals that require explicit browser interaction
                // (click, login, form-fill, etc.). Data-fetch / research goals that use
                // web_search, run_command, or direct API calls are NOT evading — they are
                // legitimately choosing a more efficient path. False-positive evasion
                // detection caused goals like "GitHub trending report" to fail even when
                // the agent was correctly using web_search + file writes.
                const BROWSER_INTERACTION_RE = /\b(click|log.?in|sign.?in|sign.?up|register|form.?fill|captcha|screenshot|scroll|authenticate|submit button|type into|interact with)\b/i;
                const requiresExplicitInteraction = BROWSER_INTERACTION_RE.test(goal.description);
                // Only flag evasion after 30% of iterations — early exploration is fine
                const pastGracePeriod = !iterationContext ||
                    (iterationContext.current / Math.max(iterationContext.max, 1)) >= 0.30;
                if (!usedBrowserTool && pastGracePeriod && requiresExplicitInteraction) {
                    browserEvasionDetected = true;
                    console.warn(`[GoalValidator] TOOL-EVASION DETECTED: goal requires browser tools but agent used: [${[...new Set(actualToolsUsed)].join(', ')}]`);
                }
            }
        }

        // ── Option A: Criterion-Path Evidence Set ─────────────────────────────
        // Collect all file paths declared in criteria (before execution starts
        // so the agent can't game ordering). These are used as evidence for
        // llm_evaluates criteria that have no explicit filePath.
        const criterionFilePaths = goal.success_criteria
            .filter(c => c.config?.path && typeof c.config.path === 'string')
            .map(c => c.config.path as string)
            .filter((p, i, arr) => arr.indexOf(p) === i); // deduplicate

        // Compute which criterion types to skip this pass
        const skipTypes = new Set<string>();
        if (iterationContext) {
            const { current, max } = iterationContext;
            const pct = current / Math.max(max, 1);
            const isEarlyCheck = current === 3; // mandatory derailment-detection pass
            if (!isEarlyCheck) {
                if (pct < 0.15) skipTypes.add('content_contains');
                if (pct < 0.40) skipTypes.add('llm_evaluates');
            }
        }

        const details: ValidationResult['details'] = [];

        // Validate each criterion
        for (const criterion of goal.success_criteria) {
            // Skip expensive types that aren't due yet — preserve their previous status
            if (skipTypes.has(criterion.type)) {
                details.push({
                    criterion_id: criterion.id,
                    passed: criterion.status === 'passed',
                    message: criterion.message || `Skipped (not yet due at this iteration)`
                });
                continue;
            }

            // mtime-cache for file_exists and file_contains:
            // Once a file passes, skip re-evaluation until its mtime changes.
            // Prevents a replan from un-passing criteria just because the file wasn't re-read.
            let result: { passed: boolean; message: string };
            if ((criterion.type === 'file_exists' || criterion.type === 'file_contains') && criterion.config.path) {
                const absPath = path.isAbsolute(criterion.config.path)
                    ? criterion.config.path
                    : path.join(this.workspaceDir, criterion.config.path);
                const cacheKey = `${absPath}::${criterion.id}`;
                let currentMtime = 0;
                try { currentMtime = fs.statSync(absPath).mtimeMs; } catch { /* file not yet created */ }

                const cached = this._llmEvalCache.get(cacheKey);
                if (cached && cached.mtime === currentMtime && currentMtime > 0 && cached.result.passed) {
                    // File exists and hasn't changed since it last passed — return cached pass
                    result = cached.result;
                } else {
                    result = await this.validateCriterion(criterion, executionContext);
                    if (result.passed && currentMtime > 0) {
                        this._llmEvalCache.set(cacheKey, { mtime: currentMtime, result });
                    } else if (!result.passed) {
                        // File failed or was modified — clear any stale cached pass
                        this._llmEvalCache.delete(cacheKey);
                    }
                }
            } else if (criterion.type === 'llm_evaluates' && criterion.config.path) {
                const absPath = path.isAbsolute(criterion.config.path)
                    ? criterion.config.path
                    : path.join(this.workspaceDir, criterion.config.path);
                const cacheKey = `${absPath}::${criterion.id}`;
                let currentMtime = 0;
                try {
                    currentMtime = fs.statSync(absPath).mtimeMs;
                } catch { /* file doesn't exist yet — mtime stays 0, cache will miss */ }

                const cached = this._llmEvalCache.get(cacheKey);
                if (cached && cached.mtime === currentMtime && currentMtime > 0) {
                    // File hasn't changed since last eval — reuse cached result, no LLM call
                    console.log(`[GoalValidator] llm_evaluates cache HIT for ${criterion.config.path} (mtime ${currentMtime}) — skipping LLM call`);
                    result = cached.result;
                } else {
                    // File changed or first check — run LLM eval and cache the result
                    result = await this.checkLLMEvaluates(
                        criterion.config.expected || criterion.config.pattern || 'Is this goal complete?',
                        criterion.config.path,
                        executionContext,
                        browserEvasionDetected,
                        criterionFilePaths
                    );
                    // Only cache successful reads — never cache "Cannot read file" failures,
                    // so a transient parse error doesn't lock out future eval attempts.
                    const isReadError = !result.passed && result.message.startsWith('Cannot read file');
                    if (currentMtime > 0 && !isReadError) {
                        this._llmEvalCache.set(cacheKey, { mtime: currentMtime, result });
                        console.log(`[GoalValidator] llm_evaluates cache SET for ${criterion.config.path} (mtime ${currentMtime})`);
                    } else if (isReadError) {
                        console.warn(`[GoalValidator] llm_evaluates NOT cached (read error) for ${criterion.config.path} — will retry next iteration`);
                    }
                }
            } else {
                result = criterion.type === 'llm_evaluates'
                    ? await this.checkLLMEvaluates(
                        criterion.config.expected || criterion.config.pattern || 'Is this goal complete?',
                        criterion.config.path,
                        executionContext,
                        browserEvasionDetected,
                        criterionFilePaths
                    )
                    : await this.validateCriterion(criterion, executionContext);
            }

            // Update criterion status
            criterion.status = result.passed ? 'passed' : 'failed';
            criterion.message = result.message;
            criterion.lastChecked = new Date();

            details.push({
                criterion_id: criterion.id,
                passed: result.passed,
                message: result.message
            });

            console.log(`[GoalValidator] Criterion ${criterion.id} (${criterion.type}): ${result.passed ? '✓' : '✗'} - ${result.message}`);
        }

        const passed = goal.success_criteria.filter(c => c.status === 'passed');
        const failed = goal.success_criteria.filter(c => c.status === 'failed');

        // Calculate weighted score
        const totalWeight = goal.success_criteria.reduce((sum, c) => sum + c.weight, 0);
        const passedWeight = passed.reduce((sum, c) => sum + c.weight, 0);
        const score = totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) : 0;

        // Complete only when ALL required criteria explicitly passed AND score >= 80%.
        // Checking requiredPassed.length === requiredAll.length (not just "none failed")
        // closes the weight-skew edge case where optional criteria inflate the score.
        const requiredAll = goal.success_criteria.filter(c => c.required);
        const requiredPassed = passed.filter(c => c.required);
        const requiredFailed = failed.filter(c => c.required);
        const complete = requiredAll.length > 0
            && requiredPassed.length === requiredAll.length
            && score >= 80;

        const result: ValidationResult = {
            complete,
            passed,
            failed,
            score,
            details
        };

        this.emit('validation:complete', { goal_id: goal.id, result });

        console.log(`[GoalValidator] Goal ${goal.id}: ${complete ? 'COMPLETE' : 'INCOMPLETE'} (Score: ${score}%, ${passed.length}/${goal.success_criteria.length} passed)`);

        return result;
    }

    // ========================================================================
    // VALIDATION METHODS
    // ========================================================================

    /**
     * Check if a file exists.
     * Rejects files whose mtime predates the current execution (stale artifacts from prior runs).
     */
    private async checkFileExists(filePath: string): Promise<{ passed: boolean; message: string }> {
        const fullPath = this.resolvePath(filePath);

        try {
            const stat = await fs.promises.stat(fullPath);

            // ── STALE FILE DETECTION ──────────────────────────────────────────────────
            // Reject files that predate this execution. Without this, leftover files from
            // prior runs ghost-pass file_exists criteria in new executions.
            // e.g. reddit-ml.png (169798 bytes) from run N passing in run N+1.
            if (this.executionStartTime > 0 && stat.mtimeMs < this.executionStartTime) {
                return {
                    passed: false,
                    message: `File STALE — created at ${new Date(stat.mtimeMs).toISOString()} which predates this run. Agent must write a fresh copy: ${fullPath}`
                };
            }
            // ── END STALE FILE DETECTION ──────────────────────────────────────────────

            return { passed: true, message: `File exists: ${filePath} (${stat.size} bytes)` };
        } catch {
            // Give agent the exact path it needs to create
            return { passed: false, message: `File NOT found at: ${fullPath} — agent must write this file` };
        }
    }

    /**
     * Check if a file contains a pattern — returns content preview on failure
     */
    private async checkFileContains(
        filePath: string,
        pattern: string
    ): Promise<{ passed: boolean; message: string }> {
        const fullPath = this.resolvePath(filePath);

        try {
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            // Bug 3 fix: add 'm' (multiline) flag so ^ and $ anchor per-line,
            // not to start/end of entire string. Also add 'g' and 'i' for completeness.
            const regex = new RegExp(pattern, 'gim');

            if (regex.test(content)) {
                return { passed: true, message: `File contains pattern "${pattern}"` };
            } else {
                // Show first 300 chars so agent can see what's wrong
                const preview = content.slice(0, 300).replace(/\n/g, '\\n');

                // Fix F: For JS/TS source files where the pattern looks like REST-doc format
                // (e.g. "GET /api/health"), add a specific hint. GoalExtractor sometimes generates
                // REST-doc style patterns that will never match Express source code which uses
                // app.get('/api/health', ...) syntax. The agent needs to see this mismatch clearly.
                const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
                const isSourceFile = ['js', 'ts', 'mjs', 'cjs', 'jsx', 'tsx'].includes(ext);
                const patternLooksLikeRestDoc = /^[A-Z]+ \/[a-z]/.test(pattern.trim());
                let hint = '';
                if (isSourceFile && patternLooksLikeRestDoc) {
                    hint = ` NOTE: Pattern uses REST documentation format ("GET /api/health") but this is a source code file. ` +
                        `Express routes look like app.get('/api/health', ...) — the literal string "GET /api/health" will not appear in code. ` +
                        `To satisfy this: add a JSDoc comment above each route, e.g. // GET /api/health, or adjust your route strings.`;
                }

                return {
                    passed: false,
                    message: `Pattern "${pattern}" NOT found in ${filePath}. File exists (${content.length} chars). Content preview: "${preview}"${hint}`
                };
            }
        } catch (error) {
            return { passed: false, message: `Cannot read file at ${fullPath}: ${error}` };
        }
    }

    /**
     * Check if code compiles.
     *
     * Bug 2 fix: Strip leading `cd <dir> && ` prefix from the command and pass
     * <dir> as the `cwd` option instead of letting it run through the shell.
     * This prevents "Compiler not found: cd" errors when the GoalExtractor
     * generates commands like `cd /workspace && tsc --target ES2020 greeting.ts`
     * because `cd` is a shell built-in, not a binary discoverable on PATH in all
     * container configurations.
     */
    private async checkCodeCompiles(
        command?: string
    ): Promise<{ passed: boolean; message: string }> {
        let cmd = command || 'npx tsc --noEmit';
        let cwd = this.workspaceDir;

        // Bug 2 fix: strip `cd <dir> && ` prefix, pass dir as cwd
        const cdPrefixMatch = cmd.match(/^cd\s+(\S+)\s*&&\s*(.+)$/i);
        if (cdPrefixMatch) {
            const cdDir = cdPrefixMatch[1];
            cmd = cdPrefixMatch[2].trim();
            // Resolve the cd target relative to the current workspace dir
            cwd = path.isAbsolute(cdDir) ? cdDir : path.join(this.workspaceDir, cdDir);
        }

        // Security: validate the actual compile command (not the cd wrapper)
        const cmdCheck = isCommandSafe(cmd);
        if (!cmdCheck.safe) {
            logSecurityEvent('block', 'GoalValidator', `checkCodeCompiles blocked: ${cmdCheck.reason}`, { command: cmd });
            return { passed: false, message: `Command blocked: ${cmdCheck.reason}` };
        }

        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd,
                timeout: 60000
            });

            // Exit code 0 = compilation succeeded
            return { passed: true, message: 'Code compiles successfully' };
        } catch (error: any) {
            const stderr: string = error.stderr || '';
            const message: string = error.message || '';

            // TypeScript compile error
            if (stderr.includes('error TS') || stderr.includes('error:')) {
                return {
                    passed: false,
                    message: `Compilation errors:\n${stderr.substring(0, 500)}`
                };
            }

            // Python syntax error
            if (stderr.includes('SyntaxError') || stderr.includes('IndentationError')) {
                return {
                    passed: false,
                    message: `Syntax error:\n${stderr.substring(0, 500)}`
                };
            }

            // Command not found — genuine infrastructure failure
            if (
                message.includes('command not found') ||
                message.includes('not recognized') ||
                message.includes('ENOENT') ||
                (error.code === 127)
            ) {
                return {
                    passed: false,
                    message: `Compiler not found: ${cmd.split(' ')[0]} is not installed or not in PATH. ` +
                        `Install it or update the compile command in the success criterion.`
                };
            }

            // Generic non-zero exit — treat as compile failure
            return {
                passed: false,
                message: `Compilation failed (exit ${error.code ?? 'unknown'}): ${stderr.substring(0, 300) || message.substring(0, 300)}`
            };
        }
    }

    /**
     * Check if tests pass
     */
    private async checkTestsPass(
        command?: string
    ): Promise<{ passed: boolean; message: string }> {
        let cmd = command || 'npm test';

        // Strip shell redirects (e.g. "npm test > results.txt") — when execAsync runs a
        // command with `>`, the shell redirects stdout to the file and the calling process
        // sees an empty string. Strip the redirect so we capture output directly.
        const redirectMatch = cmd.match(/^(.+?)\s*>\s*\S+\s*$/);
        if (redirectMatch) {
            const stripped = redirectMatch[1].trim();
            console.warn(`[GoalValidator] Stripped redirect from test command: "${cmd}" → "${stripped}"`);
            cmd = stripped;
        }

        // Security: validate command before execution
        const cmdCheck = isCommandSafe(cmd);
        if (!cmdCheck.safe) {
            logSecurityEvent('block', 'GoalValidator', `checkTestsPass blocked: ${cmdCheck.reason}`, { command: cmd });
            return { passed: false, message: `Command blocked: ${cmdCheck.reason}` };
        }

        // Resolve the project directory where npm test should run.
        // Priority: outputDir (per-execution project slug dir) > workspaceDir root.
        // This is the root cause fix: running npm test from /workspace when package.json
        // is at /workspace/my-project/ produces "Missing script: test" every iteration
        // regardless of what the agent writes.
        const projectDir = this.outputDir || this.workspaceDir;

        // npm install pre-flight: if node_modules is missing in projectDir, run npm install.
        // Without this, npm test fails with MODULE_NOT_FOUND even if package.json is correct.
        try {
            const nmDir = path.join(projectDir, 'node_modules');
            const pkgJson = path.join(projectDir, 'package.json');
            await fs.promises.access(pkgJson); // package.json must exist
            try {
                await fs.promises.access(nmDir); // node_modules already present — skip
            } catch {
                // node_modules missing — run npm install
                try {
                    await execAsync('npm install --prefer-offline --no-audit --no-fund', {
                        cwd: projectDir,
                        timeout: 120000
                    });
                } catch (installErr: any) {
                    console.warn(`[GoalValidator] npm install failed in ${projectDir}:`, installErr.message?.substring(0, 200));
                }
            }
        } catch { /* no package.json yet — npm test will report a clear error */ }

        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd: projectDir,
                timeout: 120000
            });

            const combined = stdout + stderr;

            // Check for explicit failure indicators first
            if (
                combined.includes('FAIL') ||
                combined.includes('failing') ||
                combined.includes('✗') ||
                combined.includes('× ') ||
                /\d+ failed/.test(combined)
            ) {
                return {
                    passed: false,
                    message: `Tests failed: ${combined.substring(0, 300)}`
                };
            }

            // Must have explicit pass indicators — bare exit-0 is NOT enough.
            // Use `combined` (stdout + stderr): Jest/Vitest write results to stderr, not stdout.
            const hasPassIndicator =
                combined.includes('passed') ||
                combined.includes('✓') ||
                combined.includes('PASS') ||
                combined.includes('passing') ||
                /\d+ tests? (passed|ok)/i.test(combined);

            if (hasPassIndicator) {
                return { passed: true, message: `Tests passed: ${combined.substring(0, 200)}` };
            }

            // Exit 0 but no recognisable test output — treat as inconclusive failure
            return {
                passed: false,
                message: `Test command exited 0 but no pass indicators found in output. ` +
                    `Ensure the test runner outputs "passed", "✓", or "PASS". ` +
                    `Output: ${combined.substring(0, 200)}`
            };
        } catch (error: any) {
            // execAsync rejects on non-zero exit — genuine test failure
            const detail = (error.stdout || '') + (error.stderr || '') + (error.message || '');

            // ECONNREFUSED hint: tests that hit a local HTTP server will fail with
            // ECONNREFUSED if the server isn't running. Give the agent a specific, actionable
            // instruction instead of a generic failure — prevents a new loop replacing the old one.
            if (detail.includes('ECONNREFUSED') || detail.includes('connect ECONNREFUSED')) {
                return {
                    passed: false,
                    message: `Tests failed: ${detail.substring(0, 300)} ` +
                        `HINT: Tests are trying to connect to a local server but it is not running. ` +
                        `Start the server as a background process first: ` +
                        `run_command("node server.js &") or run_command("node index.js &") ` +
                        `in the project directory, wait 1 second, then re-run npm test.`
                };
            }

            return {
                passed: false,
                message: `Tests failed: ${detail.substring(0, 300)}`
            };
        }
    }

    /**
     * Check if command output matches expected pattern.
     *
     * Shell redirect handling: when command contains `> filename`, the shell redirects
     * stdout to that file — so `execAsync` captures an empty string in `stdout`.
     * We detect the redirect target, run the command (ignoring non-zero exit), then read
     * the redirect file and match the expected pattern against its content instead.
     */
    private async checkOutputMatches(
        command: string,
        expected: string
    ): Promise<{ passed: boolean; message: string }> {
        // Security: validate command before execution
        const cmdCheck = isCommandSafe(command);
        if (!cmdCheck.safe) {
            logSecurityEvent('block', 'GoalValidator', `checkOutputMatches blocked: ${cmdCheck.reason}`, { command });
            return { passed: false, message: `Command blocked: ${cmdCheck.reason}` };
        }

        const cwd = this.outputDir || this.workspaceDir;
        const regex = new RegExp(expected, 'i');

        // Detect shell redirect: `some command > output.txt` or `cmd 2>&1 > file`
        const redirectMatch = command.match(/>\s*(\S+)\s*(?:2>&1)?\s*$/);
        const redirectFile = redirectMatch ? redirectMatch[1] : null;
        const redirectPath = redirectFile
            ? (path.isAbsolute(redirectFile) ? redirectFile : path.join(cwd, redirectFile))
            : null;

        const readRedirectFile = (): string | null => {
            if (!redirectPath) return null;
            try { return fs.readFileSync(redirectPath, 'utf8'); } catch { return null; }
        };

        try {
            const { stdout } = await execAsync(command, { cwd, timeout: 60000 });

            // If redirect was used, stdout is empty — check the file instead
            const checkContent = (redirectPath && !stdout.trim()) ? (readRedirectFile() ?? stdout) : stdout;

            if (regex.test(checkContent)) {
                return { passed: true, message: `Output matches expected pattern` };
            }
            return {
                passed: false,
                message: `Output doesn't match expected "${expected}". Got: ${checkContent.substring(0, 200)}`
            };
        } catch (error: any) {
            // Command exited non-zero (e.g. npm test failing) — file may still have been written.
            // Check the redirect file for the expected pattern before giving up.
            if (redirectPath) {
                const fileContent = readRedirectFile();
                if (fileContent !== null) {
                    if (regex.test(fileContent)) {
                        return { passed: true, message: `Output matches expected pattern (from redirect file)` };
                    }
                    return {
                        passed: false,
                        message: `Tests failed. Output: ${fileContent.substring(0, 300)}`
                    };
                }
            }
            return { passed: false, message: `Command failed: ${error.message?.substring(0, 300)}` };
        }
    }

    /**
     * Run custom validation
     */
    private async runCustomValidation(
        config: SuccessCriterion['config']
    ): Promise<{ passed: boolean; message: string }> {
        if (config.command) {
            // Reject useless echo commands that always pass
            if (/^echo\s/.test(config.command.trim())) {
                return {
                    passed: false,
                    message: 'Rejected: echo commands are not real validation'
                };
            }

            // Security: validate command before execution
            const cmdCheck = isCommandSafe(config.command);
            if (!cmdCheck.safe) {
                logSecurityEvent('block', 'GoalValidator', `runCustomValidation blocked: ${cmdCheck.reason}`, { command: config.command });
                return { passed: false, message: `Command blocked: ${cmdCheck.reason}` };
            }

            try {
                const { stdout, stderr } = await execAsync(config.command, {
                    cwd: this.outputDir || this.workspaceDir,
                    timeout: 60000
                });

                // Command succeeded (exit code 0)
                return { passed: true, message: `Custom validation passed: ${stdout.substring(0, 100)}` };
            } catch (error: any) {
                return {
                    passed: false,
                    message: `Custom validation failed: ${error.message}`
                };
            }
        }

        // If no command, check for path existence as fallback
        if (config.path) {
            return this.checkFileExists(config.path);
        }

        return { passed: false, message: 'No validation command or path specified' };
    }

    /**
     * LLM-based evaluation: Ask the LLM to review output quality.
     *
     * Evidence priority (Option A):
     *   1. criterion's own filePath (most specific)
     *   2. Other criterion file paths declared in the goal (pre-execution, can't be gamed by ordering)
     *   3. Execution context journal (last resort — agent's own report, weakest evidence)
     *
     * Tool-evasion gate (Option B):
     *   If browserEvasionDetected=true, auto-fail without calling the LLM.
     *   The agent bypassed browser tools entirely for a browser-required goal.
     *
     * @param criterionFilePaths  All file paths declared in criteria for this goal (for Option A evidence)
     * @param browserEvasionDetected  True when goal needs browser tools but agent used none
     */
    private async checkLLMEvaluates(
        expectedDescription: string,
        filePath?: string,
        executionContext?: string,
        browserEvasionDetected: boolean = false,
        criterionFilePaths: string[] = []
    ): Promise<{ passed: boolean; message: string }> {
        // ── Option B: Short-circuit for tool evasion ──────────────────────────
        if (browserEvasionDetected) {
            return {
                passed: false,
                message: 'TOOL-EVASION: Goal requires browser interaction but agent never used any browser_* tool. ' +
                    'Agent cannot satisfy a sign-up/form/click goal by creating files alone.'
            };
        }

        const llm = modelRouter.getAdapterForTask('reasoning') || modelManager.getActiveAdapter();
        if (!llm) {
            return { passed: false, message: 'No LLM available for evaluation' };
        }

        // ── Option A: Build evidence from actual files ─────────────────────────
        // Priority 1: criterion's own declared file
        let fileContents = '';
        let fileLabel = '';
        if (filePath) {
            const fullPath = this.resolvePath(filePath);
            try {
                fileContents = await GoalValidator.readFileAsText(fullPath);
                if (fileContents.length > 5000) fileContents = fileContents.substring(0, 5000) + '\n... [truncated]';
                fileLabel = filePath;
            } catch {
                return { passed: false, message: `Cannot read file for evaluation: ${filePath}` };
            }
        }

        // Priority 2: other criterion file paths (pre-declared, not gameable by agent ordering)
        const supplementalEvidence: string[] = [];
        if (!fileContents && criterionFilePaths.length > 0) {
            for (const p of criterionFilePaths.slice(0, 3)) { // max 3 files
                if (p === filePath) continue;
                try {
                    const content = await GoalValidator.readFileAsText(this.resolvePath(p));
                    const preview = content.length > 2000 ? content.substring(0, 2000) + '\n...[truncated]' : content;
                    supplementalEvidence.push(`FILE: ${p}\n${preview}`);
                } catch { /* file not yet created or unreadable — skip */ }
            }
        }

        // Build the output section
        let outputSection: string;
        if (fileContents) {
            outputSection = `\nFILE CONTENTS (${fileLabel}):\n${fileContents}`;
            if (supplementalEvidence.length > 0) {
                outputSection += `\n\nSUPPLEMENTAL FILES:\n${supplementalEvidence.join('\n---\n')}`;
            }
        } else if (supplementalEvidence.length > 0) {
            // Use pre-declared criterion files as evidence — stronger than journal
            outputSection = `\nFILE EVIDENCE (from goal criteria declarations):\n${supplementalEvidence.join('\n---\n')}`;
        } else if (executionContext && executionContext.trim().length > 20) {
            // Last resort: agent's own execution journal (weakest — agent's self-report)
            outputSection = `\nEXECUTION OUTPUT (recent agent actions — note: this is the agent's own activity log, not independent verification):\n${executionContext.substring(0, 3000)}`;
        } else {
            outputSection = '\n(No file or output to evaluate)';
        }

        const prompt = `You are a strict goal completion verifier. Your job is to determine if the GOAL was actually achieved, not whether the agent was busy.

GOAL CRITERIA: ${expectedDescription}
${outputSection}

IMPORTANT RULES:
- Evaluate whether the GOAL OUTCOME is present in the evidence, not whether the agent performed actions.
- "Agent created files" or "agent ran scripts" does NOT count as success unless the files contain real evidence of goal completion.
- For sign-up/registration goals: evidence must show actual confirmation (e.g. confirmation page content, enrollment status, success message). A polling script is NOT evidence of sign-up.
- For data goals: evidence must contain real retrieved data (actual values, not placeholder text).
- If the evidence is only the agent's activity log with no actual output → answer NO.

Does the evidence prove the goal was fully achieved?
Respond with EXACTLY one of these two formats on the FIRST line:
RESULT: YES — <one-line reason citing specific evidence>
RESULT: NO — <one-line reason explaining what's missing>

Do not include any other text before the RESULT line.`;

        try {
            const response = await llm.generate(prompt, { temperature: 0.1 });

            // Strip any system-prompt echo or preamble the model might prepend
            const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
            // Find the first line that looks like our RESULT marker or a bare YES/NO
            let verdict = '';
            for (const line of lines) {
                if (/^RESULT\s*:/i.test(line) || /^(YES|NO)\b/i.test(line)) {
                    verdict = line;
                    break;
                }
            }
            // Fallback: scan entire response for YES/NO keywords
            if (!verdict) {
                const upper = response.toUpperCase();
                if (upper.includes('YES') && !upper.includes('NO')) verdict = 'YES';
                else if (upper.includes('NO') && !upper.includes('YES')) verdict = 'NO';
                else verdict = response.trim(); // last resort
            }

            const cleanedVerdict = verdict.replace(/^RESULT\s*:\s*/i, '');
            const passed = /^YES\b/i.test(cleanedVerdict);
            const reason = cleanedVerdict.replace(/^(YES|NO)\s*[—\-:]\s*/i, '').substring(0, 200) || cleanedVerdict.substring(0, 200);
            return {
                passed,
                message: `LLM evaluation: ${passed ? 'PASS' : 'FAIL'} — ${reason}`
            };
        } catch (error) {
            return { passed: false, message: `LLM evaluation failed: ${error}` };
        }
    }

    /**
     * Quick validation - check only required criteria
     */
    async quickValidate(goal: GoalDefinition): Promise<{
        allRequiredPassed: boolean;
        score: number;
    }> {
        const required = goal.success_criteria.filter(c => c.required);

        let passedCount = 0;
        for (const criterion of required) {
            const result = await this.validateCriterion(criterion);
            criterion.status = result.passed ? 'passed' : 'failed';
            if (result.passed) passedCount++;
        }

        const score = required.length > 0
            ? Math.round((passedCount / required.length) * 100)
            : 100;

        return {
            allRequiredPassed: passedCount === required.length,
            score
        };
    }

    // ========================================================================
    // HELPER METHODS
    // ========================================================================

    /**
     * Resolve file path relative to workspace
     */
    private resolvePath(filePath: string): string {
        // Unix-style /workspace/... paths must be remapped to workspaceDir on all platforms.
        // On Windows, path.isAbsolute('/workspace/foo') returns true but resolves to the
        // drive root (C:\workspace\foo), not workspaceDir. Strip the /workspace prefix first.
        let normalized = filePath.replace(/\\/g, '/');

        if (normalized.startsWith('/workspace/') || normalized === '/workspace') {
            const relative = normalized.slice('/workspace'.length).replace(/^\//, '');
            return path.join(this.workspaceDir, relative);
        }

        if (normalized.startsWith('/') && !normalized.startsWith('/workspace')) {
            // Auto-fix agent-generated paths like /trending-docs/foo.json that are
            // missing the /workspace prefix (paths emitted from inside the Docker container).
            // Do NOT touch real host system paths (/tmp, /home, /var, etc.) — these are
            // absolute paths on the host filesystem, not Docker workspace-relative paths.
            const wdNorm = this.workspaceDir.replace(/\\/g, '/');
            const isUnderWorkspaceDir = normalized.startsWith(wdNorm);
            const SYSTEM_ROOTS = ['/tmp/', '/home/', '/var/', '/usr/', '/etc/',
                '/proc/', '/sys/', '/opt/', '/root/', '/dev/', '/run/', '/mnt/', '/media/'];
            const isSystemPath = SYSTEM_ROOTS.some(r => normalized.startsWith(r));

            if (!isUnderWorkspaceDir && !isSystemPath) {
                // Looks like an agent-emitted workspace-relative path — prepend /workspace
                normalized = '/workspace' + normalized;
                const relative = normalized.slice('/workspace'.length).replace(/^\//, '');
                return path.join(this.workspaceDir, relative);
            }
            // Real absolute path (system path or already under workspaceDir) — return as-is
            return filePath;
        }

        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        return path.join(this.workspaceDir, filePath);
    }

    /**
     * Read a file as plain text, using format-aware extraction for binary types.
     * PDF → pdf-parse, DOCX → mammoth. Falls back to utf-8 for everything else.
     */
    static async readFileAsText(fullPath: string): Promise<string> {
        const ext = fullPath.split('.').pop()?.toLowerCase() ?? '';
        if (ext === 'pdf') {
            // Use lib/pdf-parse.js directly — the package index.js has a known bug where
            // it reads './test/data/05-versions-space.pdf' on import, causing ENOENT.
            const pdfMod = await import(/* @vite-ignore */ 'pdf-parse/lib/pdf-parse.js');
            const pdfParse = (pdfMod as any).default || pdfMod;
            if (typeof pdfParse !== 'function') throw new Error('pdf-parse not available');
            const data = await pdfParse(fs.readFileSync(fullPath));
            return data.text || '';
        }
        if (ext === 'docx') {
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ path: fullPath });
            return result.value || '';
        }
        return fs.promises.readFile(fullPath, 'utf-8');
    }

    /**
     * List files created (for artifact tracking)
     */
    async listArtifacts(patterns: string[]): Promise<string[]> {
        const artifacts: string[] = [];

        for (const pattern of patterns) {
            const fullPath = this.resolvePath(pattern);
            try {
                await fs.promises.access(fullPath);
                artifacts.push(pattern);
            } catch {
                // File doesn't exist, skip
            }
        }

        return artifacts;
    }
}

// Singleton instance
export const goalValidator = new GoalValidator();
