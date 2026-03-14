/**
 * Benchmark regression log API.
 * Stores and queries pass/fail results for test cases across model upgrades.
 *
 * POST /api/benchmark        — Record a benchmark result
 * GET  /api/benchmark        — List results (optional ?test_id=&model_id=&limit=)
 * GET  /api/benchmark/summary — Consistency summary: pass rate per test_id × model_id
 * DELETE /api/benchmark/:id  — Delete a single result record
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../database';

const router = Router();

// ── POST /api/benchmark ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    try {
        const {
            model_id,
            test_id,
            test_description,
            passed,
            iterations_used,
            max_iterations,
            failure_category,
            failure_detail,
            skill_injected = false,
            skill_name,
            run_duration_ms,
            notes,
        } = req.body;

        if (!model_id || !test_id || passed === undefined) {
            return res.status(400).json({ error: 'model_id, test_id, and passed are required' });
        }

        await db.run(`
            CREATE TABLE IF NOT EXISTS benchmark_results (
                id TEXT PRIMARY KEY,
                recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
                model_id TEXT NOT NULL,
                test_id TEXT NOT NULL,
                test_description TEXT,
                passed INTEGER NOT NULL DEFAULT 0,
                iterations_used INTEGER,
                max_iterations INTEGER,
                failure_category TEXT,
                failure_detail TEXT,
                skill_injected INTEGER NOT NULL DEFAULT 0,
                skill_name TEXT,
                run_duration_ms INTEGER,
                notes TEXT
            )
        `);

        const id = randomUUID();
        await db.run(
            `INSERT INTO benchmark_results
               (id, model_id, test_id, test_description, passed, iterations_used, max_iterations,
                failure_category, failure_detail, skill_injected, skill_name, run_duration_ms, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id, model_id, test_id, test_description || null,
                passed ? 1 : 0,
                iterations_used ?? null, max_iterations ?? null,
                failure_category || null, failure_detail || null,
                skill_injected ? 1 : 0, skill_name || null,
                run_duration_ms ?? null, notes || null,
            ]
        );

        return res.json({ id, recorded: true });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/benchmark ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { test_id, model_id, limit = 50 } = req.query;
        const conditions: string[] = [];
        const params: any[] = [];

        if (test_id) { conditions.push('test_id = ?'); params.push(test_id); }
        if (model_id) { conditions.push('model_id = ?'); params.push(model_id); }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        params.push(Number(limit));

        const rows = await db.all(
            `SELECT * FROM benchmark_results ${where} ORDER BY recorded_at DESC LIMIT ?`,
            params
        ).catch(() => []);

        return res.json({ results: rows, count: rows.length });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /api/benchmark/summary ─────────────────────────────────────────────
router.get('/summary', async (req, res) => {
    try {
        const rows = await db.all(`
            SELECT
                test_id,
                model_id,
                COUNT(*) AS total_runs,
                SUM(passed) AS passed_runs,
                ROUND(100.0 * SUM(passed) / COUNT(*), 1) AS pass_rate_pct,
                ROUND(AVG(iterations_used), 1) AS avg_iterations,
                MAX(recorded_at) AS last_run_at
            FROM benchmark_results
            GROUP BY test_id, model_id
            ORDER BY test_id, model_id
        `).catch(() => []);

        // Consistency gate: flag any test_id × model_id with < 2/3 pass rate
        const flagged = rows.filter((r: any) => r.pass_rate_pct < 67 && r.total_runs >= 2);

        return res.json({ summary: rows, flagged_below_threshold: flagged });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ── DELETE /api/benchmark/:id ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const result = await db.run('DELETE FROM benchmark_results WHERE id = ?', [req.params.id]);
        const deleted = (result as any)?.changes > 0;
        return res.json({ deleted, id: req.params.id });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

export default router;
