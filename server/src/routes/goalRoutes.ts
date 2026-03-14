import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { goalOrientedExecutor } from '../agents/GoalOrientedExecutor';
import { goalValidator } from '../agents/GoalValidator';
import { goalClarifier } from '../agents/goal/GoalClarifier';
import { db } from '../database';
import { GoalExecutionOptions } from '../types/goal';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting — two dimensions:
//   1. IP-level: 10 new-goal requests per minute (blocks external hammering)
//   2. Concurrent-active: max 3 running goals per session/IP (blocks self-DoS via retry loops)
// Idempotency: X-Idempotency-Key header prevents duplicate spawns from client retries.
// ─────────────────────────────────────────────────────────────────────────────

const goalRateLimit = rateLimit({
    windowMs: 60_000,       // 1 minute
    max: 10,                // 10 new goals per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many goal requests — please wait before starting more goals' },
});

// In-memory idempotency store: key → { executionId, createdAt }
// TTL of 60s — after that the same key may start a fresh execution.
const idempotencyStore = new Map<string, { executionId: string; createdAt: number }>();
const IDEMPOTENCY_TTL_MS = 60_000;

function cleanIdempotencyStore() {
    const now = Date.now();
    for (const [k, v] of idempotencyStore) {
        if (now - v.createdAt > IDEMPOTENCY_TTL_MS) idempotencyStore.delete(k);
    }
}

