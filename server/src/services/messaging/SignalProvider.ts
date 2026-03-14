/**
 * SignalProvider — Signal integration via signal-cli REST API.
 *
 * Connects to a signal-cli-rest-api Docker container for Signal messaging.
 * The container handles Signal protocol; this provider calls its REST API.
 *
 * Docker setup:
 *   docker run -d --name signal-cli-rest-api \
 *     -e MODE=normal \
 *     -p 8080:8080 \
 *     -v ./signal-data:/home/.local/share/signal-cli \
 *     bbernhard/signal-cli-rest-api
 *
 * Registration: POST /v1/register/<number> then /v1/register/<number>/verify/<code>
 */

import { MessagingProvider, IncomingMessage, ProviderConfig, OutgoingMessage } from '../MessagingGateway';
import * as fs from 'fs';
import * as path from 'path';

export class SignalProvider implements MessagingProvider {
    name = 'signal';
    connected = false;
    private apiUrl: string = 'http://localhost:8080';
    private phoneNumber: string = '';
    private messageCallback: ((msg: IncomingMessage) => void) | null = null;
    private pollInterval: ReturnType<typeof setInterval> | null = null;

    async connect(config: ProviderConfig): Promise<void> {
        this.apiUrl = config.apiUrl || 'http://localhost:8080';
        this.phoneNumber = config.phoneNumber || '';

        if (!this.phoneNumber) {
            throw new Error('Signal phone number is required (config.phoneNumber)');
        }

        try {
            // @ts-ignore — optional dependency
            const axios = (await import('axios')).default;

            // Verify signal-cli-rest-api is reachable
            const healthRes = await axios.get(`${this.apiUrl}/v1/about`, { timeout: 5000 });
            if (!healthRes.data) {
                throw new Error('signal-cli-rest-api not responding');
            }

            // Check if number is registered
            const accountsRes = await axios.get(`${this.apiUrl}/v1/accounts`, { timeout: 5000 });
            const accounts: string[] = accountsRes.data || [];
            if (!accounts.includes(this.phoneNumber)) {
                console.warn(`[SignalProvider] Number ${this.phoneNumber} not registered. Use /v1/register/${this.phoneNumber} to register.`);
            }

            // Start polling for messages
            this.startPolling(axios);

            this.connected = true;
            console.log(`[SignalProvider] Connected (number: ${this.phoneNumber})`);
        } catch (error: any) {
            if (error.code === 'ECONNREFUSED') {
                throw new Error(`signal-cli-rest-api not reachable at ${this.apiUrl}. Is the Docker container running?`);
            }
            if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
                throw new Error('axios is not installed. Run: npm install axios');
            }
            throw error;
        }
    }

    private startPolling(axios: any): void {
        // Poll for new messages every 2 seconds
        this.pollInterval = setInterval(async () => {
            if (!this.messageCallback) return;

            try {
                const res = await axios.get(
                    `${this.apiUrl}/v1/receive/${encodeURIComponent(this.phoneNumber)}`,
                    { timeout: 10000 }
                );

                const messages: any[] = res.data || [];
                for (const envelope of messages) {
                    const dataMsg = envelope.envelope?.dataMessage;
                    if (!dataMsg?.message) continue;

                    const incoming: IncomingMessage = {
                        id: `signal_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                        provider: 'signal',
                        chatId: envelope.envelope?.sourceNumber || envelope.envelope?.source || '',
                        userId: envelope.envelope?.sourceNumber || '',
                        username: envelope.envelope?.sourceName || envelope.envelope?.sourceNumber || 'Unknown',
                        text: dataMsg.message,
                        timestamp: new Date(envelope.envelope?.timestamp || Date.now()),
                        attachments: dataMsg.attachments?.map((a: any) => ({
                            type: a.contentType?.startsWith('image') ? 'image' as const
                                : a.contentType?.startsWith('audio') ? 'audio' as const
                                    : a.contentType?.startsWith('video') ? 'video' as const
                                        : 'file' as const,
                            url: a.id || '',
                            name: a.filename || 'attachment',
                        })),
                    };

                    this.messageCallback(incoming);
                }
            } catch {
                // Polling failure is non-critical, will retry
            }
        }, 2000);
    }

    async disconnect(): Promise<void> {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.connected = false;
        console.log('[SignalProvider] Disconnected');
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageCallback = handler;
    }

    async sendMessage(chatId: string, text: string, _options?: Partial<OutgoingMessage>): Promise<void> {
        // @ts-ignore
        const axios = (await import('axios')).default;

        // Split long messages (Signal limit: ~2000 chars recommended)
        const chunks = this.splitMessage(text, 2000);

        for (const chunk of chunks) {
            await axios.post(`${this.apiUrl}/v2/send`, {
                message: chunk,
                number: this.phoneNumber,
                recipients: [chatId],
            }, { timeout: 15000 });
        }
    }

    async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
        // @ts-ignore
        const axios = (await import('axios')).default;
        const FormData = (await import('form-data')).default;

        const form = new FormData();
        form.append('message', caption || '');
        form.append('number', this.phoneNumber);
        form.append('recipients', chatId);
        form.append('attachment', fs.createReadStream(filePath));

        await axios.post(`${this.apiUrl}/v2/send`, form, {
            headers: form.getHeaders(),
            timeout: 30000,
        });
    }

    getStatus(): { connected: boolean; info?: any } {
        return {
            connected: this.connected,
            info: {
                phoneNumber: this.phoneNumber,
                apiUrl: this.apiUrl,
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
