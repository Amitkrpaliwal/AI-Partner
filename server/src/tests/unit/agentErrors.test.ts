/**
 * errors.ts unit tests (Fix 5.1)
 *
 * AgentError and categorizeError are pure — no mocking required.
 */
import { describe, it, expect } from 'vitest';
import { AgentError, agentError, categorizeError, ErrorCategory } from '../../utils/errors';

describe('AgentError', () => {
    it('constructs with category, message, and context', () => {
        const err = new AgentError('Goal timed out', {
            category: 'goal_timeout',
            context: { elapsed_ms: 90000 },
        });
        expect(err.message).toBe('Goal timed out');
        expect(err.category).toBe<ErrorCategory>('goal_timeout');
        expect(err.context).toMatchObject({ elapsed_ms: 90000 });
        expect(err.name).toBe('AgentError');
        expect(err instanceof Error).toBe(true);
    });

    it('toLogObject returns a plain object', () => {
        const err = agentError('Docker daemon down', 'docker_daemon_down', { containerId: 'abc' });
        const obj = err.toLogObject();
        expect(obj.name).toBe('AgentError');
        expect(obj.category).toBe('docker_daemon_down');
        expect(obj.message).toBe('Docker daemon down');
        expect((obj.context as any).containerId).toBe('abc');
    });

    it('chains cause message in toLogObject', () => {
        const cause = new Error('ENOENT: docker.sock not found');
        const err = agentError('Container failed to start', 'docker_daemon_down', {}, cause);
        const obj = err.toLogObject();
        expect(obj.cause).toBe('ENOENT: docker.sock not found');
    });

    it('stacks cause trace when cause is an Error', () => {
        const cause = new Error('inner error');
        const err = new AgentError('outer error', { category: 'unknown', cause });
        expect(err.stack).toContain('Caused by:');
    });

    it('agentError() factory returns AgentError instance', () => {
        const err = agentError('test', 'tool_not_found');
        expect(err instanceof AgentError).toBe(true);
        expect(err.category).toBe('tool_not_found');
    });
});

describe('categorizeError', () => {
    it('classifies ModuleNotFoundError → script_dependency', () => {
        expect(categorizeError('ModuleNotFoundError: No module named requests')).toBe<ErrorCategory>('script_dependency');
    });

    it('classifies SyntaxError → script_syntax', () => {
        expect(categorizeError('SyntaxError: unexpected indent')).toBe<ErrorCategory>('script_syntax');
    });

    it('classifies EACCES → script_permission', () => {
        expect(categorizeError('EACCES: permission denied, open /workspace/out.txt')).toBe<ErrorCategory>('script_permission');
    });

    it('classifies Cloudflare → network_blocked', () => {
        expect(categorizeError('Cloudflare challenge page detected')).toBe<ErrorCategory>('network_blocked');
    });

    it('classifies 429 → network_rate_limit', () => {
        expect(categorizeError('429 Too Many Requests')).toBe<ErrorCategory>('network_rate_limit');
    });

    it('classifies timeout → network_timeout', () => {
        expect(categorizeError('Connection refused: ECONNREFUSED')).toBe<ErrorCategory>('network_timeout');
    });

    it('classifies Docker daemon down → docker_daemon_down', () => {
        expect(categorizeError('Cannot connect to the Docker daemon')).toBe<ErrorCategory>('docker_daemon_down');
    });

    it('classifies OOM → docker_resource_limit', () => {
        expect(categorizeError('Container killed: out of memory')).toBe<ErrorCategory>('docker_resource_limit');
    });

    it('classifies absolute timeout signal → goal_timeout', () => {
        expect(categorizeError('absolute timeout exceeded after 90 minutes')).toBe<ErrorCategory>('goal_timeout');
    });

    it('returns unknown for unrecognized errors', () => {
        expect(categorizeError('something weird happened')).toBe<ErrorCategory>('unknown');
    });
});
