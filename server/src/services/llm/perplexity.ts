import axios from 'axios';
import { LLMAdapter, GenerationOptions, Model, NativeSearchResult } from './types';

/**
 * Perplexity AI Adapter
 *
 * Perplexity's entire API is search-augmented — every response is grounded
 * in real-time web results with structured citations.
 *
 * Online models (sonar-pro, sonar): search every request
 * Offline models (sonar-reasoning): reasoning only, no search
 *
 * Docs: https://docs.perplexity.ai
 */
export class PerplexityAdapter implements LLMAdapter {
    public model: string;
    readonly nativeSearch = true;
    private apiKey: string;
    private baseURL = 'https://api.perplexity.ai';
    private isConnected: boolean = false;

    constructor(apiKey: string = '', defaultModel: string = 'sonar-pro') {
        this.apiKey = apiKey || process.env.PERPLEXITY_API_KEY || '';
        this.model = defaultModel;
    }

    async connect(): Promise<void> {
        if (!this.apiKey) {
            console.warn('[perplexity] No API key configured — skipping');
            this.isConnected = false;
            return;
        }
        this.isConnected = true;
        console.log(`✓ perplexity connected (${this.model})`);
    }

    async disconnect(): Promise<void> {
        this.isConnected = false;
    }

    async isAvailable(): Promise<boolean> {
        return !!(this.apiKey && this.isConnected);
    }

    async listModels(): Promise<Model[]> {
        const models = [
            { id: 'sonar-pro', name: 'Sonar Pro (search)', searchEnabled: true },
            { id: 'sonar', name: 'Sonar (search)', searchEnabled: true },
            { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', searchEnabled: true },
            { id: 'sonar-reasoning', name: 'Sonar Reasoning', searchEnabled: true },
            { id: 'r1-1776', name: 'R1-1776 (offline)', searchEnabled: false },
        ];
        return models.map(m => ({
            id: m.id,
            name: m.name,
            provider: 'perplexity',
            capabilities: { chat: true, completion: true, embedding: false, vision: false }
        }));
    }

    setModel(modelId: string): void {
        this.model = modelId;
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        const result = await this.generateWithSearch(prompt, options);
        return result.text;
    }

    async generateJSON(prompt: string, _schema?: any, options?: GenerationOptions): Promise<any> {
        const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON, no markdown, no explanation.`;
        const text = await this.generate(jsonPrompt, { ...options, temperature: 0.1 });

        let clean = text.trim();
        if (clean.startsWith('```json')) clean = clean.slice(7);
        if (clean.startsWith('```')) clean = clean.slice(3);
        if (clean.endsWith('```')) clean = clean.slice(0, -3);
        clean = clean.trim();

        try { return JSON.parse(clean); } catch { /* fall through */ }
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }

        return { _parseError: true, needsTool: false, taskComplete: false, response: text };
    }

    async *stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string> {
        const response = await axios.post(
            `${this.baseURL}/chat/completions`,
            {
                model: this.model,
                messages: [
                    ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
                    ...(options?.history?.map(h => ({ role: h.role, content: h.content })) || []),
                    { role: 'user', content: prompt }
                ],
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.maxTokens || 4096,
                stream: true,
            },
            {
                headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
                responseType: 'stream',
            }
        );

        for await (const chunk of response.data) {
            const lines = chunk.toString().split('\n').filter((l: string) => l.startsWith('data: '));
            for (const line of lines) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') return;
                try {
                    const parsed = JSON.parse(data);
                    const token = parsed.choices?.[0]?.delta?.content;
                    if (token) yield token;
                } catch { /* skip malformed chunks */ }
            }
        }
    }

    async generateWithSearch(prompt: string, options?: GenerationOptions): Promise<NativeSearchResult> {
        const response = await axios.post(
            `${this.baseURL}/chat/completions`,
            {
                model: this.model,
                messages: [
                    ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
                    ...(options?.history?.map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : '' })) || []),
                    { role: 'user', content: prompt }
                ],
                temperature: options?.temperature ?? 0.5,
                max_tokens: options?.maxTokens || 4096,
                return_citations: true,
                return_images: false,
            },
            {
                headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            }
        );

        const data = response.data;
        const text = data.choices?.[0]?.message?.content || '';
        const sources: NativeSearchResult['sources'] = [];

        // Perplexity returns citations as an array of URLs
        for (const citation of (data.citations || [])) {
            if (typeof citation === 'string') {
                sources.push({ title: citation, url: citation });
            } else if (citation.url) {
                sources.push({ title: citation.title || citation.url, url: citation.url, snippet: citation.text });
            }
        }

        return { text, sources };
    }
}
