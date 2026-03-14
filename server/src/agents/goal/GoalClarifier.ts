/**
 * GoalClarifier — Generates clarifying questions before a goal is executed.
 *
 * Returns 0–5 targeted questions when the goal is ambiguous.
 * 0 questions = goal is clear, proceed immediately.
 * Designed to work across all interfaces: web UI, Discord, Telegram, WhatsApp.
 */

import { modelManager } from '../../services/llm/modelManager';
import { modelRouter } from '../../services/llm/modelRouter';
import { parseParamCount } from '../../utils/modelUtils';
import { appLogger as log } from '../../utils/Logger';

export interface ClarifyingQuestion {
    id: string;                          // short identifier e.g. "q1"
    question: string;                    // the question to ask
    hint?: string;                       // optional placeholder / example
    type: 'text' | 'choice' | 'yesno';
    options?: string[];                  // only for type "choice"
    required: boolean;
}

export class GoalClarifier {

    /**
     * Analyze the goal text and return 0–5 clarifying questions.
     * Returns an empty array if the goal is unambiguous.
     */
    async generateQuestions(
        goalText: string,
        conversationContext?: { role: string; content: string }[]
    ): Promise<ClarifyingQuestion[]> {
        const llm = modelRouter.getAdapterForTask('simple_qa') || modelManager.getActiveAdapter();
        if (!llm) return [];

        // Only attempt clarification on fast local models (Ollama/LMStudio, ≤ 8B params).
        // Cloud APIs and proxied models (gemini, claude, ollama-cloud, etc.) have first-token
        // latency of 10-30s and will consistently timeout at 8s.
        // parseParamCount returns 0 for cloud model names (no size token) — treat 0 as "unknown/cloud"
        // and skip rather than attempt-and-timeout.
        const { provider: activeProvider } = modelManager.getActiveModelStatus();
        const clarificationModelId = (llm as any).model as string || modelManager.getActiveModelStatus().model || '';
        const paramCount = parseParamCount(clarificationModelId);
        const isLocalProvider = activeProvider === 'ollama' || activeProvider === 'lmstudio';
        const isFastLocalModel = isLocalProvider && paramCount > 0 && paramCount <= 8;
        if (!isFastLocalModel) {
            log.info(`[GoalClarifier] Skipping — ${activeProvider}/${clarificationModelId} is not a fast local model (paramCount=${paramCount})`);
            return [];
        }

        const contextSection = conversationContext && conversationContext.length > 0
            ? '\nRecent conversation:\n' +
              conversationContext.slice(-5).map(m =>
                  `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 200)}`
              ).join('\n') + '\n'
            : '';

        const prompt = `You are an assistant that helps clarify user goals before autonomous execution.${contextSection}
User goal: "${goalText}"

Analyze if this goal needs clarification. Ask ONLY about information that is GENUINELY AMBIGUOUS and would significantly change how the task is executed.

DO NOT ask about:
- Things you can reasonably infer or decide yourself
- Nice-to-have preferences that don't affect the core approach
- Technical implementation details (language, library, structure)
- Error handling, logging, or best practices (always include them)

Output ONLY a valid JSON array (0 to 5 items). Return [] if the goal is clear enough to proceed.

Schema for each item:
{
  "id": "q1",
  "question": "...",
  "hint": "optional example answer",
  "type": "text" | "choice" | "yesno",
  "options": ["A", "B", "C"],
  "required": true
}

GOOD question examples (genuinely ambiguous):
- "What output format do you need?" → choice: ["PDF", "Excel", "Markdown", "CSV"]
- "Which stock exchange?" → choice: ["NSE", "BSE", "Both"]
- "Should this run once or on a schedule?" → choice: ["Once", "Daily", "Hourly"]
- "What date range should the data cover?" → text, hint: "e.g. last 30 days"

BAD question examples (do NOT ask these):
- "What programming language?" → use Node.js by default
- "Do you want error handling?" → always yes
- "What should the file be named?" → infer from context
- "Should I include comments?" → always yes

Return ONLY the JSON array, no prose or markdown.`;

        try {
            // Hard timeout: clarification must never block goal execution.
            // Even fast local models get 6s — if they can't respond in time, proceed without clarification.
            const TIMEOUT_MS = 6000;
            const raw = await Promise.race([
                llm.generate(prompt, { temperature: 0.2, maxTokens: 150 }),
                new Promise<string>((_, reject) =>
                    setTimeout(() => reject(new Error(`GoalClarifier timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
                )
            ]);

            // Strip <think> blocks (DeepSeek/Qwen) before parsing
            const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

            // Extract JSON array using balanced-bracket scan (avoids greedy regex issues)
            const parsed = extractJsonArray(cleaned);
            if (!parsed) return [];

            return parsed
                .slice(0, 5)
                .filter((q: any) => q && typeof q.question === 'string' && q.question.trim())
                .map((q: any, i: number) => ({
                    id: q.id || `q${i + 1}`,
                    question: q.question.trim(),
                    hint: q.hint || undefined,
                    type: (['text', 'choice', 'yesno'].includes(q.type) ? q.type : 'text') as 'text' | 'choice' | 'yesno',
                    options: Array.isArray(q.options) && q.options.length > 0 ? q.options : undefined,
                    required: q.required !== false
                }));
        } catch (err: any) {
            const isTimeout = err?.message?.includes('timed out');
            // Timeout is expected for slow models — info level, not warn.
            // Any other error is unexpected and worth investigating.
            if (isTimeout) {
                log.info(`[GoalClarifier] Timed out after ${6000}ms — proceeding without clarification. ` +
                    `Goal may be executed with unverified intent. Consider using a local model for clarification.`);
            } else {
                log.warn({ err: String(err) }, '[GoalClarifier] Failed to generate questions — proceeding without clarification');
            }
            return [];
        }
    }

    /**
     * Format questions as a chat message for display in any interface.
     */
    formatQuestionsAsMessage(questions: ClarifyingQuestion[]): string {
        const lines = ['Before I start, I have a few quick questions:\n'];
        questions.forEach((q, i) => {
            let line = `${i + 1}. ${q.question}`;
            if (q.type === 'choice' && q.options) {
                line += ` *(${q.options.join(' / ')})*`;
            } else if (q.type === 'yesno') {
                line += ' *(Yes / No)*';
            } else if (q.hint) {
                line += ` *(e.g. ${q.hint})*`;
            }
            lines.push(line);
        });
        lines.push('\nJust reply with your answers and I\'ll get started right away.');
        return lines.join('\n');
    }

    /**
     * Build an enriched goal string by injecting clarification answers.
     * Accepts either a structured answers map (from web UI) or a raw string (from chat/messaging).
     */
    injectAnswers(
        originalGoal: string,
        questions: ClarifyingQuestion[],
        answers: Record<string, string> | string
    ): string {
        if (typeof answers === 'string') {
            // Free-form reply from chat UI or messaging platform
            if (!answers.trim()) return originalGoal;
            return `${originalGoal}\n\nUser clarifications: ${answers.trim()}`;
        }

        // Structured answers from web UI Q&A form
        const answered = questions
            .filter(q => answers[q.id] && answers[q.id].trim())
            .map(q => `- ${q.question}: ${answers[q.id].trim()}`);

        if (answered.length === 0) return originalGoal;
        return `${originalGoal}\n\nAdditional context provided by user:\n${answered.join('\n')}`;
    }
}

export const goalClarifier = new GoalClarifier();

/**
 * Find and parse the first valid JSON array in a string using balanced bracket
 * scanning instead of a greedy regex. Falls back to trying each `[...]` segment.
 */
function extractJsonArray(text: string): any[] | null {
    // Walk through characters to find a balanced [ ... ] block
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        // Skip string literals to avoid counting brackets inside them
        if (ch === '"') {
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') i++; // skip escaped char
                i++;
            }
            continue;
        }
        if (ch === '[') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === ']') {
            depth--;
            if (depth === 0 && start !== -1) {
                // Try parsing this balanced block
                try {
                    const candidate = text.slice(start, i + 1);
                    const result = JSON.parse(candidate);
                    if (Array.isArray(result)) return result;
                } catch {
                    // Not valid JSON — reset and keep looking
                    start = -1;
                }
            }
        }
    }

    // Last resort: try the whole cleaned string
    try {
        const result = JSON.parse(text);
        if (Array.isArray(result)) return result;
    } catch { /* give up */ }

    return null;
}

// parseParamCount is imported from ../../utils/modelUtils
