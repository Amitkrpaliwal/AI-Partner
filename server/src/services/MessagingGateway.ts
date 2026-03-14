/**
 * MessagingGateway — Unified interface for messaging platform integrations.
 *
 * Routes incoming messages from Telegram, Discord, WhatsApp, etc. to the
 * AI Co-Worker, and sends responses back through the originating channel.
 */

import { EventEmitter } from 'events';
import { fileUploadService } from './FileUploadService';

// ============================================================================
// TYPES
// ============================================================================

export interface IncomingMessage {
    id: string;
    provider: string;
    chatId: string;
    userId: string;
    username?: string;
    text: string;
    timestamp: Date;
    replyToId?: string;
    attachments?: Array<{
        type: 'image' | 'file' | 'audio' | 'video';
        url: string;
        name?: string;
    }>;
}

export interface OutgoingMessage {
    chatId: string;
    text: string;
    parseMode?: 'text' | 'markdown' | 'html';
    replyToId?: string;
}

export interface ProviderConfig {
    enabled: boolean;
    token?: string;
    [key: string]: any;
}

export interface MessagingProvider {
    name: string;
    connected: boolean;
    connect(config: ProviderConfig): Promise<void>;
    disconnect(): Promise<void>;
    onMessage(handler: (msg: IncomingMessage) => void): void;
    sendMessage(chatId: string, text: string, options?: Partial<OutgoingMessage>): Promise<void>;
    sendFile(chatId: string, path: string, caption?: string): Promise<void>;
    getStatus(): { connected: boolean; info?: any };
}

// ============================================================================
// MESSAGING GATEWAY
// ============================================================================

export class MessagingGateway extends EventEmitter {
    private providers: Map<string, MessagingProvider> = new Map();
    private messageHandler: ((msg: IncomingMessage) => Promise<string>) | null = null;
    /** Last chatId seen per provider — used by MessagingServer to send without explicit chatId */
    private lastSeenChatId: Map<string, string> = new Map();

    /** Return the most recently seen chatId for a provider, or null if none yet */
    getLastChatId(providerName: string): string | null {
        return this.lastSeenChatId.get(providerName) ?? null;
    }

    /**
     * Register a messaging provider
     */
    registerProvider(provider: MessagingProvider): void {
        this.providers.set(provider.name, provider);

        // Wire up message handling
        provider.onMessage(async (msg) => {
            this.emit('message:received', msg);
            // Track last seen chatId per provider for proactive sends
            this.lastSeenChatId.set(msg.provider, msg.chatId);
            console.log(`[MessagingGateway] Received from ${msg.provider}/${msg.username}: ${msg.text.substring(0, 80)}`);

            if (this.messageHandler) {
                try {
                    // Process attachments if present
                    let enrichedText = msg.text;
                    if (msg.attachments && msg.attachments.length > 0) {
                        const attachmentContextParts: string[] = [];

                        for (const att of msg.attachments) {
                            try {
                                const conversationId = `${msg.provider}-${msg.chatId}`;

                                if (att.type === 'audio') {
                                    // Transcribe audio via SpeechService
                                    try {
                                        const result = await fileUploadService.processFromUrl(
                                            att.url, att.name || 'audio', 'audio/ogg', conversationId
                                        );
                                        if (result.success && result.file) {
                                            // Try to transcribe
                                            try {
                                                const { SpeechService } = await import('./SpeechService');
                                                const speechService = new SpeechService();
                                                const fs = await import('fs');
                                                const audioBuffer = fs.readFileSync(result.file.storedPath);
                                                const transcription = await speechService.speechToText(audioBuffer);
                                                attachmentContextParts.push(`[Voice message transcription]: ${transcription}`);
                                            } catch {
                                                attachmentContextParts.push(`[Voice message received — saved to ${result.file.storedPath}]`);
                                            }
                                        }
                                    } catch (e: any) {
                                        console.warn(`[MessagingGateway] Audio download failed:`, e.message);
                                        attachmentContextParts.push(`[Voice message — download failed]`);
                                    }
                                } else {
                                    // Download and process other file types
                                    const mimeGuess = att.type === 'image' ? 'image/jpeg'
                                        : att.type === 'video' ? 'video/mp4'
                                            : 'application/octet-stream';

                                    const result = await fileUploadService.processFromUrl(
                                        att.url, att.name || 'attachment', mimeGuess, conversationId
                                    );

                                    if (result.success && result.file) {
                                        if (result.file.extractedText) {
                                            attachmentContextParts.push(
                                                `[File: ${result.file.originalName}]\n${result.file.extractedText}`
                                            );
                                        } else {
                                            attachmentContextParts.push(
                                                `[Attached ${att.type}: ${result.file.originalName}]`
                                            );
                                        }
                                    }
                                }
                            } catch (e: any) {
                                console.warn(`[MessagingGateway] Attachment processing failed:`, e.message);
                            }
                        }

                        if (attachmentContextParts.length > 0) {
                            enrichedText = `${msg.text}\n\n--- Attached Files ---\n${attachmentContextParts.join('\n\n')}`;
                        }
                    }

                    const enrichedMsg = { ...msg, text: enrichedText };
                    const response = await this.messageHandler(enrichedMsg);
                    await provider.sendMessage(msg.chatId, response);
                    this.emit('message:sent', { provider: msg.provider, chatId: msg.chatId, response: response.substring(0, 100) });

                    // Auto-upload any generated files mentioned in the response.
                    // Parses "**Files created:**\n- /path/to/file" sections.
                    const artifactPaths = this.extractArtifactPaths(response);
                    if (artifactPaths.length > 0) {
                        for (const filePath of artifactPaths) {
                            try {
                                await this.sendFile(msg.provider, msg.chatId, filePath, `📎 ${filePath.split('/').pop()}`);
                            } catch (e: any) {
                                console.warn(`[MessagingGateway] Could not send artifact "${filePath}": ${e.message}`);
                            }
                        }
                    }
                } catch (error: any) {
                    console.error(`[MessagingGateway] Error handling message:`, error.message);
                    try {
                        await provider.sendMessage(msg.chatId, `⚠️ Error: ${error.message}`);
                    } catch (_) { /* ignore send failure */ }
                }
            }
        });

        console.log(`[MessagingGateway] Registered provider: ${provider.name}`);
    }

