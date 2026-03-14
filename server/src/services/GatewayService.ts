import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'http';
import { memoryManager } from '../memory/MemoryManager';
import { verifyToken } from '../middleware/auth';

/**
 * Gateway event types following the architecture spec
 */
export interface GatewayEvent {
    type: 'human_message' | 'heartbeat_tick' | 'task_trigger' | 'ooda_event' | 'plan_preview';
    channel: 'web' | 'whatsapp' | 'telegram' | 'discord';
    user_id: string;
    conversation_id?: string;
    timestamp: string;
    payload: any;
}

/**
 * Message event for human messages
 */
export interface HumanMessageEvent extends GatewayEvent {
    type: 'human_message';
    payload: {
        text: string;
        attachments?: string[];
    };
}

/**
 * OODA loop event for Inspector
 */
export interface OODAEvent extends GatewayEvent {
    type: 'ooda_event';
    payload: {
        phase: 'observe' | 'orient' | 'decide' | 'act' | 'reflect';
        content: string;
        metadata?: Record<string, any>;
    };
}

/**
 * Plan preview event for HITL approval
 */
export interface PlanPreviewEvent extends GatewayEvent {
    type: 'plan_preview';
    payload: {
        plan_id: string;
        description: string;
        steps: Array<{
            id: string;
            action: string;
            description: string;
            requires_confirmation: boolean;
        }>;
    };
}

/**
 * Gateway Service - Central WebSocket control plane
 * 
 * Responsibilities:
 * - WebSocket server for all channels
 * - Event routing to appropriate handlers
 * - Multi-channel support (web first, others future)
 * - OODA event broadcasting
 * - Plan preview for HITL
 */
export class GatewayService {
    public io: SocketIOServer;
    private connectedClients: Map<string, Socket> = new Map();
    private screencastWired = false;

    constructor(server: http.Server) {
        this.io = new SocketIOServer(server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });

        // Socket.IO JWT authentication (when auth is enabled)
        this.io.use((socket, next) => {
            if (process.env.AI_PARTNER_AUTH_ENABLED !== 'true') {
                (socket as any).userId = 'default';
                return next();
            }

            const token = socket.handshake.auth?.token || socket.handshake.query?.token;
            if (token) {
                const payload = verifyToken(token as string);
                if (payload) {
                    (socket as any).userId = payload.userId;
                    (socket as any).username = payload.username;
                    return next();
                }
            }

            next(new Error('Authentication required'));
        });

