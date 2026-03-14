/**
 * ExecutionEngine — Handles script execution across Docker, ContainerSession, and ShellServer.
 * Also manages runtime detection (Python vs Node.js) and sandbox availability.
 * Extracted from GoalOrientedExecutor.ts (Sprint 2: Kill the Monolith).
 */

import path from 'path';
import { ExecutionState } from '../../types/goal';
import { mcpManager } from '../../mcp/MCPManager';
import { configManager } from '../../services/ConfigManager';
import { ContainerSandbox } from '../../tools/containerSandbox';
import { skillLearner } from '../../services/SkillLearner';
import { containerSessionManager } from '../../execution/ContainerSession';
import { modelManager } from '../../services/llm/modelManager';
import { modelRouter } from '../../services/llm/modelRouter';
import { createLogger } from '../../utils/Logger';

const log = createLogger('ExecutionEngine');
import { ScriptGenerator } from './ScriptGenerator';

/**
 * Extract text content from an MCP tool result.
 * MCP filesystem server returns: { content: [{ type: 'text', text: '...' }] }
 * This helper handles that format plus plain string fallbacks.
 */
function extractMCPText(result: unknown): string {
    if (typeof result === 'string') return result;
    const r = result as Record<string, any>;
    // MCP protocol format: content is an array of content blocks — join ALL blocks, not just the first
    if (Array.isArray(r?.content)) {
        return r.content
            .filter((block: any) => block?.type === 'text')
            .map((block: any) => block?.text ?? '')
            .join('\n');
    }
    // Legacy / other formats
    return r?.content ?? r?.contents?.[0]?.text ?? r?.text ?? '';
}

export class ExecutionEngine {
    private detectedRuntime: 'python' | 'node' | null = null;
    private runtimeChecked: boolean = false;
    private sandboxAvailable: boolean | null = null;
    private sandboxInstance: ContainerSandbox | null = null;
    private scriptGen = new ScriptGenerator();

    // These are set by the orchestrator per-execution
    public containerSessionId: string | null = null;
    public enableNetwork: boolean = false;

    /**
     * Tracks how many times selfCorrectScript has been called during the current
     * goal execution.  Reset by GoalOrientedExecutor at the start of each new run.
     * Capped at MAX_SELF_CORRECTION_ATTEMPTS to prevent spending excess LLM calls
     * fixing the same broken script approach when replanning would be more effective.
     */
    public selfCorrectionAttempts = 0;
    private static readonly MAX_SELF_CORRECTION_ATTEMPTS = 3;

    /**
     * Detect which script runtime is available.
     * IMPORTANT: When using ContainerSession, always prefer Node.js — it's guaranteed
     * to be available in the container (we're running on Node). Python may or may not
     * be installed depending on the image. Checking the host for Python is misleading
     * because the host runtime doesn't match the container runtime.
     */
    async detectRuntime(): Promise<'python' | 'node'> {
        if (this.runtimeChecked && this.detectedRuntime) return this.detectedRuntime;

        // If we have a ContainerSession, always use Node.js — it's guaranteed in the container
        if (this.containerSessionId && await containerSessionManager.isDockerAvailable()) {
            this.detectedRuntime = 'node';
            this.runtimeChecked = true;
            log.info('[ExecutionEngine] Runtime: Node.js (ContainerSession active — Node guaranteed in container)');
            return 'node';
        }

        // No container — check the host system for Python
        try {
            const pyResult = await mcpManager.callTool('shell', 'run_command', {
                command: process.platform === 'win32' ? 'python --version' : 'python3 --version',
                timeout: 5000
            });
            const stdout = (pyResult as any)?.stdout || (pyResult as any)?.output || '';
            const stderr = (pyResult as any)?.stderr || '';
            const combinedOutput = `${stdout} ${stderr}`;
            // On Windows, "python --version" can return exitCode 0 but print
            // "Python was not found in the Windows Store..." — check the output too.
            if ((pyResult as any)?.exitCode === 0 && !this.isRuntimeNotFoundError(combinedOutput)) {
                this.detectedRuntime = 'python';
                this.runtimeChecked = true;
                log.info('[ExecutionEngine] Runtime detected: Python (host)');
                return 'python';
            }
        } catch { /* Python not available on host */ }

        // Node.js is always available (we're running on it)
        this.detectedRuntime = 'node';
        this.runtimeChecked = true;
        log.info('[ExecutionEngine] Runtime detected: Node.js (Python not available on host)');
        return 'node';
    }

