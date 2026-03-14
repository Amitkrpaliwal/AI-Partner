import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { configManager } from '../services/ConfigManager';
import { shellServer } from './servers/ShellServer';
import { browserServer } from './servers/BrowserServer';
import { webSearchServer } from './servers/WebSearchServer';
import { gitHubServer } from './servers/GitHubServer';
import { notionServer } from './servers/NotionServer';
import { imageGenServer } from './servers/ImageGenServer';
import { gmailServer } from './servers/GmailServer';
import { googleCalendarServer } from './servers/GoogleCalendarServer';
import { twitterServer } from './servers/TwitterServer';
import { trelloServer } from './servers/TrelloServer';
import { googleDriveServer } from './servers/GoogleDriveServer';
import { spotifyServer } from './servers/SpotifyServer';
import { messagingServer } from './servers/MessagingServer';
import { apifyServer } from './servers/ApifyServer';
import { scheduleServer } from './servers/ScheduleServer';
import { agentConfigServer } from './servers/AgentConfigServer';
import { knowledgeBaseServer } from './servers/KnowledgeBaseServer';
import { agentPool } from '../agents/AgentPool';
import { validateToolArgs } from './toolSchemas';
import { withRetry, isTransientError } from '../utils/retry';
import { dynamicToolRegistry } from './DynamicToolRegistry';
import { containerSessionManager } from '../execution/ContainerSession';
import { auditLogger } from '../services/AuditLogger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MCPServerConfig {
    command: string;
    args: string[];
    env?: Record<string, string>;
}

interface MCPServersConfig {
    mcpServers: Record<string, MCPServerConfig>;
}

export interface ExternalMCPServerConfig {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    description?: string;
    addedAt: string;
}

export class MCPManager {
    private clients: Map<string, Client> = new Map();
    private configPath: string;
    private currentWorkspace: string = '';
    private externalServers: Map<string, ExternalMCPServerConfig> = new Map();
    private externalConfigPath: string;

    constructor() {
        this.configPath = path.join(__dirname, 'configs', 'mcp-servers.json');
        this.externalConfigPath = path.join(__dirname, 'configs', 'external-mcp-servers.json');
    }

    async initialize() {
        console.log('[MCPManager] Initializing...');
        this.currentWorkspace = configManager.getWorkspaceDir();
        // Set ShellServer workspace so commands execute in the correct directory
        shellServer.setWorkspace(this.currentWorkspace);
        await this.loadConfig();
        await this.loadExternalServers();
    }

    /**
     * Update workspace and reconnect filesystem server
     */
    async setWorkspace(workspacePath: string): Promise<void> {
        if (this.currentWorkspace === workspacePath) {
            return; // No change
        }

        console.log(`[MCPManager] Updating workspace to: ${workspacePath}`);
        this.currentWorkspace = workspacePath;

        // Update shell server workspace for sandboxing
        shellServer.setWorkspace(workspacePath);

        // Disconnect existing filesystem client
        const existingClient = this.clients.get('filesystem');
        if (existingClient) {
            try {
                await existingClient.close();
            } catch (e) {
                // Ignore close errors
            }
            this.clients.delete('filesystem');
        }

        // Reconnect with new workspace
        await this.connectFilesystemServer(workspacePath);
    }

