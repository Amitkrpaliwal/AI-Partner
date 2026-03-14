/**
 * ExecutionEngine unit tests (Fix 2.4 + isRuntimeNotFoundError)
 *
 * Both extractMCPText and isRuntimeNotFoundError are inlined here — importing
 * ExecutionEngine directly would trigger native module loads (Docker, puppeteer)
 * that crash in a test environment.
 */
import { describe, it, expect } from 'vitest';

// ── Inline extractMCPText (mirrors ExecutionEngine.ts) ──────────────────────
function extractMCPText(result: unknown): string {
    if (typeof result === 'string') return result;
    const r = result as Record<string, any>;
    if (Array.isArray(r?.content)) {
        return r.content
            .filter((block: any) => block?.type === 'text')
            .map((block: any) => block?.text ?? '')
            .join('\n');
    }
    return r?.content ?? r?.contents?.[0]?.text ?? r?.text ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// extractMCPText
// ─────────────────────────────────────────────────────────────────────────────

describe('extractMCPText', () => {
    it('returns a plain string unchanged', () => {
        expect(extractMCPText('hello world')).toBe('hello world');
    });

    it('extracts text from a single-block MCP response', () => {
        const result = { content: [{ type: 'text', text: 'first file\n' }] };
        expect(extractMCPText(result)).toBe('first file\n');
    });

    it('joins ALL text blocks — not just the first (Fix 2.4)', () => {
        const result = {
            content: [
                { type: 'text', text: 'file1.txt' },
                { type: 'text', text: 'file2.txt' },
                { type: 'text', text: 'file3.txt' },
            ],
        };
        expect(extractMCPText(result)).toBe('file1.txt\nfile2.txt\nfile3.txt');
    });

    it('skips non-text blocks', () => {
        const result = {
            content: [
                { type: 'text', text: 'visible' },
                { type: 'image', data: 'base64...' },
                { type: 'text', text: 'also visible' },
            ],
        };
        expect(extractMCPText(result)).toBe('visible\nalso visible');
    });

    it('returns empty string for an empty content array', () => {
        expect(extractMCPText({ content: [] })).toBe('');
    });

    it('falls back to r.text for legacy response format', () => {
        expect(extractMCPText({ text: 'fallback text' })).toBe('fallback text');
    });

    it('falls back to r.content string for legacy format', () => {
        expect(extractMCPText({ content: 'legacy content string' })).toBe('legacy content string');
    });

    it('returns empty string for null/undefined result', () => {
        expect(extractMCPText(null)).toBe('');
        expect(extractMCPText(undefined)).toBe('');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// isRuntimeNotFoundError
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionEngine.isRuntimeNotFoundError', () => {
    // We can't easily instantiate ExecutionEngine (heavy deps), so test the
    // pure logic inline — it has no this.* references.
    function isRuntimeNotFoundError(output: string): boolean {
        const lower = output.toLowerCase();
        return lower.includes('was not found') ||
            lower.includes('is not recognized') ||
            lower.includes('command not found') ||
            (lower.includes('no such file or directory') && (lower.includes('python') || lower.includes('node')));
    }

    it('returns true for Windows "was not found" message', () => {
        expect(isRuntimeNotFoundError('Python was not found in the Windows Store')).toBe(true);
    });

    it('returns true for Windows "is not recognized as an internal or external command"', () => {
        expect(isRuntimeNotFoundError("'python' is not recognized as an internal or external command")).toBe(true);
    });

    it('returns true for Linux "command not found"', () => {
        expect(isRuntimeNotFoundError('python3: command not found')).toBe(true);
    });

    it('returns true for "no such file or directory" with python in message', () => {
        expect(isRuntimeNotFoundError('/usr/bin/python: No such file or directory')).toBe(true);
    });

    it('returns false for a normal script runtime error (not a missing runtime)', () => {
        expect(isRuntimeNotFoundError('SyntaxError: Unexpected token }')).toBe(false);
        expect(isRuntimeNotFoundError('ModuleNotFoundError: No module named requests')).toBe(false);
    });

    it('returns false for an empty string', () => {
        expect(isRuntimeNotFoundError('')).toBe(false);
    });
});
