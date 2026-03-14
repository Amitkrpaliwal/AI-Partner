/**
 * DiscordProvider — Discord Bot integration for AI Co-Worker.
 *
 * Responds in designated channels or DMs.
 * Supports text messages and file attachments.
 *
 * NOTE: Requires `discord.js` package to be installed.
 * Install with: npm install discord.js
 */

import { MessagingProvider, IncomingMessage, ProviderConfig, OutgoingMessage } from '../MessagingGateway';

export class DiscordProvider implements MessagingProvider {
    name = 'discord';
    connected = false;
    private client: any = null;
    private messageCallback: ((msg: IncomingMessage) => void) | null = null;

    async connect(config: ProviderConfig): Promise<void> {
        if (!config.token) {
            throw new Error('Discord bot token is required');
        }

        try {
            const { Client, GatewayIntentBits } = await import('discord.js');
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.DirectMessages,
                ]
            });

            this.client.on('messageCreate', (msg: any) => {
                // Ignore bot's own messages
                if (msg.author.bot) return;
                if (!this.messageCallback) return;

                // Only respond if mentioned or in DM
                const isMentioned = msg.mentions.has(this.client.user);
                const isDM = !msg.guild;
                if (!isMentioned && !isDM) return;

                // Remove mention from text
                const text = msg.content.replace(/<@!?\d+>/g, '').trim();

                // Parse attachments
                const attachments: IncomingMessage['attachments'] = [];
                if (msg.attachments?.size > 0) {
                    for (const [, att] of msg.attachments) {
                        const contentType = att.contentType || '';
                        let type: 'image' | 'file' | 'audio' | 'video' = 'file';
                        if (contentType.startsWith('image/')) type = 'image';
                        else if (contentType.startsWith('audio/')) type = 'audio';
                        else if (contentType.startsWith('video/')) type = 'video';

                        attachments.push({
                            type,
                            url: att.url,
                            name: att.name || 'attachment',
                        });
                    }
                }

                // Skip if no text and no attachments
                if (!text && attachments.length === 0) return;

                const incoming: IncomingMessage = {
                    id: msg.id,
                    provider: 'discord',
                    chatId: msg.channel.id,
                    userId: msg.author.id,
                    username: msg.author.username,
                    text: text || `[${attachments.length} file(s) attached]`,
                    timestamp: msg.createdAt,
                    attachments: attachments.length > 0 ? attachments : undefined,
                };

                this.messageCallback(incoming);
            });

            await this.client.login(config.token);
            this.connected = true;
            console.log(`[DiscordProvider] Connected as ${this.client.user?.tag}`);
        } catch (error: any) {
            if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
                throw new Error('discord.js is not installed. Run: npm install discord.js');
            }
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
            this.client = null;
        }
        this.connected = false;
        console.log('[DiscordProvider] Disconnected');
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageCallback = handler;
    }

    async sendMessage(chatId: string, text: string, _options?: Partial<OutgoingMessage>): Promise<void> {
        if (!this.client) throw new Error('Discord bot not connected');

        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('send' in channel)) {
            throw new Error(`Cannot send to channel ${chatId}`);
        }

        // Discord limits messages to 2000 chars
        const chunks = this.splitMessage(text, 2000);
        for (const chunk of chunks) {
            await (channel as any).send(chunk);
        }
    }

    async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
        if (!this.client) throw new Error('Discord bot not connected');

        const channel = await this.client.channels.fetch(chatId);
        if (!channel || !('send' in channel)) {
            throw new Error(`Cannot send to channel ${chatId}`);
        }

        await (channel as any).send({
            content: caption || '',
            files: [path]
        });
    }

    getStatus(): { connected: boolean; info?: any } {
        return {
            connected: this.connected,
            info: this.client?.user ? { tag: this.client.user.tag, guilds: this.client.guilds?.cache.size } : undefined,
        };
    }

    private splitMessage(text: string, maxLength: number): string[] {
        if (text.length <= maxLength) return [text];
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }
            let splitIndex = remaining.lastIndexOf('\n', maxLength);
            if (splitIndex <= 0) splitIndex = maxLength;
            chunks.push(remaining.substring(0, splitIndex));
            remaining = remaining.substring(splitIndex);
        }
        return chunks;
    }
}
