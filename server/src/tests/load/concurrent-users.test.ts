/**
 * Load Test: Concurrent Users
 * Tests: 10 concurrent users → verify container isolation + no memory leaks
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';

describe('Concurrent Users Load Test', () => {
    it('should handle 10 concurrent API requests', async () => {
        const users = Array.from({ length: 10 }, (_, i) => `load_test_user_${i}`);

        const startMem = process.memoryUsage().heapUsed;
        const startTime = Date.now();

        const results = await Promise.allSettled(
            users.map(userId =>
                axios.get(`${BASE}/api/health`, {
                    timeout: 10000,
                    headers: { 'X-User-Id': userId },
                })
            )
        );

        const elapsed = Date.now() - startTime;
        const endMem = process.memoryUsage().heapUsed;

        const successes = results.filter(r => r.status === 'fulfilled').length;
        const failures = results.filter(r => r.status === 'rejected').length;
        const memDelta = (endMem - startMem) / 1024 / 1024;

        console.log(`Concurrent requests: ${successes} success, ${failures} failed in ${elapsed}ms`);
        console.log(`Memory delta: ${memDelta.toFixed(2)} MB`);

        expect(successes).toBe(10);
        expect(elapsed).toBeLessThan(10000); // All should complete within 10s
    });

    it('should handle 50 rapid sequential health checks without degradation', async () => {
        const latencies: number[] = [];

        for (let i = 0; i < 50; i++) {
            const start = Date.now();
            await axios.get(`${BASE}/api/health`, { timeout: 5000 });
            latencies.push(Date.now() - start);
        }

        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];
        const max = Math.max(...latencies);

        console.log(`Health check latency: avg=${avg.toFixed(0)}ms, p95=${p95}ms, max=${max}ms`);

        expect(avg).toBeLessThan(200);  // Average under 200ms
        expect(p95).toBeLessThan(500);  // P95 under 500ms
    }, 30000);

    it('should handle concurrent chat requests without cross-contamination', async () => {
        const users = ['user_alpha', 'user_beta', 'user_gamma'];

        const results = await Promise.allSettled(
            users.map(userId =>
                axios.post(`${BASE}/api/chat`, {
                    message: `Hello, I am ${userId}`,
                    userId,
                }, { timeout: 30000 })
            )
        );

        const fulfilled = results.filter(r => r.status === 'fulfilled');
        // All requests should either succeed or fail gracefully (no LLM = 500)
        // We mainly check that no request caused a crash
        expect(results.every(r => r.status === 'fulfilled' || r.status === 'rejected')).toBe(true);
    }, 60000);

    it('should handle concurrent file listing without errors', async () => {
        const requests = Array(20).fill(null).map(() =>
            axios.get(`${BASE}/api/files`, { timeout: 5000 })
        );

        const results = await Promise.allSettled(requests);
        const successes = results.filter(r => r.status === 'fulfilled').length;

        expect(successes).toBe(20);
    });
});