// ============================================================================
// POST /api/autonomous/goal - Start goal-oriented execution
// ============================================================================
router.post('/', goalRateLimit, async (req: Request, res: Response) => {
    try {
        const { request, options, user_id } = req.body as {
            request: string;
            options?: GoalExecutionOptions;
            user_id?: string;
        };

        if (!request) {
            return res.status(400).json({ error: 'Missing required field: request' });
        }

        const userId = (req as any).userId || user_id || 'default';

        // ── Idempotency check ──────────────────────────────────────────────────
        // If the client sends X-Idempotency-Key and an identical key was used within
        // the last 60s, return the existing execution instead of spawning a new one.
        // Prevents duplicate goals from auto-retry logic or double-clicks.
        cleanIdempotencyStore();
        const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
        if (idempotencyKey) {
            const existing = idempotencyStore.get(idempotencyKey);
            if (existing) {
                return res.json({
                    success: true,
                    execution_id: existing.executionId,
                    message: 'Duplicate request — returning existing execution',
                    status: 'executing',
                    idempotent: true,
                });
            }
        }

        // ── Concurrent-active limit ────────────────────────────────────────────
        // Count running goals for this userId. Cap at 3 to prevent resource exhaustion
        // from retry loops — this is the primary protection against self-DoS.
        const activeCount = goalOrientedExecutor.countActiveExecutions(userId);
        if (activeCount >= 3) {
            return res.status(429).json({
                error: `Max 3 concurrent goals allowed. You have ${activeCount} currently running. Wait for one to finish before starting another.`
            });
        }

        console.log(`[GoalRoutes] Starting goal execution for: "${request.substring(0, 100)}..."`);

        // Start execution (async - returns immediately with execution_id)
        const executionPromise = goalOrientedExecutor.executeGoal(request, userId, {
            ...options,
            requestId: (req as any).id,   // propagate HTTP request ID for log tracing
        });

        // Get execution ID from the event
        const executionId = await new Promise<string>((resolve) => {
            goalOrientedExecutor.once('goal:started', (data) => {
                resolve(data.execution_id);
            });

            // Timeout fallback
            setTimeout(() => resolve(`goal_${Date.now()}`), 1000);
        });

        // Register idempotency key so retries within the TTL return this execution
        if (idempotencyKey) {
            idempotencyStore.set(idempotencyKey, { executionId, createdAt: Date.now() });
        }

        // Return immediately with execution_id
        res.json({
            success: true,
            execution_id: executionId,
            message: 'Goal execution started',
            status: 'executing'
        });

        // Let execution continue in background
        executionPromise.catch(err => {
            console.error(`[GoalRoutes] Execution ${executionId} failed:`, err);
        });

    } catch (e: any) {
        console.error('[GoalRoutes] Error starting execution:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/autonomous/goal/clarify - Generate clarifying questions before running
// ============================================================================
router.post('/clarify', async (req: Request, res: Response) => {
    try {
        const { request, conversationContext } = req.body as {
            request: string;
            conversationContext?: { role: string; content: string }[];
        };

        if (!request) {
            return res.status(400).json({ error: 'Missing required field: request' });
        }

        const questions = await goalClarifier.generateQuestions(request, conversationContext);
        res.json({ questions });

    } catch (e: any) {
        console.error('[GoalRoutes] Error generating clarifying questions:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/autonomous/goal/sync - Execute synchronously (waits for completion)
// ============================================================================
router.post('/sync', async (req: Request, res: Response) => {
    try {
        const { request, options, user_id } = req.body as {
            request: string;
            options?: GoalExecutionOptions;
            user_id?: string;
        };

        if (!request) {
            return res.status(400).json({ error: 'Missing required field: request' });
        }

        const userId = (req as any).userId || user_id || 'default';

        console.log(`[GoalRoutes] Starting sync goal execution for: "${request.substring(0, 100)}..."`);

        // Keep the TCP connection alive during long-running executions (prevent 5-min socket timeout)
        req.socket.setKeepAlive(true);
        req.socket.setTimeout(0); // disable idle timeout for this request

        // Execute and wait for result
        const result = await goalOrientedExecutor.executeGoal(request, userId, {
            ...options,
            requestId: (req as any).id,   // propagate HTTP request ID for log tracing
        });

        res.json({
            success: result.status === 'completed',
            result
        });

    } catch (e: any) {
        console.error('[GoalRoutes] Error in sync execution:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// GET /api/autonomous/goal/:id - Get execution status
// ============================================================================
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // Check in-memory first
        const liveState = goalOrientedExecutor.getStatus(id);
        if (liveState) {
            return res.json({
                execution_id: id,
                live: true,
                state: liveState
            });
        }

        // Check database
        const dbState = await db.get(
            'SELECT * FROM goal_executions WHERE id = ?',
            [id]
        );

        if (!dbState) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        res.json({
            execution_id: id,
            live: false,
            state: JSON.parse(dbState.state),
            goal: JSON.parse(dbState.goal),
            status: dbState.status,
            iterations: dbState.iterations,
            artifacts: JSON.parse(dbState.artifacts || '[]'),
            started_at: dbState.started_at,
            completed_at: dbState.completed_at
        });

    } catch (e: any) {
        console.error('[GoalRoutes] Error getting status:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// GET /api/autonomous/goal - List executions
// ============================================================================
router.get('/', async (req: Request, res: Response) => {
    try {
        const { user_id, status, limit = 20 } = req.query;

        let query = 'SELECT id, user_id, request, status, iterations, max_iterations, started_at, completed_at FROM goal_executions';
        const params: any[] = [];
        const conditions: string[] = [];

        if (user_id) {
            conditions.push('user_id = ?');
            params.push(user_id);
        }

        if (status) {
            conditions.push('status = ?');
            params.push(status);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY started_at DESC LIMIT ?';
        params.push(Number(limit));

        const executions = await db.all(query, params);

        res.json({ executions });

    } catch (e: any) {
        console.error('[GoalRoutes] Error listing executions:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/autonomous/goal/:id/pause - Pause execution
// ============================================================================
router.post('/:id/pause', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const success = goalOrientedExecutor.pause(id);

        if (success) {
            res.json({ success: true, message: 'Execution paused' });
        } else {
            res.status(400).json({ success: false, message: 'Cannot pause (not running or not found)' });
        }

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/autonomous/goal/:id/resume - Resume execution
// ============================================================================
router.post('/:id/resume', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const success = goalOrientedExecutor.resume(id);

        if (success) {
            res.json({ success: true, message: 'Execution resumed' });
        } else {
            res.status(400).json({ success: false, message: 'Cannot resume (not paused or not found)' });
        }

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/autonomous/goal/:id/cancel - Cancel execution
// ============================================================================
router.post('/:id/cancel', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const success = goalOrientedExecutor.cancel(id);

        if (success) {
            res.json({ success: true, message: 'Execution cancelled' });
        } else {
            res.status(400).json({ success: false, message: 'Execution not found' });
        }

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/autonomous/goal/validate - Validate criteria without executing
// ============================================================================
router.post('/validate', async (req: Request, res: Response) => {
    try {
        const { criteria } = req.body;

        if (!criteria || !Array.isArray(criteria)) {
            return res.status(400).json({ error: 'Missing or invalid criteria array' });
        }

        const results = [];
        for (const criterion of criteria) {
            const result = await goalValidator.validateCriterion(criterion);
            results.push({
                criterion,
                ...result
            });
        }

        res.json({ results });

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// DELETE /api/autonomous/goal/:id - Delete execution record
// ============================================================================
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // Cancel if running
        goalOrientedExecutor.cancel(id);

        // Delete from database
        await db.run('DELETE FROM goal_executions WHERE id = ?', [id]);

        res.json({ success: true, message: 'Execution deleted' });

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// POST /api/autonomous/goal/approval/:approvalId - Respond to HITL approval
// ============================================================================
router.post('/approval/:approvalId', async (req: Request, res: Response) => {
    try {
        const { approvalId } = req.params;
        const { approved, modifiedScript } = req.body;

        if (typeof approved !== 'boolean') {
            return res.status(400).json({ error: 'Missing required field: approved (boolean)' });
        }

        const success = goalOrientedExecutor.respondToApproval(approvalId, approved, modifiedScript);

        if (success) {
            res.json({ success: true, message: `Approval ${approved ? 'granted' : 'rejected'}` });
        } else {
            res.status(404).json({ success: false, message: 'No pending approval found with that ID' });
        }

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// GET /api/autonomous/goal/settings/approval-mode - Get HITL approval mode
// ============================================================================
router.get('/settings/approval-mode', (_req: Request, res: Response) => {
    res.json({ approvalMode: goalOrientedExecutor.getApprovalMode() });
});

// ============================================================================
// POST /api/autonomous/goal/settings/approval-mode - Set HITL approval mode
// ============================================================================
router.post('/settings/approval-mode', (req: Request, res: Response) => {
    const { mode } = req.body;
    if (!['none', 'script', 'all'].includes(mode)) {
        return res.status(400).json({ error: 'Mode must be "none", "script", or "all"' });
    }
    goalOrientedExecutor.setApprovalMode(mode);
    res.json({ success: true, approvalMode: mode });
});

// ============================================================================
// POST /api/autonomous/goal/:id/input - Respond to user-input escalation
// ============================================================================
router.post('/:id/input', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { inputId, hint } = req.body as { inputId: string; hint: string };

        if (!inputId || typeof hint !== 'string') {
            return res.status(400).json({ error: 'Missing required fields: inputId, hint' });
        }

        const success = goalOrientedExecutor.respondToUserInput(inputId, hint);

        if (success) {
            res.json({ success: true, message: hint.trim() ? 'Hint accepted — resuming execution' : 'Hint skipped — failing execution' });
        } else {
            res.status(404).json({ success: false, message: 'No pending user-input request found (may have timed out)' });
        }

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export const goalRoutes = router;

