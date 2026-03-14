-- Execution checkpoints for crash recovery and HITL state preservation.
-- checkpoint_draft: staging area — written first, never read for recovery
-- checkpoint:       committed value — only promoted from draft atomically
-- container_id:     Docker container ID at time of checkpoint
-- files_written:    JSON array of paths written up to this checkpoint

ALTER TABLE autonomous_executions ADD COLUMN checkpoint_draft TEXT;
ALTER TABLE autonomous_executions ADD COLUMN checkpoint TEXT;
ALTER TABLE autonomous_executions ADD COLUMN container_id TEXT;
ALTER TABLE autonomous_executions ADD COLUMN files_written TEXT;
