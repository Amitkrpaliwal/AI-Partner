/**
 * Benchmark Suite: Search Latency, Tool Call Latency, LLM Round-Trip
 *
 * Measures performance baselines for core operations.
 * Results are logged to console for comparison across runs.
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const api = axios.create({ baseURL: BASE, timeout: 30000 });

interface BenchmarkResult {
    name: string;
    samples: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
}

function summarize(name: string, latencies: number[]): BenchmarkResult {
    const sorted = [...latencies].sort((a, b) => a - b);
    const result: BenchmarkResult = {
        name,
        samples: latencies.length,
        avgMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        p50Ms: sorted[Math.floor(sorted.length * 0.5)],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    };
    console.log(
        `[BENCH] ${result.name}: avg=${result.avgMs}ms min=${result.minMs}ms max=${result.maxMs}ms p50=${result.p50Ms}ms p95=${result.p95Ms}ms (n=${result.samples})`
    );
    return result;
}

async function measure(fn: () => Promise<void>): Promise<number> {
    const start = performance.now();
    await fn();
    return Math.round(performance.now() - start);
}

describe('Benchmark Suite', () => {
    it('benchmark: health endpoint latency (baseline)', async () => {
        const latencies: number[] = [];
        for (let i = 0; i < 30; i++) {
            latencies.push(await measure(() => api.get('/api/health').then(() => { })));
        }
        const result = summarize('Health Endpoint', latencies);
        expect(result.avgMs).toBeLessThan(100);
    });

    it('benchmark: file listing latency', async () => {
        const latencies: number[] = [];
        for (let i = 0; i < 20; i++) {
            latencies.push(await measure(() => api.get('/api/files').then(() => { })));
        }
        const result = summarize('File Listing', latencies);
        expect(result.avgMs).toBeLessThan(500);
    });

    it('benchmark: search latency', async () => {
        let searchAvailable = false;
        try {
            await api.get('/api/search/status');
            searchAvailable = true;
        } catch { /* skip */ }

        if (!searchAvailable) {
            console.log('[BENCH] Search: SKIPPED (not available)');
            return;
        }

        const queries = ['JavaScript', 'Python', 'Docker', 'React', 'TypeScript'];
        const latencies: number[] = [];
        for (const q of queries) {
            latencies.push(await measure(() =>
                api.post('/api/search/test', { query: q }).then(() => { })
            ));
        }
        const result = summarize('Web Search', latencies);
        expect(result.avgMs).toBeLessThan(15000); // Search can be slow
    }, 120000);

    it('benchmark: scheduler task list latency', async () => {
        const latencies: number[] = [];
        for (let i = 0; i < 20; i++) {
            latencies.push(await measure(() => api.get('/api/scheduler/tasks').then(() => { })));
        }
        const result = summarize('Scheduler List', latencies);
        expect(result.avgMs).toBeLessThan(200);
    });

    it('benchmark: messaging status latency', async () => {
        const latencies: number[] = [];
        for (let i = 0; i < 20; i++) {
            latencies.push(await measure(() =>
                api.get('/api/messaging/status').then(() => { }).catch(() => { })
            ));
        }
        const result = summarize('Messaging Status', latencies);
        expect(result.avgMs).toBeLessThan(500);
    });

    it('benchmark: heartbeat status latency', async () => {
        const latencies: number[] = [];
        for (let i = 0; i < 20; i++) {
            latencies.push(await measure(() =>
                api.get('/api/heartbeat/status').then(() => { }).catch(() => { })
            ));
        }
        const result = summarize('Heartbeat Status', latencies);
        expect(result.avgMs).toBeLessThan(200);
    });

    it('benchmark: audit log query latency', async () => {
        const latencies: number[] = [];
        for (let i = 0; i < 10; i++) {
            latencies.push(await measure(() =>
                api.get('/api/audit/log?limit=50').then(() => { }).catch(() => { })
            ));
        }
        const result = summarize('Audit Log Query', latencies);
        expect(result.avgMs).toBeLessThan(500);
    });
});
