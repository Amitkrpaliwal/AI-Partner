import { Router, Request, Response } from 'express';
import { goalOrientedExecutor } from '../agents/GoalOrientedExecutor';
import { db } from '../database';

const router = Router();

// ============================================================================
// POST /api/autonomous/execute
// Start autonomous task execution — delegates to GoalOrientedExecutor singleton
// ============================================================================
router.post('/execute', async (req: Request, res: Response) => {
    try {
        const { task, options } = req.body;
        const userId = (req as any).userId || (req.query.userId as string) || 'default';

        if (!task) {
            return res.status(400).json({ error: 'Task description is required' });
        }

        console.log(`[AutonomousAPI] Starting execution for task: "${task.substring(0, 100)}..."`);

        // Launch in background — GoalOrientedExecutor is a persistent singleton,
        // so getStatus() will always find the execution by ID.
        let resolvedId = `goal_${Date.now()}`;
        const executionPromise = goalOrientedExecutor.executeGoal(task, userId, options);

        // Capture execution ID from the goal:started event
        const idCapture = new Promise<string>((resolve) => {
            goalOrientedExecutor.once('goal:started', (data) => resolve(data.execution_id));
            setTimeout(() => resolve(resolvedId), 1000);
        });

        resolvedId = await idCapture;

        executionPromise.catch((err) => {
            console.error(`[AutonomousAPI] Execution ${resolvedId} failed:`, err);
        });

        res.json({
            success: true,
            execution_id: resolvedId,
            message: 'Autonomous execution started. Listen for WebSocket events for progress.'
        });

    } catch (error) {
        console.error('[AutonomousAPI] Failed to start execution:', error);
        res.status(500).json({ error: 'Failed to start autonomous execution' });
    }
});

// ============================================================================
// GET /api/autonomous/:execution_id/status
// ============================================================================
router.get('/:execution_id/status', (req: Request, res: Response) => {
    const { execution_id } = req.params;

    // GoalOrientedExecutor singleton holds all live execution states
    const status = goalOrientedExecutor.getStatus(execution_id);

    if (!status) {
        return res.status(404).json({ error: 'Execution not found or already completed' });
    }

    res.json({ execution_id, status });
});

// ============================================================================
// POST /api/autonomous/:execution_id/pause
// ============================================================================
router.post('/:execution_id/pause', (req: Request, res: Response) => {
    const { execution_id } = req.params;
    const success = goalOrientedExecutor.pause(execution_id);
    res.json({ success, message: success ? 'Execution paused' : 'Could not pause execution' });
});

// ============================================================================
// POST /api/autonomous/:execution_id/resume
// ============================================================================
router.post('/:execution_id/resume', (req: Request, res: Response) => {
    const { execution_id } = req.params;
    const success = goalOrientedExecutor.resume(execution_id);
    res.json({ success, message: success ? 'Execution resumed' : 'Could not resume execution' });
});

// ============================================================================
// POST /api/autonomous/:execution_id/stop
// ============================================================================
router.post('/:execution_id/stop', (req: Request, res: Response) => {
    const { execution_id } = req.params;
    const success = goalOrientedExecutor.cancel(execution_id);
    res.json({ success, message: success ? 'Execution stopped' : 'Could not stop execution' });
});

// ============================================================================
// POST /api/autonomous/goal/:execution_id/input
// Called by GoalProgressPanel when user submits a hint via the escalation box.
// Resolves the pending Promise in GoalOrientedExecutor so the hint is injected
// into the next ReActReasoner iteration.
// ============================================================================
router.post('/goal/:execution_id/input', (req: Request, res: Response) => {
    const { execution_id } = req.params;
    const { inputId, hint } = req.body;

    if (!inputId) {
        return res.status(400).json({ error: 'inputId is required' });
    }

    const success = goalOrientedExecutor.respondToUserInput(inputId, hint ?? '');
    if (!success) {
        // inputId not found — likely already timed out or resolved
        return res.status(404).json({
            error: 'No pending input found for this inputId — it may have timed out'
        });
    }

    console.log(`[AutonomousAPI] User hint accepted for execution ${execution_id}: "${(hint || '').substring(0, 80)}"`);
    res.json({ success: true, message: 'Hint received — agent will apply it on the next iteration' });
});

// ============================================================================
// GET /api/autonomous/history
// List past executions from persistent SQLite store
// ============================================================================
router.get('/history', async (req: Request, res: Response) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
        const executions = await db.all(
            'SELECT id, user_id, request, status, iterations, started_at, completed_at FROM goal_executions ORDER BY started_at DESC LIMIT ?',
            [limit]
        );
        res.json({ executions });
    } catch (error) {
        console.error('[AutonomousAPI] Failed to fetch history:', error);
        res.status(500).json({ error: 'Failed to fetch execution history' });
    }
});

export default router;
