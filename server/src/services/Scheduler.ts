/**
 * Scheduler Service
 *
 * Manages cron-based scheduled tasks that trigger AI agent execution.
 *
 * Features:
 * - Cron expression scheduling (via node-cron)
 * - Persistent storage (SQLite)
 * - Execution history tracking
 * - Auto-restore on server restart
 * - Pause/resume per task
 */

import cron from 'node-cron';
import crypto from 'crypto';
import { db } from '../database';
import { auditLogger } from './AuditLogger';

export interface ScheduledTask {
    id: string;
    name: string;
    cronExpression: string;
    taskMessage: string;       // The prompt/message sent to the AI
    mode: 'chat' | 'goal';    // Execution mode
    userId: string;
    enabled: boolean;
    createdAt: string;
    lastRunAt?: string;
    nextRunAt?: string;
    runCount: number;
}

export interface TaskRun {
    id: string;
    taskId: string;
    startTime: string;
    endTime?: string;
    status: 'running' | 'completed' | 'failed';
    result?: string;
    error?: string;
}

class Scheduler {
    private jobs: Map<string, cron.ScheduledTask> = new Map();
    private initialized = false;
    private io: any = null;

    /** Inject Socket.IO instance for real-time updates */
    setSocketIO(io: any): void {
        this.io = io;
    }


    async initialize(): Promise<void> {
        if (this.initialized) return;

        await db.run(`
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                cron_expression TEXT NOT NULL,
                task_message TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'chat',
                user_id TEXT NOT NULL DEFAULT 'default',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now')),
                last_run_at TEXT,
                run_count INTEGER DEFAULT 0
            )
        `);

        await db.run(`
            CREATE TABLE IF NOT EXISTS task_runs (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                start_time TEXT NOT NULL DEFAULT (datetime('now')),
                end_time TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                result TEXT,
                error TEXT,
                FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
            )
        `);

        await db.run(`
            CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id)
        `);

        this.initialized = true;

        // Restore active tasks from DB
        await this.restoreTasks();

        console.log('[Scheduler] Initialized');
    }

    /**
     * Add a new scheduled task.
     */
    async addTask(
        name: string,
        cronExpression: string,
        taskMessage: string,
        options: { mode?: 'chat' | 'goal'; userId?: string } = {}
    ): Promise<ScheduledTask> {
        await this.ensureInitialized();

        // Validate cron expression
        if (!cron.validate(cronExpression)) {
            throw new Error(`Invalid cron expression: ${cronExpression}`);
        }

        const id = `sched_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const mode = options.mode || 'chat';
        const userId = options.userId || 'default';

        await db.run(
            `INSERT INTO scheduled_tasks (id, name, cron_expression, task_message, mode, user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, name, cronExpression, taskMessage, mode, userId]
        );

        const task = await this.getTask(id);
        if (!task) throw new Error('Failed to create task');

        // Start the cron job
        this.startJob(task);

        auditLogger.log('system', 'scheduler.task_created', {
            taskId: id, name, cronExpression, mode,
        }, { userId });

