import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { db } from '../database';
import { configManager } from './ConfigManager';
import { modelManager } from './llm/modelManager';
import { vectorMemory } from '../memory/VectorMemory';
import { dynamicToolRegistry } from '../mcp/DynamicToolRegistry';

/**
 * SkillLearner 2.0 — Self-Improving Skills System (Phase 6 Upgrade)
 *
 * Upgrades over v1:
 * - Parameterized skill templates with typed parameters
 * - Embedding-based matching via VectorMemory (semantic similarity)
 * - Skill versioning with changelog tracking
 * - Deduplication: merge similar skills instead of duplicating
 */

// ============================================================================
// TYPES
// ============================================================================

export interface SkillParameter {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'path' | 'array';
    description: string;
    required: boolean;
    default?: any;
}

export interface LearnedSkill {
    id: string;
    name: string;
    description: string;
    pattern: string;              // Keyword pattern for fallback matching
    template: string;             // Script template with {{placeholders}}
    strategy_hint: string;        // Human-readable strategy summary (NOT raw code) for prompt injection
    parameters: SkillParameter[]; // Phase 6A: typed parameters
    runtime: 'python' | 'node';
    version: number;              // Phase 6C: versioning
    successCount: number;
    failureCount: number;
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string | null;
    tags: string[];
    parentId: string | null;      // Tracks lineage for versioned skills
    promotedToTool: boolean;      // Sprint 3: whether this skill has been promoted to a dynamic tool
}

// ============================================================================
// SKILL LEARNER 2.0
// ============================================================================

export class SkillLearner {

