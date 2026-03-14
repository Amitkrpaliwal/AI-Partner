-- Named agent keyword auto-routing: comma-separated list of trigger words/phrases
-- When a user message contains any keyword, the goal is routed to this agent automatically.
-- Empty string = disabled (opt-in per profile).
ALTER TABLE agent_profiles ADD COLUMN auto_select_keywords TEXT NOT NULL DEFAULT '';
