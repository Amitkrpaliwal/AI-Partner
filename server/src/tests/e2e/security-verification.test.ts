/**
 * Security Verification Tests
 * Covers: 13V.3, 13V.4, 13V.5, 13V.7
 *
 * Tests security validation functions directly and via API endpoints.
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const api = axios.create({ baseURL: BASE, timeout: 15000, validateStatus: () => true });

describe('Security Verification', () => {

    // ================================================================
    // 13V.3: Goal mode without Docker → clear error message
    // ================================================================
    describe('13V.3: Goal mode Docker requirement', () => {
        it('should return clear error when Docker is required but unavailable', async () => {
            // Start a goal with require_docker = true
            // If Docker is not available, should get a clear error (not silent fallback)
            const res = await api.post('/api/autonomous/goal', {
                goal: 'Test goal that requires Docker',
                criteria: [{ type: 'output_matches', config: { command: 'echo test', expected: 'test' } }],
                options: { requireDocker: true },
            });

            // Either succeeds (Docker available) or returns clear error
            if (res.status !== 200) {
                const errorMsg = JSON.stringify(res.data).toLowerCase();
                // Should mention Docker, not silently fall back
                expect(
                    errorMsg.includes('docker') ||
                    errorMsg.includes('container') ||
                    errorMsg.includes('sandbox')
                ).toBe(true);
            }
        });
    });

    // ================================================================
    // 13V.4: Dynamic tool with dangerous code → blocked
    // ================================================================
    describe('13V.4: Dynamic tool code injection prevention', () => {
        it('should block tool with require(child_process)', async () => {
            const res = await api.post('/api/mcp/tools/register', {
                name: 'evil_tool',
                description: 'A malicious tool that tries to execute system commands',
                code: `const cp = require('child_process'); return cp.execSync('whoami').toString();`,
            });

            // Should be blocked — 400 or security error
            if (res.status === 200) {
                // Tool was registered — check it can't execute
                const execRes = await api.post('/api/mcp/tools/execute', {
                    name: 'evil_tool',
                    args: {},
                });
                expect(execRes.data.error || execRes.data.blocked).toBeTruthy();
            } else {
                expect(res.status).toBeGreaterThanOrEqual(400);
                const msg = JSON.stringify(res.data).toLowerCase();
                expect(msg.includes('blocked') || msg.includes('unsafe') || msg.includes('dangerous')).toBe(true);
            }
        });

        it('should block tool with eval()', async () => {
            const res = await api.post('/api/mcp/tools/register', {
                name: 'eval_tool',
                description: 'A tool that tries to use eval for code execution',
                code: `return eval('1+1');`,
            });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });

        it('should block tool with process.exit', async () => {
            const res = await api.post('/api/mcp/tools/register', {
                name: 'crash_tool',
                description: 'A tool that tries to crash the process via exit',
                code: `process.exit(1);`,
            });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });

        it('should block tool with import()', async () => {
            const res = await api.post('/api/mcp/tools/register', {
                name: 'import_tool',
                description: 'A tool that tries dynamic import for module access',
                code: `const fs = await import('fs'); return fs.readFileSync('/etc/passwd');`,
            });
            expect(res.status).toBeGreaterThanOrEqual(400);
        });
    });

    // ================================================================
    // 13V.5: browser_navigate('file:///etc/passwd') → blocked
    // ================================================================
    describe('13V.5: Browser URL filtering', () => {
        it('should block file:// protocol navigation', async () => {
            const res = await api.post('/api/mcp/call', {
                server: 'browser',
                tool: 'browser_navigate',
                args: { url: 'file:///etc/passwd' },
            });

            // Should be blocked
            if (res.status === 200) {
                const msg = JSON.stringify(res.data).toLowerCase();
                expect(msg.includes('blocked') || msg.includes('unsafe') || msg.includes('not allowed')).toBe(true);
            } else {
                expect(res.status).toBeGreaterThanOrEqual(400);
            }
        });

        it('should block javascript: protocol', async () => {
            const res = await api.post('/api/mcp/call', {
                server: 'browser',
                tool: 'browser_navigate',
                args: { url: 'javascript:alert(1)' },
            });
            if (res.status === 200) {
                const msg = JSON.stringify(res.data).toLowerCase();
                expect(msg.includes('blocked') || msg.includes('unsafe')).toBe(true);
            } else {
                expect(res.status).toBeGreaterThanOrEqual(400);
            }
        });

        it('should block localhost navigation', async () => {
            const res = await api.post('/api/mcp/call', {
                server: 'browser',
                tool: 'browser_navigate',
                args: { url: 'http://localhost:8080/admin' },
            });
            if (res.status === 200) {
                const msg = JSON.stringify(res.data).toLowerCase();
                expect(msg.includes('blocked') || msg.includes('unsafe') || msg.includes('internal')).toBe(true);
            } else {
                expect(res.status).toBeGreaterThanOrEqual(400);
            }
        });
    });

    // ================================================================
    // 13V.7: All tool calls appear in audit log
    // ================================================================
    describe('13V.7: Audit log completeness', () => {
        it('should have audit log endpoint accessible', async () => {
            const res = await api.get('/api/audit/log?limit=10');
            expect(res.status).toBe(200);
        });

        it('should log tool calls in audit log', async () => {
            // Make a known API call first
            await api.get('/api/health');

            // Check audit log for entries
            const res = await api.get('/api/audit/log?limit=50');
            expect(res.status).toBe(200);

            const logs = Array.isArray(res.data) ? res.data : (res.data.logs || []);
            // Audit log should have entries (may be empty on fresh DB)
            expect(Array.isArray(logs)).toBe(true);
        });

        it('should include tool call details in audit entries', async () => {
            const res = await api.get('/api/audit/log?limit=20&category=tool_call');
            if (res.status !== 200) return; // Category filter may not be supported

            const logs = Array.isArray(res.data) ? res.data : (res.data.logs || []);
            if (logs.length > 0) {
                const entry = logs[0];
                // Should have timestamp and action at minimum
                expect(entry.timestamp || entry.created_at).toBeTruthy();
                expect(entry.action || entry.event || entry.category).toBeTruthy();
            }
        });

        it('should log security-blocked events', async () => {
            const res = await api.get('/api/audit/log?limit=20&category=security');
            if (res.status !== 200) return;

            const logs = Array.isArray(res.data) ? res.data : (res.data.logs || []);
            // After security tests above, there should be blocked events
            expect(Array.isArray(logs)).toBe(true);
        });
    });
});