    /**
     * Check if Docker sandbox is available (cached).
     */
    private async isSandboxAvailable(): Promise<boolean> {
        if (this.sandboxAvailable !== null) return this.sandboxAvailable;
        const workspace = mcpManager.getWorkspace();
        this.sandboxInstance = new ContainerSandbox(workspace);
        this.sandboxAvailable = await this.sandboxInstance.ensureReady();
        log.info(`[ExecutionEngine] Docker sandbox: ${this.sandboxAvailable ? 'available' : 'not available'}`);
        return this.sandboxAvailable;
    }

    /**
     * Get or create the sandbox instance.
     */
    private getSandbox(): ContainerSandbox {
        if (!this.sandboxInstance) {
            const workspace = mcpManager.getWorkspace();
            this.sandboxInstance = new ContainerSandbox(workspace);
        }
        return this.sandboxInstance;
    }

    /**
     * Check if an error indicates the runtime itself is missing (not a script error).
     */
    isRuntimeNotFoundError(output: string): boolean {
        const lower = output.toLowerCase();
        return lower.includes('was not found') ||
            lower.includes('is not recognized') ||
            lower.includes('command not found') ||
            lower.includes('no such file or directory') && (lower.includes('python') || lower.includes('node'));
    }

    /**
     * Primary execution strategy: Ask LLM to write a script that creates all needed files.
     * Detects available runtime (Python preferred, Node.js fallback).
     * Uses llm.generate() (plain text) to avoid JSON serialization issues.
     */
    async executeViaScript(
        state: ExecutionState,
        requestApproval: (executionId: string, script: string, runtime: 'python' | 'node', goalDescription: string) => Promise<{ approved: boolean; modifiedScript?: string }>,
        selfCorrectScript: (originalScript: string, error: string, state: ExecutionState, runtime: 'python' | 'node') => Promise<string | null>,
        broadcastGoalEvent: (event: string, data: any) => void
    ): Promise<boolean> {
        const llm = modelRouter.getAdapterForTask('code_generation') || modelManager.getActiveAdapter();
        if (!llm) return false;

        const workspace = mcpManager.getWorkspace();
        const expectedFiles = state.goal.success_criteria
            .filter(c => c.type === 'file_exists' && c.config.path)
            .map(c => c.config.path!);

        if (expectedFiles.length === 0) {
            log.info('[ExecutionEngine] No expected files - skipping script execution');
            return false;
        }

        const runtime = await this.detectRuntime();

        // Inside Docker, scripts must write to /workspace (the volume-mounted host workspace).
        // If we pass the Windows host path (e.g. D:\AI\Test\...) to the LLM, it generates
        // path.join("D:\\AI\\Test\\...", ...) which on Linux Node.js is a relative path and
        // writes files to /workspace/D:\AI\Test\.../ — a broken location inside the container.
        const isContainerized = !!(this.containerSessionId && await containerSessionManager.isDockerAvailable());
        const effectiveWorkspace = isContainerized ? '/workspace' : workspace;
        const escapedWorkspace = effectiveWorkspace.replace(/\\/g, '\\\\');

        // Map expected host file paths to their container equivalents when running in Docker
        const mapToContainerPath = (p: string): string => {
            if (!isContainerized) return p;
            // Replace the host workspace prefix with /workspace
            const normalizedP = p.replace(/\\/g, '/');
            const normalizedWs = workspace.replace(/\\/g, '/');
            if (normalizedP.startsWith(normalizedWs)) {
                return '/workspace' + normalizedP.slice(normalizedWs.length);
            }
            return p;
        };
        const effectiveExpectedFiles = expectedFiles.map(mapToContainerPath);

        log.info(`[ExecutionEngine] Attempting script execution (${runtime}, workspace=${effectiveWorkspace}) for ${effectiveExpectedFiles.length} files`);

        // Check for a previously learned skill that matches this goal
        try {
            const matchedSkill = await skillLearner.findMatchingSkill(state.goal.description);
            if (matchedSkill) {
                log.info(`[ExecutionEngine] Using learned skill: "${matchedSkill.name}"`);
                const appliedScript = skillLearner.applyTemplate(matchedSkill, effectiveWorkspace, state.goal.description, effectiveExpectedFiles);
                if (appliedScript.length > 50) {
                    const scriptExt = matchedSkill.runtime === 'python' ? 'py' : 'js';
                    const scriptPath = `_goal_script.${scriptExt}`;
                    await mcpManager.callTool('filesystem', 'write_file', { path: `${workspace}/${scriptPath}`, content: appliedScript });
                    state.artifacts.push(scriptPath);

                    const { stdout, success } = await this.runScript(scriptPath, matchedSkill.runtime, workspace);
                    if (success) {
                        log.info(`[ExecutionEngine] Learned skill succeeded!`);
                        return this.finishScriptExecution(state, scriptPath, matchedSkill.runtime, stdout, true);
                    }
                    log.info(`[ExecutionEngine] Learned skill failed, falling back to LLM generation`);
                }
            }
        } catch (e) {
            // Non-critical: fall through to normal generation
        }

        const prompt = runtime === 'python'
            ? this.scriptGen.buildPythonPrompt(state.goal.description, effectiveExpectedFiles, effectiveWorkspace, escapedWorkspace)
            : this.scriptGen.buildNodePrompt(state.goal.description, effectiveExpectedFiles, effectiveWorkspace, escapedWorkspace);

        try {
            const rawScript = await llm.generate(prompt, { temperature: 0.3 });
            const script = this.scriptGen.cleanScriptResponse(rawScript, runtime);

            // Validate script has file operations
            const hasFileOps = runtime === 'python'
                ? script.includes('open(') || script.includes('write(')
                : script.includes('writeFile') || script.includes('writeSync') || script.includes('fs.');
            if (script.length < 50 || !hasFileOps) {
                log.warn('[ExecutionEngine] Script too short or missing file operations');
                return false;
            }

            log.info(`[ExecutionEngine] Generated ${runtime} script (${script.length} chars), writing and executing...`);

            // ========== HITL APPROVAL CHECKPOINT ==========
            const approval = await requestApproval(
                state.execution_id,
                script,
                runtime,
                state.goal.description
            );

            if (!approval.approved) {
                log.info('[ExecutionEngine] Script execution rejected by user');
                state.error_history.push({
                    iteration: state.current_iteration,
                    error: 'Script execution rejected by user (HITL)',
                    context: 'executeViaScript:approval',
                    recovery_attempted: false,
                    recovery_successful: false,
                    timestamp: new Date()
                });
                broadcastGoalEvent('goal:approval-rejected', {
                    executionId: state.execution_id,
                    message: 'Script execution was rejected'
                });
                return false;
            }

            // If user modified the script, use the modified version
            const finalScript = approval.modifiedScript || script;

            // Write the script to workspace
            const scriptExt = runtime === 'python' ? 'py' : 'js';
            const scriptPath = `_goal_script.${scriptExt}`;
            await mcpManager.callTool('filesystem', 'write_file', {
                path: `${workspace}/${scriptPath}`,
                content: finalScript
            });

            state.artifacts.push(scriptPath);

            // Execute the script
            const { stdout, success } = await this.runScript(scriptPath, runtime, workspace);

            log.info(`[ExecutionEngine] Script execution ${success ? 'succeeded' : 'failed'}: ${stdout.substring(0, 300)}`);

            // Self-correction: if script failed AND it's NOT a runtime-not-found error, try to fix once
            if (!success && script && !this.isRuntimeNotFoundError(stdout)) {
                const errorMsg = stdout || 'Script execution failed';
                if (this.selfCorrectionAttempts >= ExecutionEngine.MAX_SELF_CORRECTION_ATTEMPTS) {
                    log.warn({ attempts: this.selfCorrectionAttempts }, '[ExecutionEngine] Self-correction cap reached — skipping, forcing replan path');
                    return this.finishScriptExecution(state, scriptPath, runtime, stdout, false);
                }
                this.selfCorrectionAttempts++;
                const correctedScript = await selfCorrectScript(script, errorMsg, state, runtime);
                if (correctedScript) {
                    log.info(`[ExecutionEngine] Retrying with self-corrected script (${correctedScript.length} chars)`);
                    await mcpManager.callTool('filesystem', 'write_file', {
                        path: `${workspace}/${scriptPath}`,
                        content: correctedScript
                    });

                    const retryResult = await this.runScript(scriptPath, runtime, workspace);
                    log.info(`[ExecutionEngine] Self-correction ${retryResult.success ? 'succeeded' : 'also failed'}`);
                    return this.finishScriptExecution(state, scriptPath, runtime, retryResult.stdout, retryResult.success);
                }
            } else if (!success && this.isRuntimeNotFoundError(stdout)) {
                log.error(`[ExecutionEngine] Runtime not found - aborting script execution (not retrying)`);
            }

            return this.finishScriptExecution(state, scriptPath, runtime, stdout, success);
        } catch (error) {
            log.error('[ExecutionEngine] Script execution failed:', error);
            state.error_history.push({
                iteration: state.current_iteration,
                error: `Script execution failed: ${error}`,
                context: 'executeViaScript',
                recovery_attempted: true,
                recovery_successful: false,
                timestamp: new Date()
            });
            return false;
        }
    }

