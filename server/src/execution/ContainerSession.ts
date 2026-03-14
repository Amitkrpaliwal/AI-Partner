/**
 * ContainerSession — Persistent Docker container for safe code execution.
 *
 * Each user gets a long-lived container that persists state between commands:
 * - Filesystem changes survive across calls
 * - Environment variables persist
 * - Running processes (servers, watchers) stay alive
 * - REPL sessions (node, python) maintain state
 *
 * Uses `docker exec` for commands, NOT `docker run` (avoids per-call overhead).
 * Auto-stops after idle timeout. Auto-creates on first use.
 *
 * Competitive parity with: AgentZero (Docker-as-OS), OpenClaw (per-session containers)
 */

import { EventEmitter } from 'events';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Writable } from 'stream';
import { createLogger } from '../utils/Logger';

const execAsync = promisify(exec);
const log = createLogger('ContainerSession');

// ============================================================================
// DOCKER ERROR CLASSIFICATION
// ============================================================================

export type DockerErrorType = 'daemon_down' | 'image_missing' | 'resource_limit' | 'permission' | 'unknown';

/**
 * Classify a Docker error message into a typed category so callers can give
 * user-facing messages instead of falling back silently.
 */
export function classifyDockerError(msg: string): DockerErrorType {
    const m = msg.toLowerCase();
    if (
        m.includes('cannot connect to the docker daemon') ||
        m.includes('is the docker daemon running') ||
        m.includes('no such file or directory') && m.includes('docker.sock')
    ) return 'daemon_down';
    if (
        m.includes('no such image') ||
        m.includes('pull access denied') ||
        m.includes('image not found') ||
        m.includes('manifest unknown')
    ) return 'image_missing';
    if (
        m.includes('oom') ||
        m.includes('out of memory') ||
        m.includes('memory') && m.includes('exceeded') ||
        m.includes('no space left')
    ) return 'resource_limit';
    if (
        m.includes('permission denied') ||
        m.includes('access denied')
    ) return 'permission';
    return 'unknown';
}

// ============================================================================
// TYPES
// ============================================================================

export interface ContainerConfig {
    /** Docker image to use */
    image: string;
    /** Container name prefix */
    namePrefix: string;
    /** Working directory inside the container */
    workDir: string;
    /** Memory limit (e.g., '512m', '1g') */
    memoryLimit: string;
    /** CPU limit (e.g., '1.0' = 1 CPU) */
    cpuLimit: string;
    /** Auto-stop after N ms of inactivity (default: 30 min) */
    idleTimeoutMs: number;
    /** Port forwarding map: hostPort → containerPort */
    portMappings: Map<number, number>;
    /** Volumes to mount: hostPath → containerPath */
    volumeMounts: Map<string, string>;
    /** Environment variables */
    env: Map<string, string>;
    /** Network mode */
    networkMode: string;
}

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
}

export interface ContainerStatus {
    containerId: string | null;
    containerName: string;
    running: boolean;
    image: string;
    createdAt: number | null;
    lastActivity: number | null;
    uptime: number;
}

// ============================================================================
// CONTAINER SESSION
// ============================================================================

export class ContainerSession extends EventEmitter {
    private containerId: string | null = null;
    readonly containerName: string;
    private config: ContainerConfig;
    private createdAt: number | null = null;
    private lastActivity: number | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private activePTYs: Map<string, ChildProcess> = new Map();
    /** When > 0, idle timer is suppressed (HITL pause is active) */
    private holdCount: number = 0;