    private async loadConfig() {
        try {
            if (!fs.existsSync(this.configPath)) {
                console.warn(`[MCPManager] Config not found at ${this.configPath}`);
                // Still try to connect filesystem with workspace dir
                await this.connectFilesystemServer(this.currentWorkspace);
                return;
            }
            const raw = fs.readFileSync(this.configPath, 'utf-8');
            const config: MCPServersConfig = JSON.parse(raw);

            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                // For filesystem server, override the path with workspace dir
                if (name === 'filesystem') {
                    await this.connectFilesystemServer(this.currentWorkspace);
                } else {
                    await this.connectToServer(name, serverConfig);
                }
            }
        } catch (e) {
            console.error('[MCPManager] Failed to load config:', e);
            // Fallback: try to connect filesystem with workspace
            await this.connectFilesystemServer(this.currentWorkspace);
        }
    }

    /**
     * Connect filesystem MCP server with the specified workspace path
     */
    private async connectFilesystemServer(workspacePath: string): Promise<void> {
        const effectivePath = workspacePath || process.cwd();
        console.log(`[MCPManager] Connecting filesystem server to: ${effectivePath}`);

        const isWindows = process.platform === 'win32';
        // Use npx without -y: if the package is pre-installed in node_modules (Docker image),
        // it will be found immediately without any network download.
        const config: MCPServerConfig = isWindows ? {
            command: 'cmd.exe',
            args: ['/c', 'npx', '@modelcontextprotocol/server-filesystem', effectivePath],
            env: {}
        } : {
            command: 'npx',
            args: ['--yes', '@modelcontextprotocol/server-filesystem', effectivePath],
            env: {}
        };

        await this.connectToServer('filesystem', config);
    }

    private async connectToServer(name: string, config: MCPServerConfig) {
        try {
            console.log(`[MCPManager] Connecting to ${name}...`);
            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: { ...process.env, ...config.env } as Record<string, string>
            });

            const client = new Client({
                name: "ai-coworker-client",
                version: "1.0.0",
            }, {
                capabilities: {}
            });

            await client.connect(transport);
            this.clients.set(name, client);
            console.log(`[MCPManager] Connected to ${name}`);
        } catch (e) {
            console.error(`[MCPManager] Failed to connect to ${name}:`, e);
        }
    }

    /**
     * Get current workspace path used by filesystem server
     */
    getWorkspace(): string {
        return this.currentWorkspace;
    }

    async getServers() {
        const servers = Array.from(this.clients.keys()).map(name => ({
            name,
            status: 'connected',
            workspace: name === 'filesystem' ? this.currentWorkspace : undefined
        }));

        // Add shell server to servers list
        servers.push({
            name: 'shell',
            status: 'connected',
            workspace: this.currentWorkspace
        });

        // Add browser server to servers list
        servers.push({
            name: 'browser',
            status: browserServer.isReady() ? 'connected' : 'available',
            workspace: undefined
        });

        // Add web search server to servers list
        servers.push({
            name: 'websearch',
            status: 'connected',
            workspace: undefined
        });

        // Add container execution server
        const dockerAvailable = await containerSessionManager.isDockerAvailable();
        servers.push({
            name: 'container',
            status: dockerAvailable ? 'connected' : 'unavailable',
            workspace: undefined
        });

        // Productivity integrations — shown only when keys are configured
        const integrations = [
            { name: 'github', server: gitHubServer, label: 'GitHub' },
            { name: 'notion', server: notionServer, label: 'Notion' },
            { name: 'imagegen', server: imageGenServer, label: 'Image Generation' },
            { name: 'gmail', server: gmailServer, label: 'Gmail' },
            { name: 'calendar', server: googleCalendarServer, label: 'Google Calendar' },
            { name: 'twitter', server: twitterServer, label: 'Twitter/X' },
            { name: 'trello', server: trelloServer, label: 'Trello' },
            { name: 'drive', server: googleDriveServer, label: 'Google Drive' },
            { name: 'spotify', server: spotifyServer, label: 'Spotify' },
            { name: 'apify', server: apifyServer, label: 'Apify' },
        ];
        for (const { name, server, label } of integrations) {
            servers.push({
                name,
                status: server.isAvailable() ? 'connected' : 'unavailable (add API key to .env)',
                workspace: undefined
            });
        }

        return servers;
    }

    async listTools() {
        const allTools: { server: string; tool: Tool }[] = [];

        // List tools from MCP clients (filesystem, etc.)
        for (const [name, client] of this.clients.entries()) {
            try {
                const result = await client.listTools();
                result.tools.forEach(tool => {
                    allTools.push({ server: name, tool });
                });
            } catch (e) {
                console.error(`[MCPManager] Error listing tools for ${name}:`, e);
            }
        }

        // Add shell server tools
        const shellTools = shellServer.getTools();
        shellTools.forEach(tool => {
            allTools.push({
                server: 'shell',
                tool: tool as Tool
            });
        });

        // Add browser server tools
        const browserTools = browserServer.getTools();
        browserTools.forEach(tool => {
            allTools.push({
                server: 'browser',
                tool: tool as Tool
            });
        });

        // Add web search server tools
        const searchTools = webSearchServer.getTools();
        searchTools.forEach(tool => {
            allTools.push({
                server: 'websearch',
                tool: tool as Tool
            });
        });

        // Add GitHub tools (when GITHUB_TOKEN is set)
        if (gitHubServer.isAvailable()) {
            gitHubServer.getTools().forEach(tool => {
                allTools.push({ server: 'github', tool: tool as Tool });
            });
        }

        // Add Notion tools (when NOTION_API_KEY is set)
        if (notionServer.isAvailable()) {
            notionServer.getTools().forEach(tool => {
                allTools.push({ server: 'notion', tool: tool as Tool });
            });
        }

        // Add image generation tool (when OPENAI_API_KEY or STABILITY_API_KEY is set)
        if (imageGenServer.isAvailable()) {
            imageGenServer.getTools().forEach(tool => {
                allTools.push({ server: 'imagegen', tool: tool as Tool });
            });
        }

        // Add Gmail tools (when GMAIL_USER + GMAIL_APP_PASSWORD are set)
        if (gmailServer.isAvailable()) {
            gmailServer.getTools().forEach(tool => {
                allTools.push({ server: 'gmail', tool: tool as Tool });
            });
        }

        // Add Google Calendar tools (when GOOGLE_CALENDAR_ACCESS_TOKEN is set)
        if (googleCalendarServer.isAvailable()) {
            googleCalendarServer.getTools().forEach(tool => {
                allTools.push({ server: 'calendar', tool: tool as Tool });
            });
        }

        // Add Twitter/X tools (when TWITTER_BEARER_TOKEN is set)
        if (twitterServer.isAvailable()) {
            twitterServer.getTools().forEach(tool => {
                allTools.push({ server: 'twitter', tool: tool as Tool });
            });
        }

        // Add Trello tools (when TRELLO_API_KEY + TRELLO_TOKEN are set)
        if (trelloServer.isAvailable()) {
            trelloServer.getTools().forEach(tool => {
                allTools.push({ server: 'trello', tool: tool as Tool });
            });
        }

        // Add Google Drive tools (when GOOGLE_DRIVE_ACCESS_TOKEN is set)
        if (googleDriveServer.isAvailable()) {
            googleDriveServer.getTools().forEach(tool => {
                allTools.push({ server: 'drive', tool: tool as Tool });
            });
        }

        // Add Spotify tools (when SPOTIFY_ACCESS_TOKEN is set)
        if (spotifyServer.isAvailable()) {
            spotifyServer.getTools().forEach(tool => {
                allTools.push({ server: 'spotify', tool: tool as Tool });
            });
        }

        // Add Apify tools (when APIFY_API_TOKEN is set)
        if (apifyServer.isAvailable()) {
            apifyServer.getTools().forEach(tool => {
                allTools.push({ server: 'apify', tool: tool as Tool });
            });
        }

        // Add Messaging tools — always available; tools report status gracefully when not connected
        messagingServer.getTools().forEach(tool => {
            allTools.push({ server: 'messaging', tool: tool as Tool });
        });

        // Add schedule_task tool — always available (no API key needed)
        scheduleServer.getTools().forEach(tool => {
            allTools.push({ server: 'scheduler', tool: tool as Tool });
        });

        // Add update_agent_config tool — always available
        agentConfigServer.getTools().forEach(tool => {
            allTools.push({ server: 'agentconfig', tool: tool as Tool });
        });

        // Add knowledge base tools — always available
        knowledgeBaseServer.getTools().forEach(tool => {
            allTools.push({ server: 'knowledgebase', tool: tool as Tool });
        });

        // Add container execution tools (Phase 11B)
        allTools.push({
            server: 'container',
            tool: {
                name: 'exec_in_container',
                description: 'Alternative to run_command: execute in persistent Docker container with explicit sessionId control. State (env vars, installed packages) persists. Prefer run_command for most tasks — use exec_in_container only when you need a separate named session.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        command: { type: 'string', description: 'Shell command to execute inside the container' },
                        sessionId: { type: 'string', description: 'Session ID (default: "default"). Different sessions get separate containers.' },
                        timeout: { type: 'number', description: 'Timeout in ms (default: 60000)' },
                        cwd: { type: 'string', description: 'Working directory inside container (default: /workspace)' }
                    },
                    required: ['command']
                }
            } as Tool
        });

        allTools.push({
            server: 'container',
            tool: {
                name: 'container_write_file',
                description: 'Write a file inside the Docker container. Creates parent directories if needed.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        path: { type: 'string', description: 'File path inside container (e.g., /workspace/app.py)' },
                        content: { type: 'string', description: 'File content to write' },
                        sessionId: { type: 'string', description: 'Session ID (default: "default")' }
                    },
                    required: ['path', 'content']
                }
            } as Tool
        });

        allTools.push({
            server: 'container',
            tool: {
                name: 'container_read_file',
                description: 'Read a file from the Docker container.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        path: { type: 'string', description: 'File path inside container' },
                        sessionId: { type: 'string', description: 'Session ID (default: "default")' }
                    },
                    required: ['path']
                }
            } as Tool
        });

        allTools.push({
            server: 'container',
            tool: {
                name: 'container_status',
                description: 'Check Docker availability and list active container sessions.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {}
                }
            } as Tool
        });

        // Add agent delegation tool
        allTools.push({
            server: 'agents',
            tool: {
                name: 'delegate_task',
                description: 'Delegate a sub-task to a specialized child agent. The child agent will execute independently and return results.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        task: { type: 'string', description: 'Description of the sub-task to delegate' },
                        role: { type: 'string', description: 'Specialist role for the child agent (e.g. "python developer", "data analyst")' }
                    },
                    required: ['task']
                }
            } as Tool
        });

        // Add knowledge search tool
        allTools.push({
            server: 'knowledge',
            tool: {
                name: 'knowledge_search',
                description: 'Search the knowledge base for relevant documents and information. Returns matching text chunks.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                        limit: { type: 'number', description: 'Max results (default 5)' }
                    },
                    required: ['query']
                }
            } as Tool
        });

        // Add context_reset tool for clearing stale context
        allTools.push({
            server: 'system',
            tool: {
                name: 'context_reset',
                description: 'Clear the current conversation context to start fresh. Use this when switching to a completely different task and old context is causing confusion. Preserves persistent memory (preferences, learned facts) but clears the current conversation history.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        reason: { type: 'string', description: 'Brief reason for resetting context (for logging)' }
                    }
                }
            } as Tool
        });

        // ===== DYNAMIC TOOLS (Sprint 3) =====
        // Surface all registered dynamic tools so agents can discover and use them
        try {
            await dynamicToolRegistry.initialize();
            const dynTools = dynamicToolRegistry.listTools();
            for (const dt of dynTools) {
                allTools.push({
                    server: 'tools',
                    tool: {
                        name: dt.name,
                        description: `[Dynamic Tool] ${dt.description}`,
                        inputSchema: {
                            type: 'object' as const,
                            properties: dt.inputSchema || {},
                        },
                    } as Tool
                });
            }
        } catch (e) {
            console.warn('[MCPManager] Failed to load dynamic tools:', e);
        }

        // Meta-tools: let agents manage the tool system itself
        allTools.push({
            server: 'tools',
            tool: {
                name: 'create_tool',
                description: 'Create a new reusable tool at runtime. The tool code must be a JavaScript function body that receives an `args` object. Example: `return args.a + args.b;`',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Tool name in lowercase_snake_case (e.g. parse_csv)' },
                        description: { type: 'string', description: 'What the tool does (10-500 chars)' },
                        code: { type: 'string', description: 'JavaScript function body. Receives `args` object. Must return a value.' },
                        inputSchema: { type: 'object', description: 'JSON Schema describing the args the tool accepts' },
                        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
                    },
                    required: ['name', 'description', 'code'],
                },
            } as Tool
        });

        allTools.push({
            server: 'tools',
            tool: {
                name: 'use_dynamic_tool',
                description: 'Execute a previously created dynamic tool by name.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Name of the dynamic tool to execute' },
                        args: { type: 'object', description: 'Arguments to pass to the tool' },
                    },
                    required: ['name'],
                },
            } as Tool
        });

        allTools.push({
            server: 'tools',
            tool: {
                name: 'list_dynamic_tools',
                description: 'List all available dynamic tools with their descriptions, versions, and usage stats.',
                inputSchema: { type: 'object' as const, properties: {} },
            } as Tool
        });

        allTools.push({
            server: 'tools',
            tool: {
                name: 'delete_tool',
                description: 'Delete a dynamic tool by name.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Name of the tool to delete' },
                    },
                    required: ['name'],
                },
            } as Tool
        });

        // Credential introspection — agent can see what keys are saved (never the values)
        allTools.push({
            server: 'integrations',
            tool: {
                name: 'list_saved_credentials',
                description: 'List the names of all saved integration credentials (API keys, tokens, etc.). Never returns values — only confirms which keys exist. Use this to answer questions like "which gmail account is configured" or "is GitHub connected".',
                inputSchema: { type: 'object' as const, properties: {} },
            } as Tool
        });

        // External MCP server management tools
        allTools.push({
            server: 'mcp_servers',
            tool: {
                name: 'connect_external_mcp',
                description: 'Connect an external MCP server by command. Once connected, all its tools become available immediately. Example: connect Playwright MCP with command "npx" args ["@playwright/mcp"].',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Unique name for this server (e.g. playwright, puppeteer, custom_api)' },
                        command: { type: 'string', description: 'Executable to run (e.g. npx, node, python)' },
                        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the command (e.g. ["@playwright/mcp"])' },
                        env: { type: 'object', description: 'Optional environment variables for the server process' },
                        description: { type: 'string', description: 'Human-friendly description of what this server provides' },
                    },
                    required: ['name', 'command', 'args'],
                },
            } as Tool
        });

        allTools.push({
            server: 'mcp_servers',
            tool: {
                name: 'disconnect_external_mcp',
                description: 'Disconnect and remove a previously connected external MCP server.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        name: { type: 'string', description: 'Name of the external server to disconnect' },
                    },
                    required: ['name'],
                },
            } as Tool
        });

        allTools.push({
            server: 'mcp_servers',
            tool: {
                name: 'list_external_mcp_servers',
                description: 'List all connected external MCP servers with their status and available tool count.',
                inputSchema: { type: 'object' as const, properties: {} },
            } as Tool
        });

        // Human-in-the-loop input tool — agent can proactively ask the user for information
        allTools.push({
            server: 'hitl',
            tool: {
                name: 'request_user_input',
                description: 'Pause execution and ask the user for required information. Use this proactively whenever you need credentials, OTP codes, addresses, payment details, or any user-specific data you cannot proceed without. The execution will pause until the user responds. IMPORTANT: Call this BEFORE attempting an action that requires the information — do not try to guess or invent values.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        question: {
                            type: 'string',
                            description: 'Clear explanation of why you need this information and what you will do with it. E.g. "I\'m on the Swiggy login page. I need your phone number to log in and place the order."'
                        },
                        fields: {
                            type: 'array',
                            description: 'The specific fields you need the user to fill in.',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string', description: 'Field key name (e.g. phone, password, otp)' },
                                    label: { type: 'string', description: 'Human-readable label (e.g. "Phone Number", "Password", "OTP Code")' },
                                    type: { type: 'string', enum: ['text', 'password', 'tel', 'number', 'email', 'otp'], description: 'Input type (password fields are masked in the UI)' },
                                    required: { type: 'boolean', description: 'Whether this field is required' },
                                    placeholder: { type: 'string', description: 'Example value shown as placeholder' }
                                },
                                required: ['name', 'label']
                            }
                        }
                    },
                    required: ['question', 'fields'],
                },
            } as Tool
        });

        // Integration management tools — agent can configure integrations directly in chat
        allTools.push({
            server: 'integrations',
            tool: {
                name: 'list_integrations',
                description: 'List all available third-party integrations (Gmail, GitHub, Notion, Google Calendar, etc.) with their current status — which are active and which need credentials configured.',
                inputSchema: { type: 'object' as const, properties: {} },
            } as Tool
        });

        allTools.push({
            server: 'integrations',
            tool: {
                name: 'configure_integration',
                description: 'Save an integration credential (API key, token, etc.) so the integration becomes active immediately. Call this once per credential after obtaining the value from the user. The change takes effect on the next tool call — no restart required.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        key: { type: 'string', description: 'Environment variable name (e.g. GMAIL_USER, GITHUB_TOKEN, NOTION_API_KEY)' },
                        value: { type: 'string', description: 'The credential value provided by the user' },
                        integration: { type: 'string', description: 'Human-friendly integration name for logging (e.g. gmail, github, notion)' },
                    },
                    required: ['key', 'value'],
                },
            } as Tool
        });

        return allTools;
    }

    async callTool(serverName: string, toolName: string, args: any) {
        // Validate tool arguments with Zod before dispatch
        let validatedArgs: any;
        try {
            validatedArgs = validateToolArgs(serverName, toolName, args);
        } catch (validationError: any) {
            console.error(`[MCPManager] Validation failed for ${serverName}.${toolName}:`, validationError.message);
            return {
                success: false,
                error: validationError.message,
                isValidationError: true
            };
        }

        // Audit log all tool calls (async, non-blocking)
        const auditStart = Date.now();
        const logResult = (result: any) => {
            const success = result?.success !== false;
            auditLogger.logToolCall(serverName, toolName, validatedArgs, {
                success,
                error: result?.error,
            }).catch(() => { }); // never block on audit

            // Normalize { success: false, error: '...' } from native servers to MCP error
            // protocol ({ isError: true, content: [...] }) so executeAction() in
            // ReActReasoner detects the failure and adds it to error_history.
            if (!success && !result?.isError) {
                return {
                    ...result,
                    isError: true,
                    content: [{ type: 'text', text: result?.error || 'Tool returned success: false' }],
                };
            }
            return result;
        };

        try {
            // Handle shell server calls
            if (serverName === 'shell') {
                return logResult(await shellServer.callTool(toolName, validatedArgs));
            }

            // Handle browser server calls
            if (serverName === 'browser') {
                return logResult(await browserServer.callTool(toolName, validatedArgs));
            }

            // Handle web search server calls
            if (serverName === 'websearch') {
                return logResult(await webSearchServer.callTool(toolName, validatedArgs));
            }

            // Handle GitHub calls
            if (serverName === 'github') {
                return logResult(await gitHubServer.callTool(toolName, validatedArgs));
            }

            // Handle Notion calls
            if (serverName === 'notion') {
                return logResult(await notionServer.callTool(toolName, validatedArgs));
            }

            // Handle image generation calls
            if (serverName === 'imagegen') {
                return logResult(await imageGenServer.callTool(toolName, validatedArgs));
            }

            // Handle Gmail calls
            if (serverName === 'gmail') {
                return logResult(await gmailServer.callTool(toolName, validatedArgs));
            }

            // Handle Google Calendar calls
            if (serverName === 'calendar') {
                return logResult(await googleCalendarServer.callTool(toolName, validatedArgs));
            }

            // Handle Twitter/X calls
            if (serverName === 'twitter') {
                return logResult(await twitterServer.callTool(toolName, validatedArgs));
            }

            // Handle Trello calls
            if (serverName === 'trello') {
                return logResult(await trelloServer.callTool(toolName, validatedArgs));
            }

            // Handle Google Drive calls
            if (serverName === 'drive') {
                return logResult(await googleDriveServer.callTool(toolName, validatedArgs));
            }

            // Handle Spotify calls
            if (serverName === 'spotify') {
                return logResult(await spotifyServer.callTool(toolName, validatedArgs));
            }

            // Handle Apify calls
            if (serverName === 'apify') {
                return logResult(await apifyServer.callTool(toolName, validatedArgs));
            }

            // Handle Messaging calls (telegram / discord / whatsapp proactive send)
            if (serverName === 'messaging') {
                return logResult(await messagingServer.callTool(toolName, validatedArgs));
            }

            // Handle scheduler calls
            if (serverName === 'scheduler') {
                return logResult(await scheduleServer.callTool(toolName, validatedArgs));
            }

            // Handle agent config calls
            if (serverName === 'agentconfig') {
                return logResult(await agentConfigServer.callTool(toolName, validatedArgs));
            }

            // Handle knowledge base calls
            if (serverName === 'knowledgebase') {
                return logResult(await knowledgeBaseServer.callTool(toolName, validatedArgs));
            }

            // Handle container execution calls (Phase 11B)
            if (serverName === 'container') {
                const sessionId = validatedArgs.sessionId || 'default';

                if (toolName === 'exec_in_container') {
                    // Inherit network mode from the current ReAct execution if possible.
                    // The reasoner sets this on the container session before starting, so the
                    // session already has the right network config — just pass it through.
                    const result = await containerSessionManager.exec(sessionId, validatedArgs.command, {
                        timeout: validatedArgs.timeout,
                        cwd: validatedArgs.cwd,
                        config: validatedArgs.networkMode ? { networkMode: validatedArgs.networkMode } : undefined,
                    });
                    return logResult({
                        success: result.exitCode === 0,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                        durationMs: result.durationMs,
                    });
                }

                if (toolName === 'container_write_file') {
                    const session = await containerSessionManager.getSession(sessionId);
                    await session.writeFile(validatedArgs.path, validatedArgs.content);
                    return logResult({ success: true, message: `File written: ${validatedArgs.path}` });
                }

                if (toolName === 'container_read_file') {
                    const session = await containerSessionManager.getSession(sessionId);
                    const content = await session.readFile(validatedArgs.path);
                    return logResult({ success: true, content });
                }

                if (toolName === 'container_status') {
                    const dockerAvailable = await containerSessionManager.isDockerAvailable();
                    const sessions = await containerSessionManager.getAllStatus();
                    return logResult({ success: true, dockerAvailable, sessions, sessionCount: sessions.length });
                }

                throw new Error(`Unknown container tool: ${toolName}`);
            }

            // Handle agent delegation calls
            if (serverName === 'agents' && toolName === 'delegate_task') {
                const result = await agentPool.delegateTask(validatedArgs.task, validatedArgs.role || 'general assistant');
                return logResult({ success: true, agentId: result.id, result: result.result, artifacts: result.artifacts });
            }

            // Handle knowledge search calls
            if (serverName === 'knowledge' && toolName === 'knowledge_search') {
                const { knowledgeBase } = await import('../memory/KnowledgeBase');
                const results = await knowledgeBase.search(validatedArgs.query, validatedArgs.limit || 5);
                return logResult({ success: true, results });
            }

            // Handle external MCP server management
            if (serverName === 'mcp_servers') {
                if (toolName === 'connect_external_mcp') {
                    const result = await this.connectExternalServer({
                        name: validatedArgs.name,
                        command: validatedArgs.command,
                        args: validatedArgs.args || [],
                        env: validatedArgs.env,
                        description: validatedArgs.description,
                    });
                    return logResult(result);
                }
                if (toolName === 'disconnect_external_mcp') {
                    const result = await this.disconnectExternalServer(validatedArgs.name);
                    return logResult(result);
                }
                if (toolName === 'list_external_mcp_servers') {
                    const servers = await this.listExternalServers();
                    return logResult({ success: true, servers });
                }
            }

            // Handle integration management tools
            if (serverName === 'integrations') {
                const { INTEGRATIONS } = await import('../routes/integrationRoutes');

                if (toolName === 'list_saved_credentials') {
                    const { secretManager } = await import('../services/SecretManager');
                    const secrets = await secretManager.listSecrets('default');
                    // Also include any relevant process.env keys that were set at startup
                    const envKeys = Object.keys(process.env).filter(k =>
                        /TOKEN|SECRET|PASSWORD|API_KEY|CLIENT_ID|BEARER|GMAIL|GITHUB|NOTION|TRELLO|SPOTIFY|TWITTER|CALENDAR|DRIVE/i.test(k)
                        && process.env[k]
                    );
                    const dbKeyNames = secrets.map((s: any) => s.name);
                    const allKeys = Array.from(new Set([...dbKeyNames, ...envKeys])).sort();
                    return logResult({
                        success: true,
                        saved_credentials: allKeys,
                        note: 'Values are never shown — only key names. To read what a user typed, check the GMAIL_USER key name.',
                        gmail_user: process.env.GMAIL_USER ? `GMAIL_USER is set (value: ${process.env.GMAIL_USER})` : 'GMAIL_USER not set',
                    });
                }

                if (toolName === 'list_integrations') {
                    const active: any[] = [];
                    const needsSetup: any[] = [];
                    for (const integ of INTEGRATIONS) {
                        const isConnected = integ.requiredKeys.length === 0
                            ? integ.optionalKeys.some(k => !!process.env[k])
                            : integ.requiredKeys.every(k => !!process.env[k]);
                        const entry = {
                            id: integ.id,
                            label: integ.label,
                            description: integ.description,
                            docsUrl: integ.docsUrl,
                            requiredKeys: integ.requiredKeys,
                            optionalKeys: integ.optionalKeys,
                        };
                        if (isConnected) {
                            active.push(entry);
                        } else {
                            needsSetup.push(entry);
                        }
                    }
                    return logResult({
                        success: true,
                        active,
                        needsSetup,
                        summary: `${active.length} active, ${needsSetup.length} need credentials. To configure one, ask the user for the required keys and call configure_integration.`,
                    });
                }

                if (toolName === 'configure_integration') {
                    const { key, value, integration } = validatedArgs;
                    if (!key || !value) {
                        return logResult({ success: false, error: 'key and value are required' });
                    }

                    // HALLUCINATION GUARD: reject obviously fake/placeholder values.
                    // The agent must ONLY call this tool with values the user explicitly typed.
                    const looksPlaceholder = (v: string): boolean => {
                        const lower = v.toLowerCase();
                        const placeholderPatterns = [
                            /^your[_\-]/i,           // your_token, your-api-key
                            /placeholder/i,
                            /^example/i,
                            /^fake/i,
                            /^test_/i,
                            /^dummy/i,
                            /token_here/i,
                            /api_key_here/i,
                            /insert_/i,
                            /^<.+>$/,                // <YOUR_TOKEN>
                            /^\[.+\]$/,              // [API_KEY]
                            /^{.+}$/,                // {token}
                            /^changeme/i,
                            /^none$/i,
                            /^null$/i,
                            /^undefined$/i,
                            /^n\/a$/i,
                            /^xxx/i,
                            /^abc123$/i,
                        ];
                        // Also reject very short values for keys that clearly need real tokens
                        const isTokenKey = /TOKEN|SECRET|PASSWORD|KEY|PASS/i.test(key);
                        if (isTokenKey && v.length < 8) return true;
                        return placeholderPatterns.some(p => p.test(v));
                    };

                    if (looksPlaceholder(value)) {
                        console.warn(`[MCPManager] configure_integration BLOCKED: hallucinated value for ${key}`);
                        return logResult({
                            success: false,
                            error: `BLOCKED: The value "${value.substring(0, 30)}..." looks like a placeholder, not a real credential. You MUST ask the user to paste the actual value for ${key}. Do NOT generate or guess credential values. Stop and reply to the user asking them to provide ${key}.`,
                            action_required: `Ask the user: "Please paste your ${key} value so I can configure ${integration || 'the integration'}."`
                        });
                    }

                    // Save to SecretManager (encrypted) + apply to process.env immediately
                    const { secretManager } = await import('../services/SecretManager');
                    await secretManager.setSecret('default', key, value);
                    process.env[key] = value;
                    console.log(`[MCPManager] Integration credential saved: ${key} (${integration || 'unknown'})`);
                    return logResult({
                        success: true,
                        message: `Saved ${key}. The ${integration || 'integration'} will be active on the next request.`,
                        key,
                        integration: integration || key,
                    });
                }
            }

            // Handle context_reset (returns a signal the orchestrator detects)
            if (serverName === 'system' && toolName === 'context_reset') {
                console.log(`[MCPManager] Context reset requested: ${validatedArgs.reason || 'no reason given'}`);
                return logResult({
                    success: true,
                    _contextReset: true,
                    message: `Context cleared. Previous conversation history has been reset. Reason: ${validatedArgs.reason || 'task switch'}`
                });
            }

            // Handle HITL proactive user input (signals the orchestrator to pause)
            if (serverName === 'hitl' && toolName === 'request_user_input') {
                console.log(`[MCPManager] HITL Input Requested: ${validatedArgs.question}`);
                return logResult({
                    success: true,
                    _hitlRequest: true,
                    question: validatedArgs.question,
                    fields: validatedArgs.fields,
                    message: `PAUSED: Waiting for user to provide input: ${validatedArgs.question}`,
                    action_required: validatedArgs.question
                });
            }

            // ===== DYNAMIC TOOL SYSTEM (Phase 3) =====

            // Create a new dynamic tool
            if (serverName === 'tools' && toolName === 'create_tool') {
                const tool = await dynamicToolRegistry.registerTool(
                    validatedArgs.name,
                    validatedArgs.description,
                    validatedArgs.code,
                    {
                        inputSchema: validatedArgs.inputSchema,
                        createdBy: validatedArgs.createdBy || 'agent',
                        tags: validatedArgs.tags,
                    }
                );
                return logResult({ success: true, tool: { name: tool.name, version: tool.version, id: tool.id } });
            }

            // Execute a dynamic tool
            if (serverName === 'tools' && toolName === 'use_dynamic_tool') {
                const result = await dynamicToolRegistry.executeTool(validatedArgs.name, validatedArgs.args || {});
                return logResult(result);
            }

            // List available dynamic tools
            if (serverName === 'tools' && toolName === 'list_dynamic_tools') {
                const tools = dynamicToolRegistry.listTools().map(t => ({
                    name: t.name,
                    description: t.description,
                    version: t.version,
                    usageCount: t.usageCount,
                    tags: t.tags
                }));
                return logResult({ success: true, tools });
            }

            // Delete a dynamic tool
            if (serverName === 'tools' && toolName === 'delete_tool') {
                const deleted = await dynamicToolRegistry.deleteTool(validatedArgs.name);
                return logResult({ success: deleted, message: deleted ? 'Tool deleted' : 'Tool not found' });
            }

            // Handle MCP client calls (with retry for transient failures)
            const client = this.clients.get(serverName);
            if (!client) {
                throw new Error(`Server ${serverName} not found`);
            }

            // Binary document extraction: intercept read_file for office/PDF formats
            if (serverName === 'filesystem' && toolName === 'read_file') {
                const filePath: string = validatedArgs.path || '';
                const ext = filePath.toLowerCase().split('.').pop() || '';

                if (ext === 'pdf') {
                    try {
                        // Use lib/pdf-parse.js directly — the package index.js has a known bug where
                        // it reads './test/data/05-versions-space.pdf' on import, causing ENOENT.
                        const pdfMod = await import('pdf-parse/lib/pdf-parse.js');
                        const pdfParse = (pdfMod as any).default || pdfMod;
                        if (typeof pdfParse !== 'function') throw new Error('pdf-parse module not available');
                        const data = await pdfParse(fs.readFileSync(filePath));
                        return logResult({
                            content: [{ type: 'text', text: data.text }],
                            metadata: { pages: data.numpages, info: data.info }
                        });
                    } catch (e: any) {
                        return logResult({ isError: true, content: [{ type: 'text', text: `Failed to parse PDF: ${e.message}` }] });
                    }
                }

                if (ext === 'docx') {
                    try {
                        const mammoth = await import('mammoth');
                        const result = await mammoth.extractRawText({ path: filePath });
                        return logResult({ content: [{ type: 'text', text: result.value }] });
                    } catch (e: any) {
                        return logResult({ isError: true, content: [{ type: 'text', text: `Failed to parse DOCX: ${e.message}` }] });
                    }
                }

                if (ext === 'xlsx') {
                    try {
                        const ExcelJS = (await import('exceljs')).default;
                        const workbook = new ExcelJS.Workbook();
                        await workbook.xlsx.readFile(filePath);
                        const lines: string[] = [];
                        workbook.eachSheet(sheet => {
                            lines.push(`\n## Sheet: ${sheet.name}`);
                            sheet.eachRow(row => {
                                const cells = (row.values as any[]).slice(1).map((v: any) => (v ?? '').toString());
                                lines.push(cells.join('\t'));
                            });
                        });
                        return logResult({ content: [{ type: 'text', text: lines.join('\n') }] });
                    } catch (e: any) {
                        return logResult({ isError: true, content: [{ type: 'text', text: `Failed to parse XLSX: ${e.message}` }] });
                    }
                }

                if (ext === 'pptx') {
                    try {
                        const AdmZip = (await import('adm-zip')).default;
                        const zip = new AdmZip(filePath);
                        const slides = zip.getEntries()
                            .filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/))
                            .sort((a, b) => a.entryName.localeCompare(b.entryName));
                        const lines: string[] = [];
                        for (const slide of slides) {
                            const xml = slide.getData().toString('utf-8');
                            // Extract text runs from XML
                            const texts = [...xml.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g)].map(m => m[1]);
                            if (texts.length > 0) {
                                lines.push(`\n## Slide ${slides.indexOf(slide) + 1}`);
                                lines.push(texts.join(' '));
                            }
                        }
                        return logResult({ content: [{ type: 'text', text: lines.join('\n') }] });
                    } catch (e: any) {
                        return logResult({ isError: true, content: [{ type: 'text', text: `Failed to parse PPTX: ${e.message}` }] });
                    }
                }
            }

            // Guard: reject write_file if content is semantically invalid before reaching filesystem.
            // Catches LLM mid-generation truncation ("co"), undefined/null stringification, bad JSON.
            if (serverName === 'filesystem' && toolName === 'write_file') {
                const raw = validatedArgs.content;
                const content = raw !== undefined && raw !== null ? String(raw) : '';

                // Reject sentinel strings from JS serialisation of missing values
                if (content === 'undefined' || content === 'null' || content === '[object Object]') {
                    return logResult({
                        isError: true,
                        content: [{ type: 'text', text: `[WRITE_INVALID_CONTENT] write_file aborted: content resolved to "${content}" — LLM passed an unresolved variable. Generate actual file content and retry.` }]
                    });
                }

                // Per-type minimum length thresholds
                const filePath: string = validatedArgs.path || '';
                const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
                const MIN_LENGTHS: Record<string, number> = {
                    py: 30, js: 30, ts: 30, mjs: 30,
                    json: 10,
                    csv: 5,
                    md: 20, txt: 1, html: 50, xml: 20,
                };
                const minLen = MIN_LENGTHS[ext] ?? 5;
                if (content.trim().length < minLen) {
                    return logResult({
                        isError: true,
                        content: [{ type: 'text', text: `[WRITE_TRUNCATED] write_file aborted: content for ${filePath} is ${content.trim().length} chars (minimum ${minLen} for .${ext || 'unknown'}). Content was likely truncated mid-generation. Re-generate the complete file content and retry.` }]
                    });
                }

                // Validate JSON structure before writing .json files
                if (ext === 'json') {
                    try { JSON.parse(content); } catch (jsonErr: any) {
                        return logResult({
                            isError: true,
                            content: [{ type: 'text', text: `[WRITE_INVALID_JSON] write_file aborted: ${filePath} contains invalid JSON: ${jsonErr.message}. Fix the JSON syntax and retry.` }]
                        });
                    }
                }
            }

            // Audit log file write/delete operations specifically (Phase 13D.4)
            if (serverName === 'filesystem') {
                const isWrite = ['write_file', 'edit_file', 'create_directory', 'move_file'].includes(toolName);
                const isDelete = toolName === 'delete_file' || toolName === 'remove_file';
                if (isWrite || isDelete) {
                    const filePath = validatedArgs.path || validatedArgs.source || validatedArgs.destination || '';
                    auditLogger.log(
                        'security',
                        isDelete ? 'file_delete' : 'file_write',
                        {
                            tool: toolName,
                            path: filePath,
                            destination: validatedArgs.destination,
                            server: serverName,
                        },
                        { severity: isDelete ? 'warn' : 'info' }
                    ).catch(() => { });
                }
            }

            const mcpResult = await withRetry(
                () => client.callTool({
                    name: toolName,
                    arguments: validatedArgs
                }),
                `${serverName}.${toolName}`,
                {
                    maxRetries: 2,
                    isRetryable: isTransientError,
                    onRetry: (attempt, error, delay) => {
                        console.warn(`[MCPManager] Retry ${attempt} for ${serverName}.${toolName} in ${delay}ms: ${error.message}`);
                    }
                }
            );

            // Auto-track files written by the agent in generated_files for DeliverableDownloader
            if (serverName === 'filesystem' && toolName === 'write_file' && validatedArgs.path) {
                this.trackWrittenFile(validatedArgs.path).catch(() => { });
            }

            return logResult(mcpResult);
        } catch (error: any) {
            auditLogger.logToolCall(serverName, toolName, validatedArgs, {
                success: false,
                error: error.message,
            }).catch(() => { });
            throw error;
        }
    }

    // =========================================================================
    // EXTERNAL MCP SERVER MANAGEMENT
    // =========================================================================

    /**
     * Load previously saved external servers from disk and reconnect them.
     */
    private async loadExternalServers(): Promise<void> {
        try {
            if (!fs.existsSync(this.externalConfigPath)) return;
            const raw = fs.readFileSync(this.externalConfigPath, 'utf-8');
            const saved: ExternalMCPServerConfig[] = JSON.parse(raw);
            for (const cfg of saved) {
                this.externalServers.set(cfg.name, cfg);
                await this.connectToServer(cfg.name, { command: cfg.command, args: cfg.args, env: cfg.env });
                console.log(`[MCPManager] Reconnected external server: ${cfg.name}`);
            }
        } catch (e) {
            console.warn('[MCPManager] Failed to load external servers:', e);
        }
    }

    private saveExternalServers(): void {
        try {
            const dir = path.dirname(this.externalConfigPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.externalConfigPath, JSON.stringify(Array.from(this.externalServers.values()), null, 2));
        } catch (e) {
            console.warn('[MCPManager] Failed to save external servers config:', e);
        }
    }

    /**
     * Connect a new external MCP server by command/args.
     * The server is persisted and reconnected on restart.
     */
    async connectExternalServer(cfg: Omit<ExternalMCPServerConfig, 'addedAt'>): Promise<{ success: boolean; error?: string; toolCount?: number }> {
        const name = cfg.name;
        try {
            await this.connectToServer(name, { command: cfg.command, args: cfg.args, env: cfg.env });
            const client = this.clients.get(name);
            if (!client) throw new Error('Connection succeeded but client not found');

            const toolResult = await client.listTools();
            const toolCount = toolResult.tools.length;

            const fullCfg: ExternalMCPServerConfig = { ...cfg, addedAt: new Date().toISOString() };
            this.externalServers.set(name, fullCfg);
            this.saveExternalServers();

            console.log(`[MCPManager] External server "${name}" connected with ${toolCount} tools`);
            return { success: true, toolCount };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Disconnect and remove an external MCP server.
     */
    async disconnectExternalServer(name: string): Promise<{ success: boolean; error?: string }> {
        const client = this.clients.get(name);
        if (client) {
            try { await client.close(); } catch { /* ignore */ }
            this.clients.delete(name);
        }
        const existed = this.externalServers.has(name);
        this.externalServers.delete(name);
        this.saveExternalServers();
        return { success: existed };
    }

    /**
     * List all external servers with their connection status and tool count.
     */
    async listExternalServers(): Promise<{ name: string; description?: string; command: string; args: string[]; addedAt: string; connected: boolean; toolCount: number }[]> {
        const result = [];
        for (const [name, cfg] of this.externalServers.entries()) {
            const client = this.clients.get(name);
            let toolCount = 0;
            let connected = false;
            if (client) {
                try {
                    const r = await client.listTools();
                    toolCount = r.tools.length;
                    connected = true;
                } catch { connected = false; }
            }
            result.push({ name, description: cfg.description, command: cfg.command, args: cfg.args, addedAt: cfg.addedAt, connected, toolCount });
        }
        return result;
    }

    /**
     * Track a file written by the agent into the generated_files table.
     * This makes it appear in DeliverableDownloader automatically.
     * Fire-and-forget — never throws.
     */
    private async trackWrittenFile(filePath: string): Promise<void> {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const { configManager } = await import('../services/ConfigManager');
            const { db } = await import('../database');
            const crypto = await import('crypto');

            // Map MCP path to actual filesystem path
            const workspace = configManager.getWorkspaceDir();
            const normalizedPath = filePath.replace(/^\/workspace\/?/, '');
            const diskPath = path.join(workspace, normalizedPath);

            if (!fs.existsSync(diskPath)) return;
            const stat = fs.statSync(diskPath);
            if (!stat.isFile()) return;

            // Derive display info from filename
            const filename = path.basename(diskPath);
            const ext = filename.split('.').pop()?.toLowerCase() || 'txt';
            const mimeMap: Record<string, string> = {
                txt: 'text/plain', py: 'text/x-python', js: 'text/javascript',
                ts: 'text/typescript', json: 'application/json', csv: 'text/csv',
                html: 'text/html', md: 'text/markdown', sh: 'text/x-sh',
                pdf: 'application/pdf', xlsx: 'application/vnd.ms-excel',
                docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
            };

            const id = crypto.randomUUID();
            await db.run(
                `INSERT OR IGNORE INTO generated_files
                 (id, user_id, filename, file_type, file_path, file_size, mime_type, title, description)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    'default',
                    filename,
                    ext,
                    diskPath,
                    stat.size,
                    mimeMap[ext] || 'application/octet-stream',
                    filename,
                    'Generated by agent',
                ]
            );
        } catch {
            // Silently ignore — tracking is best-effort
        }
    }
}

export const mcpManager = new MCPManager();
