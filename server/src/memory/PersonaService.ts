import { db } from '../database';

export interface Persona {
    user_id: string;
    name: string;
    role: string | null;
    preferences: Record<string, any>;
    metadata: Record<string, any>;
    created_at: string;
    updated_at: string;
}

export class PersonaService {
    async getPersona(userId: string): Promise<Persona> {
        const row = await db.get('SELECT * FROM persona WHERE user_id = ?', [userId]);

        if (!row) {
            // Create default persona if not exists
            const defaultPersona: Persona = {
                user_id: userId,
                name: 'User',
                role: null,
                preferences: {},
                metadata: {},
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };
            await this.createPersona(defaultPersona);
            return defaultPersona;
        }

        // Parse JSON fields
        return {
            ...row,
            preferences: JSON.parse(row.preferences || '{}'),
            metadata: JSON.parse(row.metadata || '{}'),
        };
    }

    async createPersona(persona: Persona): Promise<void> {
        await db.run(
            `INSERT INTO persona (user_id, name, role, preferences, metadata) VALUES (?, ?, ?, ?, ?)`,
            [
                persona.user_id,
                persona.name,
                persona.role,
                JSON.stringify(persona.preferences),
                JSON.stringify(persona.metadata),
            ]
        );
    }

    async updatePersona(userId: string, updates: Partial<Persona>): Promise<void> {
        const current = await this.getPersona(userId);
        const updated = { ...current, ...updates, updated_at: new Date().toISOString() };

        await db.run(
            `UPDATE persona SET name = ?, role = ?, preferences = ?, metadata = ?, updated_at = ? WHERE user_id = ?`,
            [
                updated.name,
                updated.role,
                JSON.stringify(updated.preferences),
                JSON.stringify(updated.metadata),
                updated.updated_at,
                userId,
            ]
        );
    }
}
