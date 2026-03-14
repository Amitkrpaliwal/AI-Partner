import express from 'express';
import http from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db } from './database';
import { appLogger } from './utils/Logger';
import { requestIdMiddleware } from './middleware/requestId';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { memoryManager } from './memory/MemoryManager';
import { NotificationService } from './services/NotificationService';
import { HeartbeatService, setHeartbeatInstance } from './services/HeartbeatService';
import { GatewayService } from './services/GatewayService';
import { createHeartbeatRouter } from './api/heartbeat';
import { tasksRouter } from './api/tasks';
import { mcpRouter } from './api/mcp';
import { modelsRouter } from './api/models';
import { skillsRouter } from './api/skills';
import { mcpManager } from './mcp/MCPManager';
import { agentOrchestrator, setGateway } from './services/AgentOrchestrator';
import { modelManager } from './services/llm/modelManager';
import { configManager } from './services/ConfigManager';
import { MarkdownConfigLoader } from './config/MarkdownConfigLoader';
import { skillManager } from './services/SkillManager';
import { progressReporter } from './agents/ProgressReporter';
import { agentPool } from './agents/AgentPool';
import autonomousRoutes from './routes/autonomousRoutes';
import chatRoutes, { initializeChatAdapters } from './routes/chatRoutes';
import { fileRoutes } from './routes/fileRoutes';
import { generateRoutes } from './routes/generateRoutes';
import { goalRoutes } from './routes/goalRoutes';
import { knowledgeRoutes } from './routes/knowledgeRoutes';
import { goalOrientedExecutor } from './agents/GoalOrientedExecutor';
import { capabilitiesRoutes } from './routes/capabilitiesRoutes';
import { setupRoutes } from './routes/setupRoutes';

const app = express();
const server = http.createServer(app);

// Long-running goal executions can take up to 15 minutes (900s benchmark timeout).
// Node.js 18+ defaults to 300s request timeout — raise it to 30 minutes.
server.requestTimeout = 1800_000;
server.headersTimeout = 1800_000;

// Initialize Gateway Service (handles Socket.IO internally)
const gateway = new GatewayService(server);

// Wire gateway to orchestrators for OODA events
setGateway(gateway);

// Connect progress reporter to gateway's Socket.IO for real-time updates
progressReporter.setSocketIO(gateway.io);


// Connect goal executor to gateway for real-time updates
goalOrientedExecutor.setGateway(gateway);

// Connect agent bus to gateway for real-time inter-agent message visibility
import { agentBus } from './agents/AgentBus';
agentBus.setGateway(gateway);

// Forward agent pool events to Socket.IO for real-time monitoring
agentPool.on('agent:spawned', (data) => gateway.io.emit('agent:spawned', { timestamp: new Date().toISOString(), ...data }));
agentPool.on('agent:completed', (data) => gateway.io.emit('agent:completed', { timestamp: new Date().toISOString(), ...data }));
agentPool.on('agent:failed', (data) => gateway.io.emit('agent:failed', { timestamp: new Date().toISOString(), ...data }));

// Forward memory events to Socket.IO so ActivityFeed updates in real-time (no polling needed)
memoryManager.on('event:stored', (data) => gateway.io.emit('event:new', data));

// Initialize other services
const notificationService = new NotificationService(gateway);
const heartbeatService = new HeartbeatService(memoryManager, notificationService);
heartbeatService.setSocketIO(gateway.io); // real-time heartbeat:tick events
setHeartbeatInstance(heartbeatService);   // expose singleton for dynamic imports

