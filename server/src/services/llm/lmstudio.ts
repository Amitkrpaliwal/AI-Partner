import axios from 'axios';
import { LLMAdapter, GenerationOptions, Model, HistoryMessage } from './types';

export class LMStudioAdapter implements LLMAdapter {
    public model: string;
    private isConnected: boolean = false;
    private baseUrl: string = 'http://localhost:1234/v1';

    constructor(model: string = 'local-model') {
        this.baseUrl = process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
        this.model = model;
    }

    /** Reconfigure base URL at runtime without restart */
    updateBaseUrl(newUrl: string): void {
        process.env.LMSTUDIO_BASE_URL = newUrl;
        this.baseUrl = newUrl;
        console.log(`[LMStudioAdapter] Base URL updated to ${newUrl}`);
    }

    async connect(): Promise<void> {
        try {
            await axios.get(`${this.baseUrl}/models`, { timeout: 2000 });
            console.log('✓ LM Studio connected');
        } catch (error) {
            console.warn(`LM Studio connection failed: ${(error as any).message}`);
            // Don't throw, just log. allow app to start.
        }
    }

    async disconnect(): Promise<void> {
        // No persistent connection
    }

    async isAvailable(): Promise<boolean> {
        try {
            await axios.get(`${this.baseUrl}/models`, { timeout: 1000 });
            return true;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<Model[]> {
        try {
            const response = await axios.get(`${this.baseUrl}/models`);
            // LM Studio returns OpenAI-style response
            // { object: 'list', data: [ { id: 'model-name', ... } ] }

            return response.data.data.map((model: any) => ({
                id: model.id,
                name: model.id,
                provider: 'lmstudio',
                capabilities: {
                    chat: true,
                    completion: true,
                    embedding: false,
                    vision: false,
                },
            }));
        } catch (e) {
            console.error('Failed to list LM Studio models', e);
            return [];
        }
    }

    setModel(modelId: string): void {
        this.model = modelId;
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        const messages: { role: string; content: string }[] = [];
        if (options?.systemPrompt) {
            messages.push({ role: 'system', content: options.systemPrompt });
        }
        if (options?.history) {
            messages.push(...options.history.map(h => ({ role: h.role, content: this.toTextOnly(h) })));
        }
        messages.push({ role: 'user', content: prompt });

        // Use current model or try to let LM Studio decide (often 'local-model' alias works)
        // IMPORTANT: LM Studio requires 'model' field, even if ignored.
        const modelToUse = this.model || 'local-model';

        try {
            const response = await axios.post(`${this.baseUrl}/v1/chat/completions`, {
                model: modelToUse,
                messages,
                temperature: options?.temperature || 0.7,
                max_tokens: options?.maxTokens || -1,
                stream: false,
            });

            return response.data.choices[0].message.content;
        } catch (error) {
            console.error('LM Studio Generate Error:', (error as any).message);
            throw error;
        }
    }

    async generateJSON(prompt: string, schema?: any, options?: GenerationOptions): Promise<any> {
        const MAX_RETRIES = 3;
        let lastError: any = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Build a stronger JSON-forcing prompt
                const jsonSystemPrompt = `You are a JSON-only response AI. You MUST respond with valid JSON only.
CRITICAL RULES:
1. Your response must be ONLY valid JSON - no text before or after
2. No markdown code blocks, no explanations, just pure JSON
3. Always include required fields from the expected schema
4. If you don't know something, use reasonable defaults

${options?.systemPrompt || ''}`;

                // Add schema hint to the prompt if available
                const enhancedPrompt = schema && Object.keys(schema).length > 0
                    ? `${prompt}\n\nExpected JSON schema: ${JSON.stringify(schema)}\n\nRespond ONLY with valid JSON:`
                    : `${prompt}\n\nRespond ONLY with valid JSON:`;

                const messages: { role: string; content: string }[] = [
                    { role: 'system', content: jsonSystemPrompt },
                    ...(options?.history?.map(h => ({ role: h.role, content: this.toTextOnly(h) })) || []),
                    { role: 'user', content: enhancedPrompt }
                ];

                const response = await axios.post(`${this.baseUrl}/v1/chat/completions`, {
                    model: this.model || 'local-model',
                    messages,
                    temperature: attempt === 1 ? 0.1 : 0.05, // Lower temp on retries
                    stream: false,
                    response_format: { type: "json_object" } // Try native JSON mode
                });

                const content = response.data.choices[0].message.content;
                const parsed = this.extractJSON(content);

                if (parsed) {
                    // Validate and normalize response
                    if (this.isValidOrchestratorResponse(parsed)) {
                        return parsed;
                    }
                    return this.normalizeOrchestratorResponse(parsed);
                }

                lastError = Object.assign(
                    new Error(`Non-JSON response: ${content.substring(0, 100)}`),
                    { rawText: content }
                );
                console.warn(`[LMStudio] Attempt ${attempt}/${MAX_RETRIES}: Failed to parse JSON, retrying...`);

            } catch (e) {
                lastError = e;
                console.warn(`[LMStudio] Attempt ${attempt}/${MAX_RETRIES}: Error - ${e}`);
            }
        }

        // All retries failed — throw so callers can extract rawText for prose-based fallback
        console.error('[LMStudio] All JSON generation attempts failed');
        const err = Object.assign(
            new Error(`All JSON generation attempts failed: ${lastError?.message}`),
            { rawText: (lastError as any)?.rawText || '' }
        );
        throw err;
    }