        this.setupEventHandlers();
        // Wire CDP screencasting at startup (async, non-blocking)
        this.wireScreencast().catch(() => {});
        console.log('[Gateway] Service initialized');
    }

    /**
     * Wire CDP screencast frames → socket.io broadcast.
     * Called once after BrowserServer is imported for the first time.
     */
    private async wireScreencast(): Promise<void> {
        if (this.screencastWired) return;
        this.screencastWired = true;
        try {
            const { browserServer } = await import('../mcp/servers/BrowserServer');

            // Server-side frame rate cap: emit at most 15fps to clients regardless of
            // how fast CDP delivers frames. Prevents WebSocket flooding (~80KB/frame ×
            // 30fps = 2.4MB/s) when Node.js event loop is fast.
            const TARGET_FPS = 15;
            const FRAME_INTERVAL_MS = Math.round(1000 / TARGET_FPS); // 66ms
            let lastEmitTs = 0;

            browserServer.onScreencastFrame = (base64: string) => {
                const now = Date.now();
                if (now - lastEmitTs < FRAME_INTERVAL_MS) return; // drop frame — too soon
                lastEmitTs = now;
                this.io.emit('browser:screenshot', {
                    base64,
                    mimeType: 'image/jpeg',
                    url: browserServer.getCurrentUrl(),
                    iteration: -1,
                    isLive: true,
                });
            };
            console.log('[Gateway] CDP screencast wired (capped at 15fps)');
        } catch (e) {
            console.warn('[Gateway] wireScreencast failed:', e);
        }
    }

    /**
     * Setup WebSocket event handlers
     */
    private setupEventHandlers(): void {
        this.io.on('connection', (socket: Socket) => {
            const clientId = socket.id;
            console.log(`[Gateway] Client connected: ${clientId}`);
            this.connectedClients.set(clientId, socket);

            // Handle human messages (with streaming support)
            socket.on('message:send', async (data: { content: string; userId?: string; mode?: string; conversationId?: string }) => {
                const event: HumanMessageEvent = {
                    type: 'human_message',
                    channel: 'web',
                    user_id: data.userId || 'default',
                    timestamp: new Date().toISOString(),
                    payload: {
                        text: data.content
                    }
                };

                await this.handleHumanMessage(event, socket, data.mode, data.conversationId);
            });

            // Handle execution cancellation
            socket.on('message:cancel', async (data: { conversationId?: string }) => {
                console.log(`[Gateway] Execution cancel requested`);
                try {
                    const { agentOrchestrator } = await import('./AgentOrchestrator');
                    if (agentOrchestrator.cancelExecution) {
                        agentOrchestrator.cancelExecution(data.conversationId);
                    }
                } catch (e) {
                    console.error('[Gateway] Cancel error:', e);
                }
                socket.emit('execution:cancelled', { success: true });
            });

            // Handle plan approval
            socket.on('plan:approve', async (data: { plan_id: string }) => {
                console.log(`[Gateway] Plan approved: ${data.plan_id}`);
                this.emit('plan:approved', { plan_id: data.plan_id });
            });

            // Handle plan rejection
            socket.on('plan:reject', async (data: { plan_id: string; reason?: string }) => {
                console.log(`[Gateway] Plan rejected: ${data.plan_id}`);
                this.emit('plan:rejected', { plan_id: data.plan_id, reason: data.reason });
            });

            // Handle goal sync request — client sends this on ChatArea remount
            // to learn if a goal is still running for its conversation
            socket.on('goal:request_sync', async (data: { conversationId?: string }) => {
                try {
                    const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                    const executions = goalOrientedExecutor.getActiveExecutions
                        ? goalOrientedExecutor.getActiveExecutions()
                        : new Map();
                    for (const [, state] of executions) {
                        if (!data.conversationId || (state as any).conversationId === data.conversationId) {
                            socket.emit('goal:sync', {
                                execution_id: state.execution_id,
                                status: state.status,
                                iteration: state.current_iteration,
                                progress: state.progress_percent,
                            });
                            break;
                        }
                    }
                } catch { /* non-fatal */ }
            });

            // Handle conversation loading
            socket.on('conversation:load', async (conversationId: string) => {
                // Load conversation from memory and emit messages
                // This will be handled by the orchestrator
                console.log(`[Gateway] Loading conversation: ${conversationId}`);
            });

            // Handle workspace file listing
            socket.on('workspace:list', async () => {
                console.log(`[Gateway] Workspace list requested`);
                try {
                    const { configManager } = await import('./ConfigManager');
                    const fs = await import('fs');
                    const path = await import('path');

                    const workspaceDir = configManager.getWorkspaceDir();

                    if (fs.existsSync(workspaceDir)) {
                        const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
                        const files = entries.map(entry => {
                            const isDir = entry.isDirectory();
                            return isDir ? `${entry.name}/` : entry.name;
                        });
                        socket.emit('file:list', { files });
                        console.log(`[Gateway] Sent ${files.length} files`);
                    } else {
                        socket.emit('file:list', { files: [], error: 'Workspace not found' });
                    }
                } catch (e) {
                    console.error('[Gateway] Error listing files:', e);
                    socket.emit('file:list', { files: [], error: String(e) });
                }
            });

            // Phase 11C.6: Container output streaming
            socket.on('container:exec', async (data: { sessionId?: string; command: string; timeout?: number }) => {
                const sessId = data.sessionId || 'default';
                console.log(`[Gateway] Container exec request: session=${sessId}, cmd="${data.command.substring(0, 60)}"`);

                try {
                    const { containerSessionManager } = await import('../execution/ContainerSession');

                    if (!await containerSessionManager.isDockerAvailable()) {
                        socket.emit('container:output', {
                            sessionId: sessId,
                            type: 'error',
                            data: 'Docker is not available',
                            done: true,
                        });
                        return;
                    }

                    socket.emit('container:output', {
                        sessionId: sessId,
                        type: 'info',
                        data: `$ ${data.command}`,
                        done: false,
                    });

                    const result = await containerSessionManager.exec(sessId, data.command, {
                        timeout: data.timeout || 60000,
                    });

                    if (result.stdout) {
                        socket.emit('container:output', {
                            sessionId: sessId,
                            type: 'stdout',
                            data: result.stdout,
                            done: false,
                        });
                    }
                    if (result.stderr) {
                        socket.emit('container:output', {
                            sessionId: sessId,
                            type: 'stderr',
                            data: result.stderr,
                            done: false,
                        });
                    }

                    socket.emit('container:output', {
                        sessionId: sessId,
                        type: 'exit',
                        data: `Exit code: ${result.exitCode} (${result.durationMs}ms)${result.timedOut ? ' [TIMED OUT]' : ''}`,
                        exitCode: result.exitCode,
                        durationMs: result.durationMs,
                        timedOut: result.timedOut,
                        done: true,
                    });
                } catch (e: any) {
                    socket.emit('container:output', {
                        sessionId: sessId,
                        type: 'error',
                        data: e.message,
                        done: true,
                    });
                }
            });

            // Container session status request
            socket.on('container:status', async () => {
                try {
                    const { containerSessionManager } = await import('../execution/ContainerSession');
                    const dockerAvailable = await containerSessionManager.isDockerAvailable();
                    const sessions = await containerSessionManager.getAllStatus();
                    socket.emit('container:status', {
                        dockerAvailable,
                        sessions,
                        sessionCount: sessions.length,
                    });
                } catch (e: any) {
                    socket.emit('container:status', { dockerAvailable: false, sessions: [], sessionCount: 0, error: e.message });
                }
            });

            // ── Browser Control (Take/Release/Interact) ───────────────────────────
            // Pause agent, let user click/type on the live screenshot, then resume.

            /** User clicks "Take Control" — pause agent loop */
            socket.on('browser:take_control', async (data?: { targetUrl?: string }) => {
                try {
                    const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                    const { browserServer } = await import('../mcp/servers/BrowserServer');

                    // If browser isn't running yet (e.g. HITL fired before browser_launch was
                    // called), launch it now so the popup has a live session to connect to.
                    if (!browserServer.isLaunched()) {
                        console.log('[Gateway] Browser not active — launching for human control');
                        await browserServer.callTool('browser_launch', { headless: true });
                    }

                    // Navigate to the target URL if provided and browser has no active page.
                    // Gives the human a relevant starting point instead of a blank tab.
                    const targetUrl = data?.targetUrl;
                    const currentUrl = browserServer.getCurrentUrl();
                    if (targetUrl && (!currentUrl || currentUrl === 'about:blank')) {
                        console.log(`[Gateway] Navigating to target URL for human control: ${targetUrl}`);
                        await browserServer.callTool('browser_navigate', { url: targetUrl });
                    }

                    goalOrientedExecutor.takeBrowserControl();
                    const url = browserServer.getCurrentUrl();
                    this.io.emit('browser:control_granted', { url });
                    console.log('[Gateway] Browser control granted to user');
                } catch (e) { console.error('[Gateway] take_control error:', e); }
            });

            /** Auto-open preview — launches browser + navigates but does NOT grant control.
             *  User still needs to click "Take Control" explicitly to interact. */
            socket.on('browser:launch_preview', async (data?: { targetUrl?: string }) => {
                try {
                    const { browserServer } = await import('../mcp/servers/BrowserServer');
                    if (!browserServer.isLaunched()) {
                        console.log('[Gateway] Launching browser for preview (no control granted)');
                        await browserServer.callTool('browser_launch', { headless: true });
                    }
                    const targetUrl = data?.targetUrl;
                    const currentUrl = browserServer.getCurrentUrl();
                    if (targetUrl && (!currentUrl || currentUrl === 'about:blank')) {
                        console.log(`[Gateway] Navigating to target URL for preview: ${targetUrl}`);
                        await browserServer.callTool('browser_navigate', { url: targetUrl });
                    }
                    // Send a screenshot so Inspector shows the page immediately
                    socket.emit('browser:screenshot_request');
                    console.log('[Gateway] Browser preview ready — user has not taken control');
                } catch (e) { console.error('[Gateway] launch_preview error:', e); }
            });

            /** User clicks "Release Control" — resume agent loop */
            socket.on('browser:release_control', async () => {
                try {
                    const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
                    const { browserServer } = await import('../mcp/servers/BrowserServer');
                    goalOrientedExecutor.releaseBrowserControl();

                    // If the agent was blocked on a HITL input (e.g. waiting for credentials),
                    // auto-resolve it now — the user handled it in the browser visually.
                    // Pass the current URL so the agent knows where the browser landed.
                    const currentUrl = browserServer.getCurrentUrl();
                    const resolved = goalOrientedExecutor.resolveAnyPendingInput(
                        `User completed the browser interaction. Browser is now at: ${currentUrl}. Continue from the current browser state — do NOT navigate away or re-enter credentials.`
                    );
                    if (resolved) {
                        console.log('[Gateway] Auto-resolved pending HITL after browser release');
                    }

                    // Take a final screenshot so the agent sees the new page state
                    const shot = await browserServer.screenshot({});
                    if (shot.base64) {
                        this.io.emit('browser:screenshot', {
                            base64: shot.base64, mimeType: 'image/png',
                            url: currentUrl, iteration: -1,
                        });
                    }
                    this.io.emit('browser:control_released', {});
                    console.log('[Gateway] Browser control released by user');
                } catch (e) { console.error('[Gateway] release_control error:', e); }
            });

            /** User clicked on the screenshot image — forward as coordinate click */
            socket.on('browser:click', async (data: { xRatio: number; yRatio: number }) => {
                try {
                    const { browserServer } = await import('../mcp/servers/BrowserServer');
                    // Viewport dimensions match what BrowserServer uses (1366×768)
                    const x = Math.round(Math.max(0, Math.min(1, data.xRatio)) * 1366);
                    const y = Math.round(Math.max(0, Math.min(1, data.yRatio)) * 768);
                    await browserServer.clickAtCoordinates(x, y);
                    // Brief wait for any navigation / JS to settle
                    await new Promise(r => setTimeout(r, 600));
                    const shot = await browserServer.screenshot({});
                    if (shot.base64) {
                        this.io.emit('browser:screenshot', {
                            base64: shot.base64, mimeType: 'image/png',
                            url: browserServer.getCurrentUrl(), iteration: -1,
                        });
                    }
                } catch (e) { console.error('[Gateway] browser:click error:', e); }
            });

            /** User typed text — forward to active page element */
            socket.on('browser:type', async (data: { text: string }) => {
                try {
                    const { browserServer } = await import('../mcp/servers/BrowserServer');
                    await browserServer.typeText(data.text);
                    const shot = await browserServer.screenshot({});
                    if (shot.base64) {
                        this.io.emit('browser:screenshot', {
                            base64: shot.base64, mimeType: 'image/png',
                            url: browserServer.getCurrentUrl(), iteration: -1,
                        });
                    }
                } catch (e) { console.error('[Gateway] browser:type error:', e); }
            });

            /** User pressed a special key (Enter, Tab, Escape, Backspace, …) */
            socket.on('browser:key', async (data: { key: string }) => {
                try {
                    const { browserServer } = await import('../mcp/servers/BrowserServer');
                    await browserServer.pressKey(data.key);
                    await new Promise(r => setTimeout(r, 400));
                    const shot = await browserServer.screenshot({});
                    if (shot.base64) {
                        this.io.emit('browser:screenshot', {
                            base64: shot.base64, mimeType: 'image/png',
                            url: browserServer.getCurrentUrl(), iteration: -1,
                        });
                    }
                } catch (e) { console.error('[Gateway] browser:key error:', e); }
            });

            /** User scrolled — forward wheel delta */
            socket.on('browser:scroll', async (data: { xRatio: number; yRatio: number; deltaY: number }) => {
                try {
                    const { browserServer } = await import('../mcp/servers/BrowserServer');
                    const x = Math.round(data.xRatio * 1366);
                    const y = Math.round(data.yRatio * 768);
                    await browserServer.scrollAt(x, y, 0, data.deltaY);
                    const shot = await browserServer.screenshot({});
                    if (shot.base64) {
                        this.io.emit('browser:screenshot', {
                            base64: shot.base64, mimeType: 'image/png',
                            url: browserServer.getCurrentUrl(), iteration: -1,
                        });
                    }
                } catch (e) { console.error('[Gateway] browser:scroll error:', e); }
            });

            /** Manual refresh — take a fresh screenshot on demand */
            socket.on('browser:screenshot_request', async () => {
                try {
                    const { browserServer } = await import('../mcp/servers/BrowserServer');
                    const shot = await browserServer.screenshot({});
                    if (shot.base64) {
                        socket.emit('browser:screenshot', {
                            base64: shot.base64, mimeType: 'image/png',
                            url: browserServer.getCurrentUrl(), iteration: -1,
                        });
                    }
                } catch (e) { console.error('[Gateway] screenshot_request error:', e); }
            });
            // ── End Browser Control ───────────────────────────────────────────────

            socket.on('disconnect', () => {
                console.log(`[Gateway] Client disconnected: ${clientId}`);
                this.connectedClients.delete(clientId);
            });
        });
    }

    /**
     * Handle incoming human messages with streaming support
     */
    private async handleHumanMessage(event: HumanMessageEvent, socket: Socket, mode?: string, conversationId?: string): Promise<void> {
        try {
            // Import orchestrator dynamically to avoid circular deps
            const { agentOrchestrator } = await import('./AgentOrchestrator');

            // Use streaming chat - tokens arrive via message:stream events
            await agentOrchestrator.chatStreaming(
                event.user_id,
                event.payload.text,
                conversationId,
                mode || 'chat',
                (data) => {
                    socket.emit('message:stream', data);
                    // Also emit on done in case early emit was missed
                    if (data.done && data.conversationId) {
                        socket.emit('conversation:id', { conversationId: data.conversationId });
                    }
                },
                // Emit conversation ID immediately when known — enables Stop button during execution
                (convId) => socket.emit('conversation:id', { conversationId: convId })
            );
        } catch (error) {
            console.error('[Gateway] Error handling message:', error);
            socket.emit('message:error', { error: String(error) });
        }
    }

    /**
     * Emit event to all connected clients
     */
    emit(event: string, data: any): void {
        this.io.emit(event, data);
    }

    /**
     * Emit event to specific client
     */
    emitTo(clientId: string, event: string, data: any): void {
        const socket = this.connectedClients.get(clientId);
        if (socket) {
            socket.emit(event, data);
        }
    }

    /**
     * Broadcast OODA event to all clients
     */
    emitOODA(phase: OODAEvent['payload']['phase'], content: string, metadata?: Record<string, any>): void {
        const event: OODAEvent = {
            type: 'ooda_event',
            channel: 'web',
            user_id: 'system',
            timestamp: new Date().toISOString(),
            payload: { phase, content, metadata }
        };

        this.io.emit('ooda:event', event);
    }

    /**
     * Emit plan preview for HITL approval
     */
    emitPlanPreview(plan: PlanPreviewEvent['payload']): void {
        const event: PlanPreviewEvent = {
            type: 'plan_preview',
            channel: 'web',
            user_id: 'system',
            timestamp: new Date().toISOString(),
            payload: plan
        };

        this.io.emit('plan:preview', event);
    }

    /**
     * Emit heartbeat status
     */
    emitHeartbeat(status: string, details?: any): void {
        this.io.emit('heartbeat:status', {
            status,
            timestamp: new Date().toISOString(),
            details
        });
    }

    /**
     * Emit notification to clients
     */
    emitNotification(type: 'info' | 'warning' | 'error' | 'success', title: string, message: string): void {
        this.io.emit('notification', { type, title, message, timestamp: new Date().toISOString() });
    }

    /**
     * Get connection status
     */
    getStatus(): { connected: number; clients: string[] } {
        return {
            connected: this.connectedClients.size,
            clients: Array.from(this.connectedClients.keys())
        };
    }
}

// Note: Gateway instance is created in index.ts with the HTTP server
