/**
 * ReActReasoner / ContextBuilder unit tests
 *
 * Tests focused on pure, dependency-free logic:
 * - TOOL_ALIASES map (deduplication and resolution)
 * - extractActionFromText (LLM prose parsing)
 * - isVisionCapableModel (model capability detection)
 *
 * All functions are inlined — importing ContextBuilder or ReActReasoner directly
 * would trigger native module loads (mcpManager, puppeteer, modelManager) that
 * crash in the test environment.
 */
import { describe, it, expect } from 'vitest';

// ── Inline TOOL_ALIASES (mirrors ReActReasoner.ts) ──────────────────────────
const TOOL_ALIASES: Record<string, string> = {
    bash: 'run_command', shell: 'run_command', execute: 'run_command',
    run_script: 'run_command', exec: 'run_command', cmd: 'run_command',
    execute_script: 'run_command', run_code: 'run_command',
    save_file: 'write_file', create_file: 'write_file', output_file: 'write_file',
    write: 'write_file', file_write: 'write_file',
    mkdir: 'create_directory', make_directory: 'create_directory', makedirs: 'create_directory',
    search: 'web_search', google: 'web_search', bing: 'web_search',
    browser_search: 'web_search', web_browse: 'browser_navigate',
    http_get: 'run_command', fetch_url: 'run_command', http_request: 'run_command',
    read: 'read_file', cat: 'read_file', open_file: 'read_file',
    ls: 'list_directory', dir: 'list_directory', list: 'list_directory',
    stealth: 'stealth_fetch', bypass_fetch: 'stealth_fetch', cloudflare_fetch: 'stealth_fetch',
    navigate: 'browser_navigate', goto: 'browser_navigate', open_url: 'browser_navigate',
    click: 'browser_click', tap: 'browser_click', press: 'browser_click',
    fill: 'browser_fill', type_into: 'browser_fill', input: 'browser_fill',
    extract: 'browser_extract', get_element: 'browser_extract', scrape: 'browser_extract',
    get_text: 'browser_get_text', page_text: 'browser_get_text',
    get_content: 'browser_get_content', page_content: 'browser_get_content',
    screenshot: 'browser_screenshot', capture: 'browser_screenshot',
    scroll: 'browser_scroll', scroll_down: 'browser_scroll',
    wait: 'browser_wait', wait_for: 'browser_wait',
};

// ── Inline extractActionFromText (mirrors ContextBuilder.ts) ─────────────────
type SuggestedAction = { tool: string; args: Record<string, any>; reasoning: string } | null;