    /**
     * Run a script using the detected runtime. Tries Docker sandbox first, falls back to ShellServer.
     */
    async runScript(
        scriptPath: string,
        runtime: 'python' | 'node',
        workspace: string
    ): Promise<{ stdout: string; success: boolean }> {
        // Phase 11B.4: Try ContainerSession first (persistent container)
        if (await containerSessionManager.isDockerAvailable() && this.containerSessionId) {
            try {
                const sessionId = this.containerSessionId;
                const networkMode = this.enableNetwork ? 'bridge' : 'none';
                log.info(`[ExecutionEngine] Executing ${runtime} script in ContainerSession: ${sessionId}`);

                // Mount the app workspace into the sandbox so MCP-written files are visible.
                // AI_PARTNER_HOST_WORKSPACE is the host-side path/volume name for /workspace
                // (set in docker-compose.yml; defaults to 'aipartner-workspace' named volume).
                // When unset (local dev), fall back to the actual workspace path on disk.
                const hostWorkspace = process.env.AI_PARTNER_HOST_WORKSPACE || workspace;
                const volumeMounts = new Map([[hostWorkspace, '/workspace']]);

                const session = await containerSessionManager.getSession(sessionId, { networkMode, volumeMounts });
                const containerScriptPath = `/workspace/${scriptPath}`;

                const scriptContent = await mcpManager.callTool('filesystem', 'read_file', { path: containerScriptPath });
                const isError = (scriptContent as any)?.isError === true;
                const content = isError ? '' : extractMCPText(scriptContent);

                if (content && !isError) {
                    // Write the script into the container via stdin pipe (fixes heredoc quoting bugs).
                    // When the workspace volume is mounted, the file is also already at containerScriptPath,
                    // but writeFile ensures correctness even when the volume mount isn't available.
                    await session.writeFile(containerScriptPath, content);
                    const cmd = runtime === 'python' ? `python3 ${containerScriptPath}` : `node ${containerScriptPath}`;
                    let execResult = await session.exec(cmd, { timeout: 120000 });
                    if (execResult.exitCode === 0) {
                        return { stdout: execResult.stdout, success: true };
                    }

                    // AUTO-INSTALL: if Node.js failed with "Cannot find module 'X'", install X and retry
                    if (runtime === 'node') {
                        const combinedErr = `${execResult.stdout} ${execResult.stderr}`;
                        const moduleMatch = combinedErr.match(/Cannot find module '([^']+)'/);
                        if (moduleMatch) {
                            const missingPkg = moduleMatch[1];
                            // Only auto-install npm package names (not relative paths)
                            if (!missingPkg.startsWith('.') && !missingPkg.startsWith('/')) {
                                log.info(`[ExecutionEngine] Auto-installing missing npm package: ${missingPkg}`);
                                const installResult = await session.exec(`npm install ${missingPkg}`, { timeout: 60000 });
                                if (installResult.exitCode === 0) {
                                    log.info(`[ExecutionEngine] Installed ${missingPkg}, retrying script`);
                                    execResult = await session.exec(cmd, { timeout: 120000 });
                                    if (execResult.exitCode === 0) {
                                        return { stdout: execResult.stdout, success: true };
                                    }
                                } else {
                                    log.warn(`[ExecutionEngine] npm install ${missingPkg} failed: ${installResult.stderr?.substring(0, 200)}`);
                                }
                            }
                        }
                    }

                    // AUTO-FALLBACK: If Python failed with "not found", re-generate as Node.js
                    const combinedOutput = `${execResult.stdout} ${execResult.stderr}`;
                    if (runtime === 'python' && this.isRuntimeNotFoundError(combinedOutput)) {
                        log.warn(`[ExecutionEngine] Python not available in container, auto-falling back to Node.js`);
                        this.detectedRuntime = 'node';
                        this.runtimeChecked = true;

                        // Re-generate the script as Node.js using LLM
                        const llm = modelRouter.getAdapterForTask('code_generation') || modelManager.getActiveAdapter();
                        if (llm) {
                            const nodePrompt = this.scriptGen.buildNodePrompt(
                                `Convert this task to Node.js: ${content.substring(0, 500)}`,
                                [],
                                '/workspace',
                                '/workspace'
                            );
                            try {
                                const rawNodeScript = await llm.generate(nodePrompt, { temperature: 0.3 });
                                const nodeScript = this.scriptGen.cleanScriptResponse(rawNodeScript, 'node');
                                const nodeScriptPath = '/workspace/_goal_script.js';
                                await session.writeFile(nodeScriptPath, nodeScript);
                                const nodeResult = await session.exec(`node ${nodeScriptPath}`, { timeout: 120000 });
                                if (nodeResult.exitCode === 0) {
                                    log.info(`[ExecutionEngine] Node.js fallback succeeded`);
                                    return { stdout: nodeResult.stdout, success: true };
                                }
                                return { stdout: nodeResult.stdout || nodeResult.stderr, success: false };
                            } catch (genError: any) {
                                log.warn(`[ExecutionEngine] Node.js fallback generation failed: ${genError.message}`);
                            }
                        }
                    }

                    return { stdout: execResult.stdout || execResult.stderr, success: false };
                }
            } catch (containerError: any) {
                log.warn(`[ExecutionEngine] ContainerSession execution failed, trying sandbox: ${containerError.message}`);
            }
        }

