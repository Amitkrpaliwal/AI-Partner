/**
 * Scheduler API Routes
 *
 * GET    /api/scheduler/tasks          - List all scheduled tasks
 * POST   /api/scheduler/tasks          - Create a new scheduled task
 * GET    /api/scheduler/tasks/:id      - Get task details
 * DELETE /api/scheduler/tasks/:id      - Delete a task
 * POST   /api/scheduler/tasks/:id/enable  - Enable a task
 * POST   /api/scheduler/tasks/:id/disable - Disable a task
 * GET    /api/scheduler/tasks/:id/runs    - Get task run history
 */

import { Router, Request, Response } from 'express';
import { scheduler } from '../services/Scheduler';

export const schedulerRoutes = Router();

/**
 * GET /api/scheduler/tasks
 * List all scheduled tasks.
 */
schedulerRoutes.get('/tasks', async (_req: Request, res: Response) => {
    try {
        const tasks = await scheduler.listTasks();
        res.json({
            success: true,
            tasks,
            activeJobs: scheduler.getActiveCount(),
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/scheduler/tasks
 * Create a new scheduled task.
 *
 * Body: {
 *   name: string,
 *   cronExpression: string,
 *   taskMessage: string,
 *   mode?: 'chat' | 'goal',
 *   userId?: string
 * }
 */
schedulerRoutes.post('/tasks', async (req: Request, res: Response) => {
    try {
        const { name, cronExpression, taskMessage, mode, userId } = req.body;

        if (!name || !cronExpression || !taskMessage) {
            return res.status(400).json({
                success: false,
                error: 'name, cronExpression, and taskMessage are required',
            });
        }

        const task = await scheduler.addTask(name, cronExpression, taskMessage, { mode, userId });
        res.json({ success: true, task });
    } catch (error: any) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/scheduler/tasks/:id
 * Get a specific task.
 */
schedulerRoutes.get('/tasks/:id', async (req: Request, res: Response) => {
    try {
        const task = await scheduler.getTask(req.params.id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        res.json({ success: true, task });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/scheduler/tasks/:id
 * Delete a scheduled task.
 */
schedulerRoutes.delete('/tasks/:id', async (req: Request, res: Response) => {
    try {
        const deleted = await scheduler.deleteTask(req.params.id);
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        res.json({ success: true, message: 'Task deleted' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/scheduler/tasks/:id/enable
 * Enable a scheduled task.
 */
schedulerRoutes.post('/tasks/:id/enable', async (req: Request, res: Response) => {
    try {
        await scheduler.setEnabled(req.params.id, true);
        res.json({ success: true, message: 'Task enabled' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/scheduler/tasks/:id/disable
 * Disable a scheduled task.
 */
schedulerRoutes.post('/tasks/:id/disable', async (req: Request, res: Response) => {
    try {
        await scheduler.setEnabled(req.params.id, false);
        res.json({ success: true, message: 'Task disabled' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/scheduler/tasks/:id/runs
 * Get run history for a task.
 */
schedulerRoutes.get('/tasks/:id/runs', async (req: Request, res: Response) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
        const runs = await scheduler.getTaskRuns(req.params.id, limit);
        res.json({ success: true, runs });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default schedulerRoutes;