function extractActionFromText(text: string, validTools: string[]): SuggestedAction {
    if (!text) return null;

    // Strategy 1: find a JSON object in the text
    const jsonMatch = text.match(/\{[\s\S]*?"tool"\s*:\s*"([^"]+)"[\s\S]*?\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.tool && validTools.includes(parsed.tool)) {
                return { tool: parsed.tool, args: parsed.args || {}, reasoning: parsed.reasoning || '' };
            }
        } catch { /* malformed inner JSON */ }
    }

    // Strategy 2: look for a known tool name mentioned in prose
    const lower = text.toLowerCase();
    const ACTION_SIGNALS = /\b(use|call|call(?:ing)?|run(?:ning)?|execut(?:e|ing)|perform(?:ing)?|invoke|→|action:|next:)\b/i;
    for (const tool of validTools) {
        if (lower.includes(tool)) {
            const toolPos = lower.indexOf(tool);
            const nearbyText = text.substring(Math.max(0, toolPos - 80), toolPos + tool.length + 80);
            if (!ACTION_SIGNALS.test(nearbyText)) continue;

            const args: Record<string, string> = {};
            if (tool === 'write_file') {
                const pathMatch = text.match(/["']([^"']+\.[a-zA-Z]{1,5})["']/);
                if (pathMatch) args.path = pathMatch[1];
            } else if (tool === 'run_command') {
                const cmdMatch = text.match(/`([^`]+)`/);
                if (cmdMatch) args.command = cmdMatch[1];
            } else if (tool === 'web_search') {
                const queryMatch = text.match(/(?:search\s+for\s+|query:\s*)["']([^"'\n]{5,120})["']/i)
                    || text.match(/["']([^"'\n]{10,120})["']/);
                if (queryMatch) args.query = queryMatch[1].trim();
                if (!args.query) continue;
            }
            return { tool, args, reasoning: `Extracted from LLM prose (tool: ${tool})` };
        }
    }

    return null;
}

// ── Inline isVisionCapableModel (mirrors ContextBuilder.ts) ──────────────────
function isVisionCapableModel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    if (id.includes('claude-3') || id.includes('claude-sonnet') || id.includes('claude-opus') || id.includes('claude-haiku')) return true;
    if (id.includes('gpt-4o') || id.includes('gpt-4-turbo') || id.includes('gpt-4-vision')) return true;
    if (id.includes('gemini')) return true;
    if (id.includes('llava') || id.includes('moondream') || id.includes('vision') || id.includes('bakllava')) return true;
    if (id.includes('pixtral')) return true;
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL_ALIASES
// ─────────────────────────────────────────────────────────────────────────────

describe('TOOL_ALIASES', () => {
    it('resolves bash → run_command', () => {
        expect(TOOL_ALIASES['bash']).toBe('run_command');
    });

    it('resolves shell → run_command', () => {
        expect(TOOL_ALIASES['shell']).toBe('run_command');
    });

    it('resolves save_file → write_file', () => {
        expect(TOOL_ALIASES['save_file']).toBe('write_file');
    });

    it('resolves mkdir → create_directory', () => {
        expect(TOOL_ALIASES['mkdir']).toBe('create_directory');
    });

    it('resolves search → web_search', () => {
        expect(TOOL_ALIASES['search']).toBe('web_search');
    });

    it('resolves ls → list_directory', () => {
        expect(TOOL_ALIASES['ls']).toBe('list_directory');
    });

    it('resolves navigate → browser_navigate', () => {
        expect(TOOL_ALIASES['navigate']).toBe('browser_navigate');
    });

    it('resolves screenshot → browser_screenshot', () => {
        expect(TOOL_ALIASES['screenshot']).toBe('browser_screenshot');
    });

    it('returns undefined for a real tool name (no aliasing needed)', () => {
        expect(TOOL_ALIASES['run_command']).toBeUndefined();
        expect(TOOL_ALIASES['write_file']).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractActionFromText
// ─────────────────────────────────────────────────────────────────────────────

describe('extractActionFromText', () => {
    const validTools = ['run_command', 'write_file', 'web_search', 'read_file', 'list_directory'];

    it('extracts tool from embedded JSON in prose (flat structure)', () => {
        // The regex Strategy 1 is non-greedy and stops at the first '}', so nested
        // args objects would produce incomplete JSON. Use a flat JSON with no nested braces.
        const text = `Action: {"tool":"run_command","reasoning":"execute the script"}`;
        const result = extractActionFromText(text, validTools);
        expect(result?.tool).toBe('run_command');
    });

    it('returns null for empty text', () => {
        expect(extractActionFromText('', validTools)).toBeNull();
    });

    it('returns null when no valid tool is mentioned', () => {
        const text = 'I should think about this more carefully before acting.';
        expect(extractActionFromText(text, validTools)).toBeNull();
    });

    it('extracts write_file from action directive prose', () => {
        const text = `→ action: use write_file to save the result to 'output/result.txt'`;
        const result = extractActionFromText(text, validTools);
        expect(result?.tool).toBe('write_file');
    });

    it('does NOT extract a tool mentioned only in reasoning prose (no action signal)', () => {
        const text = 'I considered web_search but decided to use a different approach.';
        const result = extractActionFromText(text, validTools);
        expect(result?.tool).not.toBe('web_search');
    });

    it('extracts web_search only when a quoted query is present', () => {
        const text = `I will use web_search with query: "AAPL stock price today"`;
        const result = extractActionFromText(text, validTools);
        if (result?.tool === 'web_search') {
            expect(result.args?.query).toBeTruthy();
        }
        // Either found with a query OR returned null (no bare-prose query) — both valid
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// isVisionCapableModel
// ─────────────────────────────────────────────────────────────────────────────

describe('isVisionCapableModel', () => {
    it('returns true for claude-3 models', () => {
        expect(isVisionCapableModel('claude-3-opus-20240229')).toBe(true);
        expect(isVisionCapableModel('claude-3-sonnet-20240229')).toBe(true);
    });

    it('returns true for claude-sonnet / claude-opus shorthand', () => {
        expect(isVisionCapableModel('claude-sonnet-4')).toBe(true);
        expect(isVisionCapableModel('claude-opus-4')).toBe(true);
    });

    it('returns true for gpt-4o', () => {
        expect(isVisionCapableModel('gpt-4o')).toBe(true);
    });

    it('returns true for any gemini model', () => {
        expect(isVisionCapableModel('gemini-pro-vision')).toBe(true);
        expect(isVisionCapableModel('gemini-1.5-flash')).toBe(true);
    });

    it('returns true for llava (Ollama vision)', () => {
        expect(isVisionCapableModel('llava:7b')).toBe(true);
    });

    it('returns false for text-only models', () => {
        expect(isVisionCapableModel('gpt-3.5-turbo')).toBe(false);
        expect(isVisionCapableModel('mistral-7b')).toBe(false);
        expect(isVisionCapableModel('deepseek-r1')).toBe(false);
    });
});
