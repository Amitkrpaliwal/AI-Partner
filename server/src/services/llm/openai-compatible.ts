import OpenAI from 'openai';
import { LLMAdapter, GenerationOptions, Model, ContentBlock, NativeSearchResult } from './types';

/**
 * OpenAI-Compatible LLM Adapter
 *
 * Works with ANY provider that exposes an OpenAI-compatible API:
 * - OpenAI (GPT-4o, GPT-4o-mini, o1, o3)
 * - Anthropic (via OpenAI-compatible proxy)
 * - Google Gemini (via OpenAI-compatible endpoint)
 * - Groq, Together, DeepSeek, Mistral, Fireworks
 * - Any local server at /v1/chat/completions (vLLM, text-gen-webui, etc.)
 */
export class OpenAICompatibleAdapter implements LLMAdapter {
    public model: string;
    private client: OpenAI | null = null;
    private baseURL: string;
    private apiKey: string;
    private providerName: string;
    private isConnected: boolean = false;
    private customHeaders: Record<string, string>;

    /** OpenAI and Groq support native search */
    get nativeSearch(): boolean {
        return this.providerName === 'openai' || this.providerName === 'groq';
    }

    constructor(
        providerName: string = 'openai',
        baseURL: string = 'https://api.openai.com/v1',
        apiKey: string = '',
        defaultModel: string = 'gpt-4o-mini',
        customHeaders: Record<string, string> = {}
    ) {
        this.providerName = providerName;
        this.baseURL = baseURL;
        this.apiKey = apiKey || process.env.OPENAI_API_KEY || '';
        this.model = defaultModel;
        // OpenRouter attribution headers (optional but recommended)
        if (providerName === 'openrouter' && Object.keys(customHeaders).length === 0) {
            this.customHeaders = { 'HTTP-Referer': 'https://ai-partner.local', 'X-Title': 'AI Partner' };
        } else {
            this.customHeaders = customHeaders;
        }
    }

    async connect(): Promise<void> {
        try {
            if (!this.apiKey) {
                console.warn(`[${this.providerName}] No API key configured — skipping`);
                this.isConnected = false;
                return;
            }

            this.client = new OpenAI({
                apiKey: this.apiKey,
                baseURL: this.baseURL,
                timeout: 60000,
                maxRetries: 2,
                defaultHeaders: Object.keys(this.customHeaders).length > 0 ? this.customHeaders : undefined
            });

            // Quick health check — 8s cap, no retries so startup doesn't stall
            const models = await this.client.models.list({ maxRetries: 0, timeout: 8000 } as any);
            this.isConnected = true;
            console.log(`✓ ${this.providerName} connected (${this.baseURL}) — ${models.data.length} models`);
        } catch (e: any) {
            // Some providers don't support models.list — try a ping completion instead
            // Use tight timeout so startup doesn't stall on unreachable providers
            if (this.client && !e.message?.includes('timed out') && !e.message?.includes('timeout')) {
                try {
                    await this.client.chat.completions.create({
                        model: this.model,
                        messages: [{ role: 'user', content: 'hi' }],
                        max_tokens: 1
                    }, { maxRetries: 0, timeout: 8000 } as any);
                    this.isConnected = true;
                    console.log(`✓ ${this.providerName} connected (${this.baseURL})`);
                    return;
                } catch {
                    // Fall through
                }
            }
            console.warn(`✗ ${this.providerName} connection failed: ${e.message}`);
            this.isConnected = false;
        }
    }

    async disconnect(): Promise<void> {
        this.client = null;
        this.isConnected = false;
    }

