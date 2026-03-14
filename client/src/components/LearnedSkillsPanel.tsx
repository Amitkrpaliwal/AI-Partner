import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GraduationCap, Trash2, ChevronDown, ChevronRight, Tag, AlertCircle, RefreshCw, Search, ArrowUpCircle, CheckCircle } from 'lucide-react';
import { API_BASE } from '@/lib/api';

interface SkillParam {
    name: string;
    type: string;
    description: string;
    required: boolean;
    default?: any;
}

interface LearnedSkill {
    id: string;
    name: string;
    description: string;
    runtime: 'python' | 'node';
    version: number;
    tags: string[];
    parameters: SkillParam[];
    successCount: number;
    failureCount: number;
    readyToPromote?: boolean;
    createdAt: string;
    updatedAt: string;
}

interface SkillVersion {
    version: number;
    script: string;
    goalDescription: string;
    createdAt: string;
}

export function LearnedSkillsPanel() {
    const [skills, setSkills] = useState<LearnedSkill[]>([]);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [versions, setVersions] = useState<SkillVersion[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [promoting, setPromoting] = useState<string | null>(null);
    const [promoted, setPromoted] = useState<string | null>(null);

    useEffect(() => { fetchSkills(); }, []);

    const fetchSkills = async () => {
        setLoading(true);
        setError(null);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`${API_BASE}/api/skills/learned`, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            setSkills(data.skills || []);
        } catch (e: any) {
            setError(e.name === 'AbortError' ? 'Server unreachable — is the backend running?' : e.message);
        } finally {
            setLoading(false);
        }
    };

    const toggleExpand = async (id: string) => {
        if (expanded === id) {
            setExpanded(null);
            return;
        }
        setExpanded(id);
        try {
            const res = await fetch(`${API_BASE}/api/skills/learned/${id}/versions`);
            const data = await res.json();
            setVersions(data.versions || []);
        } catch (e: any) {
            setVersions([]);
        }
    };

    const deleteSkill = async (id: string) => {
        try {
            await fetch(`${API_BASE}/api/skills/learned/${id}`, { method: 'DELETE' });
            setSkills(skills.filter(s => s.id !== id));
            if (expanded === id) setExpanded(null);
        } catch (e: any) {
            setError(e.message);
        }
    };

    const successRate = (s: LearnedSkill) => {
        const total = s.successCount + s.failureCount;
        return total === 0 ? 0 : Math.round((s.successCount / total) * 100);
    };

    const promoteSkill = async (skill: LearnedSkill) => {
        setPromoting(skill.id);
        try {
            const res = await fetch(`${API_BASE}/api/skills/learned/${encodeURIComponent(skill.name)}/promote`, { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                setPromoted(skill.id);
                setTimeout(() => setPromoted(null), 3000);
            } else {
                setError(data.error || 'Promotion failed');
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setPromoting(null);
        }
    };

    const filteredSkills = skills.filter(s =>
        !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.description?.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="p-4 h-full overflow-auto space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <GraduationCap className="w-6 h-6 text-amber-400" /> Learned Skills
                </h1>
                <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{skills.length} skills</span>
                    <button onClick={fetchSkills} className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-muted-foreground/20 transition-colors">
                        <RefreshCw className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                    className="w-full pl-9 pr-3 py-2 text-sm bg-muted/60 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                    placeholder="Search skills..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
            </div>

            {/* Error */}
            {error && (
                <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                    <button onClick={() => { setError(null); fetchSkills(); }} className="ml-auto text-red-400 hover:text-red-200 text-xs">Retry</button>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="text-center text-muted-foreground py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full mx-auto mb-2" />
                    Loading skills...
                </div>
            )}

            {/* Empty */}
            {!loading && !error && skills.length === 0 && (
                <div className="text-center text-muted-foreground/70 py-12">
                    <GraduationCap className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    <p>No learned skills yet</p>
                    <p className="text-xs mt-1">Complete tasks in Goal mode — the system learns from successes</p>
                </div>
            )}

            {/* Skills List */}
            {filteredSkills.map(skill => (
                <Card key={skill.id} className="border-border">
                    <CardHeader className="pb-2 cursor-pointer" onClick={() => toggleExpand(skill.id)}>
                        <CardTitle className="text-sm flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {expanded === skill.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                <span className="text-foreground">{skill.name}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${skill.runtime === 'python' ? 'bg-blue-900/40 text-blue-300' : 'bg-yellow-900/40 text-yellow-300'}`}>
                                    {skill.runtime}
                                </span>
                                <span className="text-xs text-muted-foreground/70">v{skill.version}</span>
                                {skill.readyToPromote && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">
                                        ⬆ Ready to Promote
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-3">
                                <span className={`text-xs ${successRate(skill) >= 80 ? 'text-emerald-400' : successRate(skill) >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                                    {successRate(skill)}% success
                                </span>
                                {skill.readyToPromote && (
                                    <button
                                        onClick={e => { e.stopPropagation(); promoteSkill(skill); }}
                                        disabled={promoting === skill.id}
                                        title="Promote to Tool Marketplace"
                                        className="p-1 rounded hover:bg-amber-500/20 text-amber-400 transition-colors disabled:opacity-50"
                                    >
                                        {promoted === skill.id ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
                                    </button>
                                )}
                                <button onClick={e => { e.stopPropagation(); deleteSkill(skill.id); }}
                                    className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground/70 hover:text-red-400 transition-colors">
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </CardTitle>
                    </CardHeader>

                    {expanded === skill.id && (
                        <CardContent className="space-y-3">
                            <p className="text-sm text-muted-foreground">{skill.description}</p>

                            {/* Tags */}
                            {skill.tags.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {skill.tags.map(t => (
                                        <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted text-muted-foreground rounded text-xs">
                                            <Tag className="w-3 h-3" /> {t}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Parameters */}
                            {skill.parameters.length > 0 && (
                                <div>
                                    <h4 className="text-xs font-semibold text-muted-foreground mb-1">Parameters</h4>
                                    <div className="space-y-1">
                                        {skill.parameters.map(p => (
                                            <div key={p.name} className="flex items-center gap-2 text-xs">
                                                <code className="bg-muted px-1.5 py-0.5 rounded text-amber-300">{p.name}</code>
                                                <span className="text-muted-foreground/70">{p.type}</span>
                                                {p.required && <span className="text-red-400">*</span>}
                                                <span className="text-zinc-600">— {p.description}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Version History */}
                            {versions.length > 0 && (
                                <div>
                                    <h4 className="text-xs font-semibold text-muted-foreground mb-1">Version History</h4>
                                    <div className="space-y-1">
                                        {versions.map(v => (
                                            <div key={v.version} className="flex items-center justify-between text-xs py-1 border-b border-border last:border-none">
                                                <span className="text-muted-foreground">v{v.version}: {v.goalDescription?.substring(0, 60) || 'No description'}...</span>
                                                <span className="text-muted-foreground/70">{new Date(v.createdAt).toLocaleDateString()}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="text-xs text-zinc-600 flex justify-between">
                                <span>✅ {skill.successCount} | ❌ {skill.failureCount}</span>
                                <span>Updated: {new Date(skill.updatedAt).toLocaleDateString()}</span>
                            </div>
                        </CardContent>
                    )}
                </Card>
            ))}
        </div>
    );
}
