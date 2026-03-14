import { EventEmitter } from 'events';
import { Server as SocketIOServer } from 'socket.io';

// ============================================================================
// PROGRESS REPORTER
// Emits real-time progress updates via WebSocket
// ============================================================================

export class ProgressReporter extends EventEmitter {
    private io: SocketIOServer | null = null;
    private userId: string | null = null;

    constructor() {
        super();
        this.setupEventForwarding();
    }

    /**
     * Set the Socket.IO server instance
     */
    setSocketIO(io: SocketIOServer, userId?: string) {
        this.io = io;
        this.userId = userId || null;
    }

    /**
     * Forward all autonomous:* events to WebSocket clients
     */
    private setupEventForwarding() {
        const events = [
            'autonomous:planning',
            'autonomous:plan_created',
            'autonomous:step_started',
            'autonomous:step_completed',
            'autonomous:step_failed',
            'autonomous:step_retry',
            'autonomous:completed',
            'autonomous:paused',
            'autonomous:resumed',
            'autonomous:cancelled'
        ];

        events.forEach(eventName => {
            this.on(eventName, (data: any) => {
                this.broadcast(eventName, data);
                console.log(`[ProgressReporter] ${eventName}:`, JSON.stringify(data).substring(0, 200));
            });
        });
    }

    /**
     * Broadcast event to all connected clients
     */
    private broadcast(eventName: string, data: any) {
        if (this.io) {
            this.io.emit(eventName, {
                timestamp: new Date().toISOString(),
                ...data
            });
        }
    }

    /**
     * Send to specific user
     */
    sendToUser(userId: string, eventName: string, data: any) {
        if (this.io) {
            // Find sockets for this user and emit
            this.io.emit(eventName, {
                timestamp: new Date().toISOString(),
                user_id: userId,
                ...data
            });
        }
    }

    // =========================================================================
    // CONVENIENCE METHODS
    // =========================================================================

    planCreated(executionId: string, steps: any[], message: string) {
        this.emit('autonomous:plan_created', {
            execution_id: executionId,
            steps,
            message
        });
    }

    stepStarted(executionId: string, step: number, total: number, iteration: number, description: string) {
        this.emit('autonomous:step_started', {
            execution_id: executionId,
            step,
            total,
            iteration,
            description
        });
    }

    stepCompleted(executionId: string, step: number, artifacts: string[], durationMs: number) {
        this.emit('autonomous:step_completed', {
            execution_id: executionId,
            step,
            status: 'success',
            artifacts,
            duration_ms: durationMs
        });
    }

    stepFailed(executionId: string, step: number, reason: string, retries: number) {
        this.emit('autonomous:step_failed', {
            execution_id: executionId,
            step,
            reason,
            retries
        });
    }

    stepRetry(executionId: string, step: number, retry: number, maxRetries: number, reason: string) {
        this.emit('autonomous:step_retry', {
            execution_id: executionId,
            step,
            retry,
            max_retries: maxRetries,
            reason
        });
    }

    completed(executionId: string, status: string, totalSteps: number, totalIterations: number, durationMs: number, artifacts: string[]) {
        this.emit('autonomous:completed', {
            execution_id: executionId,
            status,
            total_steps: totalSteps,
            total_iterations: totalIterations,
            duration_ms: durationMs,
            artifacts
        });
    }

    paused(executionId: string) {
        this.emit('autonomous:paused', { execution_id: executionId });
    }

    resumed(executionId: string) {
        this.emit('autonomous:resumed', { execution_id: executionId });
    }

    cancelled(executionId: string) {
        this.emit('autonomous:cancelled', { execution_id: executionId });
    }
}

// Singleton instance
export const progressReporter = new ProgressReporter();
