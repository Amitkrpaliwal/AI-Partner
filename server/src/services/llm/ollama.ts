import { Ollama } from 'ollama';
import axios from 'axios';
import { LLMAdapter, GenerationOptions, Model, getTextContent, HistoryMessage, NativeSearchResult } from './types';
import { searchProviderManager } from '../../search/SearchProviderManager';

// Use OLLAMA_HOST env var for Docker compatibility (host.docker.internal)
// `let` so OllamaAdapter.updateHost() can recreate the client at runtime without restart.
let ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' });

const OLLAMA_CLOUD_BASE = 'https://ollama.com/api';

export class OllamaAdapter implements LLMAdapter {
  public model: string;
  private isConnected: boolean = false;

  /** Native search always available:
   *  - With OLLAMA_API_KEY: uses Ollama Cloud search API (better results)
   *  - Without key: uses local SearXNG/Brave/DuckDuckGo fallback chain */
  readonly nativeSearch = true;

  /** Lazy getter — always reads current env value so Settings UI saves take effect immediately */
  private get cloudApiKey(): string {
    return process.env.OLLAMA_API_KEY || '';
  }

  constructor(model: string = 'llama3.2') {
    this.model = model;
  }

  /** Reconfigure host at runtime — persists to process.env so embed provider also picks it up */
  updateHost(newHost: string): void {
    process.env.OLLAMA_HOST = newHost;
    ollama = new Ollama({ host: newHost });
    console.log(`[OllamaAdapter] Host updated to ${newHost}`);
  }

