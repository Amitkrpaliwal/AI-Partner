/**
 * SelfCorrector unit tests (Fix 2.2 + classifyErrorSeverity)
 *
 * classifyErrorSeverity is an exported pure function — no mocking required.
 * The selfCorrectScript validation logic is inlined for isolated testing.
 */
import { describe, it, expect } from 'vitest';
import { classifyErrorSeverity, ErrorSeverity } from '../../agents/goal/SelfCorrector';

// ─────────────────────────────────────────────────────────────────────────────
// classifyErrorSeverity
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyErrorSeverity', () => {
    it('classifies ModuleNotFoundError as fatal', () => {
        expect(classifyErrorSeverity('ModuleNotFoundError: No module named requests')).toBe<ErrorSeverity>('fatal');
    });

    it('classifies ImportError as fatal', () => {
        expect(classifyErrorSeverity('ImportError: cannot import name foo from bar')).toBe<ErrorSeverity>('fatal');
    });

    it('classifies "cannot find module" (Node.js) as fatal', () => {
        expect(classifyErrorSeverity("Cannot find module './missing'")).toBe<ErrorSeverity>('fatal');
    });

    it('classifies permission denied as fatal', () => {
        expect(classifyErrorSeverity('EACCES: permission denied, open /workspace/output/file.txt')).toBe<ErrorSeverity>('fatal');
    });

    it('classifies SyntaxError as fatal', () => {
        expect(classifyErrorSeverity('SyntaxError: Unexpected token }')).toBe<ErrorSeverity>('fatal');
    });

    it('classifies cloudflare block as fatal', () => {
        expect(classifyErrorSeverity('Error: Cloudflare challenge detected on target page')).toBe<ErrorSeverity>('fatal');
    });

    it('classifies 403 forbidden as fatal', () => {
        expect(classifyErrorSeverity('HTTPError: 403 Forbidden')).toBe<ErrorSeverity>('fatal');
    });

    it('classifies timeout as transient', () => {
        expect(classifyErrorSeverity('Error: request timeout after 30000ms')).toBe<ErrorSeverity>('transient');
    });

    it('classifies rate limit as transient', () => {
        expect(classifyErrorSeverity('429 Too Many Requests — rate limit exceeded')).toBe<ErrorSeverity>('transient');
    });

    it('classifies 503 as transient', () => {
        expect(classifyErrorSeverity('503 Service Unavailable')).toBe<ErrorSeverity>('transient');
    });

    it('classifies connection refused as transient', () => {
        expect(classifyErrorSeverity('ECONNREFUSED: connection refused at 127.0.0.1:5432')).toBe<ErrorSeverity>('transient');
    });

    it('classifies unknown errors as unknown', () => {
        expect(classifyErrorSeverity('something went wrong')).toBe<ErrorSeverity>('unknown');
        expect(classifyErrorSeverity('')).toBe<ErrorSeverity>('unknown');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// selfCorrectScript validation logic (inlined — Fix 2.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('selfCorrectScript validation (inlined Fix 2.2)', () => {
    function validateCorrectedScript(
        cleaned: string,
        originalScript: string,
        runtime: 'python' | 'node'
    ): boolean {
        const isDifferentEnough =
            Math.abs(cleaned.length - originalScript.length) > 10 ||
            cleaned.substring(0, 200) !== originalScript.substring(0, 200);

        const hasMinStructure = cleaned.includes('\n') || cleaned.includes(';');

        const hasFileOps = runtime === 'python'
            ? cleaned.includes('open(') || cleaned.includes('write(') ||
              cleaned.includes('.write_text(') || cleaned.includes('.write_bytes(')
            : cleaned.includes('writeFile') || cleaned.includes('writeSync') ||
              cleaned.includes('fs.') || cleaned.includes('createWriteStream');

        return isDifferentEnough && hasMinStructure && hasFileOps;
    }

    const originalPy = `import requests\nwith open('/workspace/out.txt', 'w') as f:\n    f.write('hello')`;
    const originalNode = `const fs = require('fs');\nfs.writeFileSync('/workspace/out.txt', 'hello');`;

    it('accepts a meaningfully different Python script with file operations', () => {
        const fixed = `import requests\ndata = requests.get('http://example.com').text\nwith open('/workspace/out.txt', 'w') as f:\n    f.write(data)`;
        expect(validateCorrectedScript(fixed, originalPy, 'python')).toBe(true);
    });

    it('accepts a meaningfully different Node.js script with writeFile', () => {
        const fixed = `const fs = require('fs');\nconst data = 'updated';\nfs.writeFileSync('/workspace/out.txt', data);`;
        expect(validateCorrectedScript(fixed, originalNode, 'node')).toBe(true);
    });

    it('rejects a script that is identical to the original', () => {
        expect(validateCorrectedScript(originalPy, originalPy, 'python')).toBe(false);
    });

    it('rejects a script with no file operations (Python)', () => {
        const noFileOps = `import sys\nprint('hello')\nprint('world')`;
        expect(validateCorrectedScript(noFileOps, originalPy, 'python')).toBe(false);
    });

    it('rejects a one-liner with no newline or semicolon (no structure)', () => {
        const noStructure = `fs.writeFileSync('/workspace/out.txt', 'x')`;
        // has writeFileSync (file op) but no '\n' or ';'
        // This is a single expression with no statement separator
        expect(validateCorrectedScript(noStructure, originalNode, 'node')).toBe(false);
    });

    it('accepts a Node.js script using createWriteStream', () => {
        const stream = `const fs = require('fs');\nconst s = fs.createWriteStream('/workspace/out.txt');\ns.write('hello');\ns.end();`;
        expect(validateCorrectedScript(stream, originalNode, 'node')).toBe(true);
    });
});