    constructor(sessionId: string, config?: Partial<ContainerConfig>) {
        super();

        const defaults: ContainerConfig = {
            image: 'aipartner-sandbox',  // Pre-built image with Python, git, etc.
            namePrefix: 'aipartner',
            workDir: '/workspace',
            memoryLimit: '512m',
            cpuLimit: '1.0',
            idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
            portMappings: new Map(),
            volumeMounts: new Map(),
            env: new Map([
                ['TERM', 'xterm-256color'],
                ['LANG', 'C.UTF-8'],
            ]),
            networkMode: 'bridge',
        };

        this.config = { ...defaults, ...config };
        this.containerName = `${this.config.namePrefix}_${sessionId}`;
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Ensure the container is running. Creates if needed.
     */
    async ensureRunning(): Promise<void> {
        if (this.containerId && await this.isRunning()) {
            this.touchActivity();
            return;
        }

        // Check if container exists but is stopped
        try {
            const { stdout } = await execAsync(
                `docker inspect --format "{{.State.Status}}" ${this.containerName}`,
                { timeout: 10000 }
            );
            const status = stdout.trim();

            if (status === 'running') {
                // Container exists and is running — grab its ID
                const { stdout: idOut } = await execAsync(
                    `docker inspect --format "{{.Id}}" ${this.containerName}`,
                    { timeout: 5000 }
                );
                this.containerId = idOut.trim().substring(0, 12);
                this.touchActivity();
                log.info(`[ContainerSession] Reconnected to existing container: ${this.containerName}`);
                return;
            }

            if (status === 'exited' || status === 'created') {
                // Restart stopped container
                await execAsync(`docker start ${this.containerName}`, { timeout: 30000 });
                const { stdout: idOut } = await execAsync(
                    `docker inspect --format "{{.Id}}" ${this.containerName}`,
                    { timeout: 5000 }
                );
                this.containerId = idOut.trim().substring(0, 12);
                this.touchActivity();
                log.info(`[ContainerSession] Restarted container: ${this.containerName}`);
                this.emit('container:restarted', { name: this.containerName });
                return;
            }
        } catch {
            // Container doesn't exist — create it
        }

        await this.create();
    }

    /**
     * Create a new container.
     */
    private async create(): Promise<void> {
        const args: string[] = [
            'docker', 'run', '-d',
            '--name', this.containerName,
            '--memory', this.config.memoryLimit,
            '--cpus', this.config.cpuLimit,
            '--network', this.config.networkMode,
            '-w', this.config.workDir,
        ];

        // Environment variables
        for (const [key, value] of this.config.env) {
            args.push('-e', `${key}=${value}`);
        }

        // Port mappings
        for (const [hostPort, containerPort] of this.config.portMappings) {
            args.push('-p', `${hostPort}:${containerPort}`);
        }

        // Volume mounts — remap paths for Docker-in-Docker scenarios
        for (const [hostPath, containerPath] of this.config.volumeMounts) {
            // When running in Docker, use the host volume name instead of container-internal path
            const effectivePath = process.env.AI_PARTNER_HOST_WORKSPACE && hostPath.startsWith('/workspace')
                ? process.env.AI_PARTNER_HOST_WORKSPACE + hostPath.slice('/workspace'.length)
                : hostPath;
            args.push('-v', `${effectivePath}:${containerPath}`);
        }

        // Public DNS servers so sandbox containers can resolve internet hostnames
        args.push('--dns', '1.1.1.1', '--dns', '8.8.8.8');

        // Image + keep-alive command
        args.push(this.config.image, 'tail', '-f', '/dev/null');

        const cmd = args.join(' ');
        log.info(`[ContainerSession] Creating container: ${cmd}`);

        try {
            // Check if the requested image exists locally; fall back to node:20-slim if not
            try {
                await execAsync(`docker image inspect ${this.config.image}`, { timeout: 10000 });
            } catch {
                if (this.config.image !== 'node:20-slim') {
                    log.warn(`[ContainerSession] Image '${this.config.image}' not found, falling back to 'node:20-slim'`);
                    this.config.image = 'node:20-slim';
                }
            }

            const { stdout } = await execAsync(cmd, { timeout: 60000 });
            this.containerId = stdout.trim().substring(0, 12);
            this.createdAt = Date.now();
            this.touchActivity();

            // Install common tools inside the container (only needed for bare images)
            if (this.config.image === 'node:20-slim') {
                await this.installBaseTools();
            } else {
                log.info(`[ContainerSession] Using pre-built image '${this.config.image}', skipping tool install`);
            }

            log.info(`[ContainerSession] Container created: ${this.containerName} (${this.containerId})`);
            this.emit('container:created', { name: this.containerName, id: this.containerId });
        } catch (error: any) {
            const errorType = classifyDockerError(error.message || '');
            log.error(
                { dockerErrorType: errorType },
                `[ContainerSession] Failed to create container (${errorType}): ${error.message}`
            );
            this.emit('container:error', { error: error.message, errorType });
            const typedError = Object.assign(
                new Error(`Container creation failed: ${error.message}`),
                { dockerErrorType: errorType }
            );
            throw typedError;
        }
    }

    /**
     * Install common development tools in the container.
     */
    private async installBaseTools(): Promise<void> {
        try {
            // Install git, python, curl, and browser dependencies inside slim node image
            await this.exec('apt-get update -qq && apt-get install -y -qq git python3 python3-pip curl jq libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libpangocairo-1.0-0 libnspr4 2>/dev/null', {
                timeout: 180000,
            });

            // Verify python3 was actually installed
            const pyCheck = await this.exec('python3 --version', { timeout: 5000 });
            if (pyCheck.exitCode === 0) {
                log.info(`[ContainerSession] Base tools installed (Python: ${pyCheck.stdout.trim()})`);
            } else {
                log.warn(`[ContainerSession] Python3 install verification failed, scripts may need Node.js fallback`);
            }
        } catch (e: any) {
            log.warn(`[ContainerSession] Base tools install failed (non-fatal): ${e.message}`);
        }
    }

    /**
     * Stop and remove the container.
     */
    async destroy(): Promise<void> {
        this.clearIdleTimer();

        // Kill all PTY sessions
        for (const [id, proc] of this.activePTYs) {
            proc.kill('SIGTERM');
            this.activePTYs.delete(id);
        }

        if (this.containerName) {
            try {
                await execAsync(`docker rm -f ${this.containerName}`, { timeout: 15000 });
                log.info(`[ContainerSession] Container destroyed: ${this.containerName}`);
                this.emit('container:destroyed', { name: this.containerName });
            } catch (e: any) {
                log.warn(`[ContainerSession] Destroy failed: ${e.message}`);
            }
        }

        this.containerId = null;
        this.createdAt = null;
        this.lastActivity = null;
    }

    // ========================================================================
    // COMMAND EXECUTION
    // ========================================================================

    /**
     * Execute a command inside the container.
     * This is the primary interface — replaces host-level `exec` calls.
     */
    async exec(command: string, options: {
        timeout?: number;
        cwd?: string;
        env?: Record<string, string>;
    } = {}): Promise<ExecResult> {
        await this.ensureRunning();
        this.touchActivity();

        const timeout = options.timeout || 60000;
        const startTime = Date.now();

        // Build docker exec args as an array — avoids shell quoting issues on Windows.
        // Using execAsync(string) passes through cmd.exe on Windows, which mangles
        // commands containing embedded quotes (e.g. python3 -c "...").
        // spawn() bypasses the shell and passes args directly to the OS API.
        const spawnArgs: string[] = ['exec'];
        if (options.cwd) spawnArgs.push('-w', options.cwd);
        if (options.env) {
            for (const [key, value] of Object.entries(options.env)) {
                spawnArgs.push('-e', `${key}=${value}`);
            }
        }
        spawnArgs.push(this.containerName, 'sh', '-c', command);

        return new Promise<ExecResult>((resolve) => {
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let resolved = false;

            const child = spawn('docker', spawnArgs, { stdio: 'pipe' });

            const timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                child.kill('SIGTERM');
                resolve({
                    stdout: Buffer.concat(stdoutChunks).toString(),
                    stderr: Buffer.concat(stderrChunks).toString(),
                    exitCode: 124,
                    timedOut: true,
                    durationMs: Date.now() - startTime,
                });
            }, timeout);

            child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
            child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

            child.on('close', (code) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                resolve({
                    stdout: Buffer.concat(stdoutChunks).toString(),
                    stderr: Buffer.concat(stderrChunks).toString(),
                    exitCode: code ?? 1,
                    timedOut: false,
                    durationMs: Date.now() - startTime,
                });
            });

            child.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                resolve({
                    stdout: Buffer.concat(stdoutChunks).toString(),
                    stderr: err.message,
                    exitCode: 1,
                    timedOut: false,
                    durationMs: Date.now() - startTime,
                });
            });
        });
    }

    /**
     * Write a file into the container via stdin pipe.
     * Uses `docker exec -i ... cat > path` to stream content without shell quoting issues.
     * Handles any content: binary, special chars, scripts with quotes, etc.
     */
    async writeFile(containerPath: string, content: string): Promise<void> {
        await this.ensureRunning();

        // Ensure parent directory exists
        await this.exec(`mkdir -p "$(dirname '${containerPath}')"`);

        // Write content via stdin pipe — avoids all heredoc quoting/escaping issues
        await new Promise<void>((resolve, reject) => {
            const child = spawn('docker', [
                'exec', '-i', this.containerName,
                'sh', '-c', `cat > '${containerPath}'`
            ]);

            const fileContent = typeof content === 'string' ? content : String(content);

            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`writeFile failed: exit ${code} for ${containerPath}`));
            });

            // Stream content to stdin and close it
            (child.stdin as Writable).write(fileContent, 'utf-8', (err) => {
                if (err) reject(err);
                else (child.stdin as Writable).end();
            });
        });
    }

    /**
     * Read a file from the container.
     */
    async readFile(containerPath: string): Promise<string> {
        await this.ensureRunning();
        const result = await this.exec(`cat '${containerPath}'`);
        if (result.exitCode !== 0) {
            throw new Error(`Cannot read file: ${result.stderr}`);
        }
        return result.stdout;
    }

    /**
     * Copy a file from host to container.
     */
    async copyToContainer(hostPath: string, containerPath: string): Promise<void> {
        await this.ensureRunning();
        await execAsync(`docker cp "${hostPath}" ${this.containerName}:${containerPath}`, { timeout: 30000 });
    }

    /**
     * Copy a file from container to host.
     */
    async copyFromContainer(containerPath: string, hostPath: string): Promise<void> {
        await this.ensureRunning();
        await execAsync(`docker cp ${this.containerName}:${containerPath} "${hostPath}"`, { timeout: 30000 });
    }

    // ========================================================================
    // INTERACTIVE / PTY SESSIONS
    // ========================================================================

    /**
     * Start an interactive REPL session (node, python, bash, etc.).
     * Returns a session ID for sending input and receiving output.
     */
    startREPL(runtime: string = 'node'): {
        sessionId: string;
        onOutput: (callback: (data: string) => void) => void;
        sendInput: (input: string) => void;
        close: () => void;
    } {
        const sessionId = `repl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        const proc = spawn('docker', ['exec', '-i', this.containerName, runtime], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.activePTYs.set(sessionId, proc);

        const outputCallbacks: Array<(data: string) => void> = [];

        proc.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            outputCallbacks.forEach(cb => cb(text));
            this.touchActivity();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            outputCallbacks.forEach(cb => cb(`[stderr] ${text}`));
        });

        proc.on('exit', () => {
            this.activePTYs.delete(sessionId);
            this.emit('repl:closed', { sessionId, runtime });
        });

        this.emit('repl:started', { sessionId, runtime });

        return {
            sessionId,
            onOutput: (callback) => outputCallbacks.push(callback),
            sendInput: (input) => {
                proc.stdin?.write(input + '\n');
                this.touchActivity();
            },
            close: () => {
                proc.kill('SIGTERM');
                this.activePTYs.delete(sessionId);
            },
        };
    }

    // ========================================================================
    // STATUS & HELPERS
    // ========================================================================

    /**
     * Check if the container is currently running.
     */
    async isRunning(): Promise<boolean> {
        if (!this.containerName) return false;

        try {
            const { stdout } = await execAsync(
                `docker inspect --format "{{.State.Running}}" ${this.containerName}`,
                { timeout: 5000 }
            );
            return stdout.trim() === 'true';
        } catch {
            return false;
        }
    }

    /**
     * Get container status.
     */
    async getStatus(): Promise<ContainerStatus> {
        const running = await this.isRunning();
        return {
            containerId: this.containerId,
            containerName: this.containerName,
            running,
            image: this.config.image,
            createdAt: this.createdAt,
            lastActivity: this.lastActivity,
            uptime: this.createdAt ? Date.now() - this.createdAt : 0,
        };
    }

    /**
     * Update last activity and reset idle timer.
     */
    /**
     * Prevent the idle timeout from firing while a HITL pause is active.
     * Each holdAlive() call must be matched by a releaseHold() call.
     */
    holdAlive(): void {
        this.holdCount++;
        this.clearIdleTimer();
        log.info(`[ContainerSession] Hold activated (count=${this.holdCount}) for ${this.containerName}`);
    }

    /**
     * Re-enable the idle timer after a HITL pause ends.
     */
    releaseHold(): void {
        this.holdCount = Math.max(0, this.holdCount - 1);
        if (this.holdCount === 0) {
            this.touchActivity(); // restart idle timer
            log.info(`[ContainerSession] Hold released, idle timer restarted for ${this.containerName}`);
        }
    }

    private touchActivity(): void {
        this.lastActivity = Date.now();
        this.resetIdleTimer();
    }

    /**
     * Reset the idle timeout — skipped while a hold is active.
     */
    private resetIdleTimer(): void {
        this.clearIdleTimer();
        if (this.holdCount > 0) return; // HITL pause: don't schedule stop

        this.idleTimer = setTimeout(async () => {
            log.info(`[ContainerSession] Idle timeout reached for ${this.containerName}, stopping...`);
            this.emit('container:idle', { name: this.containerName });

            // Remove completely — each goal gets a fresh container so nothing to preserve
            try {
                await execAsync(`docker rm -f ${this.containerName}`, { timeout: 15000 });
                log.info(`[ContainerSession] Container removed (idle): ${this.containerName}`);
            } catch (e: any) {
                log.warn(`[ContainerSession] Idle stop failed: ${e.message}`);
            }
        }, this.config.idleTimeoutMs);
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}

// ============================================================================
// CONTAINER SESSION MANAGER (Singleton)
// ============================================================================

export class ContainerSessionManager extends EventEmitter {
    private sessions: Map<string, ContainerSession> = new Map();
    private dockerAvailable: boolean | null = null;

    /**
     * Check if Docker is available on the system.
     */
    async isDockerAvailable(): Promise<boolean> {
        if (this.dockerAvailable !== null) return this.dockerAvailable;

        try {
            await execAsync('docker version --format "{{.Server.Version}}"', { timeout: 5000 });
            this.dockerAvailable = true;
        } catch {
            this.dockerAvailable = false;
        }

        return this.dockerAvailable;
    }

    /**
     * Return an existing session without creating one (returns undefined if not found).
     */
    getExistingSession(sessionId: string): ContainerSession | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Get or create a session for a user/task.
     */
    async getSession(sessionId: string, config?: Partial<ContainerConfig>): Promise<ContainerSession> {
        if (!await this.isDockerAvailable()) {
            throw new Error('Docker is not available. Install Docker to enable persistent execution.');
        }

        let session = this.sessions.get(sessionId);
        if (!session) {
            session = new ContainerSession(sessionId, config);
            this.sessions.set(sessionId, session);

            session.on('container:idle', () => {
                // Keep session reference for restart, just note it's stopped
                log.info(`[ContainerSessionManager] Session ${sessionId} went idle`);
            });

            session.on('container:destroyed', () => {
                this.sessions.delete(sessionId);
            });
        }

        return session;
    }

    /**
     * Execute a command in a session's container.
     * Creates the container on first use (lazy initialization).
     */
    async exec(sessionId: string, command: string, options?: {
        timeout?: number;
        cwd?: string;
        env?: Record<string, string>;
        config?: Partial<ContainerConfig>;
    }): Promise<ExecResult> {
        const session = await this.getSession(sessionId, options?.config);
        return session.exec(command, options);
    }

    /**
     * Destroy a session's container.
     */
    async destroySession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Destroy all sessions.
     */
    async destroyAll(): Promise<void> {
        const promises = Array.from(this.sessions.values()).map(s => s.destroy());
        await Promise.allSettled(promises);
        this.sessions.clear();
    }

    /**
     * Get status of all sessions.
     */
    async getAllStatus(): Promise<ContainerStatus[]> {
        const statuses = await Promise.all(
            Array.from(this.sessions.values()).map(s => s.getStatus())
        );
        return statuses;
    }

    /**
     * Get session count.
     */
    getSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Remove orphaned aipartner_goal_* containers that are older than maxAgeMs (default 2h).
     * These accumulate when a goal execution crashes without cleanup.
     * Fire-and-forget — non-fatal if Docker is unavailable.
     */
    async cleanupStaleContainers(maxAgeMs = 2 * 60 * 60 * 1000): Promise<void> {
        try {
            // List all containers (including stopped) matching our naming prefix
            const { stdout } = await execAsync(
                `docker ps -a --filter "name=aipartner_goal_" --format "{{.Names}} {{.CreatedAt}}"`,
                { timeout: 10000 }
            );
            if (!stdout.trim()) return;

            const now = Date.now();
            const lines = stdout.trim().split('\n').filter(Boolean);
            const toRemove: string[] = [];

            for (const line of lines) {
                // Docker format: "name YYYY-MM-DD HH:MM:SS +ZONE"
                const spaceIdx = line.indexOf(' ');
                if (spaceIdx < 0) continue;
                const name = line.substring(0, spaceIdx).trim();
                const dateStr = line.substring(spaceIdx + 1).trim();
                const created = new Date(dateStr).getTime();
                if (!isNaN(created) && now - created > maxAgeMs) {
                    // Only remove containers not tracked by active sessions
                    const sessionId = name.replace(/^aipartner_/, '');
                    if (!this.sessions.has(sessionId)) {
                        toRemove.push(name);
                    }
                }
            }

            if (toRemove.length === 0) return;

            log.info(`[ContainerSessionManager] Removing ${toRemove.length} stale container(s): ${toRemove.join(', ')}`);
            await execAsync(`docker rm -f ${toRemove.join(' ')}`, { timeout: 15000 });
        } catch {
            // Non-fatal — Docker may not be available or containers already gone
        }
    }
}

/** Singleton instance */
export const containerSessionManager = new ContainerSessionManager();