    /**
     * Set the handler that processes incoming messages and returns a response string.
     */
    setMessageHandler(handler: (msg: IncomingMessage) => Promise<string>): void {
        this.messageHandler = handler;
    }

    /**
     * Connect a specific provider
     */
    async connectProvider(name: string, config: ProviderConfig): Promise<void> {
        const provider = this.providers.get(name);
        if (!provider) {
            throw new Error(`Provider "${name}" not registered`);
        }
        if (!config.enabled) {
            console.log(`[MessagingGateway] Provider "${name}" is disabled`);
            return;
        }
        await provider.connect(config);
        this.emit('provider:connected', { name });
        console.log(`[MessagingGateway] Connected provider: ${name}`);
    }

    /**
     * Disconnect a specific provider
     */
    async disconnectProvider(name: string): Promise<void> {
        const provider = this.providers.get(name);
        if (provider) {
            await provider.disconnect();
            this.emit('provider:disconnected', { name });
        }
    }

    /**
     * Send a message through a specific provider
     */
    async sendMessage(providerName: string, chatId: string, text: string): Promise<void> {
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Provider "${providerName}" not found`);
        }
        if (!provider.connected) {
            throw new Error(`Provider "${providerName}" not connected`);
        }
        await provider.sendMessage(chatId, text);
    }

    /**
     * Extract file paths from a goal completion response message.
     * Looks for the "**Files created:**\n- path" pattern and validates each path exists on disk.
     */
    private extractArtifactPaths(response: string): string[] {
        const paths: string[] = [];
        const filesSection = response.match(/\*\*Files? created:?\*\*\s*\n([\s\S]*?)(?:\n\n|\n\*\*|$)/i);
        if (!filesSection) return paths;

        const lines = filesSection[1].split('\n');
        for (const line of lines) {
            const match = line.match(/^[-*]\s+(.+)$/);
            if (!match) continue;
            const candidate = match[1].trim();
            // Only include if it looks like a file path (has extension or starts with /)
            if (/\.[a-zA-Z0-9]{2,5}$/.test(candidate) || candidate.startsWith('/')) {
                paths.push(candidate);
            }
        }
        return paths;
    }

    /**
     * Send a file through a specific provider (uploads directly — no localhost links).
     * Falls back to sending a text message with the filename if the provider fails.
     */
    async sendFile(providerName: string, chatId: string, filePath: string, caption?: string): Promise<void> {
        const provider = this.providers.get(providerName);
        if (!provider || !provider.connected) return;

        // Resolve relative paths against workspace directory
        let resolvedPath = filePath;
        if (!filePath.startsWith('/') && !filePath.match(/^[A-Za-z]:\\/)) {
            try {
                const { configManager } = await import('./ConfigManager');
                const path = await import('path');
                resolvedPath = path.join(configManager.getWorkspaceDir(), filePath);
            } catch { /* keep original */ }
        }

        // Check file exists before attempting upload
        try {
            const fs = await import('fs');
            if (!fs.existsSync(resolvedPath)) {
                console.warn(`[MessagingGateway] sendFile: file not found: ${resolvedPath}`);
                return;
            }
        } catch { /* ignore stat check failure */ }

        try {
            await provider.sendFile(chatId, resolvedPath, caption);
        } catch (e: any) {
            // Fallback: send filename as text if file upload fails
            console.warn(`[MessagingGateway] sendFile failed for ${providerName}: ${e.message}`);
            const name = resolvedPath.split('/').pop() || resolvedPath;
            await provider.sendMessage(chatId, `📎 File ready: ${name} (upload failed — check server logs)`);
        }
    }

    /**
     * Get status of all providers
     */
    getStatus(): Record<string, { connected: boolean; info?: any }> {
        const status: Record<string, any> = {};
        for (const [name, provider] of this.providers.entries()) {
            status[name] = provider.getStatus();
        }
        return status;
    }

    /**
     * Get status of a specific provider by name.
     */
    getProviderStatus(name: string): { connected: boolean; info?: any } | null {
        const provider = this.providers.get(name);
        if (!provider) return null;
        return provider.getStatus();
    }

    /**
     * Get registered provider names
     */
    getProviderNames(): string[] {
        return Array.from(this.providers.keys());
    }
}

export const messagingGateway = new MessagingGateway();
