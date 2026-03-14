-- Baseline schema — all tables that existed before the migration system was introduced.
-- This migration is idempotent (all CREATE TABLE IF NOT EXISTS).

-- User Persona Table
CREATE TABLE IF NOT EXISTS persona (
  user_id TEXT PRIMARY KEY DEFAULT 'default',
  name TEXT,
  role TEXT,
  preferences JSON NOT NULL DEFAULT '{}',
  metadata JSON NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Episodic Memory (Events Timeline)
CREATE TABLE IF NOT EXISTS episodic_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  event_text TEXT NOT NULL,
  event_type TEXT,
  context JSON,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  embedding BLOB,
  FOREIGN KEY (user_id) REFERENCES persona(user_id)
);

CREATE INDEX IF NOT EXISTS idx_episodic_timestamp ON episodic_memory(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_user ON episodic_memory(user_id);

-- Biographic Memory (Semantic Facts)
CREATE TABLE IF NOT EXISTS biographic_facts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  source TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES persona(user_id)
);

CREATE INDEX IF NOT EXISTS idx_facts_subject ON biographic_facts(subject, predicate);
CREATE INDEX IF NOT EXISTS idx_facts_user ON biographic_facts(user_id);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSON,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);

-- Scheduled Tasks
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  schedule TEXT NOT NULL,
  action TEXT NOT NULL,
  parameters JSON,
  enabled BOOLEAN DEFAULT TRUE,
  last_run TIMESTAMP,
  next_run TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES persona(user_id)
);

CREATE TABLE IF NOT EXISTS heartbeat_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status TEXT,
  action_taken TEXT,
  result JSON,
  FOREIGN KEY (user_id) REFERENCES persona(user_id)
);

-- Core Memory (Legacy Support)
CREATE TABLE IF NOT EXISTS core_memory (
  category TEXT,
  key TEXT,
  value JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category, key)
);

-- Installed Skills
CREATE TABLE IF NOT EXISTS installed_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  provider TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  config JSON DEFAULT '{}',
  version TEXT,
  installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_skills_name ON installed_skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON installed_skills(enabled);

-- Generated Files / Deliverables
CREATE TABLE IF NOT EXISTS generated_files (
  id TEXT PRIMARY KEY,
  execution_id TEXT,
  conversation_id TEXT,
  user_id TEXT NOT NULL DEFAULT 'default',
  filename TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  title TEXT,
  description TEXT,
  metadata JSON DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  download_count INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES persona(user_id)
);

CREATE INDEX IF NOT EXISTS idx_files_user ON generated_files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_execution ON generated_files(execution_id);
CREATE INDEX IF NOT EXISTS idx_files_conversation ON generated_files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_files_type ON generated_files(file_type);
CREATE INDEX IF NOT EXISTS idx_files_created ON generated_files(created_at DESC);

-- Autonomous Execution History
CREATE TABLE IF NOT EXISTS autonomous_executions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total_steps INTEGER DEFAULT 0,
  completed_steps INTEGER DEFAULT 0,
  total_iterations INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  plan JSON,
  results JSON,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES persona(user_id)
);

CREATE INDEX IF NOT EXISTS idx_exec_user ON autonomous_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_exec_status ON autonomous_executions(status);
CREATE INDEX IF NOT EXISTS idx_exec_created ON autonomous_executions(created_at DESC);

-- Goal Executions
CREATE TABLE IF NOT EXISTS goal_executions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  request TEXT NOT NULL,
  goal JSON NOT NULL,
  state JSON NOT NULL,
  status TEXT NOT NULL,
  iterations INTEGER DEFAULT 0,
  max_iterations INTEGER,
  artifacts JSON DEFAULT '[]',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES persona(user_id)
);

CREATE INDEX IF NOT EXISTS idx_goal_exec_user ON goal_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_goal_exec_status ON goal_executions(status);
CREATE INDEX IF NOT EXISTS idx_goal_exec_started ON goal_executions(started_at DESC);

-- Chat Adapter Configurations
CREATE TABLE IF NOT EXISTS chat_adapter_configs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL UNIQUE,
  enabled BOOLEAN DEFAULT FALSE,
  token TEXT,
  bot_username TEXT,
  allowed_users JSON DEFAULT '[]',
  allowed_channels JSON DEFAULT '[]',
  metadata JSON DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_adapter_platform ON chat_adapter_configs(platform);

-- Agent Profiles
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'general assistant',
  system_prompt TEXT NOT NULL DEFAULT '',
  tool_whitelist JSON NOT NULL DEFAULT '[]',
  avatar_color TEXT NOT NULL DEFAULT '#6366f1',
  memory_namespace TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_name ON agent_profiles(name);

-- Scheduler Run History
CREATE TABLE IF NOT EXISTS scheduler_run_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  output TEXT,
  error_message TEXT,
  duration_ms INTEGER DEFAULT 0,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sched_history_task ON scheduler_run_history(task_id);
CREATE INDEX IF NOT EXISTS idx_sched_history_started ON scheduler_run_history(started_at DESC);
