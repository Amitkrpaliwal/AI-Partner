-- Agent Profiles wiring: slug (for @mention routing) + max_iterations override
ALTER TABLE agent_profiles ADD COLUMN slug TEXT;
ALTER TABLE agent_profiles ADD COLUMN max_iterations INTEGER DEFAULT 15;

-- Backfill slug from existing name: lowercase, spaces → hyphens, strip non-alphanumeric
UPDATE agent_profiles
SET slug = lower(replace(replace(replace(name, ' ', '-'), '_', '-'), '.', ''))
WHERE slug IS NULL;

-- Ensure slugs stay unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_slug ON agent_profiles(slug);
