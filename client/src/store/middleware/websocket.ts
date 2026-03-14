import { Socket } from 'socket.io-client';
import { AppState } from '../index';

// Store pending plan for HITL approval
let pendingPlan: any = null;

export function getPendingPlan() {
    return pendingPlan;
}

export function approvePlan(socket: Socket) {
    if (pendingPlan) {
        socket.emit('plan:approve', { plan_id: pendingPlan.plan_id });
        pendingPlan = null;
    }
}

export function rejectPlan(socket: Socket, reason?: string) {
    if (pendingPlan) {
        socket.emit('plan:reject', { plan_id: pendingPlan.plan_id, reason });
        pendingPlan = null;
    }
}

export function bindWebSocketEvents(socket: Socket, getState: () => AppState) {
    // Message streaming
    socket.on('message:stream', (message: any) => {
        const state = getState();
        const activeId = state.activeConversationId;

        // Ignore messages that belong to a different conversation than the currently active one
        // (Prevents background tasks or Telegram chats from appearing in the web UI)
        if (message.conversationId && activeId && message.conversationId !== activeId) {
            return;
        }

        if (activeId) {
            // Check if message exists to determine add vs update
            const conv = state.conversations.get(activeId);
            if (conv) {
                const existing = conv.messages.find(m => m.id === message.id);
                if (existing) {
                    state.updateMessage(activeId, message.id, message.content);
                } else {
                    state.addMessage(activeId, {
                        id: message.id,
                        role: message.role,
                        content: message.content,
                        timestamp: new Date(message.timestamp).getTime(),
                        richContent: message.richContent
                    });
                }
            }
        }
    });

    // OODA events from GatewayService
    socket.on('ooda:event', (event: any) => {
        // GatewayService sends: { type, channel, user_id, timestamp, payload: { phase, content, metadata } }
        const payload = event.payload || event;
        const phase = (payload.phase || 'REFLECT').toUpperCase();

        getState().addOODAEvent({
            phase: phase as 'OBSERVE' | 'ORIENT' | 'DECIDE' | 'ACT' | 'REFLECT',
            message: payload.content || payload.message || '',
            timestamp: event.timestamp || new Date().toISOString(),
            details: payload.metadata || payload.details
        });
    });

    // HITL Plan Preview - store pending plan for approval UI
    socket.on('plan:preview', (event: any) => {
        console.log('[HITL] Received plan preview:', event);
        const plan = event.payload || event;
        pendingPlan = plan;

        // Add OODA event to show plan in inspector
        getState().addOODAEvent({
            phase: 'DECIDE',
            message: `⏳ AWAITING APPROVAL: ${plan.description}`,
            timestamp: new Date().toISOString(),
            details: { plan, requiresApproval: true }
        });

        // Trigger re-render by dispatching custom event
        window.dispatchEvent(new CustomEvent('hitl:plan-pending', { detail: plan }));
    });

    // Screenshot / Image from browser tools
    socket.on('chat:image', (data: any) => {
        const state = getState();
        const activeId = state.activeConversationId;
        if (activeId && data.richContent) {
            state.addMessage(activeId, {
                id: `img_${Date.now()}`,
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                richContent: data.richContent,
            });
        }
    });

    // Code Output
    socket.on('code:output', (data: any) => {
        const state = getState();
        const activeId = state.activeConversationId;
        if (activeId) {
            state.addMessage(activeId, {
                id: `code_${Date.now()}`,
                role: 'system',
                content: `[${data.type.toUpperCase()}]\n${data.data}`,
                timestamp: Date.now()
            });
        }
    });

    // Conversation Ready (Hydration)
    socket.on('conversation:ready', (data: { id: string; messages: any[] }) => {
        const state = getState();
        const formattedMessages = data.messages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.created_at).getTime(),
            richContent: m.rich_content ? JSON.parse(m.rich_content) : undefined
        }));

        state.setConversations([{
            id: data.id,
            title: 'Session', // Backend should send title
            messages: formattedMessages,
            createdAt: Date.now(),
            updatedAt: Date.now()
        }]);
        state.setActiveConversation(data.id);
    });
}

