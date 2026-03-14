-- Goal outcome post-mortems with domain-tag indexed lookup.
-- Written on goal completion/failure. Queried at goal start to inject
-- prior solutions and known-blocked approaches into the ReAct prompt.

CREATE TABLE IF NOT EXISTS goal_outcomes (
    id          TEXT PRIMARY KEY,
    goal_text   TEXT NOT NULL,
    status      TEXT NOT NULL,   -- 'completed' | 'failed'
    failure_cause   TEXT,
    working_approach TEXT,
    blocked_tools   TEXT,        -- JSON array of tool names that were blocked
    iterations_used INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Junction table for deterministic tag-based lookup (no vector search needed)
CREATE TABLE IF NOT EXISTS goal_outcome_tags (
    outcome_id  TEXT NOT NULL REFERENCES goal_outcomes(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_outcome_tags_tag ON goal_outcome_tags(tag);
CREATE INDEX IF NOT EXISTS idx_goal_outcomes_created ON goal_outcomes(created_at DESC);
