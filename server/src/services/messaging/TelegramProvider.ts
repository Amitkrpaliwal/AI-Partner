/**
 * TelegramProvider — Telegram Bot integration for AI Co-Worker.
 *
 * Uses the Telegram Bot API. Requires a bot token from @BotFather.
 * Supports text messages, file uploads, and slash commands.
 *
 * On connect: registers all commands with Telegram so users see a "/" menu,
 * and responds to /start with an onboarding message.
 *
 * NOTE: Requires `node-telegram-bot-api` package to be installed.
 * Install with: npm install node-telegram-bot-api
 */

import { MessagingProvider, IncomingMessage, ProviderConfig, OutgoingMessage } from '../MessagingGateway';
import { telegramHITLBridge } from '../TelegramHITLBridge';

export class TelegramProvider implements MessagingProvider {
    name = 'telegram';
    connected = false;
    private bot: any = null;
    private messageCallback: ((msg: IncomingMessage) => void) | null = null;
    // Cached set of agent command names (underscore form) for fast preprocessing lookup
    private agentCommandNames = new Set<string>();
    // Per-chat pending agent: when user sends /agentname with no task, hold slug until next message
    private pendingAgent = new Map<string, string>(); // chatId → slug

    async connect(config: ProviderConfig): Promise<void> {
        if (!config.token) {
            throw new Error('Telegram bot token is required. Get one from @BotFather');
        }

        try {
            // Lazy-load the telegram bot API
            const TelegramBot = (await import('node-telegram-bot-api')).default;
            this.bot = new TelegramBot(config.token, { polling: true });

            // Register command menu — appears when user types "/" in Telegram
            await this.registerCommands();

            // Handle /start — sent automatically when user first opens the bot
            this.bot.onText(/^\/start/, async (msg: any) => {
                const name = msg.from?.first_name || 'there';
                const welcome = [
                    `👋 Hi ${name}! I'm your AI Partner.`,
                    '',
                    'Just send me a message to chat, or use a command:',
                    '',
                    '🤖 *Run tasks*',
                    '`/goal <task>` — execute a multi-step autonomous task',
                    '`/mode auto` — switch to auto mode (I decide chat vs goal)',
                    '',
                    '🧑‍💼 *Specialist Agents*',
                    '`/agents` — list available specialist agents',
                    '`/agent <slug> <task>` — run task with a named agent',
                    '`@slug <task>` — inline agent mention (e.g. `@researcher find X`)',
                    '',
                    '🧠 *Memory & Knowledge*',
                    '`/memory <query>` — search what I remember',
                    '`/kb <query>` — search knowledge base',
                    '',
                    '🔧 *Models & Tools*',
                    '`/model` — show current model',
                    '`/model list` — browse all available models',
                    '`/model <id> <provider>` — switch model',
                    '',
                    '📊 *Status & Files*',
                    '`/status` — system status',
                    '`/files` — list generated files',
                    '`/cost` — token usage this session',
                    '`/skills` — list learned skills',
                    '',
                    '⏰ *Scheduling*',
                    '`/schedule` — show scheduled tasks',
                    '`/proactive` — toggle proactive mode',
                    '',
                    'Or just type anything to start a conversation!',
                ].join('\n');

                try {
                    await this.bot.sendMessage(String(msg.chat.id), welcome, { parse_mode: 'Markdown' });
                } catch {
                    // Markdown parse failed — send as plain text
                    const plain = welcome.replace(/[*_`[\]()]/g, '');
                    await this.bot.sendMessage(String(msg.chat.id), plain).catch(() => {});
                }
            });

            // Handle incoming messages
            this.bot.on('message', async (msg: any) => {
                if (!this.messageCallback) return;

                let text = msg.text || msg.caption || '';
                const attachments: IncomingMessage['attachments'] = [];

                // Detect Telegram attachment types
                try {
                    if (msg.voice) {
                        const file = await this.bot.getFile(msg.voice.file_id);
                        attachments.push({
                            type: 'audio',
                            url: `https://api.telegram.org/file/bot${config.token}/${file.file_path}`,
                            name: 'voice_message.ogg',
                        });
                    }
                    if (msg.audio) {
                        const file = await this.bot.getFile(msg.audio.file_id);
                        attachments.push({
                            type: 'audio',
                            url: `https://api.telegram.org/file/bot${config.token}/${file.file_path}`,
                            name: msg.audio.file_name || 'audio.mp3',
                        });
                    }
                    if (msg.document) {
                        const file = await this.bot.getFile(msg.document.file_id);
                        attachments.push({
                            type: 'file',
                            url: `https://api.telegram.org/file/bot${config.token}/${file.file_path}`,
                            name: msg.document.file_name || 'document',
                        });
                    }
                    if (msg.photo && msg.photo.length > 0) {
                        // Get highest resolution photo
                        const photo = msg.photo[msg.photo.length - 1];
                        const file = await this.bot.getFile(photo.file_id);
                        attachments.push({
                            type: 'image',
                            url: `https://api.telegram.org/file/bot${config.token}/${file.file_path}`,
                            name: 'photo.jpg',
                        });
                    }
                    if (msg.video) {
                        const file = await this.bot.getFile(msg.video.file_id);
                        attachments.push({
                            type: 'video',
                            url: `https://api.telegram.org/file/bot${config.token}/${file.file_path}`,
                            name: msg.video.file_name || 'video.mp4',
                        });
                    }
                } catch (e: any) {
                    console.warn('[TelegramProvider] Failed to get file info:', e.message);
                }

                // Skip if no text and no attachments, or if handled by a specific command listener
                if (!text && attachments.length === 0) return;
                if (text === '/start') return; // handled by onText above

                // Check if this is a reply to a HITL input request — if so, resolve it directly
                if (text && telegramHITLBridge.handleTextReply(msg)) return;

                // Rewrite agent shortcut commands: /web_researcher task → @web-researcher task
                // Telegram commands use underscores; agent slugs use hyphens.
                // The active agent persists for all subsequent messages in this chat until
                // the user issues a different /command or a plain @mention.
                const chatId = String(msg.chat.id);
                if (text) {
                    const agentCmdMatch = text.match(/^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
                    if (agentCmdMatch) {
                        const cmdName = agentCmdMatch[1].toLowerCase();
                        if (this.agentCommandNames.has(cmdName)) {
                            const slug = cmdName.replace(/_/g, '-');
                            const task = (agentCmdMatch[2] || '').trim();
                            // Always set this agent as active for ALL future messages in this chat
                            this.pendingAgent.set(chatId, slug);
                            if (task) {
                                // Task included inline — rewrite immediately
                                text = `@${slug} ${task}`;
                            } else {
                                // No task — prompt the user; next message will be prefixed
                                await this.bot.sendMessage(chatId,
                                    `🤖 *@${slug}* is ready.\nSend your task now:`,
                                    { parse_mode: 'Markdown' }
                                );
                                return; // don't pass this non-message to the callback
                            }
                        } else {
                            // Non-agent /command (e.g. /start, /help) — clear active agent
                            this.pendingAgent.delete(chatId);
                        }
                    } else if (this.pendingAgent.has(chatId) && !text.startsWith('@')) {
                        // Route plain message to the active agent — keep it active (do NOT delete)
                        const slug = this.pendingAgent.get(chatId)!;
                        text = `@${slug} ${text}`;
                    }
                }

                const incoming: IncomingMessage = {
                    id: String(msg.message_id),
                    provider: 'telegram',
                    chatId: String(msg.chat.id),
                    userId: String(msg.from?.id || 'unknown'),
                    username: msg.from?.username || msg.from?.first_name || 'Unknown',
                    text: text || `[${attachments.length} file(s) attached]`,
                    timestamp: new Date(msg.date * 1000),
                    replyToId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
                    attachments: attachments.length > 0 ? attachments : undefined,
                };

                this.messageCallback(incoming);
            });

            // Handle HITL inline button taps (approve/reject/skip)
            this.bot.on('callback_query', async (query: any) => {
                const handled = await telegramHITLBridge.handleCallbackQuery(query);
                if (!handled) {
                    // Unknown button — just acknowledge to stop the loading spinner
                    await this.bot.answerCallbackQuery(query.id).catch(() => { /* ignored */ });
                }
            });

            // Handle errors — 409 Conflict means a duplicate polling instance exists (two bot
            // connections with the same token). Log clearly but don't crash.
            this.bot.on('polling_error', (error: any) => {
                if (error?.response?.statusCode === 409 || error?.message?.includes('409')) {
                    console.error('[TelegramProvider] 409 Conflict — duplicate polling instance. Check for duplicate bot connections.');
                } else {
                    console.error('[TelegramProvider] Polling error:', error.message);
                }
            });

            // Wire HITL bridge — must happen after bot is ready
            telegramHITLBridge.setBot(this.bot);

            this.connected = true;
            console.log('[TelegramProvider] Connected successfully');
        } catch (error: any) {
            if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
                throw new Error('node-telegram-bot-api is not installed. Run: npm install node-telegram-bot-api');
            }
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.bot) {
            await this.bot.stopPolling();
            this.bot = null;
            telegramHITLBridge.setBot(null);
        }
        this.connected = false;
        console.log('[TelegramProvider] Disconnected');
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageCallback = handler;
    }

    async sendMessage(chatId: string, text: string, options?: Partial<OutgoingMessage>): Promise<void> {
        if (!this.bot) throw new Error('Telegram bot not connected');

        // Telegram limits messages to 4096 chars
        const chunks = this.splitMessage(text, 4096);
        for (const chunk of chunks) {
            try {
                await this.bot.sendMessage(chatId, chunk, {
                    parse_mode: options?.parseMode === 'html' ? 'HTML' : 'Markdown',
                    reply_to_message_id: options?.replyToId ? parseInt(options.replyToId) : undefined,
                });
            } catch (e: any) {
                // Markdown parsing often fails with complex LLM output — retry as plain text
                if (e.message?.includes('parse') || e.message?.includes('entities') || e.response?.statusCode === 400) {
                    console.warn('[TelegramProvider] Markdown parse failed, sending as plain text');
                    await this.bot.sendMessage(chatId, chunk, {
                        reply_to_message_id: options?.replyToId ? parseInt(options.replyToId) : undefined,
                    });
                } else {
                    throw e;
                }
            }
        }
    }

    async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
        if (!this.bot) throw new Error('Telegram bot not connected');
        await this.bot.sendDocument(chatId, path, { caption });
    }

    getStatus(): { connected: boolean; info?: any } {
        return {
            connected: this.connected,
            info: this.bot ? { polling: true } : undefined,
        };
    }

    /**
     * Register the bot's command list with Telegram.
     * Static system commands are always present. Agent profiles are appended
     * dynamically from the DB so the "/" menu reflects current profile list.
     * Telegram command names use underscores; slugs use hyphens — we convert.
     * Called on connect and after any profile seed/create/delete.
     */
    async registerCommands(): Promise<void> {
        if (!this.bot) return;
        try {
            const staticCommands = [
                { command: 'start',     description: 'Show welcome message & command list' },
                { command: 'help',      description: 'List all available commands' },
                { command: 'status',    description: 'System status — model, providers, memory' },
                { command: 'goal',      description: 'Run an autonomous task: /goal <task description>' },
                { command: 'agents',    description: 'List available specialist agents (@slug)' },
                { command: 'agent',     description: 'Route to a specialist: /agent <slug> <task>' },
                { command: 'model',     description: 'Show or switch model: /model list | /model <id> <provider>' },
                { command: 'memory',    description: 'Search memory: /memory <query>' },
                { command: 'kb',        description: 'Search knowledge base: /kb <query>' },
                { command: 'files',     description: 'List recently generated files' },
                { command: 'skills',    description: 'List learned skills' },
                { command: 'cost',      description: 'Show token usage and estimated cost' },
                { command: 'schedule',  description: 'Show scheduled / proactive tasks' },
                { command: 'mode',      description: 'Set chat mode: /mode chat | auto | goal' },
            ];

            // Dynamically append agent profiles — slug hyphens → underscores for Telegram
            let agentCommands: { command: string; description: string }[] = [];
            try {
                const { db } = await import('../../database');
                const profiles: any[] = await db.all(
                    'SELECT slug, role FROM agent_profiles ORDER BY created_at ASC'
                );
                this.agentCommandNames.clear();
                agentCommands = profiles.map(p => {
                    const cmdName = p.slug.replace(/-/g, '_');
                    this.agentCommandNames.add(cmdName);
                    const desc = (p.role || 'Specialist agent').substring(0, 64);
                    return { command: cmdName, description: desc };
                });
            } catch {
                // DB not ready yet — agent commands skipped, static commands still registered
            }

            // Telegram caps at 100 commands total
            const all = [...staticCommands, ...agentCommands].slice(0, 100);
            await this.bot.setMyCommands(all);
            console.log(`[TelegramProvider] Command menu registered (${staticCommands.length} system + ${agentCommands.length} agents)`);
        } catch (e: any) {
            console.warn('[TelegramProvider] Failed to register commands:', e.message);
        }
    }

    /**
     * Refresh the Telegram "/" command menu after profiles are added or removed.
     * Called from agentProfileRoutes after seed/create/delete.
     */
    async refreshAgentCommands(): Promise<void> {
        await this.registerCommands();
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
            // Try to split at a newline
            let splitIndex = remaining.lastIndexOf('\n', maxLength);
            if (splitIndex <= 0) splitIndex = maxLength;
            chunks.push(remaining.substring(0, splitIndex));
            remaining = remaining.substring(splitIndex);
        }
        return chunks;
    }
}