        console.log(`[Scheduler] Task created: ${name} (${cronExpression})`);
        return task;
    }

    /**
     * Get a single task by ID.
     */
    async getTask(id: string): Promise<ScheduledTask | null> {
        await this.ensureInitialized();

        const row: any = await db.get('SELECT * FROM scheduled_tasks WHERE id = ?', [id]);
        if (!row) return null;

        return this.rowToTask(row);
    }

    /**
     * List all tasks.
     */
    async listTasks(): Promise<ScheduledTask[]> {
        await this.ensureInitialized();

        const rows = await db.all('SELECT * FROM scheduled_tasks ORDER BY created_at DESC');
        return (rows || []).map((r: any) => this.rowToTask(r));
    }

    /**
     * Enable/disable a task.
     */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
        await this.ensureInitialized();

        await db.run('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);

        if (enabled) {
            const task = await this.getTask(id);
            if (task) this.startJob(task);
        } else {
            this.stopJob(id);
        }

        console.log(`[Scheduler] Task ${id} ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Delete a task and its run history.
     */
    async deleteTask(id: string): Promise<boolean> {
        await this.ensureInitialized();

        this.stopJob(id);

        await db.run('DELETE FROM task_runs WHERE task_id = ?', [id]);
        const result = await db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id]);

        auditLogger.log('system', 'scheduler.task_deleted', { taskId: id });

        return (result as any)?.changes > 0;
    }

    /**
     * Get run history for a task.
     */
    async getTaskRuns(taskId: string, limit: number = 20): Promise<TaskRun[]> {
        await this.ensureInitialized();

        const rows = await db.all(
            'SELECT * FROM task_runs WHERE task_id = ? ORDER BY start_time DESC LIMIT ?',
            [taskId, limit]
        );

        return (rows || []).map((r: any) => ({
            id: r.id,
            taskId: r.task_id,
            startTime: r.start_time,
            endTime: r.end_time,
            status: r.status,
            result: r.result,
            error: r.error,
        }));
    }

    /**
     * Execute a scheduled task (called by the cron job).
     */
    private async executeTask(task: ScheduledTask): Promise<void> {
        const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        await db.run(
            `INSERT INTO task_runs (id, task_id, status) VALUES (?, ?, 'running')`,
            [runId, task.id]
        );

        console.log(`[Scheduler] Executing task: ${task.name}`);

        try {
            // Dynamic import to avoid circular deps
            const { agentOrchestrator } = await import('./AgentOrchestrator');
            const result = await agentOrchestrator.chat(task.userId, task.taskMessage);

            await db.run(
                `UPDATE task_runs SET end_time = datetime('now'), status = 'completed', result = ? WHERE id = ?`,
                [JSON.stringify(result.response?.substring(0, 2000)), runId]
            );

            await db.run(
                `UPDATE scheduled_tasks SET last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ?`,
                [task.id]
            );

            // Emit real-time update to frontend
            this.io?.emit('scheduler:task_run', {
                taskId: task.id, taskName: task.name, runId,
                status: 'completed', startTime: new Date().toISOString(),
            });

            auditLogger.log('system', 'scheduler.task_executed', {
                taskId: task.id, name: task.name, runId, status: 'completed',
            }, { userId: task.userId });

        } catch (error: any) {
            await db.run(
                `UPDATE task_runs SET end_time = datetime('now'), status = 'failed', error = ? WHERE id = ?`,
                [error.message?.substring(0, 500), runId]
            );

            await db.run(
                `UPDATE scheduled_tasks SET last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ?`,
                [task.id]
            );

            // Emit real-time failure update to frontend
            this.io?.emit('scheduler:task_run', {
                taskId: task.id, taskName: task.name, runId,
                status: 'failed', error: error.message, startTime: new Date().toISOString(),
            });

            auditLogger.log('system', 'scheduler.task_failed', {
                taskId: task.id, name: task.name, runId, error: error.message,
            }, { userId: task.userId, severity: 'error' });

            console.error(`[Scheduler] Task ${task.name} failed:`, error.message);
        }
    }

    /**
     * Start a cron job for a task.
     */
    private startJob(task: ScheduledTask): void {
        // Stop existing job if any
        this.stopJob(task.id);

        if (!task.enabled) return;

        const job = cron.schedule(task.cronExpression, () => {
            this.executeTask(task).catch(e => {
                console.error(`[Scheduler] Unhandled error in task ${task.name}:`, e);
            });
        });

        this.jobs.set(task.id, job);
    }

    /**
     * Stop a cron job.
     */
    private stopJob(id: string): void {
        const job = this.jobs.get(id);
        if (job) {
            job.stop();
            this.jobs.delete(id);
        }
    }

    /**
     * Restore scheduled tasks from DB on startup.
     */
    private async restoreTasks(): Promise<void> {
        const rows = await db.all('SELECT * FROM scheduled_tasks WHERE enabled = 1');
        const tasks = (rows || []).map((r: any) => this.rowToTask(r));

        for (const task of tasks) {
            this.startJob(task);
        }

        if (tasks.length > 0) {
            console.log(`[Scheduler] Restored ${tasks.length} active tasks`);
        }
    }

    private rowToTask(row: any): ScheduledTask {
        return {
            id: row.id,
            name: row.name,
            cronExpression: row.cron_expression,
            taskMessage: row.task_message,
            mode: row.mode,
            userId: row.user_id,
            enabled: row.enabled === 1,
            createdAt: row.created_at,
            lastRunAt: row.last_run_at,
            runCount: row.run_count || 0,
        };
    }

    /**
     * Get active job count.
     */
    getActiveCount(): number {
        return this.jobs.size;
    }

    /**
     * Get recent run history across all tasks.
     */
    async getRecentHistory(limit: number = 50): Promise<any[]> {
        await this.ensureInitialized();
        const rows = await db.all(
            `SELECT tr.*, st.name as task_name FROM task_runs tr
             JOIN scheduled_tasks st ON tr.task_id = st.id
             ORDER BY tr.start_time DESC LIMIT ?`,
            [limit]
        );
        return (rows || []).map((r: any) => ({
            id: r.id,
            taskId: r.task_id,
            taskName: r.task_name,
            startTime: r.start_time,
            endTime: r.end_time,
            status: r.status,
            result: r.result,
            error: r.error,
        }));
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.initialize();
        }
    }
}

export const scheduler = new Scheduler();
