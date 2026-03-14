/**
 * SlackProvider — Slack integration via @slack/bolt (Socket Mode).
 *
 * Uses Socket Mode so no public URL is required. Supports slash commands,
 * thread-based conversations, and file uploads.
 *
 * NOTE: Requires `@slack/bolt` package to be installed.
 * Install with: npm install @slack/bolt
 */

import { MessagingProvider, IncomingMessage, ProviderConfig, OutgoingMessage } from '../MessagingGateway';
import * as fs from 'fs';
import * as path from 'path';

export class SlackProvider implements MessagingProvider {
    name = 'slack';
    connected = false;
    private app: any = null;
    private messageCallback: ((msg: IncomingMessage) => void) | null = null;
    private botUserId: string = '';

    async connect(config: ProviderConfig): Promise<void> {
        try {
            // @ts-ignore — optional dependency
            const { App } = await import('@slack/bolt');

            this.app = new App({
                token: config.token,           // xoxb- Bot Token
                appToken: config.appToken,     // xapp- App-Level Token (for Socket Mode)
                socketMode: true,
            });

            // Listen for messages
            this.app.message(async ({ message, say }: any) => {
                if (!this.messageCallback) return;
                if (message.subtype) return; // Ignore bot messages, edits, etc.

                const incoming: IncomingMessage = {
                    id: message.ts || String(Date.now()),
                    provider: 'slack',
                    chatId: message.channel,
                    userId: message.user || '',
                    username: message.user || 'Unknown',
                    text: message.text || '',
                    timestamp: new Date(parseFloat(message.ts || '0') * 1000),
                    replyToId: message.thread_ts || undefined,
                };

                this.messageCallback(incoming);
            });

            // Slash command: /ai
            this.app.command('/ai', async ({ command, ack, respond }: any) => {
                await ack();

                if (!this.messageCallback) {
                    await respond('AI Partner is not ready.');
                    return;
                }

                const subcommand = command.text?.split(' ')[0]?.toLowerCase();
                const args = command.text?.substring(subcommand?.length || 0).trim();

                const incoming: IncomingMessage = {
                    id: command.trigger_id || String(Date.now()),
                    provider: 'slack',
                    chatId: command.channel_id,
                    userId: command.user_id,
                    username: command.user_name || 'Unknown',
                    text: subcommand === 'status'
                        ? '/status'
                        : subcommand === 'goal'
                            ? `[GOAL] ${args}`
                            : args || command.text || '',
                    timestamp: new Date(),
                };

                this.messageCallback(incoming);
            });

            // App mention (when someone @mentions the bot)
            this.app.event('app_mention', async ({ event }: any) => {
                if (!this.messageCallback) return;

                // Strip the bot mention from the text
                const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
                if (!text) return;

                const incoming: IncomingMessage = {
                    id: event.ts || String(Date.now()),
                    provider: 'slack',
                    chatId: event.channel,
                    userId: event.user || '',
                    username: event.user || 'Unknown',
                    text,
                    timestamp: new Date(parseFloat(event.ts || '0') * 1000),
                    replyToId: event.thread_ts || undefined,
                };

                this.messageCallback(incoming);
            });

            await this.app.start();

            // Get bot user ID for self-identification
            try {
                const authResult = await this.app.client.auth.test();
                this.botUserId = authResult.user_id || '';
            } catch { /* non-critical */ }

            this.connected = true;
            console.log('[SlackProvider] Connected via Socket Mode');
        } catch (error: any) {
            if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
                throw new Error('@slack/bolt is not installed. Run: npm install @slack/bolt');
            }
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.app) {
            await this.app.stop().catch(() => { });
            this.app = null;
        }
        this.connected = false;
        console.log('[SlackProvider] Disconnected');
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageCallback = handler;
    }

    async sendMessage(chatId: string, text: string, options?: Partial<OutgoingMessage>): Promise<void> {
        if (!this.app) throw new Error('Slack not connected');

        // Split long messages (Slack limit: 4000 chars per block)
        const chunks = this.splitMessage(text, 3900);

        for (const chunk of chunks) {
            await this.app.client.chat.postMessage({
                channel: chatId,
                text: chunk,
                thread_ts: options?.replyToId || undefined,
                mrkdwn: options?.parseMode !== 'text',
            });
        }
    }

    async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
        if (!this.app) throw new Error('Slack not connected');

        const content = fs.readFileSync(filePath);
        const filename = path.basename(filePath);

        await this.app.client.files.uploadV2({
            channel_id: chatId,
            file: content,
            filename,
            title: caption || filename,
        });
    }

    getStatus(): { connected: boolean; info?: any } {
        return {
            connected: this.connected,
            info: {
                botUserId: this.botUserId,
                socketMode: true,
            },
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
            let splitAt = remaining.lastIndexOf('\n', maxLength);
            if (splitAt <= 0) splitAt = maxLength;
            chunks.push(remaining.substring(0, splitAt));
            remaining = remaining.substring(splitAt).trimStart();
        }
        return chunks;
    }
}
