import { EventEmitter } from 'events';
import { agentOrchestrator } from '../services/AgentOrchestrator';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ChatMessage {
    id: string;
    channelId: string;
    userId: string;
    userName: string;
    content: string;
    platform: 'discord' | 'telegram' | 'web';
    timestamp: Date;
    replyTo?: string; // ID of message being replied to
    attachments?: string[]; // URLs of attached files
}

export interface ChatChannel {
    id: string;
    name: string;
    platform: 'discord' | 'telegram' | 'web';
    type: 'dm' | 'group' | 'channel';
}

export interface AdapterConfig {
    enabled: boolean;
    token?: string;
    botUsername?: string;
    allowedUsers?: string[]; // Empty = allow all
    allowedChannels?: string[]; // Empty = allow all
}

export interface ChatAdapter {
    readonly platform: string;
    initialize(config: AdapterConfig): Promise<boolean>;
    shutdown(): Promise<void>;
    sendMessage(channelId: string, content: string, replyTo?: string): Promise<void>;
    isConnected(): boolean;
    on(event: 'message', handler: (msg: ChatMessage) => void): void;
    on(event: 'error', handler: (error: Error) => void): void;
}

// ============================================================================
// BASE ADAPTER
// ============================================================================

export abstract class BaseChatAdapter extends EventEmitter implements ChatAdapter {
    abstract readonly platform: string;
    protected config: AdapterConfig | null = null;
    protected connected = false;

    abstract initialize(config: AdapterConfig): Promise<boolean>;
    abstract shutdown(): Promise<void>;
    abstract sendMessage(channelId: string, content: string, replyTo?: string): Promise<void>;

    isConnected(): boolean {
        return this.connected;
    }

    protected isUserAllowed(userId: string): boolean {
        if (!this.config?.allowedUsers || this.config.allowedUsers.length === 0) {
            return true;
        }
        return this.config.allowedUsers.includes(userId);
    }

    protected isChannelAllowed(channelId: string): boolean {
        if (!this.config?.allowedChannels || this.config.allowedChannels.length === 0) {
            return true;
        }
        return this.config.allowedChannels.includes(channelId);
    }
}

// ============================================================================
// DISCORD ADAPTER
// ============================================================================

export class DiscordAdapter extends BaseChatAdapter {
    readonly platform = 'discord';
    private client: any = null;
    private discordJs: any = null;

    async initialize(config: AdapterConfig): Promise<boolean> {
        if (!config.enabled || !config.token) {
            console.log('[DiscordAdapter] Disabled or no token provided');
            return false;
        }

        this.config = config;

        try {
            // Dynamic import discord.js
            this.discordJs = await import('discord.js');
            const { Client, GatewayIntentBits } = this.discordJs;

            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.DirectMessages
                ]
            });

            this.client.on('ready', () => {
                console.log(`[DiscordAdapter] Logged in as ${this.client.user?.tag}`);
                this.connected = true;
            });

            this.client.on('messageCreate', async (message: any) => {
                // Ignore own messages
                if (message.author.bot) return;

                // Check permissions
                if (!this.isUserAllowed(message.author.id)) return;
                if (!this.isChannelAllowed(message.channel.id)) return;

                // Only respond to mentions or DMs
                const isMention = message.mentions.users.has(this.client.user?.id);
                const isDM = message.channel.type === 1; // DM channel

                if (!isMention && !isDM) return;

                const chatMsg: ChatMessage = {
                    id: message.id,
                    channelId: message.channel.id,
                    userId: message.author.id,
                    userName: message.author.username,
                    content: message.content.replace(`<@${this.client.user?.id}>`, '').trim(),
                    platform: 'discord',
                    timestamp: message.createdAt,
                    attachments: message.attachments.map((a: any) => a.url)
                };

                this.emit('message', chatMsg);
            });

            this.client.on('error', (error: Error) => {
                console.error('[DiscordAdapter] Error:', error);
                this.emit('error', error);
            });

            await this.client.login(config.token);
            console.log('[DiscordAdapter] Initialized successfully');
            return true;

        } catch (e: any) {
            console.error('[DiscordAdapter] Failed to initialize:', e.message);
            if (e.message.includes("Cannot find module 'discord.js'")) {
                console.log('[DiscordAdapter] Install discord.js: npm install discord.js');
            }
            return false;
        }
    }

    async shutdown(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
            this.client = null;
            this.connected = false;
            console.log('[DiscordAdapter] Shutdown complete');
        }
    }

    async sendMessage(channelId: string, content: string, replyTo?: string): Promise<void> {
        if (!this.client || !this.connected) {
            throw new Error('Discord client not connected');
        }

        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !channel.send) {
            throw new Error(`Channel ${channelId} not found or not text-based`);
        }

        // Split long messages (Discord has 2000 char limit)
        const chunks = this.splitMessage(content, 2000);
        for (const chunk of chunks) {
            if (replyTo && chunks.indexOf(chunk) === 0) {
                await channel.send({ content: chunk, reply: { messageReference: replyTo } });
            } else {
                await channel.send(chunk);
            }
        }
    }

    private splitMessage(content: string, maxLength: number): string[] {
        if (content.length <= maxLength) return [content];

        const chunks: string[] = [];
        let remaining = content;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            // Find last newline or space within limit
            let splitPoint = remaining.lastIndexOf('\n', maxLength);
            if (splitPoint === -1) splitPoint = remaining.lastIndexOf(' ', maxLength);
            if (splitPoint === -1) splitPoint = maxLength;

            chunks.push(remaining.substring(0, splitPoint));
            remaining = remaining.substring(splitPoint).trimStart();
        }

        return chunks;
    }
}

