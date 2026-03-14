import type { EmbeddingProvider } from '../EmbeddingProvider';

/**
 * LocalTFIDFEmbedding — Zero-dependency TF-IDF embedding fallback (Phase 16.5)
 *
 * Produces sparse-ish vectors using hashed TF-IDF features.
 * Not as good as neural embeddings but works offline with no external services.
 * Always available as the last resort in the provider chain.
 *
 * Approach: Hash each word/bigram into a fixed-size vector bucket,
 * weight by TF-IDF-like scoring (log frequency dampening).
 */

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
    'just', 'because', 'if', 'when', 'while', 'where', 'how', 'what',
    'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me',
    'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
    'it', 'its', 'they', 'them', 'their',
]);

export class LocalTFIDFEmbedding implements EmbeddingProvider {
    readonly name = 'local-tfidf';
    readonly dimensions: number;

    constructor(dimensions: number = 256) {
        this.dimensions = dimensions;
    }

    async isAvailable(): Promise<boolean> {
        return true; // Always available — no external dependencies
    }

    async embed(text: string): Promise<Float32Array | null> {
        return this.computeEmbedding(text);
    }

    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        return texts.map(t => this.computeEmbedding(t));
    }

    private computeEmbedding(text: string): Float32Array {
        const vector = new Float32Array(this.dimensions);
        const tokens = this.tokenize(text);

        if (tokens.length === 0) return vector;

        // Count term frequencies
        const tf = new Map<string, number>();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }

        // Generate unigram features
        for (const [term, count] of tf) {
            const weight = Math.log(1 + count); // log-dampened TF
            const hash = this.hashString(term);
            const bucket = Math.abs(hash) % this.dimensions;
            // Use sign of secondary hash for positive/negative contribution
            const sign = (this.hashString(term + '_sign') % 2 === 0) ? 1 : -1;
            vector[bucket] += sign * weight;
        }

        // Generate bigram features (captures word order)
        for (let i = 0; i < tokens.length - 1; i++) {
            const bigram = `${tokens[i]}_${tokens[i + 1]}`;
            const hash = this.hashString(bigram);
            const bucket = Math.abs(hash) % this.dimensions;
            const sign = (this.hashString(bigram + '_sign') % 2 === 0) ? 1 : -1;
            vector[bucket] += sign * 0.5; // Lower weight for bigrams
        }

        // L2 normalize
        this.normalize(vector);

        return vector;
    }

    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1 && !STOP_WORDS.has(w));
    }

    /**
     * FNV-1a 32-bit hash — fast, good distribution, deterministic
     */
    private hashString(str: string): number {
        let hash = 0x811c9dc5; // FNV offset basis
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193); // FNV prime
        }
        return hash >>> 0; // Ensure unsigned
    }

    private normalize(vector: Float32Array): void {
        let norm = 0;
        for (let i = 0; i < vector.length; i++) {
            norm += vector[i] * vector[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < vector.length; i++) {
                vector[i] /= norm;
            }
        }
    }
}
