import { v4 as uuidv4 } from 'uuid';
import { db } from '../database';
import { MarkdownConfigLoader, SkillDefinition } from '../config/MarkdownConfigLoader';
import { configManager } from '../services/ConfigManager';

export interface InstalledSkill {
    id: string;
    name: string;
    description: string;
    provider: string;
    providerType: 'mcp_server' | 'builtin';
    enabled: boolean;
    config: Record<string, any>;
    version?: string;
    installedAt?: string;
    updatedAt?: string;
}

/**
 * SkillManager - Manages skills from SKILL.md files and database
 * 
 * Responsibilities:
 * - Scan workspace skills/ directory for SKILL.md files
 * - Sync discovered skills to installed_skills database table
 * - Enable/disable skills
 * - Provide skill configuration
 */
export class SkillManager {
    private configLoader: MarkdownConfigLoader | null = null;

    constructor() {
        this.initConfigLoader();
    }

    private initConfigLoader(): void {
        try {
            const workspaceDir = configManager.getWorkspaceDir();
            this.configLoader = new MarkdownConfigLoader(workspaceDir);
        } catch (e) {
            console.warn('[SkillManager] Failed to init config loader:', e);
        }
    }

    /**
     * Scan workspace and sync skills to database
     */
    async syncSkills(): Promise<{ added: number; updated: number; removed: number }> {
        console.log('[SkillManager] Syncing skills from workspace...');

        if (!this.configLoader) {
            this.initConfigLoader();
        }

        const result = { added: 0, updated: 0, removed: 0 };

        if (!this.configLoader) {
            console.warn('[SkillManager] No config loader available');
            return result;
        }

        // 1. Load skills from SKILL.md files
        const fileSkills = this.configLoader.loadSkills();
        console.log(`[SkillManager] Found ${fileSkills.length} skills in workspace`);

        // 2. Get existing skills from database
        const dbSkills = await this.getAllSkills();
        const dbSkillNames = new Set(dbSkills.map(s => s.name));
        const fileSkillNames = new Set(fileSkills.map(s => s.name));

        // 3. Add new skills
        for (const skill of fileSkills) {
            if (!dbSkillNames.has(skill.name)) {
                await this.addSkill(skill);
                result.added++;
            } else {
                // Update existing skill
                await this.updateSkillFromFile(skill);
                result.updated++;
            }
        }

        // 4. Mark removed skills as disabled (don't delete, user might have config)
        for (const dbSkill of dbSkills) {
            if (!fileSkillNames.has(dbSkill.name)) {
                await this.disableSkill(dbSkill.id);
                result.removed++;
            }
        }

        console.log(`[SkillManager] Sync complete: ${result.added} added, ${result.updated} updated, ${result.removed} disabled`);
        return result;
    }

    /**
     * Add a new skill to database
     */
    private async addSkill(skill: SkillDefinition): Promise<string> {
        const id = uuidv4();
        const now = new Date().toISOString();

        await db.run(
            `INSERT INTO installed_skills (id, name, description, provider, provider_type, enabled, config, installed_at, updated_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                skill.name,
                skill.description,
                skill.provider,
                skill.providerType,
                1, // enabled by default
                JSON.stringify(skill.config),
                now,
                now
            ]
        );

        console.log(`[SkillManager] Added skill: ${skill.name}`);
        return id;
    }

    /**
     * Update skill from SKILL.md file
     */
    private async updateSkillFromFile(skill: SkillDefinition): Promise<void> {
        const now = new Date().toISOString();

        await db.run(
            `UPDATE installed_skills SET description = ?, provider = ?, provider_type = ?, updated_at = ? WHERE name = ?`,
            [skill.description, skill.provider, skill.providerType, now, skill.name]
        );
    }

    /**
     * Get all installed skills
     */
    async getAllSkills(): Promise<InstalledSkill[]> {
        const rows = await db.all('SELECT * FROM installed_skills ORDER BY name');
        return rows.map(this.rowToSkill);
    }

    /**
     * Get enabled skills only
     */
    async getEnabledSkills(): Promise<InstalledSkill[]> {
        const rows = await db.all('SELECT * FROM installed_skills WHERE enabled = 1 ORDER BY name');
        return rows.map(this.rowToSkill);
    }

    /**
     * Get skill by ID
     */
    async getSkill(id: string): Promise<InstalledSkill | null> {
        const row = await db.get('SELECT * FROM installed_skills WHERE id = ?', [id]);
        return row ? this.rowToSkill(row) : null;
    }

    /**
     * Get skill by name
     */
    async getSkillByName(name: string): Promise<InstalledSkill | null> {
        const row = await db.get('SELECT * FROM installed_skills WHERE name = ?', [name]);
        return row ? this.rowToSkill(row) : null;
    }

    /**
     * Enable a skill
     */
    async enableSkill(id: string): Promise<boolean> {
        const now = new Date().toISOString();
        await db.run('UPDATE installed_skills SET enabled = 1, updated_at = ? WHERE id = ?', [now, id]);
        console.log(`[SkillManager] Enabled skill: ${id}`);
        return true;
    }

    /**
     * Disable a skill
     */
    async disableSkill(id: string): Promise<boolean> {
        const now = new Date().toISOString();
        await db.run('UPDATE installed_skills SET enabled = 0, updated_at = ? WHERE id = ?', [now, id]);
        console.log(`[SkillManager] Disabled skill: ${id}`);
        return true;
    }

    /**
     * Update skill configuration
     */
    async updateSkillConfig(id: string, config: Record<string, any>): Promise<InstalledSkill | null> {
        const existing = await this.getSkill(id);
        if (!existing) return null;

        const mergedConfig = { ...existing.config, ...config };
        const now = new Date().toISOString();

        await db.run(
            'UPDATE installed_skills SET config = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(mergedConfig), now, id]
        );

        return this.getSkill(id);
    }

    /**
     * Delete a skill (removes from database)
     */
    async deleteSkill(id: string): Promise<boolean> {
        await db.run('DELETE FROM installed_skills WHERE id = ?', [id]);
        console.log(`[SkillManager] Deleted skill: ${id}`);
        return true;
    }

    /**
     * Convert database row to InstalledSkill
     */
    private rowToSkill(row: any): InstalledSkill {
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            provider: row.provider,
            providerType: row.provider_type as 'mcp_server' | 'builtin',
            enabled: Boolean(row.enabled),
            config: JSON.parse(row.config || '{}'),
            version: row.version,
            installedAt: row.installed_at,
            updatedAt: row.updated_at
        };
    }
}

export const skillManager = new SkillManager();
