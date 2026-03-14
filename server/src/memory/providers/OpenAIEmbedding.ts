import type { EmbeddingProvider } from '../EmbeddingProvider';

/**
 * OpenAIEmbedding — Cloud embedding via OpenAI API (Phase 16.3)
 *
 * Uses text-embedding-3-small (1536 dimensions) by default.
 * Requires OPENAI_API_KEY environment variable.
 */
export class OpenAIEmbedding implements EmbeddingProvider {
    readonly name = 'openai';
    readonly dimensions: number;
    private model: string;
    private apiKey: string | null;
    private baseUrl: string;

    constructor(
        model: string = 'text-embedding-3-small',
        dimensions: number = 1536,
        apiKey?: string,
        baseUrl?: string
    ) {
        this.model = model;
        this.dimensions = dimensions;
        this.apiKey = apiKey || process.env.OPENAI_API_KEY || null;
        this.baseUrl = baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    }

    async isAvailable(): Promise<boolean> {
        if (!this.apiKey) {
            console.log('[OpenAIEmbedding] No API key configured');
            return false;
        }
        try {
            // Lightweight test call
            const result = await this.callApi(['test']);
            return result !== null;
        } catch {
            return false;
        }
    }

    async embed(text: string): Promise<Float32Array | null> {
        if (!this.apiKey) return null;
        try {
            const result = await this.callApi([text]);
            if (result && result.length > 0) {
                return new Float32Array(result[0]);
            }
            return null;
        } catch (error) {
            console.error('[OpenAIEmbedding] Embedding failed:', error);
            return null;
        }
    }

    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        if (!this.apiKey) return texts.map(() => null);
        try {
            const result = await this.callApi(texts);
            if (result) {
                return result.map(e => new Float32Array(e));
            }
            return texts.map(() => null);
        } catch {
            return texts.map(() => null);
        }
    }

    private async callApi(inputs: string[]): Promise<number[][] | null> {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                input: inputs,
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`[OpenAIEmbedding] API error ${res.status}: ${err}`);
            return null;
        }

        const data = await res.json();
        // Sort by index to ensure correct ordering
        const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
        return sorted.map((item: any) => item.embedding);
    }
}
