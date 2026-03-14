import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ShellCommandRequest {
    command: string;
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
}

export interface ShellCommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    duration_ms: number;
    error?: string;
}

export interface ShellSecurityConfig {
    // Allowed command prefixes (e.g., 'npm', 'node', 'git')
    allowedCommands: string[];
    // Blocked commands that are never allowed
    blockedCommands: string[];
    // Max output size in bytes
    maxOutputSize: number;
    // Default timeout in ms
    defaultTimeout: number;
    // Max concurrent commands
    maxConcurrent: number;
    // Workspace sandbox - commands can only run in this directory
    workspaceRoot: string;
}

// ============================================================================
// DEFAULT SECURITY CONFIG
// ============================================================================

const DEFAULT_SECURITY_CONFIG: ShellSecurityConfig = {
    allowedCommands: [
        // Package managers
        'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3',
        // Runtimes
        'node', 'python', 'python3', 'deno', 'bun', 'java',
        // Version control
        'git',
        // File operations (safe)
        'ls', 'dir', 'cat', 'type', 'echo', 'mkdir', 'touch',
        'cp', 'copy', 'mv', 'move', 'head', 'tail', 'find', 'grep',
        'wc', 'sort', 'uniq', 'awk', 'sed',
        // Build / compile tools
        'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'playwright',
        'pytest', 'mocha', 'jasmine', 'go', 'cargo', 'make',
        // Database
        'sqlite3', 'psql', 'mysql',
        // Network tools (safe — no pipe-to-shell)
        'curl', 'wget',
        // Container / infra
        'docker',
        // Windows-safe utils
        'where', 'which', 'pwd', 'cd',
        // Code quality / type-checking
        'mypy', 'black', 'flake8', 'pylint',
    ],
    blockedCommands: [
        // Dangerous system commands
        'rm -rf /', 'del /s /q c:\\', 'format', 'fdisk',
        'shutdown', 'reboot', 'halt',
        // Network attacks
        'curl | bash', 'wget | sh',
        // Privilege escalation
        'sudo', 'su', 'runas',
        // Registry manipulation
        'reg', 'regedit',
    ],
    maxOutputSize: 1024 * 1024, // 1MB
    defaultTimeout: 60000, // 60 seconds
    maxConcurrent: 3,
    workspaceRoot: '',
};

// ============================================================================
// SHELL SERVER
// ============================================================================

export class ShellServer extends EventEmitter {
    private config: ShellSecurityConfig;
    private activeCommands: Map<string, ChildProcess> = new Map();
    private commandCount = 0;

    constructor(config: Partial<ShellSecurityConfig> = {}) {
        super();
        this.config = { ...DEFAULT_SECURITY_CONFIG, ...config };
    }

    /**
     * Update workspace root for sandboxing
     */
    setWorkspace(workspacePath: string): void {
        this.config.workspaceRoot = workspacePath;
        console.log(`[ShellServer] Workspace set to: ${workspacePath}`);
    }

