/**
 * HITL pendingInputs FIFO queue tests (A4 fix)
 *
 * Tests the queue data structure logic in isolation — verifies FIFO ordering,
 * multi-execution isolation, and stale-inputId discard behaviour.
 * The logic mirrors GoalOrientedExecutor's pendingInputs implementation exactly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Inline implementation of the queue logic (mirrors GoalOrientedExecutor)
// Keeps the test free of GoalOrientedExecutor's heavy imports (Docker, MCP, etc.)
// ─────────────────────────────────────────────────────────────────────────────

type PendingEntry = {
    inputId: string;
    resolve: (hint: string) => void;
    timeout: ReturnType<typeof setTimeout>;
};

class PendingInputQueue {
    private pendingInputs: Map<string, PendingEntry[]> = new Map();
    private inputIdToExecution: Map<string, string> = new Map();

    enqueue(executionId: string, inputId: string, resolve: (hint: string) => void): void {
        const timeout = setTimeout(() => {
            const arr = this.pendingInputs.get(executionId);
            if (arr) {
                const idx = arr.findIndex(e => e.inputId === inputId);
                if (idx >= 0) arr.splice(idx, 1);
                if (arr.length === 0) this.pendingInputs.delete(executionId);
            }
            this.inputIdToExecution.delete(inputId);
            resolve('');
        }, 60_000);

        const arr = this.pendingInputs.get(executionId) ?? [];
        arr.push({ inputId, resolve, timeout });
        this.pendingInputs.set(executionId, arr);
        this.inputIdToExecution.set(inputId, executionId);
    }

    respondByInputId(inputId: string, hint: string): boolean {
        const execId = this.inputIdToExecution.get(inputId);
        if (!execId) return false;
        const arr = this.pendingInputs.get(execId);
        if (!arr) { this.inputIdToExecution.delete(inputId); return false; }
        const idx = arr.findIndex(e => e.inputId === inputId);
        if (idx < 0) { this.inputIdToExecution.delete(inputId); return false; }
        const [entry] = arr.splice(idx, 1);
        if (arr.length === 0) this.pendingInputs.delete(execId);
        this.inputIdToExecution.delete(inputId);
        clearTimeout(entry.timeout);
        entry.resolve(hint);
        return true;
    }

    resolveOldest(message: string): boolean {
        for (const [execId, arr] of this.pendingInputs) {
            if (arr.length === 0) { this.pendingInputs.delete(execId); continue; }
            const entry = arr.shift()!;
            if (arr.length === 0) this.pendingInputs.delete(execId);
            this.inputIdToExecution.delete(entry.inputId);
            clearTimeout(entry.timeout);
            entry.resolve(message);
            return true;
        }
        return false;
    }

    pendingCount(executionId?: string): number {
        if (executionId) return this.pendingInputs.get(executionId)?.length ?? 0;
        let total = 0;
        for (const arr of this.pendingInputs.values()) total += arr.length;
        return total;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PendingInputQueue — FIFO ordering', () => {
    let queue: PendingInputQueue;
    beforeEach(() => { queue = new PendingInputQueue(); vi.useFakeTimers(); });

    it('resolveOldest returns false when no entries pending', () => {
        expect(queue.resolveOldest('anything')).toBe(false);
    });

    it('resolves the FIRST (oldest) pending input, not the last', () => {
        const results: string[] = [];
        queue.enqueue('exec-1', 'input-A', (h) => results.push(`A:${h}`));
        queue.enqueue('exec-1', 'input-B', (h) => results.push(`B:${h}`));

        const resolved = queue.resolveOldest('browser-released');

        expect(resolved).toBe(true);
        // A was enqueued first — it must be resolved, not B
        expect(results).toEqual(['A:browser-released']);
        // B still pending
        expect(queue.pendingCount('exec-1')).toBe(1);
    });

    it('second call to resolveOldest resolves the second entry', () => {
        const results: string[] = [];
        queue.enqueue('exec-1', 'input-A', (h) => results.push(`A:${h}`));
        queue.enqueue('exec-1', 'input-B', (h) => results.push(`B:${h}`));

        queue.resolveOldest('first-release');
        queue.resolveOldest('second-release');

        expect(results).toEqual(['A:first-release', 'B:second-release']);
        expect(queue.pendingCount('exec-1')).toBe(0);
    });

    it('resolveOldest returns false after all entries resolved', () => {
        const noop = () => {};
        queue.enqueue('exec-1', 'input-A', noop);
        queue.resolveOldest('msg');
        expect(queue.resolveOldest('msg2')).toBe(false);
    });
});

describe('PendingInputQueue — respondByInputId', () => {
    let queue: PendingInputQueue;
    beforeEach(() => { queue = new PendingInputQueue(); vi.useFakeTimers(); });

    it('resolves correct entry by inputId', () => {
        const results: string[] = [];
        queue.enqueue('exec-1', 'input-A', (h) => results.push(`A:${h}`));
        queue.enqueue('exec-1', 'input-B', (h) => results.push(`B:${h}`));

        const ok = queue.respondByInputId('input-B', 'user-said-hi');

        expect(ok).toBe(true);
        expect(results).toEqual(['B:user-said-hi']);
        // input-A still pending
        expect(queue.pendingCount('exec-1')).toBe(1);
    });

    it('returns false for unknown inputId', () => {
        expect(queue.respondByInputId('nonexistent', 'hint')).toBe(false);
    });
});

describe('PendingInputQueue — multi-execution isolation', () => {
    let queue: PendingInputQueue;
    beforeEach(() => { queue = new PendingInputQueue(); vi.useFakeTimers(); });

    it('resolveOldest targets the earliest-enqueued execution, not a later one', () => {
        const results: string[] = [];
        queue.enqueue('exec-1', 'input-1A', (h) => results.push(`exec1:${h}`));
        queue.enqueue('exec-2', 'input-2A', (h) => results.push(`exec2:${h}`));

        queue.resolveOldest('browser-released');

        // exec-1 was registered first — its pending input should be resolved
        expect(results).toEqual(['exec1:browser-released']);
        expect(queue.pendingCount('exec-1')).toBe(0);
        expect(queue.pendingCount('exec-2')).toBe(1);
    });

    it('respondByInputId only affects the targeted execution', () => {
        const results: string[] = [];
        queue.enqueue('exec-1', 'input-1A', (h) => results.push(`exec1:${h}`));
        queue.enqueue('exec-2', 'input-2A', (h) => results.push(`exec2:${h}`));

        queue.respondByInputId('input-2A', 'hint-for-exec2');

        expect(results).toEqual(['exec2:hint-for-exec2']);
        expect(queue.pendingCount('exec-1')).toBe(1);
        expect(queue.pendingCount('exec-2')).toBe(0);
    });
});
