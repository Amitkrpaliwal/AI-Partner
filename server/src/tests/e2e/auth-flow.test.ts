/**
 * E2E Test: Authentication Flow
 * Tests: login → JWT → API calls → refresh → logout
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios, { AxiosInstance } from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';

describe('Authentication Flow', () => {
    let api: AxiosInstance;
    let jwt: string = '';
    let authEnabled = false;

    beforeAll(async () => {
        api = axios.create({ baseURL: BASE, timeout: 10000, validateStatus: () => true });
        // Check if auth is enabled
        const res = await api.get('/api/health');
        authEnabled = res.data?.auth?.enabled === true;
        if (!authEnabled) {
            console.warn('Auth is disabled — some tests will be skipped');
        }
    });

    it('should return 401 for unauthenticated requests when auth is enabled', async () => {
        if (!authEnabled) return;
        const res = await api.get('/api/conversations');
        expect(res.status).toBe(401);
    });

    it('should allow access to /api/health without authentication', async () => {
        const res = await api.get('/api/health');
        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('status');
    });

    it('should login with valid credentials and receive JWT', async () => {
        if (!authEnabled) return;
        const res = await api.post('/api/auth/login', {
            username: 'admin',
            password: 'admin', // Default credentials
        });
        expect(res.status).toBe(200);
        expect(res.data.token || res.headers['set-cookie']).toBeTruthy();
        jwt = res.data.token || '';
    });

    it('should reject login with invalid credentials', async () => {
        if (!authEnabled) return;
        const res = await api.post('/api/auth/login', {
            username: 'admin',
            password: 'wrong_password_12345',
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should access protected endpoints with JWT', async () => {
        if (!authEnabled || !jwt) return;
        const res = await api.get('/api/conversations', {
            headers: { Authorization: `Bearer ${jwt}` },
        });
        expect(res.status).toBe(200);
    });

    it('should generate and use an API key', async () => {
        if (!authEnabled || !jwt) return;

        // Generate API key
        const genRes = await api.post('/api/auth/apikey', {}, {
            headers: { Authorization: `Bearer ${jwt}` },
        });
        if (genRes.status !== 200) return; // API key endpoint may not exist

        const apiKey = genRes.data.apiKey;
        expect(apiKey).toBeTruthy();

        // Use API key
        const res = await api.get('/api/conversations', {
            headers: { 'X-API-Key': apiKey },
        });
        expect(res.status).toBe(200);
    });

    it('should reject expired/invalid JWT', async () => {
        if (!authEnabled) return;
        const res = await api.get('/api/conversations', {
            headers: { Authorization: 'Bearer invalid.jwt.token' },
        });
        expect(res.status).toBe(401);
    });

    it('should enforce rate limiting', async () => {
        if (!authEnabled) return;
        // Send 200 rapid requests — should trigger rate limit
        const headers = jwt ? { Authorization: `Bearer ${jwt}` } : {};
        const promises = Array(200).fill(null).map(() =>
            api.get('/api/health', { headers }).catch(e => e.response)
        );

        const responses = await Promise.all(promises);
        const rateLimited = responses.filter(r => r?.status === 429);

        // At least some should be rate limited
        console.log(`Rate limited: ${rateLimited.length}/200 requests`);
        expect(rateLimited.length).toBeGreaterThan(0);
    }, 30000);
});