  async connect(): Promise<void> {
    try {
      await ollama.list();
      this.isConnected = true;
      console.log('✓ Ollama connected');
    } catch (e) {
      console.warn('Ollama connection failed', e);
      this.isConnected = false;
    }
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async isAvailable(): Promise<boolean> {
    try {
      await ollama.list();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<Model[]> {
    try {
      const list = await ollama.list();
      return list.models.map(m => ({
        id: m.name,
        name: m.name,
        provider: 'ollama',
        capabilities: {
          chat: true,
          completion: true,
          embedding: true, // Ollama supports embeddings
          vision: false // Assuming text for now unless multimodal model
        }
      }));
    } catch {
      return [];
    }
  }

  setModel(modelId: string): void {
    this.model = modelId;
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    try {
      const response = await ollama.chat({
        model: this.model,
        messages: [
          ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          ...(options?.history?.map(h => ({ role: h.role, content: this.toTextOnly(h) })) || []),
          { role: 'user', content: prompt }
        ],
        stream: false,
        options: {
          temperature: options?.temperature,
          num_ctx: options?.maxTokens // approximate map
        }
      });
      return response.message.content;
    } catch (error) {
      console.error('Ollama generation error:', error);
      throw error;
    }
  }

  async *stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string> {
    try {
      const response = await ollama.chat({
        model: this.model,
        messages: [
          ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          ...(options?.history?.map(h => ({ role: h.role, content: this.toTextOnly(h) })) || []),
          { role: 'user', content: prompt }
        ],
        stream: true,
        options: {
          temperature: options?.temperature
        }
      });

      for await (const part of response) {
        process.stdout.write('.'); // Dot logging for heartbeat
        yield part.message.content;
      }
      console.log('\n[Ollama] Stream finished');
    } catch (error) {
      console.error('Ollama stream error:', error);
      throw error;
    }
  }

  async generateJSON(prompt: string, schema: any, options?: GenerationOptions): Promise<any> {
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
4. If you don't know something, use reasonable defaults rather than failing

${options?.systemPrompt || ''}`;

        // Add schema hint to the prompt if available
        const enhancedPrompt = schema && Object.keys(schema).length > 0
          ? `${prompt}\n\nExpected JSON schema: ${JSON.stringify(schema)}\n\nRespond ONLY with valid JSON:`
          : `${prompt}\n\nRespond ONLY with valid JSON:`;

        const response = await ollama.chat({
          model: this.model,
          messages: [
            { role: 'system', content: jsonSystemPrompt },
            ...(options?.history?.map(h => ({ role: h.role, content: this.toTextOnly(h) })) || []),
            { role: 'user', content: enhancedPrompt }
          ],
          format: 'json',
          stream: false,
          options: {
            temperature: attempt === 1 ? 0.1 : 0.05, // Lower temp on retries
            num_predict: options?.maxTokens || 2048
          }
        });

        let content = response.message.content.trim();

        // Try to extract JSON from the response
        const parsed = this.extractJSON(content);
        if (parsed) {
          // Validate that essential fields exist for orchestrator decisions
          if (this.isValidOrchestratorResponse(parsed)) {
            return parsed;
          }
          // If it's JSON but missing fields, fill in defaults
          return this.normalizeOrchestratorResponse(parsed, content);
        }

        // Track error for retry — preserve raw text for prose-based fallback in callers
        lastError = Object.assign(
            new Error(`Non-JSON response: ${content.substring(0, 100)}`),
            { rawText: content }
        );
        console.warn(`[Ollama] Attempt ${attempt}/${MAX_RETRIES}: Failed to parse JSON, retrying...`);

      } catch (error) {
        lastError = error;
        console.warn(`[Ollama] Attempt ${attempt}/${MAX_RETRIES}: Error - ${error}`);
      }
    }

    // All retries failed — throw so callers can extract rawText for prose-based fallback
    console.error('[Ollama] All JSON generation attempts failed');
    const err = Object.assign(
        new Error(`All JSON generation attempts failed: ${lastError?.message}`),
        { rawText: lastError?.rawText || '' }
    );
    throw err;
  }

  /**
   * Search the web then synthesize answer with local Ollama model.
   *
   * Two search backends (tried in order):
   *   1. Ollama Cloud API (if OLLAMA_API_KEY is set) — best results
   *   2. Local search providers (SearXNG → Brave → DuckDuckGo) — always available
   *
   * Flow:
   *   search backend → inject top results as context → local model synthesizes answer
   */
  async generateWithSearch(prompt: string, options?: GenerationOptions): Promise<NativeSearchResult> {
    let results: { title: string; url: string; snippet?: string }[] = [];

    // Path A: Ollama Cloud API (when key is configured)
    if (this.cloudApiKey) {
      try {
        const searchRes = await axios.post(
          `${OLLAMA_CLOUD_BASE}/web_search`,
          { query: prompt, max_results: 10 },
          { headers: { Authorization: `Bearer ${this.cloudApiKey}`, 'Content-Type': 'application/json' } }
        );
        const raw: { title: string; url: string; content?: string; snippet?: string }[] =
          searchRes.data?.results || searchRes.data || [];
        results = raw.filter(r => r.url).map(r => ({
          title: r.title || r.url,
          url: r.url,
          snippet: r.snippet || r.content?.substring(0, 300)
        }));
        console.log(`[OllamaAdapter] Cloud search: ${results.length} results`);
      } catch (err: any) {
        console.warn(`[OllamaAdapter] Cloud search failed (${err.message}), falling back to local providers`);
      }
    }

    // Path B: Local search providers (SearXNG / Brave / DuckDuckGo)
    if (results.length === 0) {
      // Append current year to the query so SearXNG prioritises recent results.
      // Only add it if the query doesn't already contain a 4-digit year.
      const now = new Date();
      const currentYear = now.getFullYear().toString();
      const dateTag = /\b20\d{2}\b/.test(prompt) ? '' : ` ${currentYear}`;
      const timedQuery = prompt + dateTag;

      const searchResp = await searchProviderManager.search(timedQuery, 10);
      if (searchResp.success && searchResp.results.length > 0) {
        results = searchResp.results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
        console.log(`[OllamaAdapter] Local search (${searchResp.provider}): ${results.length} results`);
      }
    }

    const sources: NativeSearchResult['sources'] = results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet
    }));

    // Current date injected so the model knows not to use stale training data
    const now = new Date();
    const currentDateStr = now.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric'
    });

    // Build grounded context for local model
    const searchContext = results
      .slice(0, 5)
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ''}`)
      .join('\n\n');

    const groundedPrompt = searchContext
      ? `Today's date is ${currentDateStr}. Use ONLY the following web search results to answer — do NOT use your training data for facts, prices, or numbers that change over time.\n\nWEB SEARCH RESULTS:\n${searchContext}\n\nQUESTION: ${prompt}\n\nAnswer based strictly on the search results above. If the results show a date, mention it. Be factual and concise.`
      : `Today's date is ${currentDateStr}.\n\n${prompt}`; // No results — at least model knows the date

    // Synthesize with local model
    const response = await ollama.chat({
      model: this.model,
      messages: [
        ...(options?.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
        { role: 'user' as const, content: groundedPrompt }
      ],
      stream: false,
      options: { temperature: options?.temperature ?? 0.3 }
    });

    return { text: response.message.content, sources };
  }

  /**
   * Fetch a URL via Ollama Cloud web_fetch API (returns extracted text content).
   * Falls back gracefully if cloud key not set.
   */
  async webFetch(url: string): Promise<string> {
    if (!this.cloudApiKey) throw new Error('OLLAMA_API_KEY not set');
    const res = await axios.post(
      `${OLLAMA_CLOUD_BASE}/web_fetch`,
      { url },
      { headers: { Authorization: `Bearer ${this.cloudApiKey}`, 'Content-Type': 'application/json' } }
    );
    return res.data?.content || res.data?.text || '';
  }

  /**
   * Convert multimodal content to text-only for non-vision models.
   * Image blocks are replaced with a placeholder note.
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

  /**
   * Check if response has required orchestrator fields
   */
  private isValidOrchestratorResponse(parsed: any): boolean {
    // Must have either needsTool+tool OR taskComplete
    if (parsed.needsTool === true && parsed.tool) return true;
    if (parsed.needsTool === false && (parsed.taskComplete !== undefined || parsed.response)) return true;
    // Also accept action-based format (for autonomous executor)
    if (parsed.action) return true;
    // ReAct tool-call format: {"tool": "name", "args": {...}, "reasoning": "..."}
    // This must be returned as-is — DO NOT normalize it into a chat response wrapper.
    if (parsed.tool && typeof parsed.tool === 'string') return true;
    return false;
  }

  /**
   * Normalize a partial response into a valid orchestrator format
   */
  private normalizeOrchestratorResponse(parsed: any, originalContent: string): any {
    // If it has action field (autonomous format), convert to orchestrator format
    if (parsed.action && parsed.action !== 'complete') {
      return {
        needsTool: true,
        tool: parsed.action,
        args: parsed.args || {},
        reasoning: parsed.reasoning || parsed.action
      };
    }

    // If it has any response-like field, treat as completion
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

    // Try to find JSON object in the text (last match — models often put explanation first)
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

    // Try to find JSON array in the text
    const arrayMatch = clean.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch (e) {
        // Ignore
      }
    }

    return null;
  }
}

/**
 * OllamaCloudAdapter — uses Ollama's hosted cloud inference API at https://ollama.com
 *
 * Same Ollama protocol as local, just authenticated via Authorization: Bearer header.
 * Models: qwen3-coder:480b-cloud, gpt-oss:120b-cloud, gpt-oss:20b-cloud, deepseek-v3.1:671b-cloud, etc.
 *
 * Also enables web_search and web_fetch via the Ollama Cloud API (same key).
 */
export class OllamaCloudAdapter implements LLMAdapter {
  public model: string;
  private apiKey: string;
  private cloudOllama: Ollama;
  readonly nativeSearch = true;

  constructor(apiKey: string, model: string = 'qwen3-coder:480b-cloud') {
    this.apiKey = apiKey;
    this.model = model;
    this.cloudOllama = new Ollama({
      host: 'https://ollama.com',
      headers: { Authorization: `Bearer ${apiKey}` } as Record<string, string>,
    });
  }

  async connect(): Promise<void> {
    // Validated on isAvailable
  }

  async disconnect(): Promise<void> {}

  async isAvailable(): Promise<boolean> {
    // Key configured = provider is available. Same pattern as all other cloud providers.
    // listModels() handles network failures gracefully with a fallback.
    return !!this.apiKey;
  }

  async listModels(): Promise<Model[]> {
    const fallback: Model[] = [{
      id: this.model,
      name: this.model,
      provider: 'ollama-cloud',
      capabilities: { chat: true, completion: true, embedding: false, vision: false },
    }];
    try {
      // Use axios (native Node.js http stack) — avoids undici/fetch issues on Windows
      const res = await axios.get(`${OLLAMA_CLOUD_BASE}/tags`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 8000,
      });
      const models: Model[] = (res.data?.models ?? []).map((m: any) => ({
        id: m.name,
        name: m.name,
        provider: 'ollama-cloud',
        capabilities: { chat: true, completion: true, embedding: false, vision: false },
      }));
      return models.length > 0 ? models : fallback;
    } catch (e: any) {
      console.warn('[OllamaCloudAdapter] listModels failed, using configured model:', e.message);
      return fallback;
    }
  }

  setModel(modelId: string): void {
    this.model = modelId;
  }

  private buildMessages(prompt: string, options?: GenerationOptions) {
    return [
      ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
      ...(options?.history?.map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : '' })) || []),
      { role: 'user', content: prompt },
    ];
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    // Use axios (Node native http.request) — avoids undici/fetch connectivity issues on Windows
    const res = await axios.post(`${OLLAMA_CLOUD_BASE}/chat`, {
      model: this.model,
      messages: this.buildMessages(prompt, options),
      stream: false,
    }, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
    });
    return res.data?.message?.content ?? '';
  }

  async *stream(prompt: string, options?: GenerationOptions): AsyncGenerator<string> {
    // Use axios streaming — parses Ollama's NDJSON response line by line
    const res = await axios.post(`${OLLAMA_CLOUD_BASE}/chat`, {
      model: this.model,
      messages: this.buildMessages(prompt, options),
      stream: true,
    }, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
      responseType: 'stream',
    });
    let buf = '';
    for await (const chunk of res.data) {
      buf += (chunk as Buffer).toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const parsed = JSON.parse(t);
          if (parsed?.message?.content) yield parsed.message.content;
        } catch { /* skip malformed chunk */ }
      }
    }
  }

  async generateJSON(prompt: string, _schema: any, options?: GenerationOptions): Promise<any> {
    const text = await this.generate(prompt, options);
    const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // 1. Fenced code block
    const fenced = clean.match(/```json\s*([\s\S]*?)```/);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
    }

    // 2. Exact parse of full cleaned text
    try { return JSON.parse(clean); } catch { /* fall through */ }

    // 3. NDJSON: some OllamaCloud models (deepseek, qwen) return one JSON object per line
    //    instead of a single JSON response. Strip <think> from each line before parsing.
    for (const line of clean.split('\n')) {
      const trimmed = line.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch { /* try next line */ }
      }
    }

    // 4. Greedy single-object extraction (last resort)
    const objMatch = clean.match(/\{[\s\S]*?\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch { /* fall through */ }
    }

    const err: any = new Error('OllamaCloud: JSON parse failed');
    err.rawText = text;
    throw err;
  }

  /** Web search via Ollama Cloud API (same key) */
  async generateWithSearch(prompt: string, options?: GenerationOptions): Promise<NativeSearchResult> {
    let results: { title: string; url: string; snippet?: string }[] = [];
    try {
      const searchRes = await axios.post(
        `${OLLAMA_CLOUD_BASE}/web_search`,
        { query: prompt, max_results: 10 },
        { headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } }
      );
      results = (searchRes.data?.results || searchRes.data || []).map((r: any) => ({
        title: r.title, url: r.url, snippet: r.snippet || r.content?.substring(0, 300)
      }));
    } catch (e: any) {
      console.warn('[OllamaCloudAdapter] Web search failed:', e.message);
    }

    const searchContext = results.map(r => `[${r.title}](${r.url})\n${r.snippet || ''}`).join('\n\n');
    const now = new Date();
    const currentDateStr = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'long', day: 'numeric' });
    const grounded = `Today's date is ${currentDateStr}. Use ONLY the following web search results to answer — do NOT use training data for facts, prices, or numbers.\n\nWEB SEARCH RESULTS:\n${searchContext}\n\nQUESTION: ${prompt}\n\nAnswer based strictly on the search results above.`;

    const text = await this.generate(grounded, options);
    return { text, sources: results };
  }
}