// ============================================================================
// TELEGRAM ADAPTER
// ============================================================================

export class TelegramAdapter extends BaseChatAdapter {
    readonly platform = 'telegram';
    private bot: any = null;

    async initialize(config: AdapterConfig): Promise<boolean> {
        if (!config.enabled || !config.token) {
            console.log('[TelegramAdapter] Disabled or no token provided');
            return false;
        }

        this.config = config;

        try {
            // Dynamic import node-telegram-bot-api
            const TelegramBot = (await import('node-telegram-bot-api')).default;

            this.bot = new TelegramBot(config.token, { polling: true });

            this.bot.on('message', async (msg: any) => {
                // Check permissions
                if (!this.isUserAllowed(String(msg.from.id))) return;
                if (!this.isChannelAllowed(String(msg.chat.id))) return;

                const chatMsg: ChatMessage = {
                    id: String(msg.message_id),
                    channelId: String(msg.chat.id),
                    userId: String(msg.from.id),
                    userName: msg.from.username || msg.from.first_name || 'Unknown',
                    content: msg.text || '',
                    platform: 'telegram',
                    timestamp: new Date(msg.date * 1000),
                    replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined
                };

                this.emit('message', chatMsg);
            });

            this.bot.on('polling_error', (error: any) => {
                // 409 Conflict = another bot instance is already polling (duplicate connection).
                // Log and swallow — do not re-emit as 'error' which would be an unhandled rejection.
                if (error?.response?.statusCode === 409 || error?.message?.includes('409')) {
                    console.error('[TelegramAdapter] 409 Conflict — duplicate polling instance detected. Check for duplicate bot connections.');
                } else {
                    console.error('[TelegramAdapter] Polling error:', error.message);
                    this.emit('error', error);
                }
            });

            this.connected = true;
            console.log('[TelegramAdapter] Initialized successfully');
            return true;

        } catch (e: any) {
            console.error('[TelegramAdapter] Failed to initialize:', e.message);
            if (e.message.includes("Cannot find module 'node-telegram-bot-api'")) {
                console.log('[TelegramAdapter] Install: npm install node-telegram-bot-api');
            }
            return false;
        }
    }

    async shutdown(): Promise<void> {
        if (this.bot) {
            await this.bot.stopPolling();
            this.bot = null;
            this.connected = false;
            console.log('[TelegramAdapter] Shutdown complete');
        }
    }

