import { StateCreator } from 'zustand';
import { API_BASE } from '../../lib/api';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  richContent?: any; // For plans, tool outputs, etc.
  metadata?: Record<string, any>;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  serverConversationId?: string; // Link to server-side conversation
}

export interface ConversationState {
  conversations: Map<string, Conversation>;
  activeConversationId: string | null;

  // Actions
  createConversation: (title?: string) => string;
  setActiveConversation: (id: string) => void;
  addMessage: (conversationId: string, message: Message) => void;
  updateMessage: (conversationId: string, messageId: string, content: string) => void;
  updateConversationTitle: (conversationId: string, title: string) => void;
  deleteConversation: (id: string) => void;
  clearAllConversations: () => void;
  setConversations: (conversations: Conversation[]) => void; // For hydration
  loadConversationFromServer: (serverConvId: string, title: string) => Promise<void>; // Load from server
  setServerConversationId: (localId: string, serverId: string) => void;
}

export const conversationSlice: StateCreator<ConversationState> = (set, _get) => ({
  conversations: new Map(),
  activeConversationId: null,

  createConversation: (title = 'New Conversation') => {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const conversation: Conversation = {
      id,
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    set((state) => {
      const newConversations = new Map(state.conversations);
      newConversations.set(id, conversation);
      return {
        conversations: newConversations,
        activeConversationId: id
      };
    });

    return id;
  },

  setActiveConversation: (id) => {
    set({ activeConversationId: id });
  },

  addMessage: (conversationId, message) => {
    set((state) => {
      const newConversations = new Map(state.conversations);
      const conversation = newConversations.get(conversationId);

      if (conversation) {
        // Avoid duplicates if message ID already exists (e.g. from stream re-renders)
        if (!conversation.messages.find(m => m.id === message.id)) {
          conversation.messages.push(message);
        }
        conversation.updatedAt = Date.now();
        newConversations.set(conversationId, { ...conversation });
      }

      return { conversations: newConversations };
    });
  },

  updateMessage: (conversationId, messageId, content) => {
    set((state) => {
      const newConversations = new Map(state.conversations);
      const conversation = newConversations.get(conversationId);

      if (conversation) {
        const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          const updatedMessage = { ...conversation.messages[messageIndex], content };
          const updatedMessages = [...conversation.messages];
          updatedMessages[messageIndex] = updatedMessage;

          newConversations.set(conversationId, {
            ...conversation,
            messages: updatedMessages,
            updatedAt: Date.now()
          });
        }
      }

      return { conversations: newConversations };
    });
  },

  updateConversationTitle: (conversationId, title) => {
    set((state) => {
      const newConversations = new Map(state.conversations);
      const conversation = newConversations.get(conversationId);

      if (conversation) {
        newConversations.set(conversationId, {
          ...conversation,
          title,
          updatedAt: Date.now()
        });
      }

      return { conversations: newConversations };
    });
  },

  deleteConversation: (id) => {
    set((state) => {
      const newConversations = new Map(state.conversations);
      newConversations.delete(id);

      return {
        conversations: newConversations,
        activeConversationId: state.activeConversationId === id ? null : state.activeConversationId
      };
    });
  },

  clearAllConversations: () => {
    set({ conversations: new Map(), activeConversationId: null });
  },

  setConversations: (conversationsList) => {
    const map = new Map();
    conversationsList.forEach(c => map.set(c.id, c));
    set({ conversations: map });
  },

  // Load a conversation from the server by its ID
  loadConversationFromServer: async (serverConvId: string, title: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${serverConvId}/messages`);
      const data = await res.json();

      // Create local conversation from server data
      const localId = `server_${serverConvId}`;
      // SQLite stores datetime("now") as UTC without a "Z" suffix e.g. "2026-03-14 19:31:00".
      // JS new Date("2026-03-14 19:31:00") treats space-separated strings as LOCAL time, not UTC.
      // Normalise by replacing the space with "T" and appending "Z" so the UTC value is correct.
      const toUtcMs = (ts: string | number): number => {
        if (typeof ts === 'number') return ts;
        const iso = String(ts).includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
        return new Date(iso).getTime();
      };
      const messages: Message[] = (data.messages || []).map((m: any) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
        timestamp: toUtcMs(m.timestamp)
      }));

      const conversation: Conversation = {
        id: localId,
        title: title || 'Conversation',
        messages,
        createdAt: messages.length > 0 ? messages[0].timestamp : Date.now(),
        updatedAt: messages.length > 0 ? messages[messages.length - 1].timestamp : Date.now(),
        serverConversationId: serverConvId
      };

      set((state) => {
        const newConversations = new Map(state.conversations);
        newConversations.set(localId, conversation);
        return {
          conversations: newConversations,
          activeConversationId: localId
        };
      });

      console.log(`[Store] Loaded conversation ${serverConvId} with ${messages.length} messages`);
    } catch (e) {
      console.error('[Store] Failed to load conversation:', e);
    }
  },

  setServerConversationId: (localId: string, serverId: string) => {
    set((state) => {
      const newConversations = new Map(state.conversations);
      const conversation = newConversations.get(localId);
      if (conversation && conversation.serverConversationId !== serverId) {
        newConversations.set(localId, {
          ...conversation,
          serverConversationId: serverId,
        });
        return { conversations: newConversations };
      }
      return state;
    });
  }
});