    /**
     * Learn from a successful goal execution.
     * Extracts pattern, generalizes script, detects duplicates, and versions.
     */
    async learnFromSuccess(
        goalDescription: string,
        script: string,
        runtime: 'python' | 'node',
        artifacts: string[]
    ): Promise<LearnedSkill | null> {
        try {
            if (script.length < 100) return null;

            // Phase 6C: Check for duplicate/similar skill via embeddings first
            const similar = await this.findMatchingSkill(goalDescription);
            if (similar && similar.successCount > 0) {
                // Deduplicate — increment and potentially update template
                const shouldUpdate = script.length > similar.template.length * 1.2; // Only update if significantly different
                if (shouldUpdate) {
                    // Create new version
                    return this.createNewVersion(similar, script, goalDescription, artifacts);
                } else {
                    // Just reinforce
                    await db.run(
                        'UPDATE learned_skills SET success_count = success_count + 1, last_used_at = datetime("now"), updated_at = datetime("now") WHERE id = ?',
                        [similar.id]
                    );
                    console.log(`[SkillLearner] Skill "${similar.name}" reinforced (count: ${similar.successCount + 1})`);
                    return similar;
                }
            }

            // Generate a generalized template with parameters
            const llm = modelManager.getActiveAdapter();
            if (!llm) return null;

            const prompt = `Analyze this successful ${runtime} script and create a reusable parameterized template.

ORIGINAL GOAL: ${goalDescription}
FILES CREATED: ${artifacts.join(', ')}

SCRIPT:
${script.substring(0, 2000)}

Create:
1. A short skill NAME (2-4 words, snake_case, e.g. "web_scraper", "api_server")
2. A one-sentence DESCRIPTION
3. A PATTERN (comma-separated keywords for matching similar future tasks)
4. TAGS (comma-separated categories like "file_ops", "web", "data", "api")
5. A STRATEGY_HINT: 1-3 sentences explaining the high-level approach (what libraries to use, what APIs, what sequence of steps) — NO code, human readable only
6. PARAMETERS: List each placeholder used in the template, one per line as:
   PARAM: name | type (string/number/boolean/path) | description | required (true/false) | default_value
7. A TEMPLATE version of the script using {{PARAMETER_NAME}} placeholders

Format exactly:
NAME: skill_name
DESCRIPTION: one sentence
PATTERN: keyword1, keyword2, keyword3
TAGS: tag1, tag2
STRATEGY_HINT: Use yfinance to fetch stock data, process with pandas, write a markdown report. Always install packages first with pip if missing.
PARAMETERS:
PARAM: workspace | path | Working directory | true |
PARAM: filename | string | Output filename | false | output.txt
TEMPLATE:
[the generalized script with {{WORKSPACE}}, {{FILENAME}} etc.]`;

            const response = await llm.generate(prompt, { temperature: 0.2 });

            // Parse the response
            const nameMatch = response.match(/NAME:\s*(.+)/i);
            const descMatch = response.match(/DESCRIPTION:\s*(.+)/i);
            const patternMatch = response.match(/PATTERN:\s*(.+)/i);
            const tagsMatch = response.match(/TAGS:\s*(.+)/i);
            const strategyMatch = response.match(/STRATEGY_HINT:\s*(.+?)(?:\n(?:PARAM|PARAMETERS|TEMPLATE):|$)/is);
            const templateMatch = response.match(/TEMPLATE:\s*\n([\s\S]+)/i);

            if (!nameMatch || !templateMatch) {
                console.warn('[SkillLearner] Failed to parse skill template from LLM response');
                return null;
            }

            // Parse parameters
            const parameters = this.parseParameters(response);

            const skill: LearnedSkill = {
                id: randomUUID(),
                name: nameMatch[1].trim().toLowerCase().replace(/\s+/g, '_'),
                description: descMatch?.[1]?.trim() || goalDescription.substring(0, 100),
                pattern: patternMatch?.[1]?.trim() || this.extractKeywords(goalDescription),
                template: templateMatch[1].trim(),
                strategy_hint: strategyMatch?.[1]?.trim() || '',
                parameters,
                runtime,
                version: 1,
                successCount: 1,
                failureCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastUsedAt: null,
                tags: tagsMatch?.[1]?.split(',').map(t => t.trim()) || [],
                parentId: null,
                promotedToTool: false,
            };

            // Store in database
            await this.ensureTable();
            await db.run(
                `INSERT INTO learned_skills (id, name, description, pattern, template, strategy_hint, parameters, runtime, version, success_count, failure_count, created_at, updated_at, tags, parent_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [skill.id, skill.name, skill.description, skill.pattern, skill.template,
                skill.strategy_hint, JSON.stringify(skill.parameters), skill.runtime, skill.version,
                    1, 0, skill.createdAt, skill.updatedAt,
                JSON.stringify(skill.tags), null]
            );

            // Store embedding for semantic matching (Phase 6B)
            await this.storeSkillEmbedding(skill);

            // Save to workspace skills directory
            await this.saveToWorkspace(skill);

            console.log(`[SkillLearner] Learned new skill: "${skill.name}" v${skill.version} (${skill.parameters.length} params)`);

            // Sprint 3: check if skill should be promoted to dynamic tool
            await this.maybePromoteToTool(skill);

            return skill;

        } catch (error) {
            console.error('[SkillLearner] Failed to learn from success:', error);
            return null;
        }
    }

    /**
     * Create a skill directly from a user instruction (no prior execution needed).
     * Uses the LLM to generate a runnable script, then passes it through learnFromSuccess()
     * so the same template extraction, dedup, and storage logic applies.
     */
    async learnFromInstruction(description: string): Promise<LearnedSkill | null> {
        const llm = modelManager.getActiveAdapter();
        if (!llm) return null;

        // Return early if a similar skill already exists
        const existing = await this.findMatchingSkill(description);
        if (existing) {
            console.log(`[SkillLearner] Similar skill already exists: "${existing.name}"`);
            return existing;
        }

        const prompt = `Write a complete, runnable Node.js script that accomplishes this task:
TASK: ${description}

Requirements:
- Use only built-in Node.js modules or commonly available npm packages (axios, node-fetch)
- Include error handling with try/catch
- Print results to stdout
- The script must be at least 100 characters and fully functional

Output ONLY the script code. No markdown fences, no explanation.`;

        try {
            const script = await llm.generate(prompt, { temperature: 0.2 });
            if (!script || script.trim().length < 100) {
                console.warn('[SkillLearner] learnFromInstruction: LLM returned empty or too-short script');
                return null;
            }
            // Delegate to learnFromSuccess — reuses all template extraction, dedup, and DB storage
            return this.learnFromSuccess(description, script.trim(), 'node', []);
        } catch (error) {
            console.error('[SkillLearner] learnFromInstruction failed:', error);
            return null;
        }
    }

    /**
     * Phase 6C: Create a new version of an existing skill
     */
    private async createNewVersion(
        existing: LearnedSkill,
        newScript: string,
        goalDescription: string,
        artifacts: string[]
    ): Promise<LearnedSkill> {
        const newVersion: LearnedSkill = {
            ...existing,
            id: randomUUID(),
            version: existing.version + 1,
            template: newScript,
            successCount: 1,
            updatedAt: new Date().toISOString(),
            parentId: existing.id,
        };

        await db.run(
            `INSERT INTO learned_skills (id, name, description, pattern, template, strategy_hint, parameters, runtime, version, success_count, failure_count, created_at, updated_at, tags, parent_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newVersion.id, newVersion.name, newVersion.description, newVersion.pattern,
            newVersion.template, newVersion.strategy_hint || '', JSON.stringify(newVersion.parameters), newVersion.runtime,
            newVersion.version, 1, 0, newVersion.createdAt, newVersion.updatedAt,
            JSON.stringify(newVersion.tags), newVersion.parentId]
        );

        // Update embedding
        await this.storeSkillEmbedding(newVersion);

        console.log(`[SkillLearner] Created "${newVersion.name}" v${newVersion.version} (upgraded from v${existing.version})`);
        return newVersion;
    }

    /**
     * Phase 6B: Store embedding for semantic skill matching
     */
    private async storeSkillEmbedding(skill: LearnedSkill): Promise<void> {
        try {
            const isAvailable = await vectorMemory.isAvailable();
            if (!isAvailable) return;

            const text = `${skill.name}: ${skill.description}. Tags: ${skill.tags.join(', ')}. Pattern: ${skill.pattern}`;
            await vectorMemory.storeWithEmbedding(
                `skill_${skill.id}`,
                'system',
                text,
                'learned_skill',
                { skillId: skill.id, name: skill.name, version: skill.version }
            );
        } catch (e) {
            // Non-critical
            console.warn('[SkillLearner] Failed to store skill embedding:', e);
        }
    }

    /**
     * Phase 6B: Find matching skill using hybrid approach:
     * 1. Try embedding-based semantic search (if available)
     * 2. Fallback to keyword matching
     */
    async findMatchingSkill(goalDescription: string): Promise<LearnedSkill | null> {
        await this.ensureTable();

        // Try embedding-based search first
        try {
            const isAvailable = await vectorMemory.isAvailable();
            if (isAvailable) {
                const results = await vectorMemory.semanticSearch(goalDescription, 'system', 3);
                const skillResults = results.filter(r => r.event_type === 'learned_skill' && r.similarity > 0.75);

                if (skillResults.length > 0) {
                    const context = skillResults[0].context as any;
                    if (context?.skillId) {
                        const row = await db.get('SELECT * FROM learned_skills WHERE id = ?', [context.skillId]);
                        if (row) {
                            console.log(`[SkillLearner] Semantic match: "${row.name}" (similarity: ${skillResults[0].similarity.toFixed(3)})`);
                            return this.rowToSkill(row);
                        }
                    }
                }
            }
        } catch (e) {
            // Fall through to keyword matching
        }

        // Fallback: keyword matching
        return this.keywordMatch(goalDescription);
    }

    /**
     * Keyword-based skill matching (fallback).
     *
     * Scoring:
     *  +pattern.length  for each matching pattern keyword in the goal
     *  -20              for each "domain word" from the skill name that is NOT in the goal
     *
     * Domain words are non-generic words extracted from the skill name (split on _ and -).
     * This prevents e.g. "fastapi_project_generator" from firing on a CSV CLI goal
     * just because both share "requirements.txt" and "setup.py" patterns.
     */
    private async keywordMatch(goalDescription: string): Promise<LearnedSkill | null> {
        const skills = await db.all(
            'SELECT * FROM learned_skills WHERE success_count >= 1 ORDER BY version DESC'
        );

        const goalLower = goalDescription.toLowerCase();

        // Generic words that appear in many skill names but don't identify a domain
        const GENERIC_WORDS = new Set([
            'project', 'generator', 'tool', 'helper', 'script', 'builder',
            'creator', 'maker', 'runner', 'manager', 'handler', 'service',
            'util', 'utility', 'setup', 'init', 'basic', 'simple', 'auto',
        ]);

        let bestMatch: LearnedSkill | null = null;
        let bestScore = 0;

        for (const row of skills) {
            const patterns = row.pattern.toLowerCase().split(',').map((p: string) => p.trim());
            let score = 0;

            // Pattern match score
            for (const pattern of patterns) {
                if (goalLower.includes(pattern) && pattern.length > 2) {
                    score += pattern.length;
                }
            }

            // Domain-mismatch penalty: extract domain words from skill name
            const skillNameWords = (row.name as string)
                .toLowerCase()
                .split(/[_\-\s]+/)
                .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));

            for (const domainWord of skillNameWords) {
                if (!goalLower.includes(domainWord)) {
                    score -= 20; // Heavy penalty per missing domain word
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = this.rowToSkill(row);
            }
        }

        if (bestScore < 5) return null;
        if (bestMatch) {
            console.log(`[SkillLearner] Keyword match: "${bestMatch.name}" (score: ${bestScore})`);
        }
        return bestMatch;
    }