// Initialize workspace on startup
async function initializeApp() {
  appLogger.info('Initializing...');

  // Run DB migrations FIRST — all other services assume schema is current
  await db.initialize();

  // Initialize audit logger (Phase 13D)
  const { auditLogger } = await import('./services/AuditLogger');
  await auditLogger.initialize();

  // Load saved integration credentials from SecretManager into process.env (Session 8)
  const { secretManager } = await import('./services/SecretManager');
  await secretManager.loadIntoEnv('default');

  // Initialize dynamic tool registry (Phase 3)
  const { dynamicToolRegistry } = await import('./mcp/DynamicToolRegistry');
  await dynamicToolRegistry.initialize();

  // Sprint 3: Forward dynamic tool events to Socket.IO for real-time frontend updates
  dynamicToolRegistry.on('tool:registered', (data) => gateway.io.emit('tool:registered', { timestamp: new Date().toISOString(), ...data }));
  dynamicToolRegistry.on('tool:deleted', (data) => gateway.io.emit('tool:deleted', { timestamp: new Date().toISOString(), ...data }));

  // Initialize usage tracker (Phase 8)
  const { usageTracker } = await import('./services/UsageTracker');
  await usageTracker.initialize();

  // Initialize Telegram HITL bridge (must be before providers register)
  const { telegramHITLBridge } = await import('./services/TelegramHITLBridge');
  telegramHITLBridge.initialize();

  // Register messaging providers (Phase 5) — they connect on-demand via API
  const { messagingGateway } = await import('./services/MessagingGateway');
  const { TelegramProvider } = await import('./services/messaging/TelegramProvider');
  const { DiscordProvider } = await import('./services/messaging/DiscordProvider');
  const { WhatsAppProvider } = await import('./services/messaging/WhatsAppProvider');
  const { SlackProvider } = await import('./services/messaging/SlackProvider');
  const { SignalProvider } = await import('./services/messaging/SignalProvider');
  messagingGateway.registerProvider(new TelegramProvider());
  messagingGateway.registerProvider(new DiscordProvider());
  messagingGateway.registerProvider(new WhatsAppProvider());
  messagingGateway.registerProvider(new SlackProvider());
  messagingGateway.registerProvider(new SignalProvider());

  // Wire messaging gateway to AI orchestrator — incoming messages get processed
  messagingGateway.setMessageHandler(async (msg) => {
    console.log(`[App] Messaging → AI: ${msg.provider}/${msg.username}: "${msg.text.substring(0, 80)}"`);
    const { agentOrchestrator } = await import('./services/AgentOrchestrator');
    const conversationId = `${msg.provider}-${msg.chatId}`;

    // Resolve @mention so agent profile (system prompt, tool whitelist, iteration cap) is applied.
    // Done here — not inside chat() — to avoid reassigning const-bound parameters in compiled output.
    let chatText = msg.text;
    let agentOverride: string | undefined;
    let profileOptions: { maxIterations?: number; toolWhitelist?: string[]; agentType?: string; agentSlug?: string } | undefined;
    const mention = await agentOrchestrator.resolveMention(msg.text).catch(() => null);
    if (mention && !mention.forceGoalMode) {
      chatText = mention.effectiveMessage;
      agentOverride = mention.namedAgentSystemPrompt;
      profileOptions = {
        maxIterations: mention.maxIterations,
        toolWhitelist: mention.toolWhitelist,
        agentType: mention.agentType,
        agentSlug: mention.namedAgentSlug,
      };
    }

    const result = await agentOrchestrator.chat(msg.userId, chatText, conversationId, 'chat', undefined, agentOverride, profileOptions);

    // Emit after chat() completes so DB is fully written before the web UI reloads.
    gateway.io.emit('conversation:updated', {
      conversationId,
      provider: msg.provider,
      username: msg.username,
      preview: result.response.substring(0, 120),
      agentSlug: profileOptions?.agentSlug,
    });

    // Send any files created by a goal execution back to the messaging provider.
    const files = (result as any).generatedFiles as string[] | undefined;
    if (files?.length) {
      for (const filePath of files) {
        await messagingGateway.sendFile(msg.provider, msg.chatId, filePath,
          `📎 ${filePath.split('/').pop()}`
        ).catch(e => console.warn(`[App] Failed to send file ${filePath} to ${msg.provider}: ${e.message}`));
      }
    }

    return result.response;
  });

  // Forward messaging events to Socket.IO for unified inbox (Phase 15D.3)
  // NOTE: message:received fires BEFORE chat() runs — used only for the
  // activity feed / unified inbox, NOT for conversation list reload (timing issue).
  messagingGateway.on('message:received', (msg) => {
    gateway.io.emit('message:received', {
      id: msg.id, provider: msg.provider, chatId: msg.chatId,
      userId: msg.userId, username: msg.username, text: msg.text,
      timestamp: msg.timestamp,
    });
  });

  // Initialize workspace if not already done
  if (!configManager.isWorkspaceInitialized()) {
    console.log('[App] Initializing workspace with templates...');
    await configManager.initializeWorkspace();
  }

  const config = configManager.getConfig();
  appLogger.info({ workspace: config.workspace_dir }, 'Workspace path');
  appLogger.info({ dataDir: configManager.getAppDataDir() }, 'App data dir');

  // Restore saved search provider configuration (preferred_provider + keys)
  const { searchProviderManager } = await import('./search');
  await searchProviderManager.initialize();
  const searchCfg = (config as any).search || {};
  if (searchCfg.searxng_endpoint) {
    searchProviderManager.configureProvider('searxng', { endpoint: searchCfg.searxng_endpoint });
  }
  if (searchCfg.brave_api_key) {
    searchProviderManager.configureProvider('brave', { apiKey: searchCfg.brave_api_key, enabled: true });
  }
  if (searchCfg.preferred_provider && searchCfg.preferred_provider !== 'auto') {
    const p = searchCfg.preferred_provider as string;
    const bump: Record<string, number> = { searxng: 10, serpapi: 10, brave: 10, duckduckgo: 10 };
    bump[p] = 1;
    for (const [name, pri] of Object.entries(bump)) searchProviderManager.configureProvider(name, { priority: pri });
    appLogger.info({ preferred: p }, 'Search provider preference restored');
  }

  // Load agents from AGENTS.md
  const configLoader = new MarkdownConfigLoader(config.workspace_dir);
  const agents = configLoader.loadAgents();
  appLogger.info({ count: agents.length }, 'Loaded agents from AGENTS.md');

  // Start Heartbeat
  heartbeatService.start();

  // Sync skills from workspace
  await skillManager.syncSkills();

  // Initialize SkillLearner DB table + run decay on startup
  const { skillLearner } = await import('./services/SkillLearner');
  await skillLearner.ensureTable();
  skillLearner.decayUnusedSkills().catch(e => console.warn('[App] Skill decay error:', e));
  // Seed pre-built skills from server/skills/ directory (community-style)
  const skillsDir = path.join(__dirname, '../skills');
  skillLearner.seedFromDirectory(skillsDir).catch(e => console.warn('[App] Skill seeding error:', e));
  appLogger.info('SkillLearner table initialized');

  // Initialize scheduler (Phase 14A)
  const { scheduler } = await import('./services/Scheduler');
  await scheduler.initialize();
  scheduler.setSocketIO(gateway.io);

  // Initialize webhook manager (Phase 14B)
  const { webhookManager } = await import('./services/WebhookManager');
  await webhookManager.initialize();

  // Initialize email + calendar trigger services (Session 7)
  const { emailTriggerService } = await import('./services/EmailTriggerService');
  await emailTriggerService.initialize();

  const { calendarTriggerService } = await import('./services/CalendarTriggerService');
  await calendarTriggerService.initialize();

  // Initialize memory consolidator (Phase 17)
  const { memoryConsolidator } = await import('./memory/MemoryConsolidator');
  await memoryConsolidator.initialize();

  // Schedule memory consolidation (Phase 17.4)
  // Daily at 2:00 AM, Weekly on Sundays at 3:00 AM
  const cron = await import('node-cron');
  cron.schedule('0 2 * * *', async () => {
    console.log('[App] Running daily memory consolidation...');
    try {
      await memoryConsolidator.consolidateDaily();
      await memoryConsolidator.archiveOldEvents('default', 7);
    } catch (e) { console.error('[App] Daily consolidation error:', e); }
  });
  cron.schedule('0 3 * * 0', async () => {
    console.log('[App] Running weekly memory consolidation...');
    try {
      await memoryConsolidator.consolidateWeekly();
    } catch (e) { console.error('[App] Weekly consolidation error:', e); }
  });

  // Initialize embedding manager from config (Phase 16)
  const { embeddingManager } = await import('./memory/EmbeddingManager');
  const embeddingConfig = config.embedding || {} as any;
  // Always configure so the Ollama → TF-IDF fallback chain is properly set up
  embeddingManager.configure({
    preferred: embeddingConfig.preferred_provider === 'auto' ? undefined : embeddingConfig.preferred_provider,
    ollama_model: embeddingConfig.ollama_model || 'nomic-embed-text',
    openai_api_key: embeddingConfig.openai_api_key,
    openai_model: embeddingConfig.openai_model,
    openai_base_url: embeddingConfig.openai_base_url,
    cohere_api_key: embeddingConfig.cohere_api_key,
    cohere_model: embeddingConfig.cohere_model,
  });
  await embeddingManager.initialize();
  await memoryManager.initializeVector();

  // Docker health check (Phase 13B)
  const { containerSessionManager } = await import('./execution/ContainerSession');
  const dockerAvailable = await containerSessionManager.isDockerAvailable();
  if (dockerAvailable) {
    appLogger.info('Docker available');
  } else {
    const requireDocker = configManager.getConfig().execution?.require_docker;
    if (requireDocker) {
      appLogger.warn('Docker is NOT available but is required for goal execution. Install Docker Desktop or set execution.require_docker=false in config.');
    } else {
      appLogger.warn('Docker not available — goal execution will use unsandboxed ShellServer');
    }
  }

  // Apply saved local provider URLs BEFORE modelManager.initialize() connects adapters.
  // User-saved config (from Settings UI) wins unless an explicit non-default env var is set.
  // In Docker, OLLAMA_HOST is always set to the docker-compose default — we let the saved
  // config override that default so user settings persist across rebuilds.
  {
    const lp = (config as any).localProviders || {};
    const DOCKER_OLLAMA_DEFAULT = 'http://host.docker.internal:11434';
    const DOCKER_LMSTUDIO_DEFAULT = 'http://host.docker.internal:1234';
    if (lp.ollama?.host && (
      !process.env.OLLAMA_HOST ||
      process.env.OLLAMA_HOST === DOCKER_OLLAMA_DEFAULT ||
      process.env.OLLAMA_HOST === 'http://localhost:11434'
    )) {
      process.env.OLLAMA_HOST = lp.ollama.host;
      appLogger.info({ host: lp.ollama.host }, 'Restored Ollama host from config');
    }
    if (lp.lmstudio?.baseUrl && (
      !process.env.LMSTUDIO_BASE_URL ||
      process.env.LMSTUDIO_BASE_URL === DOCKER_LMSTUDIO_DEFAULT ||
      process.env.LMSTUDIO_BASE_URL === 'http://localhost:1234'
    )) {
      process.env.LMSTUDIO_BASE_URL = lp.lmstudio.baseUrl;
      appLogger.info({ baseUrl: lp.lmstudio.baseUrl }, 'Restored LM Studio URL from config');
    }
    // Also update adapters (which were created in ModelManager constructor before env was set)
    await modelManager.updateLocalProvider('ollama', process.env.OLLAMA_HOST || 'http://localhost:11434');
    if (process.env.LMSTUDIO_BASE_URL) {
      await modelManager.updateLocalProvider('lmstudio', process.env.LMSTUDIO_BASE_URL);
    }
  }

  // Initialize MCP & LLM
  await mcpManager.initialize().catch(console.error);
  await modelManager.initialize().catch(console.error);

  // Initialize chat adapters from saved configs
  await initializeChatAdapters().catch(console.error);

  // Auto-configure messaging from environment variables (Docker convenience)
  // IMPORTANT: skip any platform already connected by initializeChatAdapters() above —
  // creating two bot instances with the same token causes a Telegram 409 Conflict which
  // kills polling and crashes the process.
  if (process.env.DISCORD_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.SLACK_BOT_TOKEN) {
    const { messagingGateway } = await import('./services/MessagingGateway');
    const { chatRouter } = await import('./adapters/ChatAdapters');
    const alreadyConnected = new Set(
      chatRouter.getStatus().filter(s => s.connected).map(s => s.platform)
    );

    if (process.env.DISCORD_BOT_TOKEN && !alreadyConnected.has('discord')) {
      appLogger.info('Auto-configuring Discord from env...');
      await messagingGateway.connectProvider('discord', { token: process.env.DISCORD_BOT_TOKEN, enabled: true }).catch(e =>
        appLogger.warn({ err: e.message }, 'Discord env auto-config failed'));
    }
    if (process.env.TELEGRAM_BOT_TOKEN && !alreadyConnected.has('telegram')) {
      appLogger.info('Auto-configuring Telegram from env...');
      await messagingGateway.connectProvider('telegram', { token: process.env.TELEGRAM_BOT_TOKEN, enabled: true }).catch(e =>
        appLogger.warn({ err: e.message }, 'Telegram env auto-config failed'));
    }
    if (process.env.SLACK_BOT_TOKEN) {
      appLogger.info('Auto-configuring Slack from env...');
      await messagingGateway.connectProvider('slack', {
        token: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true
      }).catch(e => appLogger.warn({ err: e.message }, 'Slack env auto-config failed'));
    }
  }

  // WhatsApp env auto-config (uses Baileys QR-auth on first run)
  if (process.env.WHATSAPP_ENABLED === 'true') {
    appLogger.info('Auto-configuring WhatsApp from env...');
    const { messagingGateway: waGateway } = await import('./services/MessagingGateway');
    await waGateway.connectProvider('whatsapp', {
      enabled: true,
      authDir: process.env.WHATSAPP_AUTH_DIR || '/data/.whatsapp-auth',
    }).catch(e => appLogger.warn({ err: e.message }, 'WhatsApp env auto-config failed'));
  }
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser() as any);
app.use(requestIdMiddleware);