        // Fallback: Try Docker sandbox (one-shot containers)
        if (await this.isSandboxAvailable()) {
            try {
                log.info(`[ExecutionEngine] Executing ${runtime} script in Docker sandbox`);
                const sandbox = this.getSandbox();
                const dockerResult = runtime === 'python'
                    ? await sandbox.executePythonFile(scriptPath)
                    : await sandbox.executeNodeFile(scriptPath);

                if (dockerResult.success) {
                    if (dockerResult.stderr) {
                        log.warn(`[ExecutionEngine] Docker stderr: ${dockerResult.stderr.substring(0, 300)}`);
                    }
                    return { stdout: dockerResult.stdout, success: true };
                }

                const isInfraError = dockerResult.stderr?.includes('no such image') ||
                    dockerResult.stderr?.includes('No such image') ||
                    dockerResult.stderr?.includes('not found') ||
                    dockerResult.exitCode === -1;

                if (isInfraError) {
                    log.warn(`[ExecutionEngine] Docker infrastructure error, falling back to ShellServer: ${dockerResult.stderr?.substring(0, 200)}`);
                    this.sandboxAvailable = false;
                } else {
                    if (dockerResult.stderr) {
                        log.warn(`[ExecutionEngine] Docker stderr: ${dockerResult.stderr.substring(0, 300)}`);
                    }
                    return { stdout: dockerResult.stdout || dockerResult.stderr, success: false };
                }
            } catch (dockerError: any) {
                log.warn(`[ExecutionEngine] Docker execution failed, falling back to ShellServer: ${dockerError.message}`);
                this.sandboxAvailable = false;
            }
        }

