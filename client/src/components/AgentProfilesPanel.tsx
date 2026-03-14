import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { Plus, Edit2, Trash2, Brain, MessageSquare, ChevronDown, ChevronRight, X, Save, Sparkles, Copy, Check, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentProfile {
    id: string;
    name: string;
    slug: string;
    role: string;
    systemPrompt: string;
    toolWhitelist: string[];
    avatarColor: string;
    memoryNamespace: string;
    description: string;
    maxIterations: number;
    autoSelectKeywords: string[];
    agentType: 'research' | 'execution' | 'delivery' | 'synthesis';
    createdAt: string;
}

// ─── Tool groups for whitelist picker ─────────────────────────────────────────

const TOOL_GROUPS: { label: string; color: string; tools: string[] }[] = [
    {
        label: 'Search',
        color: 'text-blue-400',
        tools: ['web_search', 'web_fetch', 'web_search_status'],
    },
    {
        label: 'Browser',
        color: 'text-purple-400',
        tools: ['browser_navigate', 'browser_click', 'browser_extract', 'browser_fetch',
                'browser_screenshot', 'browser_launch'],
    },
    {
        label: 'Files',
        color: 'text-green-400',
        tools: ['read_file', 'write_file', 'edit_file', 'list_directory',
                'create_directory', 'delete_file', 'move_file', 'get_file_info', 'search_files'],
    },
    {
        label: 'Code Execution',
        color: 'text-orange-400',
        tools: ['run_command', 'run_script'],
    },
    {
        label: 'Messaging',
        color: 'text-pink-400',
        tools: ['messaging_send', 'messaging_send_file', 'messaging_status'],
    },
    {
        label: 'Memory',
        color: 'text-amber-400',
        tools: ['memory_store', 'memory_retrieve', 'memory_list'],
    },
];

const AGENT_TYPE_OPTIONS = [
    { value: 'research',   label: 'Research',   desc: 'Partial results acceptable — synthesizes what was found', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
    { value: 'execution',  label: 'Execution',  desc: 'Partial = wrong — escalates to Goal mode on cap', color: 'bg-orange-500/10 text-orange-400 border-orange-500/30' },
    { value: 'delivery',   label: 'Delivery',   desc: 'Partial = nothing sent — flags clearly and gives retry hint', color: 'bg-pink-500/10 text-pink-400 border-pink-500/30' },
    { value: 'synthesis',  label: 'Synthesis',  desc: 'Partial draft acceptable — returns with caveat', color: 'bg-green-500/10 text-green-400 border-green-500/30' },
];

const ROLE_OPTIONS = [
    { value: 'general assistant', label: 'General Assistant' },
    { value: 'researcher', label: 'Researcher' },
    { value: 'coder', label: 'Coder' },
    { value: 'reviewer', label: 'Code Reviewer' },
    { value: 'planner', label: 'Planner' },
    { value: 'analyst', label: 'Data Analyst' },
    { value: 'devops', label: 'DevOps Engineer' },
    { value: 'writer', label: 'Technical Writer' },
];

const AVATAR_COLORS = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
    '#f97316', '#eab308', '#22c55e', '#06b6d4',
    '#3b82f6', '#14b8a6',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mirror the server-side deriveSlug() for live preview */
function previewSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '…';
}

function emptyForm() {
    return {
        name: '',
        role: 'general assistant',
        systemPrompt: '',
        toolWhitelist: [] as string[],
        avatarColor: AVATAR_COLORS[0],
        description: '',
        maxIterations: 15,
        autoSelectKeywords: [] as string[],
        agentType: 'research' as 'research' | 'execution' | 'delivery' | 'synthesis',
    };
}

// ─── Profile Avatar ───────────────────────────────────────────────────────────

function ProfileAvatar({ profile, size = 40 }: { profile: Pick<AgentProfile, 'name' | 'avatarColor'>; size?: number }) {
    return (
        <div
            className="flex items-center justify-center rounded-xl font-bold text-white select-none shrink-0"
            style={{ width: size, height: size, backgroundColor: profile.avatarColor, fontSize: size * 0.4 }}
        >
            {profile.name.charAt(0).toUpperCase() || '?'}
        </div>
    );
}

// ─── Copy-to-clipboard badge ──────────────────────────────────────────────────

function CopyBadge({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (
        <button
            onClick={copy}
            title={`Copy ${label}`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
            {copied ? <Check size={9} /> : <Copy size={9} />}
            {label}
        </button>
    );
}

// ─── Profile Form ─────────────────────────────────────────────────────────────

type FormData = ReturnType<typeof emptyForm>;

function ProfileForm({
    initial,
    onSave,
    onCancel,
    saving,
}: {
    initial: FormData;
    onSave: (data: FormData) => void;
    onCancel: () => void;
    saving: boolean;
}) {
    const [form, setForm] = useState<FormData>(initial);
    const [keywordsRaw, setKeywordsRaw] = useState(initial.autoSelectKeywords.join(', '));
    const [genDescription, setGenDescription] = useState('');
    const [generating, setGenerating] = useState(false);
    const [genError, setGenError] = useState<string | null>(null);
    const [showGen, setShowGen] = useState(false);

    const set = <K extends keyof FormData>(key: K, val: FormData[K]) =>
        setForm(f => ({ ...f, [key]: val }));

    const handleGenerate = async () => {
        if (!genDescription.trim()) return;
        setGenerating(true);
        setGenError(null);
        try {
            const res = await fetch(`${API_BASE}/api/agent-profiles/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: genDescription }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Generation failed');
            setForm(f => ({
                ...f,
                name: data.name || f.name,
                role: data.role || f.role,
                description: data.description || f.description,
                systemPrompt: data.systemPrompt || f.systemPrompt,
                toolWhitelist: data.toolWhitelist || f.toolWhitelist,
                avatarColor: data.avatarColor || f.avatarColor,
                maxIterations: data.maxIterations ?? f.maxIterations,
                autoSelectKeywords: data.autoSelectKeywords || f.autoSelectKeywords,
                agentType: data.agentType || f.agentType,
            }));
            setKeywordsRaw((data.autoSelectKeywords || []).join(', '));
            setShowGen(false);
        } catch (e: any) {
            setGenError(e.message);
        } finally {
            setGenerating(false);
        }
    };

    const commitKeywords = (raw: string) => {
        const kws = raw.split(',').map(k => k.trim()).filter(Boolean);
        set('autoSelectKeywords', kws);
    };

    return (
        <div className="space-y-4">
            {/* ── AI Generate Section ── */}
            <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
                <button
                    type="button"
                    onClick={() => setShowGen(v => !v)}
                    className="flex items-center gap-1.5 text-xs font-medium text-primary w-full"
                >
                    <Sparkles size={13} />
                    {showGen ? 'Hide AI Generator' : 'Generate profile with AI'}
                    <ChevronDown size={12} className={cn('ml-auto transition-transform', showGen && 'rotate-180')} />
                </button>
                {showGen && (
                    <div className="mt-2 space-y-2">
                        <textarea
                            className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                            rows={2}
                            placeholder="Describe what this agent should do, e.g. 'A DevOps expert that monitors CI/CD pipelines and troubleshoots Kubernetes clusters'"
                            value={genDescription}
                            onChange={e => setGenDescription(e.target.value)}
                        />
                        {genError && <p className="text-xs text-destructive">{genError}</p>}
                        <button
                            type="button"
                            onClick={handleGenerate}
                            disabled={generating || !genDescription.trim()}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                        >
                            <Sparkles size={12} />
                            {generating ? 'Generating…' : 'Generate & Fill Form'}
                        </button>
                    </div>
                )}
            </div>

            {/* ── Name + Role ── */}
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Agent Name *</label>
                    <input
                        className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="e.g. DevOps Alice"
                        value={form.name}
                        onChange={e => set('name', e.target.value)}
                    />
                    {form.name && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                            @mention: <span className="text-primary">@{previewSlug(form.name)}</span>
                        </p>
                    )}
                </div>
                <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Role</label>
                    <select
                        className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                        value={form.role}
                        onChange={e => set('role', e.target.value)}
                    >
                        {ROLE_OPTIONS.map(r => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* ── Description ── */}
            <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
                <input
                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Short description of this agent's expertise"
                    value={form.description}
                    onChange={e => set('description', e.target.value)}
                />
            </div>

            {/* ── System Prompt ── */}
            <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    System Prompt
                    <span className="ml-1 text-muted-foreground/60">(defines personality &amp; behavior)</span>
                </label>
                <textarea
                    className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
                    rows={6}
                    placeholder={`You are a ${form.role} specialist. Your task is to...`}
                    value={form.systemPrompt}
                    onChange={e => set('systemPrompt', e.target.value)}
                />
            </div>

            {/* ── Agent Type ── */}
            <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block">
                    Agent Type
                    <span className="ml-1 text-muted-foreground/60">(controls behaviour when iteration cap is hit)</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                    {AGENT_TYPE_OPTIONS.map(opt => (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => set('agentType', opt.value as any)}
                            className={cn(
                                'text-left px-3 py-2 rounded-lg border text-xs transition-all',
                                form.agentType === opt.value
                                    ? `${opt.color} border-current font-medium`
                                    : 'border-border text-muted-foreground hover:border-muted-foreground/50'
                            )}
                        >
                            <div className="font-semibold">{opt.label}</div>
                            <div className="text-[10px] mt-0.5 opacity-80 leading-snug">{opt.desc}</div>
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Tool Whitelist ── */}
            <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Tool Whitelist
                    <span className="ml-1 text-muted-foreground/60">
                        ({form.toolWhitelist.length === 0 ? 'all tools allowed' : `${form.toolWhitelist.length} selected`})
                    </span>
                </label>
                <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
                    {TOOL_GROUPS.map(group => (
                        <div key={group.label} className="p-2.5">
                            <div className={cn('text-[10px] font-semibold uppercase tracking-wide mb-1.5', group.color)}>
                                {group.label}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {group.tools.map(tool => {
                                    const checked = form.toolWhitelist.includes(tool);
                                    return (
                                        <button
                                            key={tool}
                                            type="button"
                                            onClick={() => {
                                                set('toolWhitelist', checked
                                                    ? form.toolWhitelist.filter(t => t !== tool)
                                                    : [...form.toolWhitelist, tool]
                                                );
                                            }}
                                            className={cn(
                                                'px-2 py-0.5 rounded text-[10px] font-mono border transition-all',
                                                checked
                                                    ? 'bg-primary/15 border-primary/40 text-primary'
                                                    : 'border-border text-muted-foreground/60 hover:border-muted-foreground/40 hover:text-muted-foreground'
                                            )}
                                        >
                                            {tool}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
                {form.toolWhitelist.length > 0 && (
                    <button
                        type="button"
                        onClick={() => set('toolWhitelist', [])}
                        className="mt-1 text-[10px] text-muted-foreground hover:text-foreground underline"
                    >
                        Clear selection (allow all tools)
                    </button>
                )}
            </div>

            {/* ── Auto-Keywords + Max Iterations ── */}
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                        Auto-Select Keywords
                        <span className="ml-1 text-muted-foreground/60">(comma-separated)</span>
                    </label>
                    <input
                        className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="kubernetes, docker, ci/cd"
                        value={keywordsRaw}
                        onChange={e => { setKeywordsRaw(e.target.value); commitKeywords(e.target.value); }}
                    />
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                        Auto-routes matching goals to this agent
                    </p>
                </div>
                <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Max Iterations</label>
                    <input
                        type="number"
                        min={5}
                        max={100}
                        className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                        value={form.maxIterations}
                        onChange={e => set('maxIterations', parseInt(e.target.value, 10) || 15)}
                    />
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                        Goal execution iteration cap
                    </p>
                </div>
            </div>

            {/* ── Avatar Color ── */}
            <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block">Avatar Color</label>
                <div className="flex gap-2 flex-wrap">
                    {AVATAR_COLORS.map(color => (
                        <button
                            key={color}
                            type="button"
                            onClick={() => set('avatarColor', color)}
                            className={cn(
                                'w-7 h-7 rounded-lg transition-all',
                                form.avatarColor === color ? 'ring-2 ring-offset-2 ring-ring scale-110' : 'opacity-70 hover:opacity-100'
                            )}
                            style={{ backgroundColor: color }}
                        />
                    ))}
                </div>
            </div>

            {/* ── Preview ── */}
            <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                <ProfileAvatar profile={form} />
                <div>
                    <p className="font-medium text-sm">{form.name || 'Agent Name'}</p>
                    <p className="text-xs text-muted-foreground">{form.role}</p>
                    {form.name && (
                        <p className="text-[10px] font-mono text-primary/70">@{previewSlug(form.name)}</p>
                    )}
                </div>
            </div>

            {/* ── Actions ── */}
            <div className="flex gap-2 pt-2">
                <button
                    onClick={() => onSave(form)}
                    disabled={saving || !form.name.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                    <Save size={14} />
                    {saving ? 'Saving...' : 'Save Profile'}
                </button>
                <button
                    onClick={onCancel}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm bg-muted text-muted-foreground rounded-lg hover:bg-muted/80 transition-colors"
                >
                    <X size={14} />
                    Cancel
                </button>
            </div>
        </div>
    );
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface AgentProfilesPanelProps {
    selectedProfileId?: string | null;
    onSelectProfile?: (profile: AgentProfile | null) => void;
}

export function AgentProfilesPanel({ selectedProfileId, onSelectProfile }: AgentProfilesPanelProps) {
    const [profiles, setProfiles] = useState<AgentProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [editingProfile, setEditingProfile] = useState<AgentProfile | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [seeding, setSeeding] = useState(false);
    const [seedResult, setSeedResult] = useState<{ inserted: string[]; skipped: string[] } | null>(null);
    const [memoryCache, setMemoryCache] = useState<Record<string, any>>({});

    useEffect(() => { fetchProfiles(); }, []);

    const fetchProfiles = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/api/agent-profiles`);
            const data = await res.json();
            setProfiles(data.profiles || []);
        } catch (e: any) {
            setError('Failed to load profiles');
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (form: FormData) => {
        setSaving(true);
        try {
            const isEdit = !!editingProfile;
            const url = isEdit
                ? `${API_BASE}/api/agent-profiles/${editingProfile!.id}`
                : `${API_BASE}/api/agent-profiles`;
            const method = isEdit ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Save failed');
            }
            await fetchProfiles();
            setShowForm(false);
            setEditingProfile(null);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (profile: AgentProfile) => {
        if (!confirm(`Delete profile "${profile.name}"? This cannot be undone.`)) return;
        try {
            await fetch(`${API_BASE}/api/agent-profiles/${profile.id}`, { method: 'DELETE' });
            await fetchProfiles();
            if (selectedProfileId === profile.id) onSelectProfile?.(null);
        } catch {
            setError('Delete failed');
        }
    };

    const handleSeed = async () => {
        setSeeding(true);
        setSeedResult(null);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/api/agent-profiles/seed`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Seed failed');
            setSeedResult(data);
            await fetchProfiles();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setSeeding(false);
        }
    };

    const loadMemory = async (profile: AgentProfile) => {
        if (memoryCache[profile.id]) return;
        try {
            const res = await fetch(`${API_BASE}/api/agent-profiles/${profile.id}/memory`);
            const data = await res.json();
            setMemoryCache(c => ({ ...c, [profile.id]: data }));
        } catch { /* ignore */ }
    };

    const toggleExpand = (profile: AgentProfile) => {
        const next = expandedId === profile.id ? null : profile.id;
        setExpandedId(next);
        if (next) loadMemory(profile);
    };

    const profileToFormData = (p: AgentProfile): FormData => ({
        name: p.name,
        role: p.role,
        systemPrompt: p.systemPrompt,
        toolWhitelist: p.toolWhitelist,
        avatarColor: p.avatarColor,
        description: p.description,
        maxIterations: p.maxIterations ?? 15,
        autoSelectKeywords: p.autoSelectKeywords ?? [],
        agentType: p.agentType ?? 'research',
    });

    return (
        <div className="p-4 h-full overflow-auto space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold flex items-center gap-2">
                        <Brain className="w-5 h-5 text-primary" />
                        Agent Profiles
                    </h1>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        Named specialists — use <code className="bg-muted px-1 rounded">@slug</code> in chat to invoke any profile
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleSeed}
                        disabled={seeding}
                        title="Insert 16 pre-designed specialist profiles (skips existing slugs)"
                        className="flex items-center gap-1.5 px-3 py-2 text-sm bg-muted text-muted-foreground border border-border rounded-lg hover:bg-muted/80 disabled:opacity-50 transition-colors"
                    >
                        <Sparkles size={14} />
                        {seeding ? 'Loading…' : 'Starter Pack'}
                    </button>
                    <button
                        onClick={() => { setShowForm(true); setEditingProfile(null); }}
                        className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                    >
                        <Plus size={15} />
                        New Profile
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
                    {error}
                    <button className="ml-2 underline" onClick={() => setError(null)}>Dismiss</button>
                </div>
            )}

            {/* Seed result banner */}
            {seedResult && (
                <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-sm">
                    <div className="flex items-center justify-between">
                        <span className="text-green-400 font-medium">
                            Starter Pack loaded — {seedResult.inserted.length} added
                            {seedResult.skipped.length > 0 && `, ${seedResult.skipped.length} already existed`}
                        </span>
                        <button className="text-xs text-muted-foreground underline" onClick={() => setSeedResult(null)}>Dismiss</button>
                    </div>
                    {seedResult.inserted.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                            {seedResult.inserted.map(s => (
                                <span key={s} className="text-[10px] font-mono bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded">@{s}</span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Create / Edit Form */}
            {showForm && (
                <div className="border rounded-xl p-4 bg-card">
                    <h2 className="text-sm font-semibold mb-3">
                        {editingProfile ? `Edit: ${editingProfile.name}` : 'Create New Profile'}
                    </h2>
                    <ProfileForm
                        initial={editingProfile ? profileToFormData(editingProfile) : emptyForm()}
                        onSave={handleSave}
                        onCancel={() => { setShowForm(false); setEditingProfile(null); }}
                        saving={saving}
                    />
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="text-center py-8 text-muted-foreground">Loading profiles...</div>
            )}

            {/* Empty State */}
            {!loading && profiles.length === 0 && !showForm && (
                <div className="text-center py-12 text-muted-foreground">
                    <Brain className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No agent profiles yet</p>
                    <p className="text-sm mt-1">Create your first specialist — or click "Generate with AI" for an instant profile</p>
                    <button
                        onClick={() => setShowForm(true)}
                        className="mt-3 flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors mx-auto"
                    >
                        <Sparkles size={14} />
                        Create First Profile
                    </button>
                </div>
            )}

            {/* Profile Cards */}
            {profiles.map(profile => (
                <div
                    key={profile.id}
                    className={cn(
                        'border rounded-xl bg-card transition-all',
                        selectedProfileId === profile.id ? 'border-primary ring-1 ring-primary' : 'border-border'
                    )}
                >
                    {/* Card Header */}
                    <div className="flex items-center gap-3 p-4">
                        <ProfileAvatar profile={profile} />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-sm truncate">{profile.name}</span>
                                <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded-full text-muted-foreground">
                                    {profile.role}
                                </span>
                                {profile.agentType && profile.agentType !== 'research' && (
                                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border font-medium',
                                        AGENT_TYPE_OPTIONS.find(o => o.value === profile.agentType)?.color ?? 'text-muted-foreground'
                                    )}>
                                        {profile.agentType}
                                    </span>
                                )}
                                {/* @slug badge — click to copy */}
                                {profile.slug && (
                                    <CopyBadge text={`@${profile.slug}`} label={`@${profile.slug}`} />
                                )}
                            </div>
                            {profile.description && (
                                <p className="text-xs text-muted-foreground truncate mt-0.5">{profile.description}</p>
                            )}
                            {/* Auto-select keyword badges */}
                            {profile.autoSelectKeywords?.length > 0 && (
                                <div className="flex items-center gap-1 mt-1 flex-wrap">
                                    <Tag size={9} className="text-muted-foreground/60" />
                                    {profile.autoSelectKeywords.map(kw => (
                                        <span key={kw} className="text-[9px] px-1.5 py-0.5 bg-primary/10 text-primary rounded-full">
                                            {kw}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                            <button
                                title="Chat with this agent"
                                onClick={() => onSelectProfile?.(selectedProfileId === profile.id ? null : profile)}
                                className={cn(
                                    'p-1.5 rounded-lg transition-colors',
                                    selectedProfileId === profile.id
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-accent'
                                )}
                            >
                                <MessageSquare size={13} />
                            </button>
                            <button
                                title="Edit"
                                onClick={() => { setEditingProfile(profile); setShowForm(true); }}
                                className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-accent transition-colors"
                            >
                                <Edit2 size={13} />
                            </button>
                            <button
                                title="Delete"
                                onClick={() => handleDelete(profile)}
                                className="p-1.5 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                            >
                                <Trash2 size={13} />
                            </button>
                            <button
                                title="View memory & details"
                                onClick={() => toggleExpand(profile)}
                                className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-accent transition-colors"
                            >
                                {expandedId === profile.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                        </div>
                    </div>

                    {/* Expanded: memory + system prompt preview */}
                    {expandedId === profile.id && (
                        <div className="border-t px-4 pb-4 pt-3 space-y-3">
                            <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                                <span>ns: <code className="font-mono">{profile.memoryNamespace}</code></span>
                                <span>max iter: {profile.maxIterations ?? 15}</span>
                            </div>

                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Memory
                            </h3>
                            {memoryCache[profile.id] ? (
                                <div className="space-y-2">
                                    <p className="text-[11px] text-muted-foreground">
                                        Recent Events ({memoryCache[profile.id].events?.length || 0})
                                    </p>
                                    {(memoryCache[profile.id].events || []).slice(0, 5).map((e: any, i: number) => (
                                        <div key={i} className="text-xs py-1 border-b border-border/50 last:border-0">
                                            <span className="text-muted-foreground">
                                                {new Date(e.timestamp).toLocaleTimeString()}
                                            </span>
                                            {' '}
                                            {e.event_text?.substring(0, 100)}
                                        </div>
                                    ))}
                                    {(memoryCache[profile.id].events || []).length === 0 && (
                                        <p className="text-xs text-muted-foreground italic">
                                            No memory yet — invoke with <code className="bg-muted px-1 rounded">@{profile.slug}</code> to start building context.
                                        </p>
                                    )}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">Loading memory...</p>
                            )}

                            {profile.systemPrompt && (
                                <div>
                                    <p className="text-[11px] text-muted-foreground mb-1">System Prompt</p>
                                    <pre className="text-xs text-muted-foreground bg-muted/30 rounded p-2 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono">
                                        {profile.systemPrompt}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
