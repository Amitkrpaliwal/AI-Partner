import { API_BASE } from '@/lib/api';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

interface Skill {
    id: string;
    name: string;
    description: string;
    provider: string;
    providerType: 'mcp_server' | 'builtin';
    enabled: boolean;
    config: Record<string, any>;
    installedAt?: string;
    updatedAt?: string;
}

export function SkillsManager() {
    const [skills, setSkills] = useState<Skill[]>([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchSkills = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/skills`);
            const data = await res.json();
            setSkills(data.skills || []);
            setError(null);
        } catch (e) {
            setError('Failed to load skills');
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSkills();
    }, []);

    const syncSkills = async () => {
        setSyncing(true);
        try {
            await fetch(`${API_BASE}/api/skills/sync`, { method: 'POST' });
            await fetchSkills();
        } catch (e) {
            setError('Failed to sync skills');
        } finally {
            setSyncing(false);
        }
    };

    const toggleSkill = async (id: string, enabled: boolean) => {
        try {
            const endpoint = enabled ? 'disable' : 'enable';
            await fetch(`${API_BASE}/api/skills/${id}/${endpoint}`, { method: 'POST' });
            await fetchSkills();
        } catch (e) {
            setError('Failed to toggle skill');
        }
    };

    const providerTypeLabel: Record<string, string> = {
        mcp_server: 'MCP Server',
        builtin: 'Built-in'
    };

    const providerColors: Record<string, string> = {
        mcp_server: 'bg-purple-500/20 text-purple-400',
        builtin: 'bg-blue-500/20 text-blue-400'
    };

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="flex items-center gap-2">
                    <span>?? Skills</span>
                    <span className="text-sm font-normal text-muted-foreground">
                        ({skills.filter(s => s.enabled).length}/{skills.length} active)
                    </span>
                </CardTitle>
                <button
                    onClick={syncSkills}
                    disabled={syncing}
                    className="px-3 py-1.5 text-sm rounded-md bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-50"
                >
                    {syncing ? 'Syncing...' : 'Sync from Workspace'}
                </button>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="text-center py-8 text-muted-foreground">
                        Loading skills...
                    </div>
                ) : error ? (
                    <div className="text-center py-8 text-red-400">
                        {error}
                    </div>
                ) : skills.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                        <p>No skills installed</p>
                        <p className="text-sm mt-2">
                            Add SKILL.md files to your workspace's <code>skills/</code> directory
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {skills.map(skill => (
                            <div
                                key={skill.id}
                                className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${skill.enabled
                                        ? 'bg-card border-border'
                                        : 'bg-muted/30 border-border/50 opacity-60'
                                    }`}
                            >
                                <div className="flex items-center gap-3">
                                    <div
                                        className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg ${skill.enabled ? 'bg-primary/20' : 'bg-muted'
                                            }`}
                                    >
                                        {skill.name.charAt(0).toUpperCase()}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">{skill.name}</span>
                                            <span className={`px-2 py-0.5 text-xs rounded ${providerColors[skill.providerType]}`}>
                                                {providerTypeLabel[skill.providerType]}
                                            </span>
                                        </div>
                                        <p className="text-sm text-muted-foreground">
                                            {skill.description}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => toggleSkill(skill.id, skill.enabled)}
                                    className={`px-3 py-1.5 text-sm rounded-md transition-colors ${skill.enabled
                                            ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                                            : 'bg-gray-500/20 text-gray-400 hover:bg-gray-500/30'
                                        }`}
                                >
                                    {skill.enabled ? 'Enabled' : 'Disabled'}
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