// Rate limiting — 500 requests per minute per IP (self-hosted, local use)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', apiLimiter as any);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many auth attempts, please try again later.' },
});
app.use('/api/auth/login', authLimiter as any);
app.use('/api/auth/register', authLimiter as any);

// Auth middleware (disabled by default — set AI_PARTNER_AUTH_ENABLED=true to enable)
import { authMiddleware } from './middleware/auth';
app.use(authMiddleware as any);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'mindful-assistant',
    heartbeat: heartbeatService.getStatus(),
    gateway: gateway.getStatus(),
    workspace: configManager.getWorkspaceDir()
  });
});

// Config endpoints
app.get('/api/config', (req, res) => {
  res.json(configManager.getConfig());
});

app.post('/api/config', async (req, res) => {
  try {
    const updated = await configManager.updateConfig(req.body);
    res.json({ success: true, config: updated });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// System browse endpoint for folder picker
app.get('/api/system/browse', async (req, res) => {
  try {
    // On Windows, use PowerShell to open folder dialog
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // PowerShell script - needs -sta for GUI dialogs
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select workspace folder'
$dialog.ShowNewFolderButton = $true
$null = $dialog.ShowDialog()
$dialog.SelectedPath
`;

    const { stdout } = await execAsync(
      `powershell -sta -NoProfile -Command "${psScript.replace(/\r?\n/g, '; ').replace(/"/g, '\`"')}"`,
      { timeout: 120000 }
    );
    const selectedPath = stdout.trim();

    if (selectedPath) {
      res.json({ path: selectedPath });
    } else {
      res.json({ path: null, message: 'No folder selected' });
    }
  } catch (e) {
    console.error('[System] Browse dialog error:', e);
    // Fallback: return current workspace
    res.json({
      path: configManager.getWorkspaceDir(),
      message: 'Folder dialog unavailable, returning current workspace'
    });
  }
});

