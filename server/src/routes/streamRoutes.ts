import express from 'express';
import { modelManager } from '../services/llm/modelManager';
import { memoryManager } from '../memory/MemoryManager';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Active streaming sessions for pause/resume/stop
const activeSessions = new Map<string, {
    abortController: AbortController;
    paused: boolean;
    pauseResolve: (() => void) | null;
}>();

/**
 * POST /api/chat/stream
 *
 * Server-Sent Events (SSE) streaming endpoint for real-time token delivery.
 * The client receives tokens as they are generated.
 *
 * Body: { message, userId?, conversationId?, systemPrompt? }
 * Returns: SSE stream of { type, data } events
 */
router.post('/stream', async (req, res) => {
    const { message, userId = 'default', conversationId, systemPrompt } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
    res.flushHeaders();

    const sessionId = uuidv4();
    const abortController = new AbortController();
    activeSessions.set(sessionId, {
        abortController,
        paused: false,
        pauseResolve: null
    });

    // Send session ID first
    sendSSE(res, 'session', { sessionId });

    try {
        const adapter = modelManager.getActiveAdapter();
        if (!adapter) {
            sendSSE(res, 'error', { message: 'No LLM adapter available' });
            res.end();
            return;
        }

        // Build context from memory
        const recentEvents = await memoryManager.getRecentEvents(5, userId);
        const contextPrompt = recentEvents.length > 0
            ? `Recent conversation context:\n${recentEvents.map(e => `- ${e.event_text}`).join('\n')}\n\n`
            : '';

        const fullSystemPrompt = systemPrompt || `You are an AI partner assistant. Be helpful, clear, and engaging.`;

        // Get conversation history
        const history: { role: string; content: string }[] = [];
        if (contextPrompt) {
            history.push({ role: 'system', content: contextPrompt });
        }

        // Stream tokens
        sendSSE(res, 'start', { model: adapter.model });

        let fullResponse = '';
        const stream = adapter.stream(message, {
            systemPrompt: fullSystemPrompt,
            history,
            temperature: 0.7,
            maxTokens: 4096
        });

        for await (const token of stream) {
            // Check abort
            if (abortController.signal.aborted) {
                sendSSE(res, 'stopped', { reason: 'user_cancelled', partial: fullResponse });
                break;
            }

            // Check pause
            const session = activeSessions.get(sessionId);
            if (session?.paused) {
                sendSSE(res, 'paused', {});
                await new Promise<void>(resolve => {
                    session.pauseResolve = resolve;
                });
                sendSSE(res, 'resumed', {});
            }

            fullResponse += token;
            sendSSE(res, 'token', { text: token });
        }

        if (!abortController.signal.aborted) {
            // Store in memory
            await memoryManager.storeEvent({
                event_type: 'conversation',
                event_text: `User: ${message}\nAssistant: ${fullResponse}`,
                user_id: userId,
                context: { conversationId, streaming: true }
            });

            sendSSE(res, 'complete', {
                fullResponse,
                usage: { tokens: fullResponse.split(/\s+/).length }
            });
        }

    } catch (error: any) {
        console.error('[StreamChat] Error:', error.message);
        sendSSE(res, 'error', { message: error.message });
    } finally {
        activeSessions.delete(sessionId);
        res.end();
    }
});

/**
 * POST /api/chat/stream/:sessionId/pause
 */
router.post('/stream/:sessionId/pause', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.paused = true;
    res.json({ success: true, status: 'paused' });
});

/**
 * POST /api/chat/stream/:sessionId/resume
 */
router.post('/stream/:sessionId/resume', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.paused = false;
    if (session.pauseResolve) {
        session.pauseResolve();
        session.pauseResolve = null;
    }
    res.json({ success: true, status: 'resumed' });
});

/**
 * POST /api/chat/stream/:sessionId/stop
 */
router.post('/stream/:sessionId/stop', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.abortController.abort();
    // Also resolve any pause
    if (session.pauseResolve) {
        session.pauseResolve();
        session.pauseResolve = null;
    }
    res.json({ success: true, status: 'stopped' });
});

/**
 * POST /api/chat/stream/:sessionId/redirect
 * Change the direction mid-stream by stopping and re-prompting
 */
router.post('/stream/:sessionId/redirect', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Stop current stream
    session.abortController.abort();
    if (session.pauseResolve) {
        session.pauseResolve();
    }

    res.json({
        success: true,
        status: 'redirected',
        message: 'Stream stopped. Send a new /stream request with updated message.'
    });
});

/**
 * GET /api/chat/stream/sessions
 * List active streaming sessions
 */
router.get('/stream/sessions', (_req, res) => {
    const sessions = Array.from(activeSessions.entries()).map(([id, s]) => ({
        sessionId: id,
        paused: s.paused,
        aborted: s.abortController.signal.aborted
    }));
    res.json({ sessions, count: sessions.length });
});

// --- Helper ---

function sendSSE(res: express.Response, type: string, data: any) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

export { router as streamRoutes };
