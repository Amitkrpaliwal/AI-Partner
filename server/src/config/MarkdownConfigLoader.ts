import fs from 'fs';
import path from 'path';

/**
 * Agent definition parsed from AGENTS.md
 */
export interface AgentDefinition {
    id: string;
    name: string;
    model: string;
    temperature: number;
    system_prompt_file?: string;
    specialization?: string;
    skills: string[];
}

/**
 * Skill definition parsed from SKILL.md
 */
export interface SkillDefinition {
    name: string;
    description: string;
    provider: string;
    providerType: 'mcp_server' | 'builtin';
    capabilities: string[];
    config: Record<string, any>;
}

/**
 * Heartbeat checklist item parsed from HEARTBEAT.md
 */
export interface HeartbeatCheckItem {
    text: string;
    category?: string;
}

/**
 * MarkdownConfigLoader - Parses markdown configuration files
 * using simple YAML-like format within markdown.
 */
export class MarkdownConfigLoader {
    private workspacePath: string;

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
    }

    /**
     * Load SOUL.md content (raw text for system prompt)
     */
    loadSoul(): string {
        const soulPath = path.join(this.workspacePath, 'SOUL.md');
        if (!fs.existsSync(soulPath)) {
            console.warn('[MarkdownConfigLoader] SOUL.md not found, using default');
            return 'You are a helpful AI assistant.';
        }
        return fs.readFileSync(soulPath, 'utf-8');
    }

    /**
     * Load USER.md content (user facts: stack, preferences, context).
     * Hard cap at 1200 chars. Warns if over 800 to prevent silent truncation creep.
     * Returns empty string if file missing — callers treat this as no-op.
     */
    loadUser(): string {
        const userPath = path.join(this.workspacePath, 'USER.md');
        if (!fs.existsSync(userPath)) return '';
        const content = fs.readFileSync(userPath, 'utf-8');
        if (content.length > 800) {
            console.warn(`[MarkdownConfigLoader] USER.md is ${content.length} chars — keep under 800 to avoid truncation`);
        }
        return content.substring(0, 1200);
    }

    /**
     * Load AGENTS.md and parse agent definitions
     */
    loadAgents(): AgentDefinition[] {
        const agentsPath = path.join(this.workspacePath, 'AGENTS.md');
        if (!fs.existsSync(agentsPath)) {
            console.warn('[MarkdownConfigLoader] AGENTS.md not found');
            return [];
        }

        const content = fs.readFileSync(agentsPath, 'utf-8');
        const agents: AgentDefinition[] = [];

        // Split by ## headers (agent sections)
        const sections = content.split(/^## /gm).slice(1);

        for (const section of sections) {
            const lines = section.trim().split('\n');
            const name = lines[0].trim();

            const agent: AgentDefinition = {
                id: '',
                name: name,
                model: 'gemini-2.0-flash-exp',
                temperature: 0.7,
                skills: []
            };

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('- id:')) {
                    agent.id = line.replace('- id:', '').trim();
                } else if (line.startsWith('- name:')) {
                    agent.name = line.replace('- name:', '').trim();
                } else if (line.startsWith('- model:')) {
                    agent.model = line.replace('- model:', '').trim();
                } else if (line.startsWith('- temperature:')) {
                    agent.temperature = parseFloat(line.replace('- temperature:', '').trim()) || 0.7;
                } else if (line.startsWith('- system_prompt_file:')) {
                    agent.system_prompt_file = line.replace('- system_prompt_file:', '').trim();
                } else if (line.startsWith('- specialization:')) {
                    agent.specialization = line.replace('- specialization:', '').trim().replace(/"/g, '');
                } else if (line.startsWith('- skills:')) {
                    // Parse skill list (next lines with - prefix at deeper indentation)
                    for (let j = i + 1; j < lines.length; j++) {
                        const skillLine = lines[j];
                        if (skillLine.match(/^\s+-\s+\w/)) {
                            agent.skills.push(skillLine.replace(/^\s+-\s+/, '').trim());
                        } else if (!skillLine.match(/^\s+/)) {
                            break;
                        }
                    }
                }
            }

            if (agent.id) {
                agents.push(agent);
            }
        }

        return agents;
    }

    /**
     * Load TOOLS.md content (raw for prompt injection)
     */
    loadTools(): string {
        const toolsPath = path.join(this.workspacePath, 'TOOLS.md');
        if (!fs.existsSync(toolsPath)) {
            console.warn('[MarkdownConfigLoader] TOOLS.md not found');
            return '';
        }
        return fs.readFileSync(toolsPath, 'utf-8');
    }

    /**
     * Load HEARTBEAT.md and parse checklist items
     */
    loadHeartbeatChecklist(): HeartbeatCheckItem[] {
        const heartbeatPath = path.join(this.workspacePath, 'HEARTBEAT.md');
        if (!fs.existsSync(heartbeatPath)) {
            console.warn('[MarkdownConfigLoader] HEARTBEAT.md not found');
            return [];
        }

        const content = fs.readFileSync(heartbeatPath, 'utf-8');
        const items: HeartbeatCheckItem[] = [];
        let currentCategory: string | undefined;

        const lines = content.split('\n');
        for (const line of lines) {
            // Detect category headers (## )
            if (line.startsWith('## ')) {
                currentCategory = line.replace('## ', '').trim();
            }
            // Detect checklist items (- [ ] or - [x])
            else if (line.match(/^-\s+\[[ x]\]\s+/i)) {
                const text = line.replace(/^-\s+\[[ x]\]\s+/i, '').trim();
                items.push({ text, category: currentCategory });
            }
        }

        return items;
    }

    /**
     * Load all skills from skills/ directory
     */
    loadSkills(): SkillDefinition[] {
        const skillsDir = path.join(this.workspacePath, 'skills');
        if (!fs.existsSync(skillsDir)) {
            console.warn('[MarkdownConfigLoader] skills/ directory not found');
            return [];
        }

        const skills: SkillDefinition[] = [];
        const skillFolders = fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const folder of skillFolders) {
            const skillPath = path.join(skillsDir, folder, 'SKILL.md');
            if (!fs.existsSync(skillPath)) continue;

            const content = fs.readFileSync(skillPath, 'utf-8');
            const skill = this.parseSkillMd(folder, content);
            if (skill) {
                skills.push(skill);
            }
        }

        return skills;
    }

    /**
     * Parse a SKILL.md file
     */
    private parseSkillMd(name: string, content: string): SkillDefinition | null {
        const skill: SkillDefinition = {
            name,
            description: '',
            provider: '',
            providerType: 'mcp_server',
            capabilities: [],
            config: {}
        };

        const lines = content.split('\n');
        let currentSection = '';

        for (const line of lines) {
            if (line.startsWith('## ')) {
                currentSection = line.replace('## ', '').trim().toLowerCase();
            } else if (currentSection === 'description') {
                if (line.trim() && !line.startsWith('#')) {
                    skill.description += line.trim() + ' ';
                }
            } else if (currentSection === 'provider') {
                if (line.startsWith('mcp_server:')) {
                    skill.providerType = 'mcp_server';
                    skill.provider = line.replace('mcp_server:', '').trim();
                } else if (line.startsWith('builtin:')) {
                    skill.providerType = 'builtin';
                    skill.provider = line.replace('builtin:', '').trim();
                }
            } else if (currentSection === 'capabilities') {
                if (line.match(/^-\s+\w/)) {
                    const cap = line.replace(/^-\s+/, '').trim();
                    skill.capabilities.push(cap);
                }
            } else if (currentSection === 'config') {
                const match = line.match(/^-\s+(\w+):\s*(.+)/);
                if (match) {
                    const [, key, value] = match;
                    skill.config[key] = value.trim();
                }
            }
        }

        skill.description = skill.description.trim();
        return skill.description ? skill : null;
    }

    /**
     * Get the main agent (first one with id: main, or first agent)
     */
    getMainAgent(): AgentDefinition | null {
        const agents = this.loadAgents();
        return agents.find(a => a.id === 'main') || agents[0] || null;
    }
}
