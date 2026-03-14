import { useEffect } from 'react';
import { getSocket } from '@/lib/socket';
import { useStore } from '@/store';
import { useChatStreamStore } from '@/store/chatStreamStore';

/**
 * Global chat socket handler — mounted ONCE at App level, never unmounts.
 *
 * All message:stream / goal:* / execution:cancelled events are handled here
 * so they survive sidebar navigation and view switches.
 *
 * State is keyed per LOCAL conversation ID so events from one execution
 * never leak into a different conversation's chat.
 */
export function useGlobalChatSocket() {
  useEffect(() => {
    const socket = getSocket();
    const store = useChatStreamStore.getState;
    const appStore = useStore.getState;

    // Per-execution HITL flag — keyed by local conv ID
    // Set when goal:user-input-needed arrives, cleared on next done event for that conv.
    const hitlPendingByConv: Record<string, boolean> = {};

    // ── Resolve incoming server conv ID → local conv ID ───────────────────────
    // Falls back to activeConversationId when the mapping isn't known yet
    // (e.g. first message before 'conversation:id' event has fired).
    const resolveLocalId = (serverConvId?: string): string | null => {
      if (serverConvId) {
        const mapped = store().resolveLocalId(serverConvId);
        if (mapped) return mapped;
      }
      // Fall back to currently active conversation only when no server ID provided
      // (broadcast events with no conversationId are for the active conv).
      if (!serverConvId) return appStore().activeConversationId ?? null;
      return null;
    };

    const sanitizeContent = (raw: string): string => {
      if (!raw || !raw.trimStart().startsWith('{')) return raw;
      try {
        const parsed = JSON.parse(raw);
        const text = parsed.response ?? parsed.message ?? parsed.text;
        if (text && typeof text === 'string' && text.trim().length > 0) return text;
      } catch { /* not JSON */ }
      return raw;
    };

    // 'conversation:id' — server assigns a server-side UUID to this exchange.
    // Bind it to whichever local conv is active right now.
    const handleConversationId = (data: { conversationId: string }) => {
      if (!data.conversationId) return;
      const localId = appStore().activeConversationId;
      if (localId) {
        store().bindServerConv(data.conversationId, localId);
        appStore().setServerConversationId(localId, data.conversationId);
      }
    };

    // 'goal:user-input-needed' — agent is paused waiting for user input.
    // Tag the correct local conv so the ChatArea banner shows.
    // IMPORTANT: only show the ChatArea banner for free-text (unstructured) HITL.
    // Structured HITL (event.fields present) is handled entirely by GoalProgressPanel —
    // showing the banner there too causes duplicate, contradictory notifications.
    const handleUserInputNeeded = (event: any) => {
      const localId = resolveLocalId(event?.conversationId);
      if (!localId) return;
      // Structured fields → GoalProgressPanel owns the UX; skip the chat banner.
      if (event?.fields?.length) return;
      hitlPendingByConv[localId] = true;
      store().updateConv(localId, { isHitlPending: true });
      // Safety net: clear after 3 minutes if goal:resumed never fires (e.g. tab hidden).
      setTimeout(() => { hitlPendingByConv[localId] = false; }, 3 * 60 * 1000);
    };

    // 'message:stream' — streaming tokens and final committed response.
    const handleStream = (data: any) => {
      const localId = resolveLocalId(data.conversationId);
      if (!localId) return; // unknown conv — discard

      if (data.content) {
        const content = sanitizeContent(data.content);
        if (!data.done) {
          // Intermediate token — update live typing bubble for this conv only
          store().updateConv(localId, {
            streamingMessage: { id: data.id, content },
            isExecuting: true,
          });
        } else {
          // Final commit — clear typing bubble, persist message to store
          const isHitl = !!hitlPendingByConv[localId];
          hitlPendingByConv[localId] = false;

          store().updateConv(localId, {
            streamingMessage: null,
            isExecuting: false,
            isHitlPending: isHitl, // keep banner up if HITL
          });

          appStore().addMessage(localId, {
            id: data.id || `ai_${Date.now()}`,
            role: 'assistant' as const,
            content,
            timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
            metadata: isHitl ? { isHitl: true } : undefined,
          });
        }
      } else if (data.done) {
        // done with no content — just clear executing state
        store().updateConv(localId, { streamingMessage: null, isExecuting: false });
      }
    };

    // 'execution:cancelled' — clear stream for the affected conv
    const handleCancelled = (data: any) => {
      const localId = resolveLocalId(data?.conversationId);
      if (localId) store().clearConv(localId);
    };

    // 'message:error' — surface error in the correct conv
    const handleError = (data: { error: string; conversationId?: string }) => {
      const localId = resolveLocalId(data?.conversationId);
      if (!localId) return;
      store().clearConv(localId);
      appStore().addMessage(localId, {
        id: `error_${Date.now()}`,
        role: 'assistant' as const,
        content: `Error: ${data.error}`,
        timestamp: Date.now(),
      });
    };

    // 'goal:sync' — server reply to goal:request_sync on reconnect / remount.
    // Set executing state on the correct conv so spinner appears.
    const handleGoalSync = (data: {
      execution_id?: string;
      status: string;
      conversationId?: string;
    }) => {
      const localId = resolveLocalId(data.conversationId);
      if (!localId) return;
      const active = data.status === 'executing' || data.status === 'planning' || data.status === 'replanning';
      store().updateConv(localId, { isExecuting: active });
    };

    // 'goal:resumed' — agent received HITL answer and is running again.
    // Clear the HITL banner immediately — don't wait for message:stream done=true.
    const handleGoalResumed = (data: any) => {
      const localId = resolveLocalId(data?.conversationId);
      if (!localId) return;
      hitlPendingByConv[localId] = false;
      store().updateConv(localId, { isHitlPending: false, isExecuting: true });
    };

    // 'goal:reasoning' / 'goal:progress' — auto-restore spinner after page refresh.
    // These are broadcast to all clients, so a freshly reconnected page sees them.
    const handleGoalActivity = (data: any) => {
      const localId = resolveLocalId(data?.conversationId);
      if (localId) store().updateConv(localId, { isExecuting: true });
    };

    socket.on('conversation:id',        handleConversationId);
    socket.on('message:stream',         handleStream);
    socket.on('execution:cancelled',    handleCancelled);
    socket.on('message:error',          handleError);
    socket.on('goal:user-input-needed', handleUserInputNeeded);
    socket.on('goal:resumed',           handleGoalResumed);
    socket.on('goal:sync',              handleGoalSync);
    socket.on('goal:reasoning',         handleGoalActivity);
    socket.on('goal:progress',          handleGoalActivity);

    return () => {
      socket.off('conversation:id',        handleConversationId);
      socket.off('message:stream',         handleStream);
      socket.off('execution:cancelled',    handleCancelled);
      socket.off('message:error',          handleError);
      socket.off('goal:user-input-needed', handleUserInputNeeded);
      socket.off('goal:resumed',           handleGoalResumed);
      socket.off('goal:sync',              handleGoalSync);
      socket.off('goal:reasoning',         handleGoalActivity);
      socket.off('goal:progress',          handleGoalActivity);
    };
  }, []); // empty deps — register once, never re-register
}
