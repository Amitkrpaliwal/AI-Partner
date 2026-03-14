/**
 * E2E Test: Scheduled Task
 * Tests: create cron → verify registration → check runs → cleanup
 */
import { describe, it, expect, afterAll } from 'vitest';
import axios from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const api = axios.create({ baseURL: BASE, timeout: 15000, validateStatus: () => true });

const createdTaskIds: string[] = [];

describe('Scheduled Task Lifecycle', () => {
    it('should list tasks (initially may be empty)', async () => {
        const res = await api.get('/api/scheduler/tasks');
        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('tasks');
        expect(res.data).toHaveProperty('activeJobs');
    });

    it('should create a scheduled task', async () => {
        const res = await api.post('/api/scheduler/tasks', {
            name: 'E2E Test Task',
            cronExpression: '0 0 31 2 *', // Feb 31 = never fires
            taskMessage: 'This is an E2E test task',
            mode: 'chat',
        });
        expect(res.status).toBe(200);
        expect(res.data.task).toBeDefined();
        expect(res.data.task.name).toBe('E2E Test Task');
        expect(res.data.task.enabled).toBe(true);
        createdTaskIds.push(res.data.task.id);
    });

    it('should reject task with invalid cron expression', async () => {
        const res = await api.post('/api/scheduler/tasks', {
            name: 'Bad Cron',
            cronExpression: 'not_a_cron',
            taskMessage: 'test',
            mode: 'chat',
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should disable a task', async () => {
        if (createdTaskIds.length === 0) return;
        const id = createdTaskIds[0];
        const res = await api.post(`/api/scheduler/tasks/${id}/disable`);
        expect(res.status).toBe(200);

        // Verify disabled
        const listRes = await api.get('/api/scheduler/tasks');
        const task = listRes.data.tasks?.find((t: any) => t.id === id);
        expect(task?.enabled).toBe(false);
    });

    it('should re-enable a task', async () => {
        if (createdTaskIds.length === 0) return;
        const id = createdTaskIds[0];
        const res = await api.post(`/api/scheduler/tasks/${id}/enable`);
        expect(res.status).toBe(200);
    });

    it('should retrieve task run history', async () => {
        if (createdTaskIds.length === 0) return;
        const id = createdTaskIds[0];
        const res = await api.get(`/api/scheduler/tasks/${id}/runs`);
        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('runs');
    });

    it('should delete a task', async () => {
        if (createdTaskIds.length === 0) return;
        const id = createdTaskIds[0];
        const res = await api.delete(`/api/scheduler/tasks/${id}`);
        expect(res.status).toBe(200);
        createdTaskIds.shift();
    });

    // Webhook tests
    it('should create and list webhooks', async () => {
        const createRes = await api.post('/api/webhooks', {
            name: 'E2E Test Webhook',
            taskTemplate: 'Process: {{payload}}',
            mode: 'chat',
        });
        expect(createRes.status).toBe(200);
        expect(createRes.data.webhook).toBeDefined();

        const webhookId = createRes.data.webhook.id;

        const listRes = await api.get('/api/webhooks');
        expect(listRes.status).toBe(200);
        expect(listRes.data.webhooks?.some((w: any) => w.id === webhookId)).toBe(true);

        // Cleanup
        await api.delete(`/api/webhooks/${webhookId}`);
    });

    afterAll(async () => {
        // Cleanup any remaining test tasks
        for (const id of createdTaskIds) {
            await api.delete(`/api/scheduler/tasks/${id}`).catch(() => { });
        }
    });
});
