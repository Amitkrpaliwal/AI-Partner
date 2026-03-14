/**
 * TelegramHITLBridge — bridges Goal executor HITL events to Telegram inline buttons.
 *
 * When a goal running from a Telegram conversation needs human approval or input,
 * this bridge:
 *   1. Listens to goal:approval-needed and goal:user-input-needed events.
 *   2. Sends an inline-keyboard message to the originating Telegram chat.
 *   3. Handles button taps (callback_query) and text replies to resolve the approval/input.
 *
 * Usage:
 *   - Call telegramHITLBridge.initialize() once on app startup.
 *   - TelegramProvider calls telegramHITLBridge.setBot(bot) after connecting.
 *   - TelegramProvider calls telegramHITLBridge.handleCallbackQuery(query) in callback_query handler.
 *   - TelegramProvider calls telegramHITLBridge.handleTextReply(msg) before passing to messageCallback.
 */

import { goalOrientedExecutor } from '../agents/GoalOrientedExecutor';
import { createLogger } from '../utils/Logger';

const log = createLogger('TelegramHITLBridge');

interface PendingMsg {
    chatId: string;
    messageId: number;
}

class TelegramHITLBridge {
    private bot: any = null;
    private initialized = false;

    // approvalId → sent bot message info (for cleanup after response)
    private approvalMsgs = new Map<string, PendingMsg>();
    // inputId → sent bot message info
    private inputMsgs = new Map<string, PendingMsg>();
    // bot messageId (of the input-request message) → inputId (so text replies resolve the right input)
    private msgToInputId = new Map<number, string>();

    // -------------------------------------------------------------------------

