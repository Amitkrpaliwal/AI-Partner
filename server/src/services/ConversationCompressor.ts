import { modelManager } from './llm/modelManager';
import { HistoryMessage, getTextContent } from './llm/types';

/**
 * ConversationCompressor — Prevents context window overflow (Phase 10 upgrade)
 *
 * Uses TOKEN-BASED compression instead of fixed message count.
 * Estimates token count and triggers compression when approaching
 * the model's context window limit. Per-model context window mappings
 * ensure optimal usage for both small (8K) and large (128K) models.
 *
 * Inspired by Agent Zero's conversation compression strategy.
 */

// ============================================================================
// PER-MODEL CONTEXT WINDOWS
// ============================================================================

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    // OpenAI
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-3.5-turbo': 16384,
    // Anthropic
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'claude-3.5-sonnet': 200000,
    // Google
    'gemini-pro': 1000000,    // Gemini 1.0 Pro: 1M (was incorrectly set to 32K)
    'gemini-1.5-pro': 1000000,
    'gemini-1.5-flash': 1000000,
    'gemini-2.0-flash': 1000000,
    // Ollama / local — actual context windows (not conservative guesses)
    'llama': 128000,          // Llama 3.1 70B: 128K (was incorrectly set to 8K)
    'mistral': 128000,        // Mistral Large 2: 128K (was incorrectly set to 32K)
    'codellama': 16384,
    'deepseek': 32000,
    'qwen': 32000,
    // Fallback
    'default': 8192,
};

const KEEP_RECENT = 10;          // Always keep the last N messages verbatim
const MAX_SUMMARY_LENGTH = 500;  // Target summary length (chars)
const COMPRESSION_THRESHOLD = 0.70; // Trigger at 70% of context window

// ============================================================================
// TOKEN ESTIMATION
// ============================================================================

/**
 * Rough token estimation: ~4 chars per token for English text.
 * Not exact but sufficient for compression decisions.
 */
function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
}

function estimateHistoryTokens(history: HistoryMessage[]): number {
    return history.reduce((sum, m) => sum + estimateTokenCount(getTextContent(m.content)) + 4, 0); // +4 per message overhead
}

/**
 * Get context window size for a model name.
 */
function getModelContextWindow(modelName: string): number {
    if (!modelName) return MODEL_CONTEXT_WINDOWS['default'];
    const lower = modelName.toLowerCase();
    const key = Object.keys(MODEL_CONTEXT_WINDOWS).find(k => lower.includes(k));
    return key ? MODEL_CONTEXT_WINDOWS[key] : MODEL_CONTEXT_WINDOWS['default'];
}

// ============================================================================
// COMPRESSOR
// ============================================================================

// Re-export the shared HistoryMessage type for backward compatibility
export type { HistoryMessage } from './llm/types';

export class ConversationCompressor {

    /**
     * Compress conversation history if it approaches the context window limit.
     * Uses token-based estimation with per-model context windows.
     * Falls back to message-count threshold for safety.
     */
    async compress(history: HistoryMessage[], modelName?: string): Promise<HistoryMessage[]> {
        const contextWindow = getModelContextWindow(modelName || '');
        const currentTokens = estimateHistoryTokens(history);
        const threshold = contextWindow * COMPRESSION_THRESHOLD;

        // Also apply a message-count safety net (even large windows shouldn't have 100+ messages)
        const messageSafetyThreshold = 50;

        if (currentTokens <= threshold && history.length <= messageSafetyThreshold) {
            return history; // No compression needed
        }

        console.log(`[Compressor] Token usage: ~${currentTokens}/${contextWindow} (${Math.round(currentTokens / contextWindow * 100)}%) — compressing`);

        // Progressive summarization: summarize in chunks for very long histories
        const toKeep = history.slice(-KEEP_RECENT);
        const toSummarize = history.slice(0, history.length - KEEP_RECENT);

        let summary: string;
        if (toSummarize.length > 40) {
            // Chunk-based summarization for very long histories
            summary = await this.progressiveSummarize(toSummarize);
        } else {
            summary = await this.summarize(toSummarize);
        }

        const compressed: HistoryMessage[] = [
            {
                role: 'system',
                content: `[Conversation Summary - ${toSummarize.length} earlier messages compressed (~${estimateHistoryTokens(toSummarize)} tokens freed)]\n${summary}`
            },
            ...toKeep
        ];

        const newTokens = estimateHistoryTokens(compressed);
        console.log(`[Compressor] Compressed ${history.length} messages → ${compressed.length} (${currentTokens} → ~${newTokens} tokens)`);

        return compressed;
    }