app.use('/api/heartbeat', createHeartbeatRouter(heartbeatService));
app.use('/api/capabilities', capabilitiesRoutes);
app.use('/api/setup', setupRoutes);

// Conversation routes
app.get('/api/conversations', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 20');
    res.json({ conversations: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get messages for a specific conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await db.all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
      [id]
    );
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Delete a conversation
app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM messages WHERE conversation_id = ?', [id]);
    await db.run('DELETE FROM conversations WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Memory API ---

// Persona
app.get('/api/memory/persona', async (req, res) => {
  try {
    const persona = await memoryManager.getPersona('default');
    res.json(persona);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/memory/persona', async (req, res) => {
  try {
    await memoryManager.updatePersona('default', req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Events
app.get('/api/memory/events', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const events = await memoryManager.getRecentEvents(limit);
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/memory/events', async (req, res) => {
  try {
    const id = await memoryManager.storeEvent(req.body);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/memory/events/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM episodic_memory WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/memory/events', async (req, res) => {
  try {
    await db.run("DELETE FROM episodic_memory WHERE user_id = 'default'");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Semantic Search
app.get('/api/memory/search', async (req, res) => {
  try {
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });
    const results = await memoryManager.hybridSearch(
      q as string,
      'default',
      limit ? parseInt(limit as string) : 5
    );
    res.json({ results, vectorEnabled: memoryManager.isVectorEnabled() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Facts
app.get('/api/memory/facts', async (req, res) => {
  try {
    const { subject, predicate } = req.query;
    const facts = await memoryManager.queryFacts('default', subject as string, predicate as string);
    res.json({ facts });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/memory/facts', async (req, res) => {
  try {
    const id = await memoryManager.storeFact({ ...req.body, user_id: 'default' });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/memory/facts/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM biographic_facts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Workspace Management
app.get('/api/workspace', (req, res) => {
  res.json({
    path: configManager.getWorkspaceDir(),
    initialized: configManager.isWorkspaceInitialized()
  });
});

app.post('/api/workspace', async (req, res) => {
  try {
    const { path: workspacePath } = req.body;
    if (!workspacePath) return res.status(400).json({ error: 'Path is required' });

    // Initialize workspace at the specified path
    const success = await configManager.initializeWorkspace(workspacePath);
    if (success) {
      // Update MCP filesystem server to target new workspace
      await mcpManager.setWorkspace(workspacePath);
      console.log(`[Workspace] Updated to: ${workspacePath}`);
      res.json({ success: true, path: workspacePath });
    } else {
      res.status(500).json({ error: 'Failed to initialize workspace' });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Workspace config files (read-only view)
app.get('/api/workspace/agents', (req, res) => {
  try {
    const configLoader = new MarkdownConfigLoader(configManager.getWorkspaceDir());
    const agents = configLoader.loadAgents();
    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/workspace/soul', (req, res) => {
  try {
    const configLoader = new MarkdownConfigLoader(configManager.getWorkspaceDir());
    const soul = configLoader.loadSoul();
    res.json({ content: soul });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/workspace/checklist', (req, res) => {
  try {
    const configLoader = new MarkdownConfigLoader(configManager.getWorkspaceDir());
    const checklist = configLoader.loadHeartbeatChecklist();
    res.json({ checklist });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.use('/api/tasks', tasksRouter);
app.use('/api/mcp', mcpRouter);
app.use('/api/models', modelsRouter);
// NOTE: /api/skills/learned must be registered BEFORE /api/skills — otherwise Express
// matches 'learned' as a :id param in skillsRouter and returns 404 "Skill not found".
import { learnedSkillsRoutes } from './routes/learnedSkillsRoutes';
app.use('/api/skills/learned', learnedSkillsRoutes);
app.use('/api/skills', skillsRouter);
app.use('/api/autonomous', autonomousRoutes);
app.use('/api/chat/adapters', chatRoutes);
import { streamRoutes } from './routes/streamRoutes';
app.use('/api/chat', streamRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/autonomous/goal', goalRoutes);
app.use('/api/knowledge', knowledgeRoutes);

// Phase 3: Tool Marketplace
import { toolMarketplaceRoutes } from './routes/toolMarketplaceRoutes';
app.use('/api/tools/marketplace', toolMarketplaceRoutes);

// External MCP server management
import { externalMCPRoutes } from './routes/externalMCPRoutes';
app.use('/api/mcp/external', externalMCPRoutes);

// Phase 5: Messaging
import { messagingRoutes } from './routes/messagingRoutes';
app.use('/api/messaging', messagingRoutes);

// Phase 8: Usage Tracking
import { usageRoutes } from './routes/usageRoutes';
app.use('/api/usage', usageRoutes);

// Phase 6: Learned Skills — route moved above /api/skills to avoid :id collision (see line ~620)

// Phase 12: Search Provider Management
import { searchRoutes } from './routes/searchRoutes';
app.use('/api/search', searchRoutes);

// Phase 11: Container Execution Management
import { containerRoutes } from './routes/containerRoutes';
app.use('/api/containers', containerRoutes);

// Phase 13A: Authentication
import { authRoutes } from './routes/authRoutes';
app.use('/api/auth', authRoutes);

// Phase 13B: Secret Management
import { secretRoutes } from './routes/secretRoutes';
app.use('/api/secrets', secretRoutes);

// Phase 13D: Audit Logging
import { auditRoutes } from './routes/auditRoutes';
app.use('/api/audit', auditRoutes);

// Phase 14A: Scheduler
import { schedulerRoutes } from './routes/schedulerRoutes';
app.use('/api/scheduler', schedulerRoutes);

// Benchmark regression log
import benchmarkRoutes from './routes/benchmarkRoutes';
app.use('/api/benchmark', benchmarkRoutes);

// Phase 14B: Webhooks
import { webhookRoutes } from './routes/webhookRoutes';
app.use('/api/webhooks', webhookRoutes);

// Session 7: Email + Calendar automation triggers
import triggerRoutes from './routes/triggerRoutes';
app.use('/api/triggers', triggerRoutes);

// Session 8: Integrations status API
import { integrationRoutes } from './routes/integrationRoutes';
app.use('/api/integrations', integrationRoutes);

// Session 8: Workspace file operations (download, delete, rename, copy, mkdir, recursive list)
import workspaceFileRoutes from './routes/workspaceRoutes';
app.use('/api/workspace', workspaceFileRoutes);

// Phase 7: Voice & Speech
import { voiceRoutes } from './routes/voiceRoutes';
app.use('/api/voice', voiceRoutes);

// Phase 17: Memory Consolidation
import { memoryConsolidationRoutes } from './routes/memoryRoutes';
app.use('/api/memory', memoryConsolidationRoutes);

// Agent Profiles (Personalities)
import { agentProfileRoutes } from './routes/agentProfileRoutes';
app.use('/api/agent-profiles', agentProfileRoutes);

// Agent pool monitoring (Phase 2: enhanced)
app.get('/api/agents', (req, res) => {
  res.json({
    active: agentPool.getActiveCount(),
    totalSpawned: agentPool.getTotalSpawned(),
    tasks: agentPool.getTasks(),
    taskTree: agentPool.getTaskTree(),
    busMessages: agentBus.getAllMessages().length,
    registeredAgents: agentBus.getAgentCount()
  });
});

// Agent budget configuration
app.post('/api/agents/budget', (req, res) => {
  const { maxDepth, maxConcurrent, totalAgentLimit, timeoutMs } = req.body;
  agentPool.setBudget({ maxDepth, maxConcurrent, totalAgentLimit, timeoutMs });
  res.json({ success: true, message: 'Budget updated' });
});

// Cancel a specific running agent task
app.post('/api/agents/:id/cancel', (req, res) => {
  try {
    agentPool.abort(req.params.id);
    res.json({ success: true, message: `Abort signal sent to agent ${req.params.id}` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Agent bus messages (for monitoring inter-agent communication)
app.get('/api/agents/messages', (req, res) => {
  res.json({ messages: agentBus.getAllMessages() });
});

// Chat endpoint - supports explicit mode selection
// mode: 'auto' (default) | 'chat' | 'goal'
app.post('/api/chat', async (req, res) => {
  try {
    const { message, userId, conversationId, mode, workspaceScope } = req.body;

    // Explicit mode selection
    if (mode === 'goal') {
      // Scope workspace before goal execution if specified
      if (workspaceScope) {
        await mcpManager.setWorkspace(workspaceScope);
      }

      // Direct goal-oriented execution
      const result = await goalOrientedExecutor.executeGoal(
        message,
        userId || 'default',
        { enable_hitl: true }
      );
      return res.json({
        response: formatGoalResult(result),
        executionMode: 'goal',
        executionId: result.execution_id,
        artifacts: result.summary.artifacts_created,
        status: result.status === 'completed' ? 'completed' : 'failed',
        progress: result.summary.progress_percent
      });
    }

    if (mode === 'chat') {
      // Simple OODA loop only
      const response = await agentOrchestrator.chat(userId || 'default', message, conversationId);
      return res.json({ ...response, executionMode: 'chat' });
    }

    // Auto mode — classify by message complexity and route directly
    const wordCount = message.trim().split(/\s+/).length;
    const taskKeywords = /\b(create|build|make|generate|implement|develop|write|add|update|modify|fix|refactor|delete|remove|deploy|run|execute|analyse|analyze|research|find|search|fetch|download|install|setup|configure)\b/i;
    const isComplexTask = wordCount > 15 || taskKeywords.test(message);

    if (isComplexTask) {
      if (workspaceScope) await mcpManager.setWorkspace(workspaceScope);
      const result = await goalOrientedExecutor.executeGoal(
        message,
        userId || 'default',
        { enable_hitl: true }
      );
      return res.json({
        response: formatGoalResult(result),
        executionMode: 'goal',
        executionId: result.execution_id,
        artifacts: result.summary.artifacts_created,
        status: result.status === 'completed' ? 'completed' : 'failed',
        progress: result.summary.progress_percent
      });
    }

    // Simple message — use lightweight OODA chat loop
    const response = await agentOrchestrator.chat(userId || 'default', message, conversationId);
    res.json({ ...response, executionMode: 'chat' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Helper to format goal results
function formatGoalResult(result: any): string {
  const status = result.status === 'completed' ? 'Completed' : 'Failed';
  let response = `**${status}**\n\n`;
  response += `**Goal:** ${result.goal.description}\n\n`;

  if (result.summary.artifacts_created.length > 0) {
    response += `**Files created:**\n`;
    for (const artifact of result.summary.artifacts_created) {
      response += `- ${artifact}\n`;
    }
  }

  response += `\n**Progress:** ${result.summary.progress_percent}%`;
  response += `\n**Iterations:** ${result.summary.total_iterations}`;

  if (result.failure_reason) {
    response += `\n\n**Failure:** ${result.failure_reason}`;
  }

  return response;
}

// In production (Docker), serve the built React client as static files
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback: any non-API/socket route serves index.html
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
        res.sendFile(path.join(clientDist, 'index.html'));
      }
    });
    console.log('[App] Serving static client from', clientDist);
  }
}

// Start server
const PORT = parseInt(process.env.APP_PORT || '3000', 10);

initializeApp().then(() => {
  server.listen(PORT, () => {
    appLogger.info({ port: PORT }, `Server running on http://localhost:${PORT}`);
    appLogger.info('Gateway, heartbeat, and database services running');
  });
}).catch(err => {
  console.error('[App] Failed to initialize:', err);
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Handles SIGTERM (docker compose down) and SIGINT (Ctrl-C).
// Stops accepting requests, waits for in-flight work, then exits cleanly.
const shutdown = async (signal: string) => {
  appLogger.info({ signal }, 'Shutting down gracefully...');

  // Stop accepting new HTTP connections; existing ones finish normally
  server.close(async () => {
    try {
      // Stop all sandbox Docker containers
      const { containerSessionManager } = await import('./execution/ContainerSession');
      await containerSessionManager.stopAll().catch(() => {});
    } catch { /* non-fatal if Docker was never used */ }

    appLogger.info('Shutdown complete');
    process.exit(0);
  });

  // Hard kill after 30 s — prevents hung deployments
  setTimeout(() => {
    appLogger.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000).unref();
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT',  () => shutdown('SIGINT'));

// Catch unhandled promise rejections — prevents crashes from transient external errors
// (e.g. Telegram 409 Conflict when polling restarts, network blips, etc.)
process.on('unhandledRejection', (reason: any) => {
  appLogger.error({ err: reason?.message ?? String(reason) }, 'Unhandled promise rejection — process kept alive');
});
process.on('uncaughtException', (err: Error) => {
  appLogger.error({ err: err.message, stack: err.stack }, 'Uncaught exception — process kept alive');
});

// Export gateway for use in other services
export { gateway };
