import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { MemoryManager, memoryManager } from '../memory/MemoryManager';
import { NotificationService } from './NotificationService';
import { configManager } from './ConfigManager';
import { MarkdownConfigLoader, HeartbeatCheckItem } from '../config/MarkdownConfigLoader';
import { proactiveAgenda } from './ProactiveAgenda';

export interface HeartbeatConfig {
    enabled: boolean;
    interval: '15m' | '30m' | '1h' | '24h';
    activeHours: { start: string; end: string };
    checklistFile: string;
    preferredChannel?: string;  // 'discord' | 'telegram' | 'web' (default: 'web')
    channelChatId?: string;     // Target chat/channel ID for messaging providers
}

export class HeartbeatService {
    private job: cron.ScheduledTask | null = null;
    private lastTick: Date | null = null;
    private config: HeartbeatConfig;
    private memory: MemoryManager;
    private notifier: NotificationService;
    private configLoader: MarkdownConfigLoader | null = null;
    private io: any = null;

    /** Wire Socket.IO so heartbeat:tick events reach the frontend in real-time */
    setSocketIO(io: any) {
        this.io = io;
    }

    constructor(memory: MemoryManager, notifier: NotificationService) {
        this.memory = memory;
        this.notifier = notifier;

        // Load config from ConfigManager
        const appConfig = configManager.getConfig();
        this.config = {
            enabled: appConfig.heartbeat.enabled,
            interval: appConfig.heartbeat.interval,
            activeHours: appConfig.heartbeat.active_hours,
            checklistFile: appConfig.heartbeat.checklist_file,
            preferredChannel: (appConfig.heartbeat as any).preferred_channel,
            channelChatId: (appConfig.heartbeat as any).channel_chat_id,
        };

        // Initialize config loader
        this.initConfigLoader();
    }

    /**
     * Initialize the markdown config loader
     */
    private initConfigLoader(): void {
        try {
            const workspaceDir = configManager.getWorkspaceDir();
            this.configLoader = new MarkdownConfigLoader(workspaceDir);
        } catch (e) {
            console.warn('[Heartbeat] Failed to initialize config loader:', e);
        }
    }

    setConfig(newConfig: Partial<HeartbeatConfig>) {
        this.config = { ...this.config, ...newConfig };
        // Persist channel settings to config file so they survive restarts
        const patch: Record<string, any> = {
            enabled: this.config.enabled,
            interval: this.config.interval,
        };
        if (this.config.preferredChannel !== undefined) patch.preferred_channel = this.config.preferredChannel;
        if (this.config.channelChatId !== undefined) patch.channel_chat_id = this.config.channelChatId;
        configManager.updateConfig({ heartbeat: patch } as any).catch(() => { /* non-fatal */ });
        this.start(); // Restart with new config
    }

    getConfig() {
        return this.config;
    }

    getStatus() {
        return {
            enabled: this.config.enabled,
            interval: this.config.interval,
            lastTick: this.lastTick,
            nextTick: this.config.enabled ? 'Scheduled' : 'Stopped',
            preferredChannel: this.config.preferredChannel,
            channelChatId: this.config.channelChatId,
        };
    }

    /**
     * Load heartbeat checklist from HEARTBEAT.md
     */
    loadChecklist(): HeartbeatCheckItem[] {
        if (!this.configLoader) {
            this.initConfigLoader();
        }

        if (this.configLoader) {
            return this.configLoader.loadHeartbeatChecklist();
        }

        return [];
    }

    /** Read raw HEARTBEAT.md text */
    readHeartbeatMd(): string {
        const workspaceDir = configManager.getWorkspaceDir();
        const filePath = path.join(workspaceDir, 'HEARTBEAT.md');
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf8');
    }

    /** Write raw HEARTBEAT.md text */
    writeHeartbeatMd(content: string): void {
        const workspaceDir = configManager.getWorkspaceDir();
        const filePath = path.join(workspaceDir, 'HEARTBEAT.md');
        fs.writeFileSync(filePath, content, 'utf8');
    }

