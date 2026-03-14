// ============================================================================
// MULTIMODAL CONTENT TYPES
// ============================================================================

export interface TextContent {
    type: 'text';
    text: string;
}

export interface ImageContent {
    type: 'image';
    base64: string;
    mimeType: string;  // e.g. 'image/png', 'image/jpeg'
}

/** A content block can be text or an image (for vision-capable models). */
export type ContentBlock = TextContent | ImageContent;

/** A message in conversation history, supporting multimodal content. */
export interface HistoryMessage {
    role: string;
    content: string | ContentBlock[];
}

/**
 * Extract the plain-text portion from a HistoryMessage's content.
 * If content is a string, returns it directly.
 * If content is ContentBlock[], concatenates all text blocks.
 */
export function getTextContent(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content
        .filter((b): b is TextContent => b.type === 'text')
        .map(b => b.text)
        .join('\n');
}

/**
 * Check if content contains any image blocks.
 */
export function hasImageContent(content: string | ContentBlock[]): boolean {
    if (typeof content === 'string') return false;
    return content.some(b => b.type === 'image');
}

// ============================================================================
// LLM ADAPTER TYPES
// ============================================================================

export interface GenerationOptions {
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
    description?: string; // For logging/debug
    history?: HistoryMessage[]; // Full conversation history (supports multimodal)
}

export interface Model {
    id: string;
    name: string;
    provider: string; // 'ollama' | 'lmstudio' | 'openai' | 'openai-compatible'
    capabilities: {
        chat: boolean;
        completion: boolean;
        embedding: boolean;
        vision: boolean;
    };
}

export interface NativeSearchResult {
    text: string;
    sources: { title: string; url: string; snippet?: string }[];
}

export interface LLMAdapter {
    model: string;

    /** Whether this adapter can perform web search natively (without external tools) */
    readonly nativeSearch?: boolean;

    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isAvailable(): Promise<boolean>;
    listModels(): Promise<Model[]>;
    setModel(modelId: string): void;

    // Unified Generate method
    generate(prompt: string, options?: GenerationOptions): Promise<string>;

    // Unified JSON method
    generateJSON(prompt: string, schema?: any, options?: GenerationOptions): Promise<any>;

    // Unified Stream method
    stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string>;

    /**
     * Generate a response with built-in web search grounding.
     * Only implemented by adapters that support native search (Anthropic, Gemini, OpenAI, Groq compound, Perplexity).
     * Returns the answer text + structured source citations.
     */
    generateWithSearch?(prompt: string, options?: GenerationOptions): Promise<NativeSearchResult>;
}
