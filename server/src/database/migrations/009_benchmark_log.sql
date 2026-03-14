-- Migration 009: Benchmark regression log
-- Stores pass/fail results for known test cases across model upgrades.
-- Fields: date, model, test_id, passed, iterations, failure_category, failure_detail, skill_injected

CREATE TABLE IF NOT EXISTS benchmark_results (
    id                TEXT PRIMARY KEY,
    recorded_at       TEXT NOT NULL DEFAULT (datetime('now')),
    model_id          TEXT NOT NULL,
    test_id           TEXT NOT NULL,
    test_description  TEXT,
    passed            INTEGER NOT NULL DEFAULT 0,  -- 1=pass, 0=fail
    iterations_used   INTEGER,
    max_iterations    INTEGER,
    failure_category  TEXT,   -- e.g. 'tool_hallucination', 'stale_artifact', 'timeout', 'wrong_output'
    failure_detail    TEXT,
    skill_injected    INTEGER NOT NULL DEFAULT 0,  -- 1 if a skill strategy_hint was used
    skill_name        TEXT,
    run_duration_ms   INTEGER,
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_benchmark_test ON benchmark_results(test_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_model ON benchmark_results(model_id, recorded_at DESC);
