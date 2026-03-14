import ollama from 'ollama';
import type { EmbeddingProvider } from '../EmbeddingProvider';

/**
 * OllamaEmbedding — Local embedding via Ollama (Phase 16.2)
 *
 * Uses nomic-embed-text (768 dimensions) by default.
 * Requires Ollama running locally with the model pulled.
 */
export class OllamaEmbedding implements EmbeddingProvider {
    readonly name = 'ollama';
    readonly dimensions: number;
    private model: string;
    private available: boolean | null = null;

    constructor(model: string = 'nomic-embed-text', dimensions: number = 768) {
        this.model = model;
        this.dimensions = dimensions;
    }

    async isAvailable(): Promise<boolean> {
        if (this.available !== null) return this.available;
        try {
            await ollama.embed({ model: this.model, input: 'test' });
            this.available = true;
            console.log(`[OllamaEmbedding] Model "${this.model}" available (${this.dimensions}d)`);
        } catch {
            this.available = false;
            console.warn(`[OllamaEmbedding] Model "${this.model}" not available. Run: ollama pull ${this.model}`);
        }
        return this.available;
    }

    async embed(text: string): Promise<Float32Array | null> {
        try {
            const response = await ollama.embed({ model: this.model, input: text });
            if (response.embeddings && response.embeddings.length > 0) {
                return new Float32Array(response.embeddings[0]);
            }
            return null;
        } catch (error) {
            console.error('[OllamaEmbedding] Embedding failed:', error);
            return null;
        }
    }

    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        try {
            const response = await ollama.embed({ model: this.model, input: texts });
            return response.embeddings.map(e => new Float32Array(e));
        } catch {
            return texts.map(() => null);
        }
    }
}
