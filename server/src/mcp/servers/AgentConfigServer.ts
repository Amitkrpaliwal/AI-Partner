/**
 * AgentConfigServer — Restricted MCP tool for runtime agent configuration.
 * Only exposes safe, non-destructive config knobs: approval_mode + network_enabled.
 * The agent must NOT be able to disable security controls or change models via a tool call.
 */

import { configManager } from '../../services/ConfigManager';

// In-memory overrides (reset on server restart).
// The GoalOrientedExecutor reads these via getAgentConfigOverrides().
const runtimeOverrides: {
    approval_mode?: 'none' | 'script' | 'all';
    network_enabled?: boolean;
} = {};

class AgentConfigServer {
    isAvailable(): boolean {
        return true; // Always available — no API key required
    }

    getTools() {
        return [
            {
                name: 'update_agent_config',
                description: 'Update runtime agent configuration. Only approval_mode and network_enabled are allowed. Changes apply to the NEXT goal execution (not the current one).',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        approval_mode: {
                            type: 'string',
                            description: 'HITL approval mode: "none" (no prompts), "script" (approve scripts only), "all" (approve every action). Default: "script".'
                        },
                        network_enabled: {
                            type: 'boolean',
                            description: 'Whether the sandbox container can access the internet. Default: false for most goals, auto-enabled for data-fetch goals.'
                        }
                    },
                    required: []
                }
            },
            {
                name: 'get_agent_config',
                description: 'Get the current runtime agent configuration overrides.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {},
                    required: []
                }
            }
        ];
    }

    async callTool(toolName: string, args: Record<string, any>): Promise<any> {
        if (toolName === 'update_agent_config') {
            const changes: string[] = [];

            if (args.approval_mode !== undefined) {
                const valid = ['none', 'script', 'all'];
                if (!valid.includes(args.approval_mode)) {
                    return { error: `approval_mode must be one of: ${valid.join(', ')}` };
                }
                runtimeOverrides.approval_mode = args.approval_mode;
                changes.push(`approval_mode = "${args.approval_mode}"`);
            }

            if (args.network_enabled !== undefined) {
                runtimeOverrides.network_enabled = Boolean(args.network_enabled);
                changes.push(`network_enabled = ${runtimeOverrides.network_enabled}`);
            }

            if (changes.length === 0) {
                return { message: 'No changes specified. Provide approval_mode and/or network_enabled.' };
            }

            return {
                updated: true,
                changes,
                current: { ...runtimeOverrides },
                note: 'Changes apply to the NEXT goal execution.'
            };
        }

        if (toolName === 'get_agent_config') {
            return {
                overrides: { ...runtimeOverrides },
                defaults: {
                    approval_mode: configManager.get('approvalMode', 'script'),
                    network_enabled: false,
                },
                effective: {
                    approval_mode: runtimeOverrides.approval_mode ?? configManager.get('approvalMode', 'script'),
                    network_enabled: runtimeOverrides.network_enabled ?? false,
                }
            };
        }

        return { error: `Unknown tool: ${toolName}` };
    }

    /** Read the current runtime overrides (called by GoalOrientedExecutor). */
    getOverrides(): typeof runtimeOverrides {
        return { ...runtimeOverrides };
    }
}

export const agentConfigServer = new AgentConfigServer();
