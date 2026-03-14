/**
 * Capabilities Routes — User-controlled power toggles.
 *
 * GET  /api/capabilities         — returns runMode + current toggle states
 * PUT  /api/capabilities         — save toggle states
 */

import { Router, Request, Response } from 'express';
import { db } from '../database';

const router = Router();

// ── Detect run mode ─────────────────────────────────────────────────────────
// docker-compose.yml sets RUN_MODE=docker.
// Running via `npm run dev` leaves it unset → 'native'.
export function getRunMode(): 'docker' | 'native' {
    return (process.env.RUN_MODE === 'docker') ? 'docker' : 'native';
}

// ── Capability definitions ───────────────────────────────────────────────────
export const CAPABILITY_DEFS = [
    {
        id: 'persistent_browser',
        label: 'Persistent Browser Sessions',
        icon: '🌐',
        description: 'Stays logged into websites between tasks. Works in both modes.',
        availableIn: ['docker', 'native'] as const,
        risk: 'none' as const,
        defaultValue: false,
    },
    {
        id: 'local_folder',
        label: 'Local Folder Access',
        icon: '🗂️',
        description: 'Share a folder on your machine with the agent. Agent can read and write files inside it only.',
        availableIn: ['docker', 'native'] as const,
        risk: 'low' as const,
        defaultValue: false,
        requiresValue: true,
        valuePlaceholder: '/path/to/your/folder',
        valueLabel: 'Folder path',
    },
    {
        id: 'desktop_control',
        label: 'Desktop Control',
        icon: '🖥️',
        description: 'Click any desktop app, move the mouse, type — full OS GUI control.',
        availableIn: ['native'] as const,  // Docker has no display server
        risk: 'high' as const,
        defaultValue: false,
        confirmationRequired: true,
        confirmText: 'I understand the agent will be able to click and type in any app on my computer.',
    },
    {
        id: 'payment_tools',
        label: 'Payment Tools',
        icon: '💳',
        description: 'Let the agent make purchases via Stripe. Always asks for your approval before charging.',
        availableIn: ['docker', 'native'] as const,
        risk: 'medium' as const,
        defaultValue: false,
        requiresValue: true,
        valuePlaceholder: 'sk_live_...',
        valueLabel: 'Stripe Secret Key',
    },
] as const;

// ── Ensure table exists ──────────────────────────────────────────────────────
async function ensureTable() {
    await db.run(`
        CREATE TABLE IF NOT EXISTS capabilities (
            id TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            value TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);
}

// ── GET /api/capabilities ────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
    try {
        await ensureTable();
        const rows = await db.all('SELECT id, enabled, value FROM capabilities');
        const stored: Record<string, { enabled: boolean; value?: string }> = {};
        for (const row of rows) {
            stored[row.id] = { enabled: row.enabled === 1, value: row.value ?? undefined };
        }

        const runMode = getRunMode();

        const capabilities = CAPABILITY_DEFS.map(def => ({
            id: def.id,
            label: def.label,
            icon: def.icon,
            description: def.description,
            risk: def.risk,
            availableInCurrentMode: (def.availableIn as readonly string[]).includes(runMode),
            enabled: stored[def.id]?.enabled ?? def.defaultValue,
            value: stored[def.id]?.value ?? null,
            requiresValue: 'requiresValue' in def ? def.requiresValue : false,
            valuePlaceholder: 'valuePlaceholder' in def ? def.valuePlaceholder : undefined,
            valueLabel: 'valueLabel' in def ? def.valueLabel : undefined,
            confirmationRequired: 'confirmationRequired' in def ? def.confirmationRequired : false,
            confirmText: 'confirmText' in def ? def.confirmText : undefined,
        }));

        res.json({ runMode, capabilities });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ── PUT /api/capabilities ────────────────────────────────────────────────────
router.put('/', async (req: Request, res: Response) => {
    try {
        await ensureTable();
        const updates: Array<{ id: string; enabled: boolean; value?: string }> = req.body.capabilities || [];

        for (const update of updates) {
            await db.run(`
                INSERT INTO capabilities (id, enabled, value, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                    enabled = excluded.enabled,
                    value = excluded.value,
                    updated_at = excluded.updated_at
            `, [update.id, update.enabled ? 1 : 0, update.value ?? null]);
        }

        // If persistent_browser was toggled, emit socket event so browser session
        // manager can pick up the change without a restart.
        const browserUpdate = updates.find(u => u.id === 'persistent_browser');
        if (browserUpdate !== undefined) {
            process.env.CAPABILITY_PERSISTENT_BROWSER = browserUpdate.enabled ? '1' : '0';
        }

        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export const capabilitiesRoutes = router;
