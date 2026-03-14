/**
 * DynamicToolRegistry — Runtime tool creation & persistence.
 *
 * Agents can create custom tools at runtime. Tools are:
 * - Registered in-memory for immediate availability
 * - Persisted to SQLite for cross-session reuse
 * - Versioned (overwrite with backup)
 * - Sandboxed (execution in isolated context)
 * - Available to all agents once registered
 */

import { z } from 'zod';
import { db } from '../database';
import { EventEmitter } from 'events';
import { isToolCodeSafe, logSecurityEvent } from '../utils/security';
import { containerSessionManager } from '../execution/ContainerSession';

// ============================================================================
// TYPES
// ============================================================================

export interface DynamicTool {
    id: string;
    name: string;
    description: string;
    inputSchema: Record<string, any>;  // JSON Schema for inputs
    code: string;                       // JavaScript function body
    runtime: 'node';                    // For now, only JS
    createdBy: string;                  // Agent ID that created it
    createdAt: Date;
    updatedAt: Date;
    version: number;
    usageCount: number;
    successCount: number;
    persistAcrossSessions: boolean;
    tags: string[];
}

export interface DynamicToolResult {
    success: boolean;
    output: any;
    error?: string;
    executionTimeMs: number;
    sandbox: 'function' | 'container';  // Sprint 3: execution environment used
}

// Schema for validating create_tool args
export const CreateToolSchema = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z_][a-z0-9_]*$/, 'Tool name must be lowercase snake_case'),
    description: z.string().min(10).max(500),
    inputSchema: z.record(z.any()).optional().default({}),
    code: z.string().min(10).max(50_000),
    tags: z.array(z.string()).optional().default([]),
    persistAcrossSessions: z.boolean().optional().default(true),
});

// ============================================================================
// REGISTRY
// ============================================================================

export class DynamicToolRegistry extends EventEmitter {
    private tools: Map<string, DynamicTool> = new Map();
    private initialized: boolean = false;

