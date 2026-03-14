-- Migration 006: Paused OODA states for HITL resume
-- When the OODA loop pauses waiting for user input (request_user_input tool),
-- the full execution state is serialized here so chat() can resume exactly
-- where it left off on the next user message.

CREATE TABLE IF NOT EXISTS paused_ooda_states (
    conversation_id     TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    mode                TEXT NOT NULL DEFAULT 'chat',
    iteration           INTEGER NOT NULL,
    conversation_history JSON NOT NULL,          -- full HistoryMessage[] at pause time
    all_tool_calls      JSON NOT NULL,           -- accumulated tool call log
    pending_tool        TEXT NOT NULL,           -- tool that triggered the pause
    pending_args        JSON NOT NULL,           -- args of that tool call
    pending_question    TEXT NOT NULL,           -- question shown to the user
    container_session_id TEXT,                  -- Docker container name (if any)
    workspace_files     JSON NOT NULL DEFAULT '[]', -- /workspace file list at pause time
    model_key           TEXT,                   -- active model at pause time
    paused_at           DATETIME DEFAULT (datetime('now')),
    expires_at          DATETIME NOT NULL        -- 30 min TTL; expired rows are ignored
);

CREATE INDEX IF NOT EXISTS idx_paused_ooda_expires
    ON paused_ooda_states (expires_at);