    /**
     * Get available tools for MCP protocol
     */
    getTools() {
        return [
            {
                name: 'run_command',
                description: 'Execute a command in the Docker sandbox. Pre-installed: Python 3 with yfinance, pandas, requests, numpy, openpyxl, matplotlib, flask. Node.js with typescript, ts-node. Use for data scripts, API calls, file processing. Runs as: python3 script.py OR node script.js OR curl etc.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        command: {
                            type: 'string',
                            description: 'The command to execute (e.g., "npm install axios", "git status")'
                        },
                        cwd: {
                            type: 'string',
                            description: 'Working directory relative to workspace root (optional)'
                        },
                        timeout: {
                            type: 'number',
                            description: 'Timeout in milliseconds (default: 60000)'
                        }
                    },
                    required: ['command']
                }
            },
            {
                name: 'list_processes',
                description: 'List currently running shell commands',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'kill_process',
                description: 'Kill a running shell command by its ID',
                inputSchema: {
                    type: 'object',
                    properties: {
                        processId: {
                            type: 'string',
                            description: 'The process ID to kill'
                        }
                    },
                    required: ['processId']
                }
            }
        ];
    }

    /**
     * Execute a tool by name
     */
    async callTool(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'run_command':
                return this.runCommand(args);
            case 'list_processes':
                return this.listProcesses();
            case 'kill_process':
                return this.killProcess(args.processId);
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    /**
     * Execute a shell command with security checks
     */
    async runCommand(request: ShellCommandRequest): Promise<ShellCommandResult> {
        const startTime = Date.now();

        // 1. Check concurrent limit
        if (this.activeCommands.size >= this.config.maxConcurrent) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: null,
                duration_ms: 0,
                error: `Max concurrent commands (${this.config.maxConcurrent}) reached. Wait for existing commands to complete.`
            };
        }

        // 2. Security validation
        const securityCheck = this.validateCommand(request.command);
        if (!securityCheck.allowed) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: null,
                duration_ms: 0,
                error: `Command blocked: ${securityCheck.reason}`
            };
        }

        // 3. Resolve working directory (sandboxed to workspace)
        const cwd = this.resolveWorkingDirectory(request.cwd);
        if (!cwd) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: null,
                duration_ms: 0,
                error: 'Invalid working directory - must be within workspace'
            };
        }

        // 4. Execute command
        const timeout = request.timeout || this.config.defaultTimeout;
        const commandId = `cmd_${++this.commandCount}_${Date.now()}`;

        console.log(`[ShellServer] Executing [${commandId}]: ${request.command} in ${cwd}`);
        this.emit('command:start', { id: commandId, command: request.command, cwd });

        try {
            const result = await this.executeCommand(commandId, request.command, cwd, timeout, request.env);
            const duration = Date.now() - startTime;

            console.log(`[ShellServer] [${commandId}] completed in ${duration}ms with exit code ${result.exitCode}`);
            this.emit('command:end', { id: commandId, ...result, duration_ms: duration });

            // Exit code 127 = command not found. Annotate so the LLM stops retrying.
            if (result.exitCode === 127) {
                return {
                    ...result,
                    stderr: (result.stderr || '') + '\n[COMMAND NOT FOUND] Exit 127: this binary is not installed in the AI Partner container. For Python/pip, use write_file + run_script inside the Docker sandbox instead.',
                    duration_ms: duration
                };
            }

            return {
                ...result,
                duration_ms: duration
            };
        } catch (error: any) {
            const duration = Date.now() - startTime;
            console.error(`[ShellServer] [${commandId}] error:`, error.message);
            this.emit('command:error', { id: commandId, error: error.message });

            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: null,
                duration_ms: duration,
                error: error.message
            };
        }
    }

    /**
     * Validate command against security rules
     */
    private validateCommand(command: string): { allowed: boolean; reason?: string } {
        const trimmedCommand = command.trim().toLowerCase();

        // 1. Check blocked commands
        for (const blocked of this.config.blockedCommands) {
            if (trimmedCommand.includes(blocked.toLowerCase())) {
                return { allowed: false, reason: `Blocked command pattern: ${blocked}` };
            }
        }

        // 2. Extract first word (the actual command)
        const firstWord = trimmedCommand.split(/\s+/)[0];

        // 3. Check if command is in allowlist
        const isAllowed = this.config.allowedCommands.some(allowed =>
            firstWord === allowed.toLowerCase() ||
            firstWord.endsWith('\\' + allowed.toLowerCase()) ||
            firstWord.endsWith('/' + allowed.toLowerCase())
        );

        if (!isAllowed) {
            return {
                allowed: false,
                reason: `Command "${firstWord}" is not in the allowed list. Allowed: ${this.config.allowedCommands.join(', ')}`
            };
        }

        return { allowed: true };
    }

    /**
     * Resolve working directory, ensuring it's within workspace
     */
    private resolveWorkingDirectory(relativePath?: string): string | null {
        if (!this.config.workspaceRoot) {
            console.warn('[ShellServer] No workspace root configured, using current directory');
            return process.cwd();
        }

        const baseDir = this.config.workspaceRoot;

        if (!relativePath) {
            return baseDir;
        }

        // Resolve the path
        const resolvedPath = path.resolve(baseDir, relativePath);

        // Security check: ensure resolved path is within workspace
        if (!resolvedPath.startsWith(baseDir)) {
            console.warn(`[ShellServer] Path escape attempt: ${relativePath} resolved to ${resolvedPath}`);
            return null;
        }

        return resolvedPath;
    }

    /**
     * Execute command using spawn
     */
    private executeCommand(
        commandId: string,
        command: string,
        cwd: string,
        timeout: number,
        env?: Record<string, string>
    ): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number | null }> {
        return new Promise((resolve, reject) => {
            // Determine shell based on platform
            const isWindows = process.platform === 'win32';
            const shell = isWindows ? 'cmd.exe' : '/bin/sh';
            const shellArgs = isWindows ? ['/c', command] : ['-c', command];

            const child = spawn(shell, shellArgs, {
                cwd,
                env: { ...process.env, ...env },
                windowsHide: true
            });

            this.activeCommands.set(commandId, child);

            let stdout = '';
            let stderr = '';
            let killed = false;

            // Timeout handler
            const timeoutId = setTimeout(() => {
                killed = true;
                child.kill('SIGTERM');
                setTimeout(() => {
                    if (!child.killed) {
                        child.kill('SIGKILL');
                    }
                }, 5000);
            }, timeout);

            // Collect stdout
            child.stdout.on('data', (data) => {
                const chunk = data.toString();
                if (stdout.length + chunk.length <= this.config.maxOutputSize) {
                    stdout += chunk;
                }
                this.emit('command:stdout', { id: commandId, data: chunk });
            });

            // Collect stderr
            child.stderr.on('data', (data) => {
                const chunk = data.toString();
                if (stderr.length + chunk.length <= this.config.maxOutputSize) {
                    stderr += chunk;
                }
                this.emit('command:stderr', { id: commandId, data: chunk });
            });

            // Handle close
            child.on('close', (code) => {
                clearTimeout(timeoutId);
                this.activeCommands.delete(commandId);

                if (killed) {
                    resolve({
                        success: false,
                        stdout,
                        stderr: stderr + '\n[Command killed due to timeout]',
                        exitCode: code
                    });
                } else {
                    resolve({
                        success: code === 0,
                        stdout,
                        stderr,
                        exitCode: code
                    });
                }
            });

            // Handle error
            child.on('error', (error) => {
                clearTimeout(timeoutId);
                this.activeCommands.delete(commandId);
                reject(error);
            });
        });
    }

    /**
     * List active commands
     */
    listProcesses(): { processes: Array<{ id: string; pid: number | undefined }> } {
        const processes = Array.from(this.activeCommands.entries()).map(([id, proc]) => ({
            id,
            pid: proc.pid
        }));
        return { processes };
    }

    /**
     * Kill a running command
     */
    killProcess(processId: string): { success: boolean; message: string } {
        const proc = this.activeCommands.get(processId);
        if (!proc) {
            return { success: false, message: `Process ${processId} not found` };
        }

        proc.kill('SIGTERM');
        setTimeout(() => {
            if (!proc.killed) {
                proc.kill('SIGKILL');
            }
        }, 5000);

        return { success: true, message: `Process ${processId} killed` };
    }

    /**
     * Add commands to allowlist
     */
    addAllowedCommands(commands: string[]): void {
        this.config.allowedCommands.push(...commands);
    }

    /**
     * Get current configuration
     */
    getConfig(): ShellSecurityConfig {
        return { ...this.config };
    }
}

// Singleton instance
export const shellServer = new ShellServer();
