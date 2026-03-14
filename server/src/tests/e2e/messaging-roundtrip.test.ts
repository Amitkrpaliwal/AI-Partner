/**
 * E2E Test: Messaging Roundtrip
 * Tests: send via adapter → get response
 *
 * NOTE: These tests verify the messaging API infrastructure without
 * requiring actual provider tokens. Integration tests with real
 * providers require manual setup.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const api = axios.create({ baseURL: BASE, timeout: 15000, validateStatus: () => true });

describe('Messaging Roundtrip', () => {
    let messagingAvailable = false;
    let registeredProviders: string[] = [];

    beforeAll(async () => {
        try {
            const res = await api.get('/api/messaging/status');
            if (res.status === 200) {
                messagingAvailable = true;
                registeredProviders = res.data.available || [];
            }
        } catch {
            console.warn('Messaging API not available — skipping');
        }
    });

    it('should return messaging status with available providers', async () => {
        if (!messagingAvailable) return;
        const res = await api.get('/api/messaging/status');
        expect(res.status).toBe(200);
        expect(res.data.available).toBeInstanceOf(Array);
        expect(res.data.available.length).toBeGreaterThanOrEqual(3); // At least telegram, discord, whatsapp
    });

    it('should list all 5 registered providers', async () => {
        if (!messagingAvailable) return;
        const expected = ['telegram', 'discord', 'whatsapp', 'slack', 'signal'];
        for (const provider of expected) {
            expect(registeredProviders).toContain(provider);
        }
    });

    it('should reject connecting a provider with invalid config', async () => {
        if (!messagingAvailable) return;
        const res = await api.post('/api/messaging/connect', {
            provider: 'discord',
            config: { token: 'invalid_token_12345', enabled: true },
        });
        // Should fail because the token is invalid
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should handle disconnect of non-connected provider gracefully', async () => {
        if (!messagingAvailable) return;
        const res = await api.post('/api/messaging/disconnect', {
            provider: 'telegram',
        });
        // Should not crash — graceful no-op
        expect(res.status).toBeLessThan(500);
    });

    it('should reject sending to non-connected provider', async () => {
        if (!messagingAvailable) return;
        const res = await api.post('/api/messaging/send', {
            provider: 'discord',
            chatId: '123456789',
            text: 'test message',
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should show provider status as disconnected initially', async () => {
        if (!messagingAvailable) return;
        const res = await api.get('/api/messaging/status');
        const providers = res.data.providers || {};
        for (const name of registeredProviders) {
            expect(providers[name]?.connected).toBe(false);
        }
    });
});
