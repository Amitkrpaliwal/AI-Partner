/**
 * WhatsAppProvider — WhatsApp integration via Baileys (open-source WhatsApp Web API).
 *
 * Uses QR code scanning for authentication. Supports text messages and file sharing.
 *
 * NOTE: Requires `@whiskeysockets/baileys` package to be installed.
 * Install with: npm install @whiskeysockets/baileys
 */

import { MessagingProvider, IncomingMessage, ProviderConfig, OutgoingMessage } from '../MessagingGateway';
import * as path from 'path';
import { createLogger } from '../../utils/Logger';

const log = createLogger('WhatsAppProvider');

export class WhatsAppProvider implements MessagingProvider {
    name = 'whatsapp';
    connected = false;
    private sock: any = null;
    private messageCallback: ((msg: IncomingMessage) => void) | null = null;
    private authDir: string = '';
    private reconnectAttempts: number = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 10;
    private readonly BASE_RECONNECT_DELAY_MS = 2000;

    async connect(config: ProviderConfig): Promise<void> {
        try {
            // @ts-ignore — optional dependency, installed when user enables WhatsApp
            const baileys = await import('@whiskeysockets/baileys');
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

            this.authDir = config.authDir || path.join(process.cwd(), '.whatsapp-auth');

            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: true, // QR code for first-time auth
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', (update: any) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                    if (isLoggedOut) {
                        this.connected = false;
                        this.reconnectAttempts = 0;
                        log.info('[WhatsAppProvider] Logged out — not reconnecting');
                        return;
                    }

                    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
                        this.connected = false;
                        log.error(`[WhatsAppProvider] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
                        return;
                    }

                    // Exponential backoff: 2s, 4s, 8s, ... capped at 5 minutes
                    const delay = Math.min(
                        this.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
                        300_000
                    );
                    this.reconnectAttempts++;

                    log.info(`[WhatsAppProvider] Connection closed (status: ${statusCode}). Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`);

                    setTimeout(() => {
                        this.connect(config).catch(err =>
                            log.error(`[WhatsAppProvider] Reconnect attempt failed: ${err.message}`)
                        );
                    }, delay);
                } else if (connection === 'open') {
                    this.connected = true;
                    this.reconnectAttempts = 0;  // reset on successful connection
                    log.info('[WhatsAppProvider] Connected successfully');
                }
            });

            this.sock.ev.on('messages.upsert', async (m: any) => {
                if (!this.messageCallback) return;

                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue; // Ignore own messages

                    const jid = msg.key.remoteJid || '';
                    const isGroup = jid.endsWith('@g.us');

                    // Phase 15A.5: Group chat — only respond when @mentioned
                    if (isGroup && config.groupMentionOnly !== false) {
                        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                        const botJid = this.sock?.user?.id;
                        if (botJid && !mentioned.some((m: string) => m.includes(botJid.split(':')[0]))) {
                            continue; // Not mentioned in group, skip
                        }
                    }

                    const text = msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';
                    const attachments: IncomingMessage['attachments'] = [];

                    // Detect attachments and try to download with Baileys
                    const mediaTypes = [
                        { key: 'audioMessage', type: 'audio' as const, name: 'voice_message.ogg' },
                        { key: 'imageMessage', type: 'image' as const, name: 'image.jpg' },
                        { key: 'videoMessage', type: 'video' as const, name: 'video.mp4' },
                        { key: 'documentMessage', type: 'file' as const, name: undefined },
                    ];

                    for (const mt of mediaTypes) {
                        const mediaMsg = msg.message?.[mt.key];
                        if (mediaMsg) {
                            try {
                                const buffer = await baileys.downloadMediaMessage(msg, 'buffer', {});
                                // Save to temp file and use as local URL
                                const fs = await import('fs');
                                const os = await import('os');
                                const tempPath = path.join(os.tmpdir(), `wa_${Date.now()}_${mt.name || mediaMsg.fileName || 'file'}`);
                                fs.writeFileSync(tempPath, buffer);
                                attachments.push({
                                    type: mt.type,
                                    url: `file://${tempPath}`,
                                    name: mt.name || mediaMsg.fileName || 'attachment',
                                });
                            } catch (e: any) {
                                console.warn(`[WhatsAppProvider] Media download failed:`, e.message);
                                attachments.push({
                                    type: mt.type,
                                    url: '',
                                    name: mt.name || mediaMsg.fileName || 'attachment',
                                });
                            }
                            break; // Only one media type per message
                        }
                    }

                    // Skip if no text and no attachments
                    if (!text && attachments.length === 0) continue;

                    const incoming: IncomingMessage = {
                        id: msg.key.id || String(Date.now()),
                        provider: 'whatsapp',
                        chatId: jid,
                        userId: msg.key.participant || jid,
                        username: msg.pushName || 'Unknown',
                        text: text || `[${attachments.length} file(s) attached]`,
                        timestamp: new Date((msg.messageTimestamp || Date.now()) * 1000),
                        attachments: attachments.length > 0 ? attachments : undefined,
                    };

                    this.messageCallback(incoming);
                }
            });
        } catch (error: any) {
            if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
                throw new Error('@whiskeysockets/baileys is not installed. Run: npm install @whiskeysockets/baileys');
            }
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        this.reconnectAttempts = 0;  // prevent stale reconnect loop after explicit disconnect
        if (this.sock) {
            await this.sock.logout().catch(() => { });
            this.sock = null;
        }
        this.connected = false;
        log.info('[WhatsAppProvider] Disconnected');
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageCallback = handler;
    }

    async sendMessage(chatId: string, text: string, _options?: Partial<OutgoingMessage>): Promise<void> {
        if (!this.sock) throw new Error('WhatsApp not connected');
        await this.sock.sendMessage(chatId, { text });
    }

    async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
        if (!this.sock) throw new Error('WhatsApp not connected');
        const fs = await import('fs');
        const buffer = fs.readFileSync(filePath);
        const filename = path.basename(filePath);

        await this.sock.sendMessage(chatId, {
            document: buffer,
            fileName: filename,
            caption: caption || filename,
        });
    }

    getStatus(): { connected: boolean; info?: any } {
        return {
            connected: this.connected,
            info: { authDir: this.authDir },
        };
    }
}