    /**
     * Phase 6A: Apply a parameterized skill template
     */
    applyTemplate(skill: LearnedSkill, workspace: string, goalDescription: string, files: string[], paramValues?: Record<string, any>): string {
        let script = skill.template;
        const escapedWs = workspace.replace(/\\/g, '\\\\');

        // Apply built-in replacements
        script = script.replace(/\{\{WORKSPACE\}\}/g, escapedWs);
        script = script.replace(/\{\{DESCRIPTION\}\}/g, goalDescription);
        if (files.length > 0) {
            script = script.replace(/\{\{FILENAME\}\}/g, files[0]);
        }

        // Apply user-provided parameter values
        if (paramValues) {
            for (const [key, value] of Object.entries(paramValues)) {
                const pattern = new RegExp(`\\{\\{${key.toUpperCase()}\\}\\}`, 'g');
                script = script.replace(pattern, String(value));
            }
        }

        // Apply defaults for any remaining placeholders
        for (const param of skill.parameters) {
            if (param.default !== undefined) {
                const pattern = new RegExp(`\\{\\{${param.name.toUpperCase()}\\}\\}`, 'g');
                script = script.replace(pattern, String(param.default));
            }
        }

        return script;
    }

    /**
     * Record a skill failure (for success rate tracking)
     */
    async recordFailure(skillId: string): Promise<void> {
        await this.ensureTable();
        await db.run(
            'UPDATE learned_skills SET failure_count = failure_count + 1, updated_at = datetime("now") WHERE id = ?',
            [skillId]
        );
    }