    /**
     * Progressive summarization: break history into chunks, summarize each, then combine.
     */
    private async progressiveSummarize(messages: HistoryMessage[]): Promise<string> {
        const chunkSize = 20;
        const chunkSummaries: string[] = [];

        for (let i = 0; i < messages.length; i += chunkSize) {
            const chunk = messages.slice(i, i + chunkSize);
            const summary = await this.summarize(chunk);
            chunkSummaries.push(summary);
        }

        // If we have multiple chunk summaries, summarize them together
        if (chunkSummaries.length > 1) {
            const combinedMessages: HistoryMessage[] = chunkSummaries.map(s => ({
                role: 'system',
                content: s
            }));
            return this.summarize(combinedMessages);
        }

        return chunkSummaries[0] || '';
    }

    /**
     * Summarize a list of messages into a compact text
     */
    private async summarize(messages: HistoryMessage[]): Promise<string> {
        const llm = modelManager.getActiveAdapter();
        if (!llm) {
            return this.fallbackSummary(messages);
        }

        const transcript = messages.map(m => {
            const text = getTextContent(m.content);
            return `${m.role}: ${text.substring(0, 200)}`;
        }).join('\n');

        const prompt = `Summarize this conversation in ${MAX_SUMMARY_LENGTH} characters or less.
Focus on: key decisions made, tools used, files created, and errors encountered.
CRITICAL RULES for intent handling:
- If a task or intent was COMPLETED, ANSWERED, or ABANDONED, mark it as [DONE] and do NOT carry it forward as active work.
- Only mark intents/tasks as [ACTIVE] if they are genuinely still in progress with unfinished steps.
- Do NOT preserve old search queries, price lookups, or information requests that were already answered.
- Separate completed context from active context clearly.
Be factual and concise.

CONVERSATION:
${transcript.substring(0, 3000)}

SUMMARY:`;

        try {
            const summary = await llm.generate(prompt, { temperature: 0.2, maxTokens: 300 });
            return summary.substring(0, MAX_SUMMARY_LENGTH * 2);
        } catch (error) {
            console.error('[Compressor] LLM summarization failed:', error);
            return this.fallbackSummary(messages);
        }
    }

    /**
     * Fallback summary when LLM is unavailable
     */
    private fallbackSummary(messages: HistoryMessage[]): string {
        const parts: string[] = [];

        const toolUses = messages.filter(m => {
            const text = getTextContent(m.content);
            return text.includes('Used ') || text.includes('Tool result:');
        });
        if (toolUses.length > 0) {
            parts.push(`Tools used: ${toolUses.length} actions`);
        }

        const filePattern = /(?:created|wrote|modified|read)\s+(?:file\s+)?["`']?([^\s"'`]+\.\w+)/gi;
        const files = new Set<string>();
        for (const m of messages) {
            const text = getTextContent(m.content);
            let match;
            while ((match = filePattern.exec(text)) !== null) {
                files.add(match[1]);
            }
        }
        if (files.size > 0) {
            parts.push(`Files: ${[...files].join(', ')}`);
        }

        const errors = messages.filter(m => {
            const text = getTextContent(m.content);
            return text.toLowerCase().includes('error') || text.toLowerCase().includes('failed');
        });
        if (errors.length > 0) {
            parts.push(`Errors encountered: ${errors.length}`);
        }

        const firstUser = messages.find(m => m.role === 'user');
        if (firstUser) {
            const text = getTextContent(firstUser.content);
            parts.push(`Initial request: ${text.substring(0, 150)}`);
        }

        return parts.join('. ') || 'Earlier conversation context (compressed).';
    }

    /**
     * Get estimated token count for a history (utility for callers)
     */
    getEstimatedTokens(history: HistoryMessage[]): number {
        return estimateHistoryTokens(history);
    }

    /**
     * Get context window for a model (utility for callers)
     */
    getContextWindow(modelName: string): number {
        return getModelContextWindow(modelName);
    }
}

export const conversationCompressor = new ConversationCompressor();
