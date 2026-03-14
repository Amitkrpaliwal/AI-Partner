import Docker from 'dockerode';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Detect the correct Docker socket/pipe by querying the active Docker context.
 * On Windows with Docker Desktop, the default pipe may differ from dockerode's default.
 */
async function getDockerOptions(): Promise<Docker.DockerOptions> {
    if (process.platform === 'win32') {
        try {
            const { stdout } = await execAsync(
                'docker context inspect --format "{{.Endpoints.docker.Host}}"',
                { timeout: 5000 }
            );
            const host = stdout.trim();
            // Extract pipe path from npipe:////./pipe/NAME format
            const pipeMatch = host.match(/npipe:\/\/(.+)/);
            if (pipeMatch) {
                return { socketPath: pipeMatch[1] };
            }
        } catch { /* fall through to defaults */ }
    }
    return {}; // Use dockerode defaults (unix socket on Linux/Mac, default pipe on Windows)
}

// Lazy-initialized Docker client using correct socket
let _dockerClient: Docker | null = null;
async function getDocker(): Promise<Docker> {
    if (!_dockerClient) {
        const opts = await getDockerOptions();
        _dockerClient = new Docker(opts);
    }
    return _dockerClient;
}

// Consistent image tags
const PYTHON_IMAGE = 'python:3.11-alpine';
const NODE_IMAGE = 'node:20-alpine';

export interface ExecutionResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    duration: number;
}