    /**
     * List all learned skills (latest versions only)
     */
    async listSkills(): Promise<LearnedSkill[]> {
        await this.ensureTable();
        const rows = await db.all(
            'SELECT * FROM learned_skills ORDER BY version DESC, success_count DESC'
        );

        // Deduplicate: keep only latest version per skill name
        const seen = new Set<string>();
        const unique: LearnedSkill[] = [];
        for (const row of rows) {
            if (!seen.has(row.name)) {
                seen.add(row.name);
                unique.push(this.rowToSkill(row));
            }
        }
        return unique;
    }

    /**
     * Get all versions of a skill
     */
    async getSkillVersions(name: string): Promise<LearnedSkill[]> {
        await this.ensureTable();
        const rows = await db.all(
            'SELECT * FROM learned_skills WHERE name = ? ORDER BY version DESC',
            [name]
        );
        return rows.map(this.rowToSkill);
    }

    /**
     * Delete a skill and all its versions
     */
    async deleteSkill(name: string): Promise<boolean> {
        await this.ensureTable();
        const result = await db.run('DELETE FROM learned_skills WHERE name = ?', [name]);
        return (result as any)?.changes > 0;
    }

    /**
     * Phase 6C: Decay unused skills.
     * - Skills unused for >30 days get their priority reduced (success_count halved).
     * - Skills unused for >90 days with low success rate (<30%) get pruned entirely.
     * - Should be called periodically (e.g., daily or on startup).
     */
    async decayUnusedSkills(): Promise<{ decayed: number; pruned: number }> {
        await this.ensureTable();

        // Halve success_count for skills unused >30 days (reduces priority in matching)
        const decayResult = await db.run(`
            UPDATE learned_skills
            SET success_count = MAX(1, success_count / 2),
                updated_at = datetime('now')
            WHERE last_used_at IS NOT NULL
              AND last_used_at < datetime('now', '-30 days')
              AND success_count > 1
        `);
        const decayed = (decayResult as any)?.changes || 0;

        // Prune skills unused >90 days with low success rate
        const pruneResult = await db.run(`
            DELETE FROM learned_skills
            WHERE (last_used_at IS NULL AND created_at < datetime('now', '-90 days'))
               OR (last_used_at < datetime('now', '-90 days')
                   AND CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) < 0.3)
        `);
        const pruned = (pruneResult as any)?.changes || 0;

        if (decayed > 0 || pruned > 0) {
            console.log(`[SkillLearner] Decay: ${decayed} skills reduced priority, ${pruned} skills pruned`);
        }
        return { decayed, pruned };
    }

    // --- Private helpers ---