    /**
     * Extract JSON from a response that might contain markdown or plain text
     */
    private extractJSON(content: string): any {
        // Strip DeepSeek / reasoning-model <think>...</think> blocks first
        let clean = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        // Clean markdown code blocks
        if (clean.startsWith('```json')) clean = clean.slice(7);
        if (clean.startsWith('```')) clean = clean.slice(3);
        if (clean.endsWith('```')) clean = clean.slice(0, -3);
        clean = clean.trim();

        // Try direct parse first
        try {
            return JSON.parse(clean);
        } catch (e) {
            // Ignore and try other methods
        }

        // Try all JSON objects, prefer last (model often puts explanation before JSON)
        const allObjectMatches = [...clean.matchAll(/\{[\s\S]*?\}/g)];
        for (let i = allObjectMatches.length - 1; i >= 0; i--) {
            try { return JSON.parse(allObjectMatches[i][0]); } catch { /* continue */ }
        }
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (e) {
                // Ignore
            }
        }

        return null;
    }

    /**
     * Check if response has required orchestrator fields
     */
    private isValidOrchestratorResponse(parsed: any): boolean {
        if (parsed.needsTool === true && parsed.tool) return true;
        if (parsed.needsTool === false && (parsed.taskComplete !== undefined || parsed.response)) return true;
        if (parsed.action) return true;
        // ReAct tool-call format: {"tool": "name", "args": {...}, "reasoning": "..."}
        if (parsed.tool && typeof parsed.tool === 'string') return true;
        return false;
    }

    /**
     * Normalize a partial response into a valid orchestrator format
     */
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

        // Default: return as-is rather than forcing list_directory (which causes loops)
        return {
            needsTool: false,
            taskComplete: false,
            response: JSON.stringify(parsed),
            reasoning: 'Response did not match expected format',
            _normalized: true
        };
    }

    async *stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string> {
        const messages: { role: string; content: string }[] = [];
        if (options?.systemPrompt) {
            messages.push({ role: 'system', content: options.systemPrompt });
        }
        if (options?.history) {
            messages.push(...options.history.map(h => ({ role: h.role, content: this.toTextOnly(h) })));
        }
        messages.push({ role: 'user', content: prompt });

        try {
            const response = await axios.post(
                `${this.baseUrl}/v1/chat/completions`,
                {
                    model: this.model || 'local-model',
                    messages,
                    temperature: options?.temperature || 0.7,
                    stream: true,
                },
                { responseType: 'stream' }
            );

            // Handle stream
            for await (const chunk of response.data) {
                // Chunk is a buffer
                const lines = chunk.toString().split('\n').filter((line: string) => line.trim());
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') return;
                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices[0]?.delta?.content;
                            if (content) yield content;
                        } catch (e) {
                            // ignore partial chunks
                        }
                    }
                }
            }
        } catch (e) {
            console.error('LM Studio Stream Error:', e);
            throw e;
        }
    }

    /**
     * Convert multimodal content to text-only for non-vision models.
     */
    private toTextOnly(msg: HistoryMessage): string {
        if (typeof msg.content === 'string') return msg.content;
        const parts: string[] = [];
        for (const block of msg.content) {
            if (block.type === 'text') {
                parts.push(block.text);
            } else {
                parts.push('[image omitted — model does not support vision]');
            }
        }
        return parts.join('\n');
    }
}
