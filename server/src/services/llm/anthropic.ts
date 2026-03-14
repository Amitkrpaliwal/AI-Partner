import Anthropic from '@anthropic-ai/sdk';
import { LLMAdapter, GenerationOptions, Model, ContentBlock, NativeSearchResult } from './types.js';

/**
 * Native Anthropic Adapter
 *
 * Uses the official Anthropic SDK instead of OpenAI-compatible shim.
 * Supports Claude-specific features: tool use, extended thinking, vision.
 */
export class AnthropicAdapter implements LLMAdapter {
    public model: string;
    readonly nativeSearch = true;
    private client: Anthropic | null = null;
    private apiKey: string;
    private isConnected: boolean = false;

    constructor(apiKey: string = '', defaultModel: string = 'claude-sonnet-4-20250514') {
        this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
        this.model = defaultModel;
    }

    async connect(): Promise<void> {
        if (!this.apiKey) {
            console.warn('[anthropic] No API key configured — skipping');
            this.isConnected = false;
            return;
        }

        // Just initialize the SDK — no API call needed.
        // Actual connectivity errors will surface on first generate() call.
        this.client = new Anthropic({ apiKey: this.apiKey });
        this.isConnected = true;
        console.log(`✓ anthropic connected (${this.model})`);
    }

    async disconnect(): Promise<void> {
        this.client = null;
        this.isConnected = false;
    }

    async isAvailable(): Promise<boolean> {
        // Available as long as we have an API key and the SDK is initialized.
        // Don't make a real API call here — it wastes credits and can fail.
        return !!(this.client && this.apiKey);
    }

    async listModels(): Promise<Model[]> {
        // Anthropic doesn't have a list-models endpoint — return known models
        const models = [
            'claude-sonnet-4-20250514',
            'claude-3-5-haiku-20241022',
            'claude-3-5-sonnet-20241022',
            'claude-3-opus-20240229'
        ];

        return models.map(id => ({
            id,
            name: id,
            provider: 'anthropic',
            capabilities: {
                chat: true,
                completion: true,
                embedding: false,
                vision: true
            }
        }));
    }