    private parseParameters(response: string): SkillParameter[] {
        const params: SkillParameter[] = [];
        const paramRegex = /PARAM:\s*(.+)/gi;
        let match;

        while ((match = paramRegex.exec(response)) !== null) {
            const parts = match[1].split('|').map(p => p.trim());
            if (parts.length >= 3) {
                params.push({
                    name: parts[0],
                    type: (parts[1] || 'string') as SkillParameter['type'],
                    description: parts[2],
                    required: parts[3]?.toLowerCase() === 'true',
                    default: parts[4] || undefined,
                });
            }
        }

        return params;
    }

    private extractKeywords(text: string): string {
        const stopWords = new Set(['a', 'an', 'the', 'is', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'with', 'that', 'this', 'create', 'make', 'build']);
        const words = text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));
        return [...new Set(words)].slice(0, 8).join(', ');
    }

    async ensureTable(): Promise<void> {
        await db.run(`
            CREATE TABLE IF NOT EXISTS learned_skills (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                pattern TEXT NOT NULL,
                template TEXT NOT NULL,
                parameters TEXT DEFAULT '[]',
                runtime TEXT DEFAULT 'node',
                version INTEGER DEFAULT 1,
                success_count INTEGER DEFAULT 1,
                failure_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP,
                tags TEXT DEFAULT '[]',
                parent_id TEXT
            )
        `);

        // Migration: add columns that may be missing from older schema
        const migrations = [
            'ALTER TABLE learned_skills ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
            'ALTER TABLE learned_skills ADD COLUMN last_used_at TIMESTAMP',
            'ALTER TABLE learned_skills ADD COLUMN tags TEXT DEFAULT \'[]\'',
            'ALTER TABLE learned_skills ADD COLUMN parent_id TEXT',
            'ALTER TABLE learned_skills ADD COLUMN parameters TEXT DEFAULT \'[]\'',
            'ALTER TABLE learned_skills ADD COLUMN version INTEGER DEFAULT 1',
            'ALTER TABLE learned_skills ADD COLUMN failure_count INTEGER DEFAULT 0',
            'ALTER TABLE learned_skills ADD COLUMN strategy_hint TEXT DEFAULT \'\'',
        ];
        for (const sql of migrations) {
            try { await db.run(sql); } catch { /* column already exists */ }
        }
    }

    private async saveToWorkspace(skill: LearnedSkill): Promise<void> {
        try {
            const workspaceDir = configManager.getWorkspaceDir();
            const skillsDir = path.join(workspaceDir, 'skills', 'learned');

            if (!fs.existsSync(skillsDir)) {
                fs.mkdirSync(skillsDir, { recursive: true });
            }

            const ext = skill.runtime === 'python' ? 'py' : 'js';
            const filePath = path.join(skillsDir, `${skill.name}.${ext}`);
            const comment = skill.runtime === 'python' ? '#' : '//';

            const header = [
                `${comment} Learned Skill: ${skill.name} v${skill.version}`,
                `${comment} ${skill.description}`,
                `${comment} Pattern: ${skill.pattern}`,
                `${comment} Tags: ${skill.tags.join(', ')}`,
                `${comment} Parameters: ${skill.parameters.map(p => p.name).join(', ')}`,
                '',
            ].join('\n');

            fs.writeFileSync(filePath, header + skill.template, 'utf-8');
            console.log(`[SkillLearner] Saved skill to ${filePath}`);
        } catch (e) {
            console.warn('[SkillLearner] Failed to save skill to workspace:', e);
        }
    }

    private rowToSkill(row: any): LearnedSkill {
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            pattern: row.pattern,
            template: row.template,
            strategy_hint: row.strategy_hint || '',
            parameters: JSON.parse(row.parameters || '[]'),
            runtime: row.runtime as 'python' | 'node',
            version: row.version || 1,
            successCount: row.success_count,
            failureCount: row.failure_count || 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at || row.created_at,
            lastUsedAt: row.last_used_at,
            tags: JSON.parse(row.tags || '[]'),
            parentId: row.parent_id || null,
            promotedToTool: false, // DB doesn't track this yet; promotion is checked live
        };
    }

    /**
     * Sprint 3: Promote a proven skill (successCount >= 3) to a dynamic tool.
     * The tool wraps the skill template so agents can invoke it directly.
     */
    private async maybePromoteToTool(skill: LearnedSkill): Promise<void> {
        try {
            if (skill.successCount < 3) return;

            // Check if tool already exists
            const existing = dynamicToolRegistry.getTool(`skill_${skill.name}`);
            if (existing) return;

            // Convert skill template to a tool function body
            // The tool accepts user-provided parameter values and returns the filled template
            const paramEntries = skill.parameters
                .map(p => `"${p.name}": { "type": "${p.type}", "description": "${p.description}" }`)
                .join(', ');

            const toolCode = `
// Auto-promoted from skill "${skill.name}" v${skill.version}
let template = ${JSON.stringify(skill.template)};
for (const [key, value] of Object.entries(args)) {
    const pattern = new RegExp('\\{\\{' + key.toUpperCase() + '\\}\\}', 'g');
    template = template.replace(pattern, String(value));
}
return { script: template, runtime: ${JSON.stringify(skill.runtime)}, skill: ${JSON.stringify(skill.name)} };
`.trim();

            await dynamicToolRegistry.registerTool(
                `skill_${skill.name}`,
                `Executes learned skill: ${skill.description}`,
                toolCode,
                {
                    inputSchema: skill.parameters.reduce((acc, p) => {
                        acc[p.name] = { type: p.type, description: p.description };
                        return acc;
                    }, {} as Record<string, any>),
                    createdBy: 'skill_learner',
                    tags: ['skill-promoted', ...skill.tags],
                }
            );

            console.log(`[SkillLearner] Promoted skill "${skill.name}" to dynamic tool "skill_${skill.name}"`);
        } catch (e) {
            console.warn('[SkillLearner] Failed to promote skill to tool:', e);
        }
    }

    // =========================================================================
    // SKILL FILE SEEDING — Community-style pre-built skill import
    // =========================================================================

    /**
     * Scan a directory for *.skill.json files and import any that are not
     * already present in the database (matched by skill name).
     *
     * Call this at server startup after DB init:
     *   await skillLearner.seedFromDirectory(path.join(__dirname, '../../skills'));
     *
     * JSON schema:  Partial<LearnedSkill> — at minimum `name`, `pattern`,
     *               `template`, and `runtime` must be present.
     */
    async seedFromDirectory(dir: string): Promise<{ imported: number; skipped: number }> {
        await this.ensureTable();

        let imported = 0;
        let skipped = 0;

        if (!fs.existsSync(dir)) {
            console.log(`[SkillLearner] Seed directory not found, skipping: ${dir}`);
            return { imported, skipped };
        }

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.skill.json'));
        if (files.length === 0) {
            console.log(`[SkillLearner] No *.skill.json files found in ${dir}`);
            return { imported, skipped };
        }

        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(raw) as Partial<LearnedSkill>;

                if (!data.name || !data.template || !data.pattern) {
                    console.warn(`[SkillLearner] Skipping ${file}: missing required fields (name, template, pattern)`);
                    skipped++;
                    continue;
                }

                // Skip if a skill with this name already exists
                const existing = await db.get(
                    'SELECT id FROM learned_skills WHERE name = ?',
                    [data.name.toLowerCase().replace(/\s+/g, '_')]
                );
                if (existing) {
                    skipped++;
                    continue;
                }

                const skill: LearnedSkill = {
                    id: randomUUID(),
                    name: data.name.toLowerCase().replace(/\s+/g, '_'),
                    description: data.description || data.name,
                    pattern: data.pattern,
                    template: data.template,
                    strategy_hint: data.strategy_hint || '',
                    parameters: data.parameters || [],
                    runtime: data.runtime || 'node',
                    version: 1,
                    successCount: 0,
                    failureCount: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lastUsedAt: null,
                    tags: [...(data.tags || []), 'seeded'],
                    parentId: null,
                    promotedToTool: false,
                };

                await db.run(
                    `INSERT INTO learned_skills
                       (id, name, description, pattern, template, strategy_hint, parameters, runtime, version,
                        success_count, failure_count, created_at, updated_at, tags, parent_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        skill.id, skill.name, skill.description, skill.pattern, skill.template,
                        skill.strategy_hint, JSON.stringify(skill.parameters), skill.runtime, skill.version,
                        0, 0, skill.createdAt, skill.updatedAt,
                        JSON.stringify(skill.tags), null,
                    ]
                );

                imported++;
                console.log(`[SkillLearner] Seeded skill: "${skill.name}" from ${file}`);
            } catch (e) {
                console.warn(`[SkillLearner] Failed to seed ${file}:`, e);
                skipped++;
            }
        }

        console.log(`[SkillLearner] Seeding complete: ${imported} imported, ${skipped} skipped`);
        return { imported, skipped };
    }
}

export const skillLearner = new SkillLearner();
