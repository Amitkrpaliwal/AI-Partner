import { Router } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../database';
import { modelManager } from '../services/llm/modelManager';

// Refresh Telegram "/" menu after profile changes (non-fatal if Telegram not connected)
async function refreshTelegramMenu() {
    try {
        const { messagingGateway } = await import('../services/MessagingGateway');
        const telegram = (messagingGateway as any).providers?.get('telegram');
        if (telegram?.refreshAgentCommands) await telegram.refreshAgentCommands();
    } catch { /* Telegram not connected — ignore */ }
}

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function row2profile(row: any) {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        role: row.role,
        systemPrompt: row.system_prompt,
        toolWhitelist: JSON.parse(row.tool_whitelist || '[]'),
        avatarColor: row.avatar_color,
        memoryNamespace: row.memory_namespace,
        description: row.description,
        maxIterations: row.max_iterations ?? 15,
        autoSelectKeywords: row.auto_select_keywords
            ? row.auto_select_keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
            : [],
        agentType: row.agent_type ?? 'research',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Derive a URL-safe slug from a display name */
function deriveSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/agent-profiles — list all profiles
router.get('/', async (_req, res) => {
    try {
        const rows = await db.all(
            'SELECT * FROM agent_profiles ORDER BY created_at ASC'
        );
        res.json({ profiles: rows.map(row2profile) });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/agent-profiles/:id — get single profile
router.get('/:id', async (req, res) => {
    try {
        const row = await db.get('SELECT * FROM agent_profiles WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Profile not found' });
        res.json(row2profile(row));
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/agent-profiles/generate — LLM-generates a profile from a plain description
// Returns a pre-filled profile object (not saved). Client saves via POST /.
router.post('/generate', async (req, res) => {
    try {
        const { description } = req.body;
        if (!description) return res.status(400).json({ error: 'description is required' });

        const llm = modelManager.getActiveAdapter();
        if (!llm) return res.status(503).json({ error: 'No LLM available' });

        // Load existing profiles for handoff hints
        const existingProfiles = await db.all('SELECT name, slug FROM agent_profiles ORDER BY created_at ASC').catch(() => [] as any[]);
        const existingSlugs = existingProfiles.map((p: any) => `@${p.slug} (${p.name})`).join(', ') || 'none yet';

        const systemPrompt =
            `You are an AI agent profile designer. Generate a JSON object for an AI agent profile based on the user description.
Return ONLY valid JSON (no markdown, no explanation) with this exact shape:
{
  "name": "Human-readable display name (2-4 words)",
  "role": "One-line role description",
  "description": "2-3 sentence description of what this agent does and specialises in",
  "agentType": "One of: research | execution | delivery | synthesis. Choose based on: research=web lookup/analysis, execution=code/shell/files that must complete, delivery=sends messages/files to external platforms, synthesis=writes docs/summaries from existing content",
  "systemPrompt": "Full system prompt following this exact structure: IDENTITY paragraph, APPROACH numbered steps (1-4), CONSTRAINTS paragraph (what it never does), DONE WHEN sentence (concrete completion condition), and one handoff line: 'For [related task]: suggest @[relevant-slug].' Use the available agents list below to pick the most appropriate handoff.",
  "toolWhitelist": ["Select ONLY the tools this agent needs from these groups — Search: web_search, web_fetch, web_search_status | Browser: browser_navigate, browser_click, browser_extract, browser_fetch, browser_screenshot, browser_launch | Files: read_file, write_file, edit_file, list_directory, create_directory, delete_file, move_file, get_file_info, search_files | Code: run_command, run_script | Messaging: messaging_send, messaging_send_file, messaging_status | Memory: memory_store, memory_retrieve, memory_list — empty array means ALL tools allowed"],
  "avatarColor": "#hex color that matches the agent domain (blue=research, orange=execution, pink=delivery, green=files/code, purple=creative)",
  "maxIterations": 10,
  "autoSelectKeywords": ["3-6 lowercase keywords that should auto-route to this agent — be specific, not generic"]
}

Available agents for handoff hints: ${existingSlugs}`;

        let raw: string;
        try {
            const result = await llm.generateJSON(
                `Create an AI agent profile for: ${description}`,
                {},
                { systemPrompt, temperature: 0.7 }
            );
            raw = result;
        } catch (err: any) {
            // generateJSON threw — try to parse rawText if available
            const rawText: string = err.rawText || '';
            if (!rawText) return res.status(502).json({ error: 'LLM generation failed', detail: err.message });
            const m = rawText.match(/\{[\s\S]*\}/);
            if (!m) return res.status(502).json({ error: 'LLM returned no valid JSON', detail: rawText.substring(0, 300) });
            raw = m[0];
        }

        // Normalise: generateJSON may return a parsed object already
        const profile = typeof raw === 'string' ? JSON.parse(raw) : raw;

        const validAgentTypes = ['research', 'execution', 'delivery', 'synthesis'];
        res.json({
            name: profile.name || 'Unnamed Agent',
            slug: deriveSlug(profile.name || 'unnamed-agent'),
            role: profile.role || 'general assistant',
            description: profile.description || '',
            systemPrompt: profile.systemPrompt || '',
            toolWhitelist: Array.isArray(profile.toolWhitelist) ? profile.toolWhitelist : [],
            avatarColor: profile.avatarColor || '#6366f1',
            maxIterations: profile.maxIterations ?? 10,
            autoSelectKeywords: Array.isArray(profile.autoSelectKeywords) ? profile.autoSelectKeywords : [],
            agentType: validAgentTypes.includes(profile.agentType) ? profile.agentType : 'research',
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/agent-profiles — create new profile
router.post('/', async (req, res) => {
    try {
        const { name, role, systemPrompt, toolWhitelist, avatarColor, description, maxIterations, autoSelectKeywords, agentType } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });

        const id = randomUUID();
        // Namespace is derived from the profile id — always unique
        const memoryNamespace = `profile_${id.substring(0, 8)}`;
        const slug = deriveSlug(name);
        const keywordsStr = Array.isArray(autoSelectKeywords)
            ? autoSelectKeywords.join(',')
            : (autoSelectKeywords || '');

        await db.run(
            `INSERT INTO agent_profiles (id, name, slug, role, system_prompt, tool_whitelist, avatar_color, memory_namespace, description, max_iterations, auto_select_keywords, agent_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                name,
                slug,
                role || 'general assistant',
                systemPrompt || '',
                JSON.stringify(toolWhitelist || []),
                avatarColor || '#6366f1',
                memoryNamespace,
                description || '',
                maxIterations ?? 15,
                keywordsStr,
                agentType || 'research',
            ]
        );

        // Seed a persona row for this namespace so memory queries don't fail
        await db.run(
            `INSERT OR IGNORE INTO persona (user_id, name, role, preferences, metadata)
             VALUES (?, ?, ?, '{}', '{}')`,
            [memoryNamespace, name, role || 'general assistant']
        );

        const created = await db.get('SELECT * FROM agent_profiles WHERE id = ?', [id]);
        void refreshTelegramMenu();
        res.status(201).json(row2profile(created));
    } catch (e: any) {
        if (e.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'A profile with this name already exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/agent-profiles/:id — update profile
router.put('/:id', async (req, res) => {
    try {
        const { name, role, systemPrompt, toolWhitelist, avatarColor, description, maxIterations, autoSelectKeywords, agentType } = req.body;
        const { id } = req.params;

        const existing = await db.get('SELECT * FROM agent_profiles WHERE id = ?', [id]);
        if (!existing) return res.status(404).json({ error: 'Profile not found' });

        const newName = name ?? existing.name;
        const newSlug = name ? deriveSlug(name) : existing.slug;
        const keywordsStr = autoSelectKeywords !== undefined
            ? (Array.isArray(autoSelectKeywords) ? autoSelectKeywords.join(',') : autoSelectKeywords)
            : existing.auto_select_keywords ?? '';

        await db.run(
            `UPDATE agent_profiles SET
               name = ?, slug = ?, role = ?, system_prompt = ?, tool_whitelist = ?,
               avatar_color = ?, description = ?, max_iterations = ?, auto_select_keywords = ?,
               agent_type = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                newName,
                newSlug,
                role ?? existing.role,
                systemPrompt ?? existing.system_prompt,
                JSON.stringify(toolWhitelist ?? JSON.parse(existing.tool_whitelist || '[]')),
                avatarColor ?? existing.avatar_color,
                description ?? existing.description,
                maxIterations ?? existing.max_iterations ?? 15,
                keywordsStr,
                agentType ?? existing.agent_type ?? 'research',
                id,
            ]
        );

        // Keep persona name in sync
        if (name) {
            await db.run(
                'UPDATE persona SET name = ?, role = ? WHERE user_id = ?',
                [name, role ?? existing.role, existing.memory_namespace]
            );
        }

        const updated = await db.get('SELECT * FROM agent_profiles WHERE id = ?', [id]);
        res.json(row2profile(updated));
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/agent-profiles/seed — insert starter pack profiles (skips slugs that already exist)
router.post('/seed', async (_req, res) => {
    try {
        const { SEED_PROFILES } = await import('../agents/seedProfiles');
        const inserted: string[] = [];
        const skipped: string[] = [];

        for (const p of SEED_PROFILES) {
            // Skip if slug already exists
            const existing = await db.get('SELECT id FROM agent_profiles WHERE slug = ?', [p.slug]);
            if (existing) { skipped.push(p.slug); continue; }

            const id = randomUUID();
            const memoryNamespace = `profile_${id.substring(0, 8)}`;
            await db.run(
                `INSERT INTO agent_profiles
                   (id, name, slug, role, system_prompt, tool_whitelist, avatar_color,
                    memory_namespace, description, max_iterations, auto_select_keywords, agent_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id, p.name, p.slug, p.role, p.systemPrompt,
                    JSON.stringify(p.toolWhitelist),
                    p.avatarColor, memoryNamespace, p.description,
                    p.maxIterations,
                    p.autoSelectKeywords.join(','),
                    p.agentType,
                ]
            );
            await db.run(
                `INSERT OR IGNORE INTO persona (user_id, name, role, preferences, metadata) VALUES (?, ?, ?, '{}', '{}')`,
                [memoryNamespace, p.name, p.role]
            );
            inserted.push(p.slug);
        }

        if (inserted.length > 0) void refreshTelegramMenu();
        res.json({ inserted, skipped, total: SEED_PROFILES.length });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/agent-profiles/:id — delete profile
router.delete('/:id', async (req, res) => {
    try {
        const existing = await db.get('SELECT * FROM agent_profiles WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: 'Profile not found' });

        await db.run('DELETE FROM agent_profiles WHERE id = ?', [req.params.id]);
        void refreshTelegramMenu();
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/agent-profiles/:id/memory — get recent memory for this profile's namespace
router.get('/:id/memory', async (req, res) => {
    try {
        const profile = await db.get('SELECT memory_namespace FROM agent_profiles WHERE id = ?', [req.params.id]);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        const events = await db.all(
            'SELECT * FROM episodic_memory WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20',
            [profile.memory_namespace]
        );
        const facts = await db.all(
            'SELECT * FROM biographic_facts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
            [profile.memory_namespace]
        );
        res.json({ namespace: profile.memory_namespace, events, facts });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export { router as agentProfileRoutes };