    /** Read raw SOUL.md text */
    readSoulMd(): string {
        const workspaceDir = configManager.getWorkspaceDir();
        const filePath = path.join(workspaceDir, 'SOUL.md');
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf8');
    }

    /** Write raw SOUL.md text */
    writeSoulMd(content: string): void {
        const workspaceDir = configManager.getWorkspaceDir();
        const filePath = path.join(workspaceDir, 'SOUL.md');
        fs.writeFileSync(filePath, content, 'utf8');
    }

    start() {
        if (this.job) {
            this.job.stop();
        }

        if (!this.config.enabled) {
            console.log('[Heartbeat] Disabled');
            return;
        }

        const schedule = this.getCronSchedule();
        console.log(`[Heartbeat] Starting with schedule: ${schedule}`);

        this.job = cron.schedule(schedule, async () => {
            await this.tick();
        });
    }

    stop() {
        if (this.job) {
            this.job.stop();
            this.job = null;
        }
    }

    async tick() {
        const now = new Date();
        this.lastTick = now;

        if (!this.isActiveTime(now)) {
            console.log('[Heartbeat] Outside active hours, skipping check.');
            return;
        }

        console.log('[Heartbeat] Tick executing...');

        try {
            const { db } = await import('../database/index');

            // 1. Gather context
            const recentEvents = await this.memory.getRecentEvents(6);
            const persona = await this.memory.getPersona('default');
            const checklist = this.loadChecklist();

            // Load SOUL.md and USER.md content
            let soulContent = '';
            let userContent = '';
            if (this.configLoader) {
                soulContent = this.configLoader.loadSoul();
                userContent = this.configLoader.loadUser();
            }

            // Read last proactive action timestamp from DB
            let lastProactiveAt: Date | null = null;
            try {
                const lastLog = await db.get(
                    `SELECT timestamp FROM heartbeat_logs WHERE status = 'action_taken' ORDER BY timestamp DESC LIMIT 1`
                ) as { timestamp: string } | undefined;
                if (lastLog) lastProactiveAt = new Date(lastLog.timestamp);
            } catch { /* table may not exist yet */ }

            // 2. Ask ProactiveAgenda to decide whether to act and what to do
            const action = await proactiveAgenda.evaluate({
                now,
                soulContent,
                userContent,
                heartbeatTasks: checklist,
                recentEvents,
                persona,
                lastProactiveAt,
            });

            // 3. Nothing to do
            if (!action) {
                await db.run(
                    `INSERT INTO heartbeat_logs (id, user_id, status, action_taken, result) VALUES (?, ?, ?, ?, ?)`,
                    [`hb_${Date.now()}`, 'default', 'ok', '', JSON.stringify({ skipped: true })]
                );
                console.log('[Heartbeat] No proactive action needed this tick.');
                return;
            }

            console.log(`[Heartbeat] Proactive action selected: "${action.goal}" (${action.priority}, source=${action.source})`);

            // 4. Execute via GoalOrientedExecutor (reuses full ReAct loop)
            const { goalOrientedExecutor } = await import('../agents/GoalOrientedExecutor');
            const execResult = await goalOrientedExecutor.executeGoal(
                action.goal,
                'proactive',
                {
                    enableNetwork: action.enableNetwork,
                    profile: action.profile,
                    max_iterations: 15,
                }
            );

            // 5. Build result summary — rich enough for the user to read in chat
            const succeeded = execResult.status === 'completed';
            const durationSec = Math.round((execResult.summary.duration_ms || 0) / 1000);
            const durationStr = durationSec >= 60
                ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
                : `${durationSec}s`;

            let summary: string;
            if (succeeded) {
                const parts: string[] = [];
                parts.push(`## ✅ Proactive Task Completed`);
                parts.push(`**Task:** ${action.goal}`);
                parts.push(`**Duration:** ${durationStr} · **Iterations:** ${execResult.summary.total_iterations}`);

                const files = execResult.summary.artifacts_created;
                if (files.length > 0) {
                    // Show relative paths (strip workspace prefix for readability)
                    const workspaceDir = configManager.getWorkspaceDir();
                    const relFiles = files.map(f =>
                        f.startsWith(workspaceDir) ? f.slice(workspaceDir.length).replace(/^[\\/]/, '') : f
                    );
                    parts.push(`**Files created:** ${relFiles.join(', ')}`);
                }

                if (execResult.final_answer) {
                    // Limit preview to ~3KB so the chat message stays readable
                    const preview = execResult.final_answer.length > 3000
                        ? execResult.final_answer.substring(0, 3000) + '\n\n*(truncated — open the file for full content)*'
                        : execResult.final_answer;
                    parts.push(`\n---\n${preview}`);
                }

                summary = parts.join('\n');
            } else {
                const parts: string[] = [];
                parts.push(`## ⚠️ Proactive Task Did Not Complete`);
                parts.push(`**Task:** ${action.goal}`);
                parts.push(`**Duration:** ${durationStr} · **Iterations:** ${execResult.summary.total_iterations}`);
                if (execResult.failure_reason) {
                    parts.push(`**Reason:** ${execResult.failure_reason}`);
                }
                if (execResult.suggestions && execResult.suggestions.length > 0) {
                    parts.push(`**Details:** ${execResult.suggestions.join('; ')}`);
                }
                summary = parts.join('\n');
            }

            const logStatus = succeeded ? 'action_taken' : 'error';

            // 6. Notify (web UI + messaging channel)
            if (action.notify || succeeded) {
                await this.notifier.send({
                    type: succeeded ? 'info' : 'warning',
                    title: `Proactive: ${action.source}`,
                    message: summary
                });
                if (action.notify) {
                    // Send text summary first
                    await this.sendToPreferredChannel(summary);
                    // Then upload each artifact file directly (no localhost links)
                    if (succeeded && execResult.summary.artifacts_created.length > 0) {
                        await this.sendArtifactsToChannel(execResult.summary.artifacts_created);
                    }
                }
            }

            // 7a. Insert result into chat so it appears in conversation history
            try {
                const convId = 'heartbeat-proactive';
                const msgId = `hbmsg_${Date.now()}`;
                // Ensure the heartbeat conversation exists
                await db.run(
                    `INSERT OR IGNORE INTO conversations (id, user_id, title, created_at, updated_at)
                     VALUES (?, 'default', 'Heartbeat / Proactive Agent', datetime('now'), datetime('now'))`,
                    [convId]
                );
                await db.run(
                    `INSERT INTO messages (id, conversation_id, role, content, created_at)
                     VALUES (?, ?, 'assistant', ?, datetime('now'))`,
                    [msgId, convId, summary]
                );
                await db.run(
                    `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`,
                    [convId]
                );
                if (this.io) {
                    this.io.emit('message:new', { conversationId: convId, messageId: msgId });
                }
            } catch { /* non-fatal — chat logging should not break heartbeat */ }

            // 7b. Log to heartbeat_logs
            await db.run(
                `INSERT INTO heartbeat_logs (id, user_id, status, action_taken, result) VALUES (?, ?, ?, ?, ?)`,
                [
                    `hb_${Date.now()}`,
                    'default',
                    logStatus,
                    action.goal,
                    JSON.stringify({
                        action,
                        execution_id: execResult.execution_id,
                        status: execResult.status,
                        summary: execResult.summary,
                        final_answer: execResult.final_answer,
                        failure_reason: execResult.failure_reason,
                        suggestions: execResult.suggestions,
                    })
                ]
            );

            console.log(`[Heartbeat] Done — status=${logStatus} execution_id=${execResult.execution_id}`);

            // Emit real-time event so frontend can refresh logs immediately
            if (this.io) {
                this.io.emit('heartbeat:tick', {
                    status: logStatus,
                    action: action.goal,
                    executionId: execResult.execution_id,
                    timestamp: new Date().toISOString(),
                });
            }

        } catch (e) {
            console.error('[Heartbeat] Error:', e);
            await this.notifier.sendError('Heartbeat Failed', e);
        }
    }

