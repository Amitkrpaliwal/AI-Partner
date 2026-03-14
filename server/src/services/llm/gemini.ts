import { GoogleGenerativeAI, GenerativeModel, Content, Part } from '@google/generative-ai';
import { LLMAdapter, GenerationOptions, Model, ContentBlock, HistoryMessage, NativeSearchResult } from './types.js';

/**
 * Native Google Gemini Adapter
 *
 * Uses the official @google/generative-ai SDK.
 * Supports Gemini-specific features: grounding, code execution, structured output.
 */
export class GeminiAdapter implements LLMAdapter {
    public model: string;
    readonly nativeSearch = true;
    private genAI: GoogleGenerativeAI | null = null;
    private generativeModel: GenerativeModel | null = null;
    private apiKey: string;
    private isConnected: boolean = false;

    constructor(apiKey: string = '', defaultModel: string = 'gemini-2.0-flash') {
        this.apiKey = apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
        this.model = defaultModel;
    }

    async connect(): Promise<void> {
        if (!this.apiKey) {
            console.warn('[gemini] No API key configured — skipping');
            this.isConnected = false;
            return;
        }

        // Just initialize the SDK — no API call needed.
        // Actual connectivity errors will surface on first generate() call.
        this.genAI = new GoogleGenerativeAI(this.apiKey);
        this.generativeModel = this.genAI.getGenerativeModel({ model: this.model });
        this.isConnected = true;
        console.log(`✓ gemini connected (${this.model})`);
    }

    async disconnect(): Promise<void> {
        this.genAI = null;
        this.generativeModel = null;
        this.isConnected = false;
    }

    async isAvailable(): Promise<boolean> {
        // Available as long as we have an API key and the SDK is initialized.
        // Don't make a real API call here — it wastes quota and can fail with
        // rate limits, causing models to disappear from the UI.
        return !!(this.genAI && this.apiKey);
    }