export class ContainerSandbox {
    private defaultTimeout = 30000; // 30 seconds
    private defaultMemoryLimit = 536870912; // 512MB
    private docker: Docker | null;
    private workspacePath: string;
    private imagesReady: boolean = false;

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
        this.docker = null; // Lazy-initialized in ensureReady() with correct socket
    }

    /**
     * Initialize Docker connection and ensure images are available.
     * Call this once (e.g. from GoalOrientedExecutor.isSandboxAvailable).
     */
    async ensureReady(): Promise<boolean> {
        if (this.imagesReady && this.docker) return true;

        try {
            // Use context-aware Docker client (resolves correct pipe on Windows)
            if (!this.docker) {
                this.docker = await getDocker();
            }
            await this.docker.ping();
            console.log('[Sandbox] Docker connected, checking images...');
            await this.ensureImages();
            this.imagesReady = true;
            return true;
        } catch (e: any) {
            console.warn(`[Sandbox] Docker not available: ${e.message}`);
            this.docker = null;
            return false;
        }
    }

    private async ensureImages() {
        if (!this.docker) return;
        const images = [PYTHON_IMAGE, NODE_IMAGE];
        for (const img of images) {
            await this.pullImage(img);
        }
        console.log('[Sandbox] Images ready');
    }

    private async pullImage(image: string) {
        try {
            const images = await this.docker!.listImages();
            const exists = images.some(i => i.RepoTags?.includes(image));
            if (exists) return;

            console.log(`[Sandbox] Pulling ${image}...`);
            await new Promise((resolve, reject) => {
                this.docker!.pull(image, (err: any, stream: any) => {
                    if (err) return reject(err);
                    this.docker!.modem.followProgress(stream,
                        (err: any, output: any) => err ? reject(err) : resolve(output),
                        () => {} // quiet progress
                    );
                });
            });
        } catch (e) {
            console.warn(`[Sandbox] Failed to pull ${image}: ${(e as any).message}`);
        }
    }

    /**
     * Check if Docker is available for sandboxed execution
     */
    async isAvailable(): Promise<boolean> {
        if (!this.docker) return false;
        try {
            await this.docker.ping();
            return true;
        } catch {
            return false;
        }
    }

    async executePython(code: string): Promise<string | ExecutionResult> {
        if (!this.docker) {
            return "Docker is not available. Code execution skipped.";
        }
        return this.runContainer(PYTHON_IMAGE, ['python', '-c', code], this.workspacePath);
    }

    /**
     * Execute a Python script file inside the Docker sandbox.
     * Workspace is mounted read-write so scripts can create files.
     */
    async executePythonFile(scriptPath: string): Promise<ExecutionResult> {
        if (!this.docker) {
            return { success: false, stdout: '', stderr: 'Docker is not available', exitCode: -1, duration: 0 };
        }
        return this.runContainer(
            PYTHON_IMAGE,
            ['python', `/workspace/${scriptPath}`],
            this.workspacePath,
            true
        );
    }

    async executeJavaScript(code: string): Promise<string | ExecutionResult> {
        if (!this.docker) {
            return "Docker is not available. Code execution skipped.";
        }
        return this.runContainer(NODE_IMAGE, ['node', '-e', code], this.workspacePath);
    }

    /**
     * Execute a Node.js script file inside the Docker sandbox.
     * Workspace is mounted read-write so scripts can create files.
     */
    async executeNodeFile(scriptPath: string): Promise<ExecutionResult> {
        if (!this.docker) {
            return { success: false, stdout: '', stderr: 'Docker is not available', exitCode: -1, duration: 0 };
        }
        return this.runContainer(
            NODE_IMAGE,
            ['node', `/workspace/${scriptPath}`],
            this.workspacePath,
            true
        );
    }

    private async runContainer(
        image: string,
        cmd: string[],
        workspaceDir: string,
        writable: boolean = false
    ): Promise<ExecutionResult> {
        const startTime = Date.now();
        let container: any;

        try {
            // Use host-visible workspace path for Docker volume mounts
            // When running in Docker, workspaceDir is container-internal (/workspace)
            // but sibling containers need the volume name or host path
            const hostPath = process.env.AI_PARTNER_HOST_WORKSPACE || workspaceDir;
            const binds = [
                `${hostPath}:/workspace:${writable ? 'rw' : 'ro'}`
            ];

            container = await this.docker!.createContainer({
                Image: image,
                Cmd: cmd,
                HostConfig: {
                    Memory: this.defaultMemoryLimit,
                    MemorySwap: this.defaultMemoryLimit,
                    CpuQuota: 50000, // 50% of one CPU
                    NetworkMode: 'none', // No network access
                    ReadonlyRootfs: false, // Allow /tmp writes (alpine needs it)
                    Binds: binds,
                    Tmpfs: {
                        '/tmp': 'rw,noexec,nosuid,size=64m' // Writable scratch space
                    },
                },
                WorkingDir: '/workspace',
                User: 'nobody',
                Tty: false,
                AttachStdout: true,
                AttachStderr: true,
            });

            await container.start();

            // Wait for container to finish
            const waitResult = await container.wait();
            const exitCode = waitResult.StatusCode;

            // Get logs (demultiplexed Docker stream format)
            const logBuffer = await container.logs({ stdout: true, stderr: true });
            const rawLogs = logBuffer instanceof Buffer ? logBuffer : Buffer.from(logBuffer);

            let stdout = '';
            let stderr = '';
            let offset = 0;

            while (offset + 8 <= rawLogs.length) {
                const type = rawLogs[offset]; // 1 = stdout, 2 = stderr
                const size = (rawLogs[offset + 4] << 24) |
                             (rawLogs[offset + 5] << 16) |
                             (rawLogs[offset + 6] << 8) |
                             rawLogs[offset + 7];

                if (size > 0 && offset + 8 + size <= rawLogs.length) {
                    const content = rawLogs.slice(offset + 8, offset + 8 + size).toString('utf-8');
                    if (type === 1) stdout += content;
                    if (type === 2) stderr += content;
                }

                offset += 8 + size;
            }

            await container.remove({ force: true });

            return {
                success: exitCode === 0,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode,
                duration: Date.now() - startTime,
            };

        } catch (error) {
            if (container) {
                try { await container.remove({ force: true }); } catch { }
            }
            return {
                success: false,
                stdout: '',
                stderr: (error as any).message,
                exitCode: -1,
                duration: Date.now() - startTime,
            };
        }
    }
}