    async sendMessage(channelId: string, content: string, replyTo?: string): Promise<void> {
        if (!this.bot || !this.connected) {
            throw new Error('Telegram bot not connected');
        }

        const options: any = {
            parse_mode: 'Markdown'
        };

        if (replyTo) {
            options.reply_to_message_id = parseInt(replyTo);
        }

        // Telegram has 4096 char limit
        const chunks = this.splitMessage(content, 4096);
        for (const chunk of chunks) {
            try {
                await this.bot.sendMessage(channelId, chunk, options);
            } catch (e: any) {
                // Markdown parsing often fails with complex LLM output — retry as plain text
                if (e.message?.includes('parse') || e.message?.includes('entities') || e.response?.statusCode === 400) {
                    console.warn('[TelegramAdapter] Markdown parse failed, sending as plain text');
                    const plainOptions: any = {};
                    if (replyTo) plainOptions.reply_to_message_id = parseInt(replyTo);
                    await this.bot.sendMessage(channelId, chunk, plainOptions);
                } else {
                    throw e;
                }
            }
        }
    }

    private splitMessage(content: string, maxLength: number): string[] {
        if (content.length <= maxLength) return [content];

        const chunks: string[] = [];
        let remaining = content;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            let splitPoint = remaining.lastIndexOf('\n', maxLength);
            if (splitPoint === -1) splitPoint = remaining.lastIndexOf(' ', maxLength);
            if (splitPoint === -1) splitPoint = maxLength;

            chunks.push(remaining.substring(0, splitPoint));
            remaining = remaining.substring(splitPoint).trimStart();
        }

        return chunks;
    }
}

// ============================================================================
// CHAT ROUTER
// ============================================================================

export class ChatRouter extends EventEmitter {
    private adapters: Map<string, ChatAdapter> = new Map();
    private conversationMap: Map<string, string> = new Map(); // channelId -> conversationId

    async registerAdapter(adapter: ChatAdapter, config: AdapterConfig): Promise<boolean> {
        const success = await adapter.initialize(config);
        if (success) {
            this.adapters.set(adapter.platform, adapter);

            adapter.on('message', async (msg: ChatMessage) => {
                await this.handleIncomingMessage(msg);
            });

            adapter.on('error', (error: Error) => {
                console.error(`[ChatRouter] Error from ${adapter.platform}:`, error);
            });

            console.log(`[ChatRouter] Registered adapter: ${adapter.platform}`);
        }
        return success;
    }

    private async handleIncomingMessage(msg: ChatMessage): Promise<void> {
        console.log(`[ChatRouter] Received from ${msg.platform} (${msg.userName}): ${msg.content.substring(0, 100)}`);

        try {
            // Get or create conversation for this channel
            let conversationId = this.conversationMap.get(msg.channelId);
            if (!conversationId) {
                conversationId = `chat_${msg.platform}_${msg.channelId}`;
                this.conversationMap.set(msg.channelId, conversationId);
            }

            // Send to orchestrator
            const response = await agentOrchestrator.chat(
                `${msg.platform}_${msg.userId}`,
                msg.content,
                conversationId
            );

            // Send response back
            const adapter = this.adapters.get(msg.platform);
            // AgentOrchestrator returns { response: string }, not { content: string }
            if (adapter && response.response) {
                await adapter.sendMessage(msg.channelId, response.response, msg.id);
            }

        } catch (error: any) {
            console.error('[ChatRouter] Failed to handle message:', error);

            // Send error response
            const adapter = this.adapters.get(msg.platform);
            if (adapter) {
                try {
                    await adapter.sendMessage(
                        msg.channelId,
                        `Sorry, I encountered an error: ${error.message}`,
                        msg.id
                    );
                } catch (e) {
                    // Ignore send errors
                }
            }
        }
    }

    async shutdown(): Promise<void> {
        for (const [platform, adapter] of this.adapters.entries()) {
            try {
                await adapter.shutdown();
                console.log(`[ChatRouter] Shutdown adapter: ${platform}`);
            } catch (e) {
                console.error(`[ChatRouter] Error shutting down ${platform}:`, e);
            }
        }
        this.adapters.clear();
    }

    getStatus(): { platform: string; connected: boolean }[] {
        return Array.from(this.adapters.entries()).map(([platform, adapter]) => ({
            platform,
            connected: adapter.isConnected()
        }));
    }
}

// Singleton instance
export const chatRouter = new ChatRouter();
