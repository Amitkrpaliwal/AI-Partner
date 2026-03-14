/**
 * MessagingServer — Proactive send/status tools for all connected messaging platforms.
 *
 * Backed by MessagingGateway, which already powers Telegram, Discord, and WhatsApp.
 * This server exposes those capabilities as MCP tools so the LLM can use them
 * in chat, in goal mode, and from HeartbeatService.
 *
 * Tools:
 *   messaging_send        — Send text to telegram / discord / whatsapp
 *   messaging_send_file   — Upload a workspace file to telegram / discord / whatsapp
 *   messaging_status      — List all connected messaging platforms + last seen chatId
 *
 * chat_id resolution (in order):
 *   1. Caller supplies explicit chat_id
 *   2. Fall back to last seen chatId for that provider (auto-tracked on incoming messages)
 *   3. Fall back to heartbeat config channelChatId (for providers with no inbound yet)
 */

class MessagingServer {
    isAvailable(): boolean {
        // Always available — tools gracefully report "not connected" when providers are absent
        return true;
    }

    getTools() {
        return [
            {
                name: 'messaging_send',
                description:
                    'Send a text message to a connected messaging platform (telegram, discord, or whatsapp). ' +
                    'If chat_id is omitted, the last known chat with that platform is used automatically.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        platform: {
                            type: 'string',
                            enum: ['telegram', 'discord', 'whatsapp'],
                            description: 'Target platform'
                        },
                        text: {
                            type: 'string',
                            description: 'Message text to send (markdown supported on Telegram/Discord)'
                        },
                        chat_id: {
                            type: 'string',
                            description: 'Chat / channel ID to send to. Omit to use the last known chat.'
                        }
                    },
                    required: ['platform', 'text']
                }
            },
            {
                name: 'messaging_send_file',
                description:
                    'Upload a file from the workspace to a connected messaging platform. ' +
                    'IMPORTANT: The file must exist before calling this tool — create it first with write_file or run_command. ' +
                    'Small text/markdown files (≤ 8 KB) are automatically sent as formatted text messages instead of documents. ' +
                    'Telegram limit: 50 MB per file.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        platform: {
                            type: 'string',
                            enum: ['telegram', 'discord', 'whatsapp'],
                            description: 'Target platform'
                        },
                        file_path: {
                            type: 'string',
                            description: 'Path to the file — use /workspace/output/filename.ext. Relative paths are auto-resolved to /workspace/.'
                        },
                        caption: {
                            type: 'string',
                            description: 'Optional caption shown with the file'
                        },
                        chat_id: {
                            type: 'string',
                            description: 'Chat / channel ID. Omit to use the last known chat.'
                        }
                    },
                    required: ['platform', 'file_path']
                }
            },
            {
                name: 'messaging_status',
                description:
                    'List all registered messaging platforms, their connection status, and the last known chat ID. ' +
                    'Use this before messaging_send when you are unsure which platforms are connected.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {}
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        try {
            switch (name) {
                case 'messaging_send':
                    return await this.send(args);
                case 'messaging_send_file':
                    return await this.sendFile(args);
                case 'messaging_status':
                    return await this.status();
                default:
                    return { success: false, error: `Unknown messaging tool: ${name}` };
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private async resolveGateway() {
        const { messagingGateway } = await import('../../services/MessagingGateway');
        return messagingGateway;
    }

    private async resolveChatId(gateway: any, platform: string, explicit?: string): Promise<string> {
        // 1. Explicit override
        if (explicit) return explicit;

        // 2. Last seen from inbound message
        const lastSeen = gateway.getLastChatId(platform);
        if (lastSeen) return lastSeen;

        // 3. Heartbeat config fallback
        const { configManager } = await import('../../services/ConfigManager');
        const cfg = configManager.getConfig() as any;
        const heartbeatChatId = cfg.heartbeat?.channelChatId;
        if (heartbeatChatId && (cfg.heartbeat?.preferredChannel === platform || !cfg.heartbeat?.preferredChannel)) {
            return heartbeatChatId;
        }

        throw new Error(
            `No chat_id available for ${platform}. ` +
            `Either supply chat_id explicitly, or send a message to the bot first so it can remember your chat ID.`
        );
    }

    private async send(args: any): Promise<any> {
        const { platform, text, chat_id } = args;
        const gateway = await this.resolveGateway();

        const status = gateway.getProviderStatus(platform);
        if (!status) {
            return { success: false, error: `Platform "${platform}" is not registered. Check that the bot token is configured.` };
        }
        if (!status.connected) {
            return { success: false, error: `Platform "${platform}" is registered but not connected. Check the token and restart.` };
        }

        const resolvedChatId = await this.resolveChatId(gateway, platform, chat_id);
        await gateway.sendMessage(platform, resolvedChatId, text);

        // Write a receipt file so llm_evaluates and file_exists criteria can confirm
        // the message was sent (tool calls aren't visible to the validator otherwise).
        // Use the goal-specific output dir when available; fall back to workspace root.
        const receiptPath = '/workspace/telegram-receipt.txt';
        try {
            const fs = await import('fs/promises');
            const receipt = `platform: ${platform}\nchat_id: ${resolvedChatId}\ntimestamp: ${new Date().toISOString()}\nmessage:\n${text}`;
            await fs.writeFile(receiptPath, receipt, 'utf-8');
        } catch { /* non-fatal — receipt is best-effort */ }

        return {
            success: true,
            platform,
            chat_id: resolvedChatId,
            receipt_file: receiptPath,
            message: `Message sent to ${platform} (chat ${resolvedChatId}). Receipt written to ${receiptPath}`
        };
    }

    private normalizePath(filePath: string): string {
        if (!filePath) return filePath;
        const p = filePath.replace(/\\/g, '/').trim();
        // Relative paths → prepend /workspace
        if (!p.startsWith('/')) return `/workspace/${p}`;
        // output/... shorthand (no leading slash already handled above)
        return p;
    }

    private async sendFile(args: any): Promise<any> {
        const { platform, caption, chat_id } = args;
        const file_path = this.normalizePath(args.file_path);

        const gateway = await this.resolveGateway();

        const status = gateway.getProviderStatus(platform);
        if (!status?.connected) {
            return { success: false, error: `Platform "${platform}" is not connected.` };
        }

        // ── PRE-FLIGHT: verify file exists and is within size limits ──────────
        const fs = await import('fs/promises');
        let fileSize = 0;
        try {
            const stat = await fs.stat(file_path);
            fileSize = stat.size;
        } catch {
            return {
                success: false,
                error: `File not found at: ${file_path}. ` +
                    `Create the file first with write_file or run_command, then call messaging_send_file.`
            };
        }

        // Telegram bot upload limit is 50 MB
        const TELEGRAM_MAX_BYTES = 50 * 1024 * 1024;
        if (platform === 'telegram' && fileSize > TELEGRAM_MAX_BYTES) {
            return {
                success: false,
                error: `File too large for Telegram (${Math.round(fileSize / 1024 / 1024)} MB, limit 50 MB). ` +
                    `Compress the file or split it into smaller parts.`
            };
        }

        // ── AUTO TEXT FALLBACK: small text files send better as formatted messages ──
        // Avoids the document download step for short reports/summaries.
        const TEXT_EXTS = new Set(['md', 'txt', 'csv', 'json', 'yaml', 'yml', 'log']);
        const ext = file_path.split('.').pop()?.toLowerCase() ?? '';
        const TEXT_FALLBACK_MAX = 8 * 1024; // 8 KB
        if (TEXT_EXTS.has(ext) && fileSize <= TEXT_FALLBACK_MAX) {
            try {
                const content = await fs.readFile(file_path, 'utf-8');
                const header = caption ? `*${caption}*\n\n` : '';
                const resolvedChatId = await this.resolveChatId(gateway, platform, chat_id);
                await gateway.sendMessage(platform, resolvedChatId, `${header}${content}`);

                const receiptPath = '/workspace/telegram-file-receipt.txt';
                const receipt = `platform: ${platform}\nchat_id: ${resolvedChatId}\ntimestamp: ${new Date().toISOString()}\nfile: ${file_path}\nsize_bytes: ${fileSize}\nmethod: text_fallback`;
                await fs.writeFile(receiptPath, receipt, 'utf-8').catch(() => {});

                return {
                    success: true,
                    platform,
                    chat_id: resolvedChatId,
                    file: file_path,
                    method: 'text_fallback',
                    receipt_file: receiptPath,
                    message: `File content sent as text to ${platform} (${fileSize} bytes). Receipt at ${receiptPath}`
                };
            } catch { /* fall through to document upload */ }
        }

        // ── DOCUMENT UPLOAD ───────────────────────────────────────────────────
        const resolvedChatId = await this.resolveChatId(gateway, platform, chat_id);
        await gateway.sendFile(platform, resolvedChatId, file_path, caption);

        // Write receipt so file_exists / llm_evaluates criteria can confirm delivery
        const receiptPath = '/workspace/telegram-file-receipt.txt';
        try {
            const receipt = `platform: ${platform}\nchat_id: ${resolvedChatId}\ntimestamp: ${new Date().toISOString()}\nfile: ${file_path}\nsize_bytes: ${fileSize}\ncaption: ${caption ?? ''}`;
            await fs.writeFile(receiptPath, receipt, 'utf-8');
        } catch { /* non-fatal */ }

        return {
            success: true,
            platform,
            chat_id: resolvedChatId,
            file: file_path,
            file_size_bytes: fileSize,
            receipt_file: receiptPath,
            message: `File sent to ${platform} (chat ${resolvedChatId}, ${Math.round(fileSize / 1024)} KB). Receipt at ${receiptPath}`
        };
    }

    private async status(): Promise<any> {
        const gateway = await this.resolveGateway();
        const allStatus = gateway.getStatus();
        const names = gateway.getProviderNames();

        const platforms = names.map(name => ({
            platform: name,
            connected: allStatus[name]?.connected ?? false,
            last_chat_id: gateway.getLastChatId(name) ?? null,
            info: allStatus[name]?.info ?? null
        }));

        const connected = platforms.filter(p => p.connected);
        return {
            success: true,
            platforms,
            connected_count: connected.length,
            summary: connected.length === 0
                ? 'No messaging platforms connected. Configure a bot token in Settings → Integrations.'
                : `Connected: ${connected.map(p => p.platform).join(', ')}`
        };
    }
}

export const messagingServer = new MessagingServer();
