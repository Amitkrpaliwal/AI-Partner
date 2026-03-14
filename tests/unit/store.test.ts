import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../src/store';

// Mock Socket.io-client to avoid connection attempts in tests
vi.mock('socket.io-client', () => ({
    io: () => ({
        on: vi.fn(),
        emit: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
    }),
}));

describe('Store Logic', () => {
    beforeEach(() => {
        useStore.setState({
            conversations: new Map(),
            activeConversationId: null,
            messages: [],
        });
    });

    it('should create a new conversation', () => {
        const { createConversation, conversations } = useStore.getState();
        createConversation('Test Chat');

        const state = useStore.getState();
        expect(state.activeConversationId).toBeDefined();

        const activeId = state.activeConversationId!;
        expect(state.conversations.get(activeId)?.title).toBe('Test Chat');
    });

    it('should add messages to conversation', () => {
        const { createConversation, addMessage } = useStore.getState();
        createConversation('Chat');
        const activeId = useStore.getState().activeConversationId!;

        const msg = {
            id: '1',
            role: 'user' as const,
            content: 'Hello',
            timestamp: Date.now()
        };

        addMessage(activeId, msg);

        const state = useStore.getState();
        const conv = state.conversations.get(activeId);
        expect(conv?.messages).toHaveLength(1);
        expect(conv?.messages[0].content).toBe('Hello');
    });
});