    async listModels(): Promise<Model[]> {
        // Try to fetch the live model list from the Gemini REST API
        if (this.apiKey) {
            try {
                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}&pageSize=100`
                );
                if (res.ok) {
                    const data = await res.json() as { models?: any[] };
                    const geminiModels = (data.models || [])
                        // Only keep models that support text generation (not embedding-only)
                        .filter((m: any) =>
                            Array.isArray(m.supportedGenerationMethods) &&
                            m.supportedGenerationMethods.includes('generateContent')
                        )
                        .map((m: any) => {
                            // API returns "models/gemini-2.0-flash" — strip the prefix
                            const id = (m.name as string).replace(/^models\//, '');
                            const displayName = m.displayName || id;
                            return {
                                id,
                                name: displayName,
                                provider: 'gemini',
                                capabilities: {
                                    chat: true,
                                    completion: true,
                                    embedding: id.includes('embed'),
                                    vision: true
                                }
                            };
                        });

                    if (geminiModels.length > 0) {
                        console.log(`[GeminiAdapter] Discovered ${geminiModels.length} models from API`);
                        return geminiModels;
                    }
                }
            } catch (e: any) {
                console.warn(`[GeminiAdapter] Failed to fetch model list from API: ${e.message}`);
            }
        }

        // Fallback: curated list of well-known models
        const fallback = [
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { id: 'gemini-2.5-pro-preview-03-25', name: 'Gemini 2.5 Pro Preview (Mar 25)' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
            { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
            { id: 'gemini-2.0-pro-exp', name: 'Gemini 2.0 Pro (Experimental)' },
            { id: 'gemini-2.0-flash-thinking-exp', name: 'Gemini 2.0 Flash Thinking (Experimental)' },
            { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
            { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
            { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B' },
        ];

        return fallback.map(({ id, name }) => ({
            id,
            name,
            provider: 'gemini',
            capabilities: { chat: true, completion: true, embedding: false, vision: true }
        }));
    }

    setModel(modelId: string): void {
        this.model = modelId;
        if (this.genAI) {
            this.generativeModel = this.genAI.getGenerativeModel({ model: modelId });
        }
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        if (!this.genAI) throw new Error('Gemini not connected');

        const model = this.genAI.getGenerativeModel({
            model: this.model,
            systemInstruction: options?.systemPrompt || undefined,
            generationConfig: {
                temperature: options?.temperature ?? 0.7,
                maxOutputTokens: options?.maxTokens || 4096
            }
        });

        // Build chat history if provided
        if (options?.history && options.history.length > 0) {
            const history = this.convertHistory(options.history);
            const chat = model.startChat({ history });
            const result = await chat.sendMessage(prompt);
            return result.response.text();
        }

        // Simple generation
        const result = await model.generateContent(prompt);
        return result.response.text();
    }

    async generateJSON(prompt: string, schema?: any, options?: GenerationOptions): Promise<any> {
        if (!this.genAI) throw new Error('Gemini not connected');

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

                const model = this.genAI.getGenerativeModel({
                    model: this.model,
                    systemInstruction: jsonSystemPrompt,
                    generationConfig: {
                        temperature: attempt === 1 ? 0.1 : 0.05,
                        maxOutputTokens: options?.maxTokens || 2048,
                        responseMimeType: 'application/json'
                    }
                });

                let content: string;

                if (options?.history && options.history.length > 0) {
                    const history = this.convertHistory(options.history);
                    const chat = model.startChat({ history });
                    const result = await chat.sendMessage(enhancedPrompt);
                    content = result.response.text();
                } else {
                    const result = await model.generateContent(enhancedPrompt);
                    content = result.response.text();
                }

                const parsed = this.extractJSON(content);
                if (parsed) {
                    // If the response has a 'tool' field, it's for ReActReasoner or similar
                    // — return it raw without orchestrator normalization which would strip 'tool'.
                    if (parsed.tool && typeof parsed.tool === 'string') return parsed;
                    if (this.isValidOrchestratorResponse(parsed)) return parsed;
                    // Only normalize if it looks like a chat orchestrator response
                    const looksLikeOrchestrator = 'needsTool' in parsed || 'taskComplete' in parsed ||
                        'response' in parsed || 'action' in parsed;
                    if (looksLikeOrchestrator) return this.normalizeOrchestratorResponse(parsed);
                    // For all other schemas (GoalExtractor, SelfCorrector, etc.) return raw
                    return parsed;
                }

                lastError = Object.assign(
                    new Error(`Non-JSON response: ${content.substring(0, 100)}`),
                    { rawText: content }
                );
                console.warn(`[gemini] Attempt ${attempt}/${MAX_RETRIES}: Failed to parse JSON`);
            } catch (error: any) {
                lastError = error;
                console.warn(`[gemini] Attempt ${attempt}/${MAX_RETRIES}: Error - ${error.message}`);
            }
        }

        // All retries failed — throw so callers can extract rawText for prose-based fallback
        console.error('[gemini] All JSON generation attempts failed');
        const err = Object.assign(
            new Error(`All JSON generation attempts failed: ${lastError?.message}`),
            { rawText: (lastError as any)?.rawText || '' }
        );
        throw err;
    }

    async *stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string> {
        if (!this.genAI) throw new Error('Gemini not connected');

        const model = this.genAI.getGenerativeModel({
            model: this.model,
            systemInstruction: options?.systemPrompt || undefined,
            generationConfig: {
                temperature: options?.temperature ?? 0.7,
                maxOutputTokens: options?.maxTokens || 4096
            }
        });

        if (options?.history && options.history.length > 0) {
            const history = this.convertHistory(options.history);
            const chat = model.startChat({ history });
            const result = await chat.sendMessageStream(prompt);

            for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) yield text;
            }
        } else {
            const result = await model.generateContentStream(prompt);

            for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) yield text;
            }
        }
    }

    async generateWithSearch(prompt: string, options?: GenerationOptions): Promise<NativeSearchResult> {
        if (!this.genAI) throw new Error('Gemini not connected');

        // Use Google Search grounding tool
        const model = this.genAI.getGenerativeModel({
            model: this.model,
            systemInstruction: options?.systemPrompt,
            tools: [{ googleSearch: {} } as any],
            generationConfig: {
                temperature: options?.temperature ?? 0.5,
                maxOutputTokens: options?.maxTokens || 4096,
            }
        });

        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();

        // Extract grounding sources from metadata
        const sources: NativeSearchResult['sources'] = [];
        const grounding = (response as any).candidates?.[0]?.groundingMetadata;
        if (grounding?.groundingChunks) {
            for (const chunk of grounding.groundingChunks) {
                const web = chunk.web;
                if (web?.uri) {
                    sources.push({ title: web.title || web.uri, url: web.uri });
                }
            }
        }

        return { text, sources };
    }

    // --- Private utility methods ---

    /**
     * Convert generic history format to Gemini Content format.
     * Handles multimodal content (text + images) via inlineData.
     */
    private convertHistory(history: HistoryMessage[]): Content[] {
        const result: Content[] = [];

        for (const h of history) {
            if (h.role === 'system') continue; // System goes in systemInstruction

            const role = h.role === 'assistant' ? 'model' : 'user';

            // Convert content to Gemini Parts
            let parts: Part[];
            if (typeof h.content === 'string') {
                parts = [{ text: h.content }];
            } else {
                parts = h.content.map(block => {
                    if (block.type === 'text') {
                        return { text: block.text } as Part;
                    }
                    // Gemini inlineData format for images
                    return {
                        inlineData: {
                            mimeType: block.mimeType,
                            data: block.base64
                        }
                    } as Part;
                });
            }

            const last = result[result.length - 1];

            // Gemini requires alternating user/model roles
            if (last && last.role === role) {
                (last.parts as Part[]).push(...parts);
            } else {
                result.push({ role, parts });
            }
        }

        // First message must be 'user'
        if (result.length > 0 && result[0].role !== 'user') {
            result.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
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
        // Strip Gemini 2.5 Pro / reasoning-model <think>...</think> blocks first
        let clean = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
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