    /** Register event listeners. Safe to call multiple times — only runs once. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;

        goalOrientedExecutor.on('goal:approval-needed', (data: any) => {
            void this.onApprovalNeeded(data);
        });

        goalOrientedExecutor.on('goal:user-input-needed', (data: any) => {
            void this.onInputNeeded(data);
        });

        log.info('[TelegramHITL] Initialized — listening for HITL events');
    }

    /** Called by TelegramProvider after bot connects (or reconnects). */
    setBot(bot: any): void {
        this.bot = bot;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Derive the Telegram chat ID from a conversationId.
     * MessagingGateway creates conversationId as `${provider}-${chatId}`, so:
     *   "telegram-123456789"  → "123456789"
     *   "telegram--987654321" → "-987654321" (group chats have negative ids)
     */
    private extractChatId(conversationId?: string): string | null {
        if (!conversationId?.startsWith('telegram-')) return null;
        return conversationId.slice('telegram-'.length);
    }

    private async onApprovalNeeded(data: any): Promise<void> {
        const chatId = this.extractChatId(data.conversationId);
        if (!chatId || !this.bot) return;

        const { approvalId, scriptPreview, runtime, goalDescription } = data;
        const preview = (scriptPreview || '').substring(0, 400);
        const text = [
            `🔐 *Script Approval Required*`,
            ``,
            `*Goal:* ${(goalDescription || 'Goal execution').substring(0, 120)}`,
            `*Runtime:* \`${runtime || 'unknown'}\``,
            ``,
            `*Script preview:*`,
            `\`\`\``,
            preview || '(no preview available)',
            `\`\`\``,
            ``,
            `Review and approve or reject execution.`,
        ].join('\n');

        try {
            const sent = await this.bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Approve', callback_data: `hitl_approve:${approvalId}` },
                        { text: '❌ Reject',  callback_data: `hitl_reject:${approvalId}`  },
                    ]],
                },
            });
            this.approvalMsgs.set(approvalId, { chatId, messageId: sent.message_id });
            log.info(`[TelegramHITL] Sent approval request to chat ${chatId} (approvalId: ${approvalId})`);
        } catch (e: any) {
            log.warn({ err: e.message }, '[TelegramHITL] Failed to send approval message — Markdown error? Retrying plain text');
            try {
                const plainText = `🔐 Script Approval Required\n\nGoal: ${(goalDescription || '').substring(0, 120)}\nRuntime: ${runtime}\n\nScript preview:\n${preview || '(no preview)'}\n\nTap Approve or Reject.`;
                const sent = await this.bot.sendMessage(chatId, plainText, {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Approve', callback_data: `hitl_approve:${approvalId}` },
                            { text: '❌ Reject',  callback_data: `hitl_reject:${approvalId}`  },
                        ]],
                    },
                });
                this.approvalMsgs.set(approvalId, { chatId, messageId: sent.message_id });
            } catch (e2: any) {
                log.warn({ err: e2.message }, '[TelegramHITL] Plain text retry also failed');
            }
        }
    }

    private async onInputNeeded(data: any): Promise<void> {
        const chatId = this.extractChatId(data.conversationId);
        if (!chatId || !this.bot) return;

        const { inputId, message: question, proactive } = data;
        const prompt = question || 'The goal is stuck and needs your guidance. Please reply with a hint or additional information.';
        const icon = proactive ? '❓' : '🤔';
        const text = `${icon} *Goal needs your input*\n\n${prompt}\n\n_Reply to this message with your answer, or tap Skip to let the goal continue without it._`;

        try {
            const sent = await this.bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⏭️ Skip', callback_data: `hitl_input_skip:${inputId}` },
                    ]],
                    force_reply: true,
                },
            });
            this.inputMsgs.set(inputId, { chatId, messageId: sent.message_id });
            this.msgToInputId.set(sent.message_id, inputId);
            log.info(`[TelegramHITL] Sent input request to chat ${chatId} (inputId: ${inputId})`);
        } catch (e: any) {
            log.warn({ err: e.message }, '[TelegramHITL] Failed to send input request');
            try {
                const sent = await this.bot.sendMessage(chatId,
                    `${icon} Goal needs your input\n\n${prompt}\n\nReply with your answer, or tap Skip.`, {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '⏭️ Skip', callback_data: `hitl_input_skip:${inputId}` },
                        ]],
                    },
                });
                this.inputMsgs.set(inputId, { chatId, messageId: sent.message_id });
                this.msgToInputId.set(sent.message_id, inputId);
            } catch (e2: any) {
                log.warn({ err: e2.message }, '[TelegramHITL] Plain text retry also failed');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Called by TelegramProvider
    // -------------------------------------------------------------------------

    /**
     * Handle a Telegram callback_query (inline button tap).
     * Returns true if the query was consumed by the HITL bridge.
     */
    async handleCallbackQuery(query: any): Promise<boolean> {
        const cbData = query.data || '';
        const chatId = String(query.message?.chat?.id || '');
        const msgId  = query.message?.message_id as number | undefined;

        // --- Approval buttons ---
        if (cbData.startsWith('hitl_approve:') || cbData.startsWith('hitl_reject:')) {
            const approvalId = cbData.replace(/^hitl_(approve|reject):/, '');
            const approved   = cbData.startsWith('hitl_approve:');
            const label      = approved ? '✅ Approved' : '❌ Rejected';

            const success = goalOrientedExecutor.respondToApproval(approvalId, approved);
            try {
                await this.bot?.answerCallbackQuery(query.id, { text: label });
                if (msgId) {
                    // Remove inline buttons so the user can't double-tap
                    await this.bot?.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: chatId, message_id: msgId }
                    ).catch(() => { /* message may have been deleted */ });
                }
                if (!success) {
                    await this.bot?.sendMessage(chatId,
                        '⚠️ This approval request has already been resolved or timed out.');
                } else {
                    await this.bot?.sendMessage(chatId,
                        `${label} — goal execution continues.`);
                }
            } catch (e: any) {
                log.warn({ err: e.message }, '[TelegramHITL] Error updating approval message');
            }
            this.approvalMsgs.delete(approvalId);
            return true;
        }

        // --- Input skip button ---
        if (cbData.startsWith('hitl_input_skip:')) {
            const inputId = cbData.replace('hitl_input_skip:', '');
            goalOrientedExecutor.respondToUserInput(inputId, '');
            try {
                await this.bot?.answerCallbackQuery(query.id, { text: '⏭️ Skipped' });
                if (msgId) {
                    await this.bot?.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: chatId, message_id: msgId }
                    ).catch(() => { /* ignored */ });
                }
            } catch (e: any) {
                log.warn({ err: e.message }, '[TelegramHITL] Error updating input message');
            }
            // Clean up tracking maps
            if (msgId) this.msgToInputId.delete(msgId);
            this.inputMsgs.delete(inputId);
            return true;
        }

        return false; // not our button
    }

    /**
     * Check whether an incoming text message is a reply to a HITL input request.
     * If so, resolve the pending input and return true (caller should NOT forward to AgentOrchestrator).
     */
    handleTextReply(msg: any): boolean {
        const replyToId = msg.reply_to_message?.message_id as number | undefined;
        if (!replyToId) return false;

        const inputId = this.msgToInputId.get(replyToId);
        if (!inputId) return false;

        const hint = (msg.text || '').trim();
        const success = goalOrientedExecutor.respondToUserInput(inputId, hint);
        if (success) {
            this.msgToInputId.delete(replyToId);
            this.inputMsgs.delete(inputId);
            log.info(`[TelegramHITL] User replied with input for ${inputId}: "${hint.substring(0, 80)}"`);
        }
        return success;
    }
}

export const telegramHITLBridge = new TelegramHITLBridge();
