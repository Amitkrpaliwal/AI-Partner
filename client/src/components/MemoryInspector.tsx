import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { API_BASE } from '@/lib/api';
import { Archive, ChevronDown, ChevronRight, Play, Trash2 } from 'lucide-react';

interface Summary {
    id: string;
    summary_type: 'daily' | 'weekly';
    period_start: string;
    period_end: string;
    content: string;
    topics: string[];
    event_count: number;
    created_at: string;
}

interface Preference {
    id: string;
    key: string;
    value: string;
    confidence: number;
    source: string;
    updated_at: string;
}

interface Stats {
    archived: number;
    active: number;
    summaries: number;
}

type TabType = 'events' | 'persona' | 'facts' | 'summaries' | 'preferences';

export function MemoryInspector() {
    const [activeTab, setActiveTab] = useState<TabType>('events');
    const [data, setData] = useState<any>(null);

    // Phase 17 state
    const [summaries, setSummaries] = useState<Summary[]>([]);
    const [preferences, setPreferences] = useState<Preference[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [expandedSummary, setExpandedSummary] = useState<string | null>(null);
    const [actionResult, setActionResult] = useState<string | null>(null);
    const [filterType, setFilterType] = useState<'all' | 'daily' | 'weekly'>('all');

    useEffect(() => {
        fetchData(activeTab);
    }, [activeTab]);

    useEffect(() => {
        fetchConsolidationData();
    }, []);

    useEffect(() => {
        if (activeTab === 'summaries') fetchSummaries();
    }, [filterType]);

    const fetchData = async (tab: string) => {
        if (tab === 'summaries') { await fetchSummaries(); return; }
        if (tab === 'preferences') { await fetchPreferences(); return; }

        let url = '';
        if (tab === 'persona') url = `${API_BASE}/api/memory/persona`;
        if (tab === 'events') url = `${API_BASE}/api/memory/events?limit=20`;
        if (tab === 'facts') url = `${API_BASE}/api/memory/facts`;

        try {
            const res = await fetch(url);
            if (!res.ok) {
                setData({ _error: `Endpoint returned ${res.status}` });
                return;
            }
            const json = await res.json();
            setData(json);
        } catch (e) {
            console.error(`Failed to load ${tab}:`, e);
            setData({ _error: 'Failed to connect to server' });
        }
    };

    const fetchConsolidationData = async () => {
        await Promise.all([fetchSummaries(), fetchPreferences(), fetchStats()]);
    };

    const fetchSummaries = async () => {
        try {
            const type = filterType === 'all' ? '' : `?type=${filterType}`;
            const res = await fetch(`${API_BASE}/api/memory/consolidation/summaries${type}`);
            if (res.ok) {
                const data = await res.json();
                setSummaries(data.summaries || []);
            }
        } catch (e) { console.error(e); }
    };

    const fetchPreferences = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/memory/preferences`);
            if (res.ok) {
                const data = await res.json();
                setPreferences(data.preferences || []);
            }
        } catch (e) { console.error(e); }
    };

    const fetchStats = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/memory/consolidation/stats`);
            if (res.ok) setStats(await res.json());
        } catch (e) { console.error(e); }
    };

    const triggerConsolidation = async (type: 'daily' | 'weekly') => {
        setActionResult(`Running ${type} consolidation...`);
        try {
            const res = await fetch(`${API_BASE}/api/memory/consolidation/${type}`, { method: 'POST' });
            const data = await res.json();
            setActionResult(data.summary ? `${type} summary created (${data.summary.event_count} events)` : `No ${type} consolidation needed`);
            await fetchConsolidationData();
        } catch (e) { setActionResult(`Failed: ${e}`); }
        setTimeout(() => setActionResult(null), 5000);
    };

    const triggerArchive = async () => {
        setActionResult('Archiving old events...');
        try {
            const res = await fetch(`${API_BASE}/api/memory/consolidation/archive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days: 7 }),
            });
            const data = await res.json();
            setActionResult(`Archived ${data.archived} events`);
            await fetchStats();
        } catch (e) { setActionResult(`Failed: ${e}`); }
        setTimeout(() => setActionResult(null), 5000);
    };

    const deleteEvent = async (id: string) => {
        await fetch(`${API_BASE}/api/memory/events/${id}`, { method: 'DELETE' });
        setData((prev: any) => prev ? { ...prev, events: prev.events.filter((e: any) => e.id !== id) } : prev);
    };

    const clearAllEvents = async () => {
        if (!window.confirm('Delete all memory events?')) return;
        await fetch(`${API_BASE}/api/memory/events`, { method: 'DELETE' });
        setData((prev: any) => prev ? { ...prev, events: [] } : prev);
    };

    const deletePreference = async (id: string) => {
        await fetch(`${API_BASE}/api/memory/preferences/${id}`, { method: 'DELETE' });
        setPreferences(prev => prev.filter(p => p.id !== id));
    };

    const deleteFact = async (id: string) => {
        await fetch(`${API_BASE}/api/memory/facts/${id}`, { method: 'DELETE' });
        setData((prev: any) => prev ? { ...prev, facts: prev.facts.filter((f: any) => f.id !== id) } : prev);
    };

    const deleteSummary = async (id: string) => {
        await fetch(`${API_BASE}/api/memory/consolidation/summaries/${id}`, { method: 'DELETE' });
        setSummaries(prev => prev.filter(s => s.id !== id));
    };

    const tabs: { key: TabType; label: string }[] = [
        { key: 'events', label: 'Events' },
        { key: 'summaries', label: 'Summaries' },
        { key: 'preferences', label: 'Preferences' },
        { key: 'persona', label: 'Persona' },
        { key: 'facts', label: 'Facts' },
    ];

    return (
        <Card className="w-full">
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div className="flex space-x-2">
                        {tabs.map(tab => (
                            <Button
                                key={tab.key}
                                variant={activeTab === tab.key ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setActiveTab(tab.key)}
                            >
                                {tab.label}
                            </Button>
                        ))}
                    </div>

                    {/* Stats badges */}
                    {stats && (
                        <div className="flex gap-3 text-xs text-muted-foreground">
                            <span>{stats.active} active</span>
                            <span>{stats.archived} archived</span>
                            <span>{stats.summaries} summaries</span>
                        </div>
                    )}
                </div>
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    {/* Events List */}
                    {activeTab === 'events' && (
                        <div className="space-y-2">
                            <div className="flex justify-end">
                                <Button size="sm" variant="destructive" onClick={clearAllEvents} className="h-7 text-xs gap-1">
                                    <Trash2 className="h-3 w-3" /> Clear All
                                </Button>
                            </div>
                            <div className="space-y-2 max-h-[560px] overflow-y-auto">
                                {data?._error ? (
                                    <div className="text-center py-8 text-muted-foreground">{data._error}</div>
                                ) : (!data || (data.events && data.events.length === 0)) ? (
                                    <div className="text-center py-8 text-muted-foreground">No recent events found.</div>
                                ) : (
                                    (data.events || []).map((e: any, i: number) => (
                                        <div key={i} className="flex gap-4 p-3 border rounded-lg bg-card hover:bg-accent/5 transition-colors group">
                                            <div className="flex-col text-center min-w-[60px] text-xs text-muted-foreground border-r pr-2 flex justify-center">
                                                <span className="font-bold text-foreground">{new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                                <span>{new Date(e.timestamp).toLocaleDateString()}</span>
                                            </div>
                                            <div className="flex-1">
                                                <div className="text-sm">{e.event_text}</div>
                                                {e.type && <span className="text-[10px] uppercase bg-secondary px-1 rounded mt-1 inline-block">{e.type}</span>}
                                            </div>
                                            <button onClick={() => deleteEvent(e.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive p-1 self-start">
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}

                    {/* Summaries Tab (Phase 17) */}
                    {activeTab === 'summaries' && (
                        <div className="space-y-4">
                            {/* Actions bar */}
                            <div className="flex items-center justify-between">
                                <div className="flex gap-2">
                                    <Button size="sm" onClick={() => triggerConsolidation('daily')}>
                                        <Play className="h-3 w-3 mr-1" /> Daily
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => triggerConsolidation('weekly')}>
                                        <Play className="h-3 w-3 mr-1" /> Weekly
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={triggerArchive}>
                                        <Archive className="h-3 w-3 mr-1" /> Archive
                                    </Button>
                                </div>
                                <div className="flex gap-1">
                                    {(['all', 'daily', 'weekly'] as const).map(type => (
                                        <Button
                                            key={type}
                                            size="sm"
                                            variant={filterType === type ? 'default' : 'ghost'}
                                            onClick={() => setFilterType(type)}
                                            className="h-7 text-xs"
                                        >
                                            {type.charAt(0).toUpperCase() + type.slice(1)}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                            {actionResult && (
                                <p className="text-xs text-muted-foreground">{actionResult}</p>
                            )}

                            {summaries.length === 0 ? (
                                <p className="text-sm text-muted-foreground text-center py-8">
                                    No summaries yet. Run daily consolidation to create your first summary.
                                </p>
                            ) : (
                                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                                    {summaries.map(summary => (
                                        <div key={summary.id} className="border rounded-lg">
                                            <div className="flex items-center">
                                        <button
                                                className="flex-1 flex items-center justify-between p-3 text-left hover:bg-muted/50"
                                                onClick={() => setExpandedSummary(
                                                    expandedSummary === summary.id ? null : summary.id
                                                )}
                                            >
                                                <div className="flex items-center gap-3">
                                                    {expandedSummary === summary.id
                                                        ? <ChevronDown className="h-4 w-4" />
                                                        : <ChevronRight className="h-4 w-4" />
                                                    }
                                                    <span className={`text-xs px-2 py-0.5 rounded-full ${summary.summary_type === 'weekly'
                                                            ? 'bg-blue-500/20 text-blue-500'
                                                            : 'bg-green-500/20 text-green-500'
                                                        }`}>
                                                        {summary.summary_type}
                                                    </span>
                                                    <span className="text-sm font-medium">
                                                        {new Date(summary.period_start).toLocaleDateString()}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {summary.event_count} events
                                                    </span>
                                                </div>
                                                <div className="flex gap-1">
                                                    {summary.topics.slice(0, 3).map((topic, i) => (
                                                        <span key={i} className="text-[10px] px-1.5 py-0.5 bg-muted rounded">
                                                            {topic}
                                                        </span>
                                                    ))}
                                                </div>
                                            </button>
                                            {expandedSummary === summary.id && (
                                                <div className="px-4 pb-4 border-t">
                                                    <p className="text-sm whitespace-pre-wrap mt-3">{summary.content}</p>
                                                </div>
                                            )}
                                        </div>
                                        <button onClick={() => deleteSummary(summary.id)} className="px-3 text-muted-foreground hover:text-destructive transition-colors self-start pt-3">
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Preferences Tab (Phase 17) */}
                    {activeTab === 'preferences' && (
                        <div className="space-y-4">
                            {preferences.length === 0 ? (
                                <p className="text-sm text-muted-foreground text-center py-8">
                                    No preferences learned yet. Preferences are extracted from conversations automatically.
                                </p>
                            ) : (
                                <div className="border rounded-md">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b bg-muted/50">
                                                <th className="h-9 px-4 text-left font-medium">Key</th>
                                                <th className="h-9 px-4 text-left font-medium">Value</th>
                                                <th className="h-9 px-4 text-left font-medium">Confidence</th>
                                                <th className="h-9 px-4 text-left font-medium">Source</th>
                                                <th className="h-9 px-4 text-left font-medium">Updated</th>
                                                <th className="h-9 px-2" />
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {preferences.map(pref => (
                                                <tr key={pref.id} className="border-b last:border-0 hover:bg-muted/50 group">
                                                    <td className="p-3 font-mono text-xs">{pref.key}</td>
                                                    <td className="p-3">{pref.value}</td>
                                                    <td className="p-3">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                                                                <div
                                                                    className="h-full bg-purple-500 rounded-full"
                                                                    style={{ width: `${pref.confidence * 100}%` }}
                                                                />
                                                            </div>
                                                            <span className="text-xs text-muted-foreground">
                                                                {Math.round(pref.confidence * 100)}%
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="p-3 text-xs text-muted-foreground">{pref.source}</td>
                                                    <td className="p-3 text-xs text-muted-foreground">
                                                        {new Date(pref.updated_at).toLocaleDateString()}
                                                    </td>
                                                    <td className="p-2">
                                                        <button onClick={() => deletePreference(pref.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive">
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Persona View */}
                    {activeTab === 'persona' && (
                        <div className="space-y-4">
                            {data?._error ? (
                                <div className="text-center py-8 text-muted-foreground">{data._error}</div>
                            ) : data ? (
                                <>
                                    <div className="p-4 border rounded bg-primary/5">
                                        <h3 className="text-lg font-bold mb-1">{data.name}</h3>
                                        <p className="text-sm text-muted-foreground">{data.role}</p>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <Card>
                                            <CardHeader><CardTitle className="text-sm">Preferences</CardTitle></CardHeader>
                                            <CardContent className="text-sm space-y-1">
                                                {Object.entries(data.preferences || {}).map(([k, v]) => (
                                                    <div key={k} className="flex justify-between border-b last:border-0 pb-1">
                                                        <span className="text-muted-foreground">{k}:</span>
                                                        <span>{String(v)}</span>
                                                    </div>
                                                ))}
                                            </CardContent>
                                        </Card>
                                        <Card>
                                            <CardHeader><CardTitle className="text-sm">Style</CardTitle></CardHeader>
                                            <CardContent className="text-sm space-y-1">
                                                {Object.entries(data.style || {}).map(([k, v]) => (
                                                    <div key={k} className="flex justify-between border-b last:border-0 pb-1">
                                                        <span className="text-muted-foreground">{k}:</span>
                                                        <span>{String(v)}</span>
                                                    </div>
                                                ))}
                                            </CardContent>
                                        </Card>
                                    </div>
                                </>
                            ) : <div className="p-8 text-center">Loading persona...</div>}
                        </div>
                    )}

                    {/* Facts View */}
                    {activeTab === 'facts' && (
                        <div className="space-y-2">
                            {data?._error ? (
                                <div className="text-center py-8 text-muted-foreground">{data._error}</div>
                            ) : (!data || (data.facts && data.facts.length === 0)) ? (
                                <div className="text-center py-8 text-muted-foreground">No facts found.</div>
                            ) : (
                                (data.facts || []).map((f: any, i: number) => (
                                    <div key={i} className="p-2 border rounded bg-card flex justify-between items-center text-sm group">
                                        <div>
                                            <span className="font-bold text-blue-500">{f.subject}</span>
                                            <span className="mx-2 text-muted-foreground">{f.predicate}</span>
                                            <span className="font-mono bg-muted px-1 rounded">{f.object}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleDateString()}</span>
                                            <button onClick={() => deleteFact(f.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive">
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}

                </div>
            </CardContent>
        </Card>
    );
}
