-- Migration 010: Add agentType column to agent_profiles
-- agentType drives iteration-exhaustion behaviour:
--   research   → partial results acceptable, return what was found
--   execution  → partial = wrong, escalate to Goal mode + write handoff-context.md
--   delivery   → partial = nothing sent, flag clearly + retry hint
--   synthesis  → partial draft acceptable with caveat
ALTER TABLE agent_profiles ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'research';
