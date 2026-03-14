/**
 * Zod schemas for all MCP tool inputs.
 * Validates arguments BEFORE dispatch to prevent crashes from null/undefined/malformed args.
 */
import { z } from 'zod';

// ============================================================================
// SHELL SERVER TOOLS
// ============================================================================

export const shellSchemas = {
    run_command: z.object({
        command: z.string().min(1, 'Command must not be empty'),
        cwd: z.string().optional(),
        timeout: z.number().positive().optional(),
        env: z.record(z.string()).optional(),
    }),
    list_processes: z.object({}).optional(),
    kill_process: z.object({
        processId: z.string().min(1, 'Process ID is required'),
    }),
};

// ============================================================================
// WEB SEARCH SERVER TOOLS
// ============================================================================

export const websearchSchemas = {
    web_search: z.object({
        query: z.string().min(1, 'Search query must not be empty'),
        limit: z.number().int().min(1).max(20).optional(),
    }),
    web_fetch: z.object({
        url: z.string().url('URL must be a valid URL'),
        maxLength: z.number().positive().optional(),
    }),
};

// ============================================================================
// BROWSER SERVER TOOLS
// ============================================================================

export const browserSchemas = {
    browser_launch: z.object({
        headless: z.boolean().optional(),
    }).optional(),
    browser_navigate: z.object({
        url: z.string().min(1, 'URL is required'),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    }),
    browser_click: z.object({
        selector: z.string().min(1, 'Selector is required'),
        timeout: z.number().positive().optional(),
    }),
    browser_fill: z.object({
        selector: z.string().min(1, 'Selector is required'),
        value: z.string(),
        timeout: z.number().positive().optional(),
    }),
    browser_extract: z.object({
        selector: z.string().min(1, 'Selector is required'),
        attribute: z.string().optional(),
        all: z.boolean().optional(),
    }),
    browser_screenshot: z.object({
        path: z.string().optional(),
        fullPage: z.boolean().optional(),
        selector: z.string().optional(),
    }).optional(),
    browser_evaluate: z.object({
        script: z.string().min(1, 'Script is required'),
    }),
    browser_wait: z.object({
        selector: z.string().optional(),
        timeout: z.number().positive().optional(),
        state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
    }),
    browser_get_content: z.object({}).optional(),
    browser_close: z.object({}).optional(),
};

// ============================================================================
// AGENT & KNOWLEDGE TOOLS
// ============================================================================

export const agentSchemas = {
    delegate_task: z.object({
        task: z.string().min(1, 'Task description is required'),
        role: z.string().optional(),
    }),
};

export const knowledgeSchemas = {
    knowledge_search: z.object({
        query: z.string().min(1, 'Search query is required'),
        limit: z.number().int().min(1).max(50).optional(),
    }),
};

// ============================================================================
// FILESYSTEM TOOLS (MCP standard — validated here before passing to MCP client)
// ============================================================================

export const filesystemSchemas = {
    read_file: z.object({
        path: z.string().min(1, 'File path is required'),
    }),
    // Bug 1 fix: accept 'file_path' as an alias for 'path'.
    // The LLM often emits file_path (a natural English phrasing) but the MCP
    // filesystem server requires the key to be 'path'. Using z.preprocess here
    // normalises the alias BEFORE Zod validates, so downstream code always
    // receives { path, content } regardless of which key the LLM used.
    write_file: z.preprocess(
        (args: any) => {
            if (
                args &&
                typeof args === 'object' &&
                args.file_path !== undefined &&
                args.path === undefined
            ) {
                return { ...args, path: args.file_path };
            }
            return args;
        },
        z.object({
            path: z.string().min(1, 'File path is required'),
            content: z.string(),
        })
    ),
    create_directory: z.object({
        path: z.string().min(1, 'Directory path is required'),
    }),
    list_directory: z.object({
        path: z.string().min(1, 'Directory path is required'),
    }),
    move_file: z.object({
        source: z.string().min(1, 'Source path is required'),
        destination: z.string().min(1, 'Destination path is required'),
    }),
    search_files: z.object({
        path: z.string().min(1, 'Search path is required'),
        pattern: z.string().min(1, 'Search pattern is required'),
        excludePatterns: z.array(z.string()).optional(),
    }),
    get_file_info: z.object({
        path: z.string().min(1, 'File path is required'),
    }),
    list_allowed_directories: z.object({}).optional(),
};

// ============================================================================
// SCHEMA LOOKUP
// ============================================================================

const allSchemas: Record<string, Record<string, z.ZodTypeAny>> = {
    shell: shellSchemas,
    websearch: websearchSchemas,
    browser: browserSchemas,
    agents: agentSchemas,
    knowledge: knowledgeSchemas,
    filesystem: filesystemSchemas,
};

/**
 * Validate tool arguments using Zod.
 * Returns validated (parsed) args on success, or throws a descriptive error.
 */
export function validateToolArgs(serverName: string, toolName: string, args: any): any {
    const serverSchemas = allSchemas[serverName];
    if (!serverSchemas) {
        // No schema defined for this server — pass through (external MCP servers)
        return args || {};
    }

    const schema = serverSchemas[toolName];
    if (!schema) {
        // No schema for this specific tool — pass through
        console.warn(`[ToolValidation] No schema for ${serverName}.${toolName}, passing args through`);
        return args || {};
    }

    try {
        // Parse and validate — this also strips unknown keys and applies defaults
        const validated = schema.parse(args || {});
        return validated;
    } catch (error) {
        if (error instanceof z.ZodError) {
            const issues = error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
            throw new Error(
                `Invalid arguments for ${serverName}.${toolName}:\n${issues}\n` +
                `Received: ${JSON.stringify(args)}`
            );
        }
        throw error;
    }
}
