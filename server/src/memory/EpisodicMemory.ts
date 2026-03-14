import { db } from '../database';
import { v4 as uuidv4 } from 'uuid';

export interface EpisodicEvent {
    id?: string;
    user_id: string;
    event_text: string;
    event_type: 'action' | 'decision' | 'learning' | 'conversation' | 'heartbeat' | 'task_execution';
    context?: Record<string, any>;
    timestamp?: string;
}

export class EpisodicMemory {
    async storeEvent(event: EpisodicEvent): Promise<string> {
        const id = event.id || uuidv4();
        const timestamp = event.timestamp || new Date().toISOString();
        const context = JSON.stringify(event.context || {});

        await db.run(
            `INSERT INTO episodic_memory (id, user_id, event_text, event_type, context, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, event.user_id, event.event_text, event.event_type, context, timestamp]
        );

        return id;
    }

    async getRecentEvents(userId: string, limit: number = 10): Promise<EpisodicEvent[]> {
        const rows = await db.all(
            `SELECT * FROM episodic_memory WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?`,
            [userId, limit]
        );

        return rows.map(row => ({
            ...row,
            context: JSON.parse(row.context || '{}'),
        }));
    }

    async getEventsByTimeRange(userId: string, start: Date, end: Date): Promise<EpisodicEvent[]> {
        const rows = await db.all(
            `SELECT * FROM episodic_memory WHERE user_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC`,
            [userId, start.toISOString(), end.toISOString()]
        );

        return rows.map(row => ({
            ...row,
            context: JSON.parse(row.context || '{}'),
        }));
    }
}