    setModel(modelId: string): void {
        this.model = modelId;
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        if (!this.client) throw new Error('Anthropic not connected');

        const messages: Anthropic.MessageParam[] = [];

        // Convert history to Anthropic format
        if (options?.history) {
            for (const h of options.history) {
                if (h.role === 'system') continue; // System goes in system param
                messages.push({
                    role: h.role as 'user' | 'assistant',
                    content: this.convertContent(h.content)
                });
            }
        }

        messages.push({ role: 'user', content: prompt });

        // Ensure messages alternate user/assistant (Anthropic requirement)
        const cleaned = this.ensureAlternatingRoles(messages);

        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: options?.maxTokens || 4096,
            system: options?.systemPrompt || undefined,
            messages: cleaned,
            temperature: options?.temperature ?? 0.7
        });

        // Extract text from content blocks
        return response.content
            .filter(block => block.type === 'text')
            .map(block => (block as Anthropic.TextBlock).text)
            .join('');
    }

    async generateJSON(prompt: string, schema?: any, options?: GenerationOptions): Promise<any> {
        if (!this.client) throw new Error('Anthropic not connected');

        const MAX_RETRIES = 3;
        let lastError: any = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const jsonSystemPrompt = `You are a JSON-only response AI. You MUST respond with valid JSON only.
CRITICAL RULES:
1. Your response must be ONLY valid JSON - no text before or after
2. No markdown code blocks, no explanations, just pure JSON
3. Always include required fields from the expected schema
4. If you don't know something, use reasonable defaults rather than failing

${options?.systemPrompt || ''}`;

                const enhancedPrompt = schema && Object.keys(schema).length > 0
                    ? `${prompt}\n\nExpected JSON schema: ${JSON.stringify(schema)}\n\nRespond ONLY with valid JSON:`
                    : `${prompt}\n\nRespond ONLY with valid JSON:`;

                const messages: Anthropic.MessageParam[] = [];
                if (options?.history) {
                    for (const h of options.history) {
                        if (h.role === 'system') continue;
                        messages.push({
                            role: h.role as 'user' | 'assistant',
                            content: this.convertContent(h.content)
                        });
                    }
                }
                messages.push({ role: 'user', content: enhancedPrompt });
                const cleaned = this.ensureAlternatingRoles(messages);

                const response = await this.client.messages.create({
                    model: this.model,
                    max_tokens: options?.maxTokens || 2048,
                    system: jsonSystemPrompt,
                    messages: cleaned,
                    temperature: attempt === 1 ? 0.1 : 0.05
                });

                const content = response.content
                    .filter(block => block.type === 'text')
                    .map(block => (block as Anthropic.TextBlock).text)
                    .join('');

                const parsed = this.extractJSON(content);
                if (parsed) {
                    // Return raw if it's a ReActReasoner tool call (has 'tool' field)
                    if (parsed.tool && typeof parsed.tool === 'string') return parsed;
                    if (this.isValidOrchestratorResponse(parsed)) return parsed;
                    // Only normalize if it looks like a chat orchestrator response
                    const looksLikeOrchestrator = 'needsTool' in parsed || 'taskComplete' in parsed ||
                        'response' in parsed || 'action' in parsed;
                    if (looksLikeOrchestrator) return this.normalizeOrchestratorResponse(parsed);
                    return parsed;
                }

                lastError = Object.assign(
                    new Error(`Non-JSON response: ${content.substring(0, 100)}`),
                    { rawText: content }
                );
                console.warn(`[anthropic] Attempt ${attempt}/${MAX_RETRIES}: Failed to parse JSON`);
            } catch (error: any) {
                lastError = error;
                console.warn(`[anthropic] Attempt ${attempt}/${MAX_RETRIES}: Error - ${error.message}`);
            }
        }

        // All retries failed — throw so callers can extract rawText for prose-based fallback
        console.error('[anthropic] All JSON generation attempts failed');
        const err = Object.assign(
            new Error(`All JSON generation attempts failed: ${lastError?.message}`),
            { rawText: (lastError as any)?.rawText || '' }
        );
        throw err;
    }

    async *stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string> {
        if (!this.client) throw new Error('Anthropic not connected');

        const messages: Anthropic.MessageParam[] = [];
        if (options?.history) {
            for (const h of options.history) {
                if (h.role === 'system') continue;
                messages.push({
                    role: h.role as 'user' | 'assistant',
                    content: this.convertContent(h.content)
                });
            }
        }
        messages.push({ role: 'user', content: prompt });
        const cleaned = this.ensureAlternatingRoles(messages);

        const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: options?.maxTokens || 4096,
            system: options?.systemPrompt || undefined,
            messages: cleaned,
            temperature: options?.temperature ?? 0.7
        });

        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield event.delta.text;
            }
        }
    }

    async generateWithSearch(prompt: string, options?: GenerationOptions): Promise<NativeSearchResult> {
        if (!this.client) throw new Error('Anthropic not connected');

        const messages: Anthropic.MessageParam[] = [];
        if (options?.history) {
            for (const h of options.history) {
                if (h.role === 'system') continue;
                messages.push({ role: h.role as 'user' | 'assistant', content: this.convertContent(h.content) });
            }
        }
        messages.push({ role: 'user', content: prompt });
        const cleaned = this.ensureAlternatingRoles(messages);

        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: options?.maxTokens || 4096,
            system: options?.systemPrompt,
            messages: cleaned,
            tools: [{ type: 'web_search_20250305' as any, name: 'web_search', max_uses: 5 }],
        } as any);

        // Extract text + source citations from response
        let text = '';
        const sources: NativeSearchResult['sources'] = [];

        for (const block of response.content) {
            if (block.type === 'text') {
                text += block.text;
            }
        }

        // Extract citations from tool_result blocks if present
        const raw = response as any;
        if (raw.citations) {
            for (const c of raw.citations) {
                sources.push({ title: c.title || c.url, url: c.url, snippet: c.cited_text });
            }
        }

        return { text, sources };
    }

    // --- Private utility methods ---

    /**
     * Convert our ContentBlock[] to Anthropic's native content format.
     * Handles both plain string content and multimodal (text + image) content.
     */
    private convertContent(content: string | ContentBlock[]): string | Anthropic.ContentBlockParam[] {
        if (typeof content === 'string') return content;
        return content.map(block => {
            if (block.type === 'text') {
                return { type: 'text' as const, text: block.text };
            }
            // Anthropic vision format
            return {
                type: 'image' as const,
                source: {
                    type: 'base64' as const,
                    media_type: block.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                    data: block.base64,
                }
            };
        });
    }

    /**
     * Ensure messages alternate user/assistant (required by Anthropic).
     * Merges consecutive same-role messages.
     */
    private ensureAlternatingRoles(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
        if (messages.length === 0) return [{ role: 'user', content: 'hello' }];

        const result: Anthropic.MessageParam[] = [];
        for (const msg of messages) {
            const last = result[result.length - 1];
            if (last && last.role === msg.role) {
                // Merge consecutive same-role messages
                last.content = `${last.content}\n\n${msg.content}`;
            } else {
                result.push({ ...msg });
            }
        }

        // First message must be 'user'
        if (result[0]?.role !== 'user') {
            result.unshift({ role: 'user', content: '(continue)' });
        }

        return result;
    }

    private isValidOrchestratorResponse(parsed: any): boolean {
        if (parsed.needsTool === true && parsed.tool) return true;
        if (parsed.needsTool === false && (parsed.taskComplete !== undefined || parsed.response)) return true;
        if (parsed.action) return true;
        return false;
    }

    private normalizeOrchestratorResponse(parsed: any): any {
        if (parsed.action && parsed.action !== 'complete') {
            return {
                needsTool: true,
                tool: parsed.action,
                args: parsed.args || {},
                reasoning: parsed.reasoning || parsed.action
            };
        }

        if (parsed.response || parsed.answer || parsed.result || parsed.output) {
            return {
                needsTool: false,
                taskComplete: true,
                response: parsed.response || parsed.answer || parsed.result || parsed.output || JSON.stringify(parsed),
                reasoning: parsed.reasoning || 'Task completed'
            };
        }

        return {
            needsTool: false,
            taskComplete: false,
            response: JSON.stringify(parsed),
            reasoning: 'Response did not match expected format',
            _normalized: true
        };
    }

    private extractJSON(content: string): any {
        let clean = content.trim();
        if (clean.startsWith('```json')) clean = clean.slice(7);
        if (clean.startsWith('```')) clean = clean.slice(3);
        if (clean.endsWith('```')) clean = clean.slice(0, -3);
        clean = clean.trim();

        try { return JSON.parse(clean); } catch { /* continue */ }

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { return JSON.parse(jsonMatch[0]); } catch { /* continue */ }
        }

        const arrayMatch = content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            try { return JSON.parse(arrayMatch[0]); } catch { /* continue */ }
        }

        return null;
    }
}