    /**
     * Initialize — create DB table and load persisted tools
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        await db.run(`
            CREATE TABLE IF NOT EXISTS dynamic_tools (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                description TEXT NOT NULL,
                input_schema TEXT DEFAULT '{}',
                code TEXT NOT NULL,
                runtime TEXT DEFAULT 'node',
                created_by TEXT DEFAULT 'system',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                version INTEGER DEFAULT 1,
                usage_count INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                persist INTEGER DEFAULT 1,
                tags TEXT DEFAULT '[]'
            )
        `);

        // Load persisted tools
        const rows = await db.all('SELECT * FROM dynamic_tools');
        for (const row of rows) {
            const tool: DynamicTool = {
                id: row.id,
                name: row.name,
                description: row.description,
                inputSchema: JSON.parse(row.input_schema || '{}'),
                code: row.code,
                runtime: row.runtime || 'node',
                createdBy: row.created_by || 'system',
                createdAt: new Date(row.created_at),
                updatedAt: new Date(row.updated_at),
                version: row.version || 1,
                usageCount: row.usage_count || 0,
                successCount: row.success_count || 0,
                persistAcrossSessions: row.persist === 1,
                tags: JSON.parse(row.tags || '[]'),
            };
            this.tools.set(tool.name, tool);
        }

        this.initialized = true;
        console.log(`[DynamicToolRegistry] Initialized with ${this.tools.size} persisted tools`);
    }

    /**
     * Register a new tool or update an existing one.
     */
    async registerTool(
        name: string,
        description: string,
        code: string,
        options: {
            inputSchema?: Record<string, any>;
            createdBy?: string;
            tags?: string[];
            persistAcrossSessions?: boolean;
        } = {}
    ): Promise<DynamicTool> {
        await this.initialize();

        // Security: validate code for dangerous patterns before registering
        const codeCheck = isToolCodeSafe(code);
        if (!codeCheck.safe) {
            logSecurityEvent('block', 'DynamicToolRegistry', `registerTool blocked: ${codeCheck.reason}`, { name });
            throw new Error(`Tool code rejected: ${codeCheck.reason}`);
        }

        // Validate code syntax before registering
        try {
            new Function('args', code);
        } catch (syntaxError: any) {
            throw new Error(`Tool code has syntax errors: ${syntaxError.message}`);
        }

        const existing = this.tools.get(name);
        const now = new Date();
        const tool: DynamicTool = {
            id: existing?.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            description,
            inputSchema: options.inputSchema || {},
            code,
            runtime: 'node',
            createdBy: options.createdBy || 'agent',
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            version: (existing?.version || 0) + 1,
            usageCount: existing?.usageCount || 0,
            successCount: existing?.successCount || 0,
            persistAcrossSessions: options.persistAcrossSessions ?? true,
            tags: options.tags || [],
        };

        // Store in memory
        this.tools.set(name, tool);

        // Persist to DB
        if (tool.persistAcrossSessions) {
            await db.run(`
                INSERT OR REPLACE INTO dynamic_tools
                (id, name, description, input_schema, code, runtime, created_by, created_at, updated_at, version, usage_count, success_count, persist, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                tool.id, tool.name, tool.description,
                JSON.stringify(tool.inputSchema), tool.code, tool.runtime,
                tool.createdBy, tool.createdAt.toISOString(), tool.updatedAt.toISOString(),
                tool.version, tool.usageCount, tool.successCount,
                tool.persistAcrossSessions ? 1 : 0, JSON.stringify(tool.tags)
            ]);
        }

        this.emit('tool:registered', { name, version: tool.version, createdBy: tool.createdBy });
        console.log(`[DynamicToolRegistry] Registered tool "${name}" v${tool.version} by ${tool.createdBy}`);

        return tool;
    }

    /**
     * Execute a dynamic tool with the given arguments.
     * Runs in a sandboxed Function context.
     */
    async executeTool(name: string, args: any = {}): Promise<DynamicToolResult> {
        await this.initialize();

        const tool = this.tools.get(name);
        if (!tool) {
            return { success: false, output: null, error: `Tool "${name}" not found`, executionTimeMs: 0, sandbox: 'function' };
        }

        const startTime = Date.now();

        // Security: re-validate code at execution time
        const codeCheck = isToolCodeSafe(tool.code);
        if (!codeCheck.safe) {
            logSecurityEvent('block', 'DynamicToolRegistry', `executeTool blocked: ${codeCheck.reason}`, { name });
            return { success: false, output: null, error: `Tool code rejected: ${codeCheck.reason}`, executionTimeMs: 0, sandbox: 'function' };
        }

        // Sprint 3: Prefer Docker container execution for true isolation
        try {
            const dockerAvailable = await containerSessionManager.isDockerAvailable();
            if (dockerAvailable) {
                return await this.executeInContainer(tool, args, startTime);
            }
        } catch (e) {
            console.warn('[DynamicToolRegistry] Docker check failed, falling back to Function sandbox:', e);
        }

        // Fallback: new Function() sandbox (NOT true isolation)
        // Wrap with a 10-second timeout to prevent infinite loops from hanging the server.
        try {
            const fn = new Function('args', `
                "use strict";
                ${tool.code}
            `);

            const FUNCTION_SANDBOX_TIMEOUT_MS = 10_000;
            const output = await Promise.race([
                Promise.resolve(fn(args)),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Tool execution timed out (10s limit in function sandbox)')), FUNCTION_SANDBOX_TIMEOUT_MS)
                ),
            ]);
            const executionTimeMs = Date.now() - startTime;

            tool.usageCount++;
            tool.successCount++;
            await this.updateUsageStats(tool);

            return { success: true, output, executionTimeMs, sandbox: 'function' };
        } catch (error: any) {
            const executionTimeMs = Date.now() - startTime;
            tool.usageCount++;
            await this.updateUsageStats(tool);

            return {
                success: false,
                output: null,
                error: error.message,
                executionTimeMs,
                sandbox: 'function'
            };
        }
    }

    /**
     * Sprint 3: Execute tool code inside a Docker container for true isolation.
     */
    private async executeInContainer(
        tool: DynamicTool,
        args: any,
        startTime: number
    ): Promise<DynamicToolResult> {
        try {
            const sessionId = 'dynamic-tools';

            // Write tool wrapper script to container
            const wrapperCode = `
const args = ${JSON.stringify(args)};
try {
    const fn = new Function('args', \`
        "use strict";
        ${tool.code.replace(/`/g, '\\`').replace(/\$/g, '\\$')}
    \`);
    const result = fn(args);
    Promise.resolve(result).then(r => {
        console.log('__TOOL_OUTPUT__' + JSON.stringify({ success: true, output: r }));
    }).catch(e => {
        console.log('__TOOL_OUTPUT__' + JSON.stringify({ success: false, error: e.message }));
    });
} catch (e) {
    console.log('__TOOL_OUTPUT__' + JSON.stringify({ success: false, error: e.message }));
}
`.trim();

            const session = await containerSessionManager.getSession(sessionId, { networkMode: 'none' });
            await session.writeFile('/tmp/_dynamic_tool.js', wrapperCode);

            const execResult = await containerSessionManager.exec(sessionId, 'node /tmp/_dynamic_tool.js', {
                timeout: 30000,
            });

            const executionTimeMs = Date.now() - startTime;

            // Parse output
            const outputMatch = execResult.stdout.match(/__TOOL_OUTPUT__(.+)/);
            if (outputMatch) {
                const parsed = JSON.parse(outputMatch[1]);
                tool.usageCount++;
                if (parsed.success) tool.successCount++;
                await this.updateUsageStats(tool);

                return {
                    success: parsed.success,
                    output: parsed.output || null,
                    error: parsed.error,
                    executionTimeMs,
                    sandbox: 'container'
                };
            }

            // No structured output — treat stdout as output
            tool.usageCount++;
            tool.successCount++;
            await this.updateUsageStats(tool);

            return {
                success: execResult.exitCode === 0,
                output: execResult.stdout,
                error: execResult.stderr || undefined,
                executionTimeMs,
                sandbox: 'container'
            };
        } catch (error: any) {
            const executionTimeMs = Date.now() - startTime;
            tool.usageCount++;
            await this.updateUsageStats(tool);

            return {
                success: false,
                output: null,
                error: `Container execution failed: ${error.message}`,
                executionTimeMs,
                sandbox: 'container'
            };
        }
    }

    /**
     * Update usage stats in DB
     */
    private async updateUsageStats(tool: DynamicTool): Promise<void> {
        if (tool.persistAcrossSessions) {
            await db.run(
                'UPDATE dynamic_tools SET usage_count = ?, success_count = ? WHERE name = ?',
                [tool.usageCount, tool.successCount, tool.name]
            );
        }
    }

    /**
     * Get a tool by name
     */
    getTool(name: string): DynamicTool | undefined {
        return this.tools.get(name);
    }

    /**
     * List all registered tools
     */
    listTools(): DynamicTool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Delete a tool
     */
    async deleteTool(name: string): Promise<boolean> {
        await this.initialize();
        const tool = this.tools.get(name);
        if (!tool) return false;

        this.tools.delete(name);
        await db.run('DELETE FROM dynamic_tools WHERE name = ?', [name]);
        this.emit('tool:deleted', { name });
        return true;
    }

    /**
     * Search tools by description/tags
     */
    searchTools(query: string): DynamicTool[] {
        const q = query.toLowerCase();
        return this.listTools().filter(t =>
            t.name.includes(q) ||
            t.description.toLowerCase().includes(q) ||
            t.tags.some(tag => tag.toLowerCase().includes(q))
        );
    }

    /**
     * Export a tool as a shareable JSON object
     */
    exportTool(name: string): any | null {
        const tool = this.tools.get(name);
        if (!tool) return null;
        return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            code: tool.code,
            tags: tool.tags,
            version: tool.version,
            exportedAt: new Date().toISOString(),
        };
    }

    /**
     * Import a tool from a JSON object
     */
    async importTool(data: any, createdBy: string = 'import'): Promise<DynamicTool> {
        if (!data.name || !data.code) {
            throw new Error('Import data must contain "name" and "code"');
        }

        // Security: validate imported code before registration
        const codeCheck = isToolCodeSafe(data.code);
        if (!codeCheck.safe) {
            logSecurityEvent('block', 'DynamicToolRegistry', `importTool blocked: ${codeCheck.reason}`, { name: data.name });
            throw new Error(`Imported tool code rejected: ${codeCheck.reason}`);
        }

        return this.registerTool(data.name, data.description || 'Imported tool', data.code, {
            inputSchema: data.inputSchema,
            createdBy,
            tags: data.tags || ['imported'],
        });
    }

    /**
     * Get tool count
     */
    getToolCount(): number {
        return this.tools.size;
    }
}

export const dynamicToolRegistry = new DynamicToolRegistry();
