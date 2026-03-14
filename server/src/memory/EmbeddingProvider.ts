/**
 * EmbeddingProvider — Abstract interface for embedding backends (Phase 16)
 *
 * Providers: Ollama (local), OpenAI, Cohere, LocalTF-IDF (zero-dep fallback)
 * Each provider produces fixed-dimension float vectors from text.
 */

export interface EmbeddingResult {
    embedding: Float32Array;
    dimensions: number;
    provider: string;
}

export interface EmbeddingProvider {
    /** Human-readable provider name */
    readonly name: string;

    /** Number of dimensions this provider produces */
    readonly dimensions: number;

    /** Check if this provider is currently available (API key set, service reachable, etc.) */
    isAvailable(): Promise<boolean>;

    /** Embed a single text string */
    embed(text: string): Promise<Float32Array | null>;

    /** Embed multiple texts in one call (providers that support batching) */
    embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}
