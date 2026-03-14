/**
 * AgentBus — Inter-agent communication system.
 * 
 * Enables parent→child, child→parent, and broadcast messaging between agents.
 * Messages are buffered per-agent and can be consumed by the agent's OODA loop.
 * Socket.IO integration for real-time frontend visibility.
 */
import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

export interface AgentMessage {
    id: string;
    from: string;         // Agent ID or 'system'
    to: string;           // Target agent ID, 'parent', or 'broadcast'
    type: 'result' | 'question' | 'status' | 'artifact' | 'context' | 'escalation';
    payload: any;
    timestamp: Date;
    acknowledged: boolean;
}

export interface AgentMailbox {
    agentId: string;
    parentId: string | null;
    messages: AgentMessage[];
    unreadCount: number;
}

// ============================================================================
// AGENT BUS
// ============================================================================

export class AgentBus extends EventEmitter {
    private mailboxes: Map<string, AgentMailbox> = new Map();
    private gateway: any = null;
    private messageCounter: number = 0;

    /**
     * Set Socket.IO gateway for real-time broadcasting
     */
    setGateway(gw: any): void {
        this.gateway = gw;
    }

    /**
     * Register an agent on the bus (creates its mailbox)
     */
    registerAgent(agentId: string, parentId: string | null = null): void {
        if (!this.mailboxes.has(agentId)) {
            this.mailboxes.set(agentId, {
                agentId,
                parentId,
                messages: [],
                unreadCount: 0
            });
        }
    }

    /**
     * Unregister an agent (archives its mailbox)
     */
    unregisterAgent(agentId: string): void {
        this.mailboxes.delete(agentId);
    }

    /**
     * Send a message from one agent to another.
     * - `to: 'parent'` resolves to the sender's parent ID
     * - `to: 'broadcast'` sends to ALL agents
     * - Otherwise, sends to the specific agent ID
     */
    send(from: string, to: string, type: AgentMessage['type'], payload: any): string {
        const messageId = `msg_${++this.messageCounter}_${Date.now()}`;
        const message: AgentMessage = {
            id: messageId,
            from,
            to,
            type,
            payload,
            timestamp: new Date(),
            acknowledged: false
        };

        if (to === 'broadcast') {
            // Broadcast to all registered agents except sender
            for (const [agentId, mailbox] of this.mailboxes.entries()) {
                if (agentId !== from) {
                    mailbox.messages.push({ ...message, to: agentId });
                    mailbox.unreadCount++;
                }
            }
        } else if (to === 'parent') {
            // Resolve parent ID from sender's mailbox
            const senderMailbox = this.mailboxes.get(from);
            if (senderMailbox?.parentId) {
                const parentMailbox = this.mailboxes.get(senderMailbox.parentId);
                if (parentMailbox) {
                    parentMailbox.messages.push({ ...message, to: senderMailbox.parentId });
                    parentMailbox.unreadCount++;
                }
            }
        } else {
            // Direct message
            const targetMailbox = this.mailboxes.get(to);
            if (targetMailbox) {
                targetMailbox.messages.push(message);
                targetMailbox.unreadCount++;
            }
        }

        // Emit events for monitoring
        this.emit('message', message);
        if (this.gateway?.io) {
            this.gateway.io.emit('agent:message', {
                timestamp: new Date().toISOString(),
                ...message
            });
        }

        return messageId;
    }

    /**
     * Read unread messages for an agent (marks them as acknowledged)
     */
    receive(agentId: string): AgentMessage[] {
        const mailbox = this.mailboxes.get(agentId);
        if (!mailbox) return [];

        const unread = mailbox.messages.filter(m => !m.acknowledged);
        unread.forEach(m => m.acknowledged = true);
        mailbox.unreadCount = 0;
        return unread;
    }

    /**
     * Peek at messages without marking as acknowledged
     */
    peek(agentId: string): AgentMessage[] {
        const mailbox = this.mailboxes.get(agentId);
        if (!mailbox) return [];
        return mailbox.messages.filter(m => !m.acknowledged);
    }

    /**
     * Check if an agent has pending messages
     */
    hasMessages(agentId: string): boolean {
        const mailbox = this.mailboxes.get(agentId);
        return (mailbox?.unreadCount ?? 0) > 0;
    }

    /**
     * Get all messages for monitoring/debugging
     */
    getAllMessages(): AgentMessage[] {
        const all: AgentMessage[] = [];
        for (const mailbox of this.mailboxes.values()) {
            all.push(...mailbox.messages);
        }
        return all.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    /**
     * Get registered agent count
     */
    getAgentCount(): number {
        return this.mailboxes.size;
    }

    /**
     * Clear all mailboxes
     */
    clear(): void {
        this.mailboxes.clear();
        this.messageCounter = 0;
    }
}

export const agentBus = new AgentBus();
