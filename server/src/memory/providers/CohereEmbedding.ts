import type { EmbeddingProvider } from '../EmbeddingProvider';

/**
 * CohereEmbedding — Cloud embedding via Cohere API (Phase 16.4)
 *
 * Uses embed-english-v3.0 (1024 dimensions) by default.
 * Requires COHERE_API_KEY environment variable.
 */
export class CohereEmbedding implements EmbeddingProvider {
    readonly name = 'cohere';
    readonly dimensions: number;
    private model: string;
    private apiKey: string | null;

    constructor(
        model: string = 'embed-english-v3.0',
        dimensions: number = 1024,
        apiKey?: string
    ) {
        this.model = model;
        this.dimensions = dimensions;
        this.apiKey = apiKey || process.env.COHERE_API_KEY || null;
    }

    async isAvailable(): Promise<boolean> {
        if (!this.apiKey) {
            console.log('[CohereEmbedding] No API key configured');
            return false;
        }
        try {
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
            console.error('[CohereEmbedding] Embedding failed:', error);
            return null;
        }
    }

    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        if (!this.apiKey) return texts.map(() => null);
        try {
            // Cohere has a batch limit of 96 texts
            const batchSize = 96;
            const results: (Float32Array | null)[] = [];
            for (let i = 0; i < texts.length; i += batchSize) {
                const batch = texts.slice(i, i + batchSize);
                const embeddings = await this.callApi(batch);
                if (embeddings) {
                    results.push(...embeddings.map(e => new Float32Array(e)));
                } else {
                    results.push(...batch.map(() => null));
                }
            }
            return results;
        } catch {
            return texts.map(() => null);
        }
    }

    private async callApi(texts: string[]): Promise<number[][] | null> {
        const res = await fetch('https://api.cohere.ai/v1/embed', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                texts,
                input_type: 'search_document',
                truncate: 'END',
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`[CohereEmbedding] API error ${res.status}: ${err}`);
            return null;
        }

        const data = await res.json();
        return data.embeddings;
    }
}
