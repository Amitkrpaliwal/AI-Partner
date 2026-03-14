import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database';

export interface TaskDefinition {
    id?: string;
    name: string;
    description?: string;
    schedule: string; // Cron expression
    action: string;
    parameters: Record<string, any>;
    enabled: boolean;
    last_run?: string;
    next_run?: string;
    created_at?: string;
}

export interface TaskExecution {
    id: string;
    task_id: string;
    executed_at: string;
    status: 'success' | 'error';
    result?: string;
    error?: string;
}

export class TaskScheduler {
    private jobs: Map<string, cron.ScheduledTask> = new Map();

    constructor() {
        this.loadTasks();
    }

    async loadTasks() {
        console.log('[TaskScheduler] Loading tasks from database...');
        try {
            const rows = await db.all('SELECT * FROM scheduled_tasks WHERE enabled = 1');
            for (const row of rows) {
                const task: TaskDefinition = {
                    ...row,
                    parameters: JSON.parse(row.parameters || '{}'),
                    enabled: Boolean(row.enabled)
                };
                this.scheduleJob(task);
            }
            console.log(`[TaskScheduler] Loaded ${rows.length} tasks.`);
        } catch (error) {
            console.error('[TaskScheduler] Failed to load tasks:', error);
        }
    }

    private scheduleJob(task: TaskDefinition) {
        if (!task.id) return;

        // Stop existing if any
        if (this.jobs.has(task.id)) {
            this.jobs.get(task.id)?.stop();
        }

        if (!task.enabled) return;

        console.log(`[TaskScheduler] Scheduling task: ${task.name} (${task.schedule})`);

        const job = cron.schedule(task.schedule, async () => {
            await this.executeTask(task);
        });

        this.jobs.set(task.id, job);
    }

    private async executeTask(task: TaskDefinition) {
        console.log(`[TaskScheduler] Executing task: ${task.name}`);
        const now = new Date().toISOString();
        const executionId = uuidv4();

        try {
            // 1. Update last_run
            await db.run('UPDATE scheduled_tasks SET last_run = ? WHERE id = ?', [now, task.id]);

            let result = '';

            // 2. Perform Action
            if (task.action === 'log') {
                console.log('[Task Action Log]', task.parameters.message);
                result = `Logged: ${task.parameters.message}`;
            } else if (task.action === 'agent_prompt') {
                // Future: Send prompt to agent orchestrator
                const { agentOrchestrator } = await import('./AgentOrchestrator');
                const response = await agentOrchestrator.chat('default', task.parameters.prompt || task.name);
                result = response.response;
            } else if (task.action === 'notification') {
                // Send notification
                result = `Notification: ${task.parameters.message}`;
            } else {
                console.log(`[Task Action] Unknown action type: ${task.action}`, task.parameters);
                result = `Unknown action: ${task.action}`;
            }

            // 3. Log execution
            await this.logExecution(executionId, task.id!, now, 'success', result);

        } catch (e) {
            console.error(`[TaskScheduler] Task execution failed: ${task.id}`, e);
            await this.logExecution(executionId, task.id!, now, 'error', undefined, String(e));
        }
    }

    private async logExecution(
        id: string,
        taskId: string,
        executedAt: string,
        status: 'success' | 'error',
        result?: string,
        error?: string
    ): Promise<void> {
        try {
            // Store in episodic memory as event for now
            // TODO: Create dedicated task_executions table
            await db.run(
                `INSERT INTO episodic_memory (id, event_type, event_text, context, timestamp) VALUES (?, ?, ?, ?, ?)`,
                [
                    id,
                    'task_execution',
                    `Task executed: ${taskId} - ${status}`,
                    JSON.stringify({ taskId, result, error }),
                    executedAt
                ]
            );
        } catch (e) {
            console.error('[TaskScheduler] Failed to log execution:', e);
        }
    }

    async createTask(task: Omit<TaskDefinition, 'id'>): Promise<string> {
        const id = uuidv4();
        const newTask: TaskDefinition = { ...task, id };

        await db.run(
            `INSERT INTO scheduled_tasks (id, user_id, name, description, schedule, action, parameters, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, 'default', newTask.name, newTask.description || '', newTask.schedule, newTask.action, JSON.stringify(newTask.parameters), newTask.enabled ? 1 : 0]
        );

        this.scheduleJob(newTask);
        return id;
    }

    async updateTask(id: string, updates: Partial<TaskDefinition>): Promise<TaskDefinition | null> {
        const existing = await db.get('SELECT * FROM scheduled_tasks WHERE id = ?', [id]);
        if (!existing) return null;

        const fields: string[] = [];
        const values: any[] = [];

        if (updates.name !== undefined) {
            fields.push('name = ?');
            values.push(updates.name);
        }
        if (updates.description !== undefined) {
            fields.push('description = ?');
            values.push(updates.description);
        }
        if (updates.schedule !== undefined) {
            fields.push('schedule = ?');
            values.push(updates.schedule);
        }
        if (updates.action !== undefined) {
            fields.push('action = ?');
            values.push(updates.action);
        }
        if (updates.parameters !== undefined) {
            fields.push('parameters = ?');
            values.push(JSON.stringify(updates.parameters));
        }
        if (updates.enabled !== undefined) {
            fields.push('enabled = ?');
            values.push(updates.enabled ? 1 : 0);
        }

        if (fields.length === 0) return null;

        values.push(id);
        await db.run(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`, values);

        // Refresh the task
        const updated = await this.getTask(id);
        if (updated) {
            this.scheduleJob(updated);
        }
        return updated;
    }

    async pauseTask(id: string): Promise<boolean> {
        const job = this.jobs.get(id);
        if (job) {
            job.stop();
        }
        await db.run('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?', [id]);
        return true;
    }

    async resumeTask(id: string): Promise<boolean> {
        await db.run('UPDATE scheduled_tasks SET enabled = 1 WHERE id = ?', [id]);
        const task = await this.getTask(id);
        if (task) {
            this.scheduleJob(task);
            return true;
        }
        return false;
    }

    async deleteTask(id: string): Promise<void> {
        if (this.jobs.has(id)) {
            this.jobs.get(id)?.stop();
            this.jobs.delete(id);
        }
        await db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id]);
    }

    async getTask(id: string): Promise<TaskDefinition | null> {
        const row = await db.get('SELECT * FROM scheduled_tasks WHERE id = ?', [id]);
        if (!row) return null;
        return {
            ...row,
            parameters: JSON.parse(row.parameters || '{}'),
            enabled: Boolean(row.enabled)
        };
    }

    async getAllTasks(): Promise<TaskDefinition[]> {
        const rows = await db.all('SELECT * FROM scheduled_tasks ORDER BY created_at DESC');
        return rows.map(row => ({
            ...row,
            parameters: JSON.parse(row.parameters || '{}'),
            enabled: Boolean(row.enabled)
        }));
    }

    async getTaskHistory(taskId: string, limit: number = 10): Promise<TaskExecution[]> {
        const rows = await db.all(
            `SELECT * FROM episodic_memory 
             WHERE event_type = 'task_execution' 
             AND json_extract(context, '$.taskId') = ?
             ORDER BY timestamp DESC LIMIT ?`,
            [taskId, limit]
        );

        return rows.map(row => {
            const context = JSON.parse(row.context || '{}');
            return {
                id: row.id,
                task_id: context.taskId,
                executed_at: row.timestamp,
                status: context.error ? 'error' : 'success',
                result: context.result,
                error: context.error
            };
        });
    }
}

export const taskScheduler = new TaskScheduler();