    async isAvailable(): Promise<boolean> {
        if (!this.client || !this.apiKey) return false;
        try {
            // 5s cap, no retries — this is called in hot paths (discoverModels, healthCheck)
            await this.client.models.list({ maxRetries: 0, timeout: 5000 } as any);
            return true;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<Model[]> {
        if (!this.client) return [];
        try {
            const list = await this.client.models.list();
            return list.data.map(m => ({
                id: m.id,
                name: m.id,
                provider: this.providerName,
                capabilities: {
                    chat: true,
                    completion: true,
                    embedding: m.id.includes('embed'),
                    vision: m.id.includes('vision') || m.id.includes('4o') || m.id.includes('gemini')
                }
            }));
        } catch {
            // If listing fails, return the configured model
            return [{
                id: this.model,
                name: this.model,
                provider: this.providerName,
                capabilities: { chat: true, completion: true, embedding: false, vision: false }
            }];
        }
    }

    setModel(modelId: string): void {
        this.model = modelId;
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        if (!this.client) throw new Error(`${this.providerName} not connected`);

        const messages: OpenAI.ChatCompletionMessageParam[] = [];

        if (options?.systemPrompt) {
            messages.push({ role: 'system', content: options.systemPrompt });
        }

        if (options?.history) {
            for (const h of options.history) {
                messages.push({
                    role: h.role as 'user' | 'assistant' | 'system',
                    content: this.convertContent(h.content) as any
                });
            }
        }

        messages.push({ role: 'user', content: prompt });

        const response = await this.client.chat.completions.create({
            model: this.model,
            messages,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.maxTokens || 4096
        });

        return response.choices[0]?.message?.content || '';
    }

    async generateJSON(prompt: string, schema?: any, options?: GenerationOptions): Promise<any> {
        if (!this.client) throw new Error(`${this.providerName} not connected`);

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

                const messages: OpenAI.ChatCompletionMessageParam[] = [
                    { role: 'system', content: jsonSystemPrompt }
                ];

                if (options?.history) {
                    for (const h of options.history) {
                        messages.push({
                            role: h.role as 'user' | 'assistant' | 'system',
                            content: this.convertContent(h.content) as any
                        });
                    }
                }

                messages.push({ role: 'user', content: enhancedPrompt });

                const response = await this.client.chat.completions.create({
                    model: this.model,
                    messages,
                    temperature: attempt === 1 ? 0.1 : 0.05,
                    max_tokens: options?.maxTokens || 2048,
                    response_format: { type: 'json_object' }
                });

                const content = response.choices[0]?.message?.content?.trim() || '';
                const parsed = this.extractJSON(content);

                if (parsed) {
                    if (this.isValidOrchestratorResponse(parsed)) {
                        return parsed;
                    }
                    return this.normalizeOrchestratorResponse(parsed);
                }

                // Preserve raw response text so callers (e.g. ReActReasoner Tier 2) can
                // fall back to prose-based tool extraction even when JSON parsing fails.
                lastError = Object.assign(
                    new Error(`Non-JSON response: ${content.substring(0, 100)}`),
                    { rawText: content }
                );
                console.warn(`[${this.providerName}] Attempt ${attempt}/${MAX_RETRIES}: Failed to parse JSON`);
            } catch (error: any) {
                // If the provider doesn't support response_format, retry without it
                if (error.message?.includes('response_format') && attempt === 1) {
                    console.warn(`[${this.providerName}] response_format not supported, retrying without it`);
                    try {
                        return await this.generateJSONFallback(prompt, schema, options);
                    } catch (e2) {
                        lastError = e2;
                    }
                } else {
                    lastError = error;
                }
                console.warn(`[${this.providerName}] Attempt ${attempt}/${MAX_RETRIES}: Error - ${error.message}`);
            }
        }

        console.error(`[${this.providerName}] All JSON generation attempts failed`);
        // Throw so callers can catch and extract rawText for prose-based fallback.
        const err = Object.assign(
            new Error(`All JSON generation attempts failed: ${lastError?.message}`),
            { rawText: lastError?.rawText || '' }
        );
        throw err;
    }

    /**
     * Fallback JSON generation without response_format (for providers that don't support it)
     */
    private async generateJSONFallback(prompt: string, schema?: any, options?: GenerationOptions): Promise<any> {
        const raw = await this.generate(
            `${prompt}\n\nRespond ONLY with valid JSON. No markdown, no explanation.`,
            { ...options, systemPrompt: 'You are a JSON-only response AI. Output ONLY valid JSON.' }
        );
        const parsed = this.extractJSON(raw);
        if (parsed) return parsed;
        throw new Error('JSON fallback also failed');
    }