    /**
     * Phase 14C.3: Send proactive summary to user's preferred messaging channel.
     * Falls back silently if channel is not configured or not connected.
     */
    private async sendToPreferredChannel(message: string): Promise<void> {
        const channel = this.config.preferredChannel;
        const chatId = this.config.channelChatId;

        if (!channel || channel === 'web' || !chatId) {
            return; // Web-only or no channel configured
        }

        try {
            const { messagingGateway } = await import('./MessagingGateway');
            const status = messagingGateway.getProviderStatus(channel);
            if (status?.connected) {
                const summary = `🔔 *Heartbeat Summary*\n\n${message}`;
                await messagingGateway.sendMessage(channel, chatId, summary);
                console.log(`[Heartbeat] Sent proactive summary to ${channel}:${chatId}`);
            } else {
                console.log(`[Heartbeat] Preferred channel ${channel} not connected, skipping`);
            }
        } catch (e: any) {
            console.warn(`[Heartbeat] Failed to send to ${channel}: ${e.message}`);
        }
    }

    /**
     * Upload generated artifact files directly to the preferred messaging channel.
     * Resolves artifact paths relative to the workspace directory.
     * Skips files that don't exist on disk or are too large (>50 MB).
     */
    private async sendArtifactsToChannel(artifacts: string[]): Promise<void> {
        const channel = this.config.preferredChannel;
        const chatId = this.config.channelChatId;
        if (!channel || channel === 'web' || !chatId) return;

        try {
            const { messagingGateway } = await import('./MessagingGateway');
            const status = messagingGateway.getProviderStatus(channel);
            if (!status?.connected) return;

            const { configManager } = await import('./ConfigManager');
            const fs = await import('fs');
            const path = await import('path');

            const workspaceDir = configManager.getWorkspaceDir();
            const MAX_SIZE = 50 * 1024 * 1024; // 50 MB — Telegram bot API limit

            for (const artifact of artifacts) {
                try {
                    // Resolve path: absolute if it starts with /, else relative to workspace
                    const fullPath = artifact.startsWith('/') ? artifact : path.join(workspaceDir, artifact);

                    if (!fs.existsSync(fullPath)) {
                        console.warn(`[Heartbeat] Artifact not found on disk: ${fullPath}`);
                        continue;
                    }

                    const stat = fs.statSync(fullPath);
                    if (stat.size > MAX_SIZE) {
                        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
                        await messagingGateway.sendMessage(channel, chatId, `📎 File too large to send via Telegram (${sizeMB} MB): ${path.basename(fullPath)}`);
                        continue;
                    }

                    const caption = `📎 ${path.basename(fullPath)}`;
                    await messagingGateway.sendFile(channel, chatId, fullPath, caption);
                    console.log(`[Heartbeat] Sent artifact to ${channel}: ${fullPath}`);
                } catch (e: any) {
                    console.warn(`[Heartbeat] Failed to send artifact "${artifact}": ${e.message}`);
                }
            }
        } catch (e: any) {
            console.warn(`[Heartbeat] sendArtifactsToChannel failed: ${e.message}`);
        }
    }

    private isActiveTime(date: Date): boolean {
        const hour = date.getHours();
        const minute = date.getMinutes();
        const currentTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        const { start, end } = this.config.activeHours;
        return currentTime >= start && currentTime <= end;
    }

    private getCronSchedule(): string {
        switch (this.config.interval) {
            case '15m': return '*/15 * * * *';
            case '30m': return '*/30 * * * *';
            case '1h':  return '0 * * * *';
            case '24h': return '0 9 * * *';
            default: return '*/30 * * * *';
        }
    }
}

// Module-level singleton reference — set by index.ts after construction.
// Any module can `import { heartbeatService } from './HeartbeatService'`
// without circular dependencies.
let _heartbeatInstance: HeartbeatService | null = null;

export function setHeartbeatInstance(instance: HeartbeatService): void {
    _heartbeatInstance = instance;
}

export { _heartbeatInstance as heartbeatService };