        // Check if Docker is required — fail with clear error if so
        const config = configManager.getConfig();
        if (config.execution?.require_docker) {
            const msg = 'Docker is required for goal execution but is not available. ' +
                'Please install Docker Desktop and ensure it is running, or set ' +
                'execution.require_docker to false in your configuration.';
            log.error(`[ExecutionEngine] ${msg}`);
            return { stdout: msg, success: false };
        }

        // ShellServer fallback (only when require_docker is false)
        const absoluteScript = path.resolve(workspace, scriptPath);
        const cmd = runtime === 'python'
            ? (process.platform === 'win32' ? `python "${absoluteScript}"` : `python3 "${absoluteScript}"`)
            : `node "${absoluteScript}"`;

        log.warn(`[ExecutionEngine] Docker unavailable — executing via ShellServer (unsandboxed): ${cmd}`);
        const result = await mcpManager.callTool('shell', 'run_command', {
            command: cmd,
            cwd: workspace
        });
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const stdout = (result as any)?.stdout || (result as any)?.stderr || resultStr;
        const success = (result as any)?.exitCode === 0;
        return { stdout, success };
    }

    /**
     * Finish script execution: track artifacts, record action, clean up temp script.
     */
    async finishScriptExecution(
        state: ExecutionState,
        scriptPath: string,
        runtime: 'python' | 'node',
        stdout: string,
        success: boolean
    ): Promise<boolean> {
        // Track created files from stdout.
        // Container scripts print /workspace/... paths — map them back to the host workspace
        // so artifact tracking uses paths the GoalValidator (host filesystem) can find.
        const hostWorkspace = mcpManager.getWorkspace();
        const createdLines = stdout.split('\n').filter((l: string) => l.startsWith('CREATED:'));
        for (const line of createdLines) {
            let filePath = line.replace('CREATED:', '').trim();
            if (filePath.startsWith('/workspace/')) {
                filePath = path.join(hostWorkspace, filePath.slice('/workspace/'.length));
            }
            if (filePath && !state.artifacts.includes(filePath)) {
                state.artifacts.push(filePath);
            }
        }

        // Record as action
        const cmd = runtime === 'python' ? `python ${scriptPath}` : `node ${scriptPath}`;
        state.completed_actions.push({
            iteration: state.current_iteration,
            action: 'Script execution for goal',
            tool_used: 'run_command',
            args: { command: cmd },
            result: stdout.substring(0, 500),
            success,
            artifacts_created: createdLines.map((l: string) => l.replace('CREATED:', '').trim()),
            progress_made: success,
            duration_ms: 0,
            timestamp: new Date()
        });

        // Learn from success: save as reusable skill (async, non-blocking)
        if (success && state.goal?.description) {
            try {
                const absScriptPath = scriptPath.startsWith('/') ? scriptPath : `${mcpManager.getWorkspace()}/${scriptPath}`;
                const scriptContent = await mcpManager.callTool('filesystem', 'read_file', { path: absScriptPath });
                const content = extractMCPText(scriptContent);
                if (content.length > 50) {
                    skillLearner.learnFromSuccess(
                        state.goal.description, content, runtime,
                        createdLines.map((l: string) => l.replace('CREATED:', '').trim())
                    ).catch(e => log.warn('[ExecutionEngine] Skill learning failed:', e));
                }
            } catch {
                // Non-critical
            }
        }

        // Clean up temp script
        try {
            await mcpManager.callTool('shell', 'run_command', {
                command: process.platform === 'win32'
                    ? `del "${scriptPath}"`
                    : `rm -f "${scriptPath}"`,
                cwd: '.'
            });
        } catch (e) {
            // Ignore cleanup errors
        }

        return success;
    }
}