    async *stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string> {
        if (!this.client) throw new Error(`${this.providerName} not connected`);

        const messages: OpenAI.ChatCompletionMessageParam[] = [];

        if (options?.systemPrompt) {
            messages.push({ role: 'system', content: options.systemPrompt });
        }

        if (options?.history) {
            for (const h of options.history) {
                messages.push({
                    role: h.role as 'user' | 'assistant' | 'system',
                    content: this.convertContent(h.content) as any
                });
            }
        }

        messages.push({ role: 'user', content: prompt });

        const stream = await this.client.chat.completions.create({
            model: this.model,
            messages,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.maxTokens || 4096,
            stream: true
        });

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
                yield content;
            }
        }
    }

    /**
     * Generate embeddings using the provider's embedding API
     */
    async embed(text: string, embeddingModel?: string): Promise<number[]> {
        if (!this.client) throw new Error(`${this.providerName} not connected`);

        const response = await this.client.embeddings.create({
            model: embeddingModel || 'text-embedding-3-small',
            input: text
        });

        return response.data[0].embedding;
    }

    // --- Utility methods ---

    /**
     * Convert our ContentBlock[] to OpenAI's content format.
     * Uses image_url with base64 data URIs for vision support.
     */
    private convertContent(content: string | ContentBlock[]): string | OpenAI.ChatCompletionContentPart[] {
        if (typeof content === 'string') return content;
        return content.map(block => {
            if (block.type === 'text') {
                return { type: 'text' as const, text: block.text };
            }
            // OpenAI vision format: image_url with data URI
            return {
                type: 'image_url' as const,
                image_url: {
                    url: `data:${block.mimeType};base64,${block.base64}`,
                    detail: 'auto' as const
                }
            };
        });
    }

    async generateWithSearch(prompt: string, options?: GenerationOptions): Promise<NativeSearchResult> {
        if (!this.client) throw new Error(`${this.providerName} not connected`);

        const sources: NativeSearchResult['sources'] = [];

        if (this.providerName === 'groq') {
            // Groq compound-beta: switch to search-enabled model
            const response = await (this.client as any).chat.completions.create({
                model: 'compound-beta',
                messages: [
                    ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
                    { role: 'user', content: prompt }
                ],
                temperature: options?.temperature ?? 0.5,
                max_tokens: options?.maxTokens || 4096,
            });
            const text = response.choices[0]?.message?.content || '';
            // Groq compound returns citations in tool_calls or annotations
            const annotations = response.choices[0]?.message?.annotations || [];
            for (const ann of annotations) {
                if (ann.url) sources.push({ title: ann.title || ann.url, url: ann.url });
            }
            return { text, sources };
        }

        // OpenAI: web_search_preview tool
        const response = await (this.client as any).responses.create({
            model: this.model.includes('search') ? this.model : 'gpt-4o-search-preview',
            tools: [{ type: 'web_search_preview' }],
            input: prompt,
        });

        const text = response.output_text || response.choices?.[0]?.message?.content || '';
        const outputItems = response.output || [];
        for (const item of outputItems) {
            if (item.type === 'web_search_call') continue;
            if (item.type === 'message') {
                for (const part of (item.content || [])) {
                    for (const ann of (part.annotations || [])) {
                        if (ann.type === 'url_citation') {
                            sources.push({ title: ann.title || ann.url, url: ann.url, snippet: ann.text });
                        }
                    }
                }
            }
        }
        return { text, sources };
    }

    private isValidOrchestratorResponse(parsed: any): boolean {
        if (parsed.needsTool === true && parsed.tool) return true;
        if (parsed.needsTool === false && (parsed.taskComplete !== undefined || parsed.response)) return true;
        if (parsed.action) return true;
        // ReAct tool-call format: {"tool": "name", "args": {...}, "reasoning": "..."}
        // This must be returned as-is — DO NOT normalize it into a chat response wrapper.
        if (parsed.tool && typeof parsed.tool === 'string') return true;
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
        // Strip DeepSeek / reasoning-model <think>...</think> blocks first.
        // These contain free-form prose (and sometimes partial JSON) that
        // completely break regex-based extraction.
        let clean = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        // Strip markdown code fences
        if (clean.startsWith('```json')) clean = clean.slice(7);
        if (clean.startsWith('```')) clean = clean.slice(3);
        if (clean.endsWith('```')) clean = clean.slice(0, -3);
        clean = clean.trim();

        try { return JSON.parse(clean); } catch { /* continue */ }

        // Find the LAST JSON object — models sometimes put explanation before the JSON
        const allObjectMatches = [...clean.matchAll(/\{[\s\S]*?\}/g)];
        for (let i = allObjectMatches.length - 1; i >= 0; i--) {
            try { return JSON.parse(allObjectMatches[i][0]); } catch { /* continue */ }
        }
        // Greedy fallback (whole content)
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try { return JSON.parse(jsonMatch[0]); } catch { /* continue */ }
        }

        const arrayMatch = clean.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            try { return JSON.parse(arrayMatch[0]); } catch { /* continue */ }
        }

        return null;
    }
}
