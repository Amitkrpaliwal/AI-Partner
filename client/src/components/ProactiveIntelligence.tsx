/**
 * ProactiveIntelligence — View for configuring and monitoring the proactive agent.
 *
 * Shows:
 *  - Enable/disable toggle + heartbeat status
 *  - Last N heartbeat log entries
 *  - Inline HEARTBEAT.md editor (what tasks the agent monitors)
 *  - Inline SOUL.md editor (agent character + quiet hours)
 *  - "Run Now" button to trigger a manual tick
 */

import { API_BASE } from '@/lib/api';
import { useState, useEffect, useCallback } from 'react';
import {
    Zap, RefreshCw, Play, Clock, CheckCircle, XCircle, AlertCircle,
    ChevronDown, ChevronUp, Edit3, Save, X, Heart, Bell
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { getSocket } from '@/lib/socket';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface HeartbeatLog {
    id: string;
    status: 'ok' | 'action_taken' | 'error';
    action_taken: string;
    result: string;
    timestamp: string;
}

interface HeartbeatStatus {
    enabled: boolean;
    interval: string;
    lastTick: string | null;
    nextTick: string;
    preferredChannel?: string;
    channelChatId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MarkdownEditor — minimal inline editor for SOUL/HEARTBEAT files
// ─────────────────────────────────────────────────────────────────────────────

function MarkdownEditor({
    title,
    getUrl,
    putUrl,
}: {
    title: string;
    getUrl: string;
    putUrl: string;
}) {
    const [content, setContent] = useState('');
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await fetch(getUrl);
            const data = await r.json();
            setContent(data.content || '');
        } catch {
            setContent('');
        } finally {
            setLoading(false);
        }
    }, [getUrl]);

    useEffect(() => {
        if (expanded) load();
    }, [expanded, load]);

    const startEdit = () => {
        setDraft(content);
        setEditing(true);
    };

    const cancelEdit = () => {
        setEditing(false);
        setDraft('');
    };

    const save = async () => {
        setSaving(true);
        try {
            await fetch(putUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: draft }),
            });
            setContent(draft);
            setEditing(false);
        } catch (e) {
            console.error('Save failed:', e);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="border rounded-lg overflow-hidden">
            <button
                onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-sm font-medium"
            >
                <span className="flex items-center gap-2">
                    <Edit3 className="w-4 h-4 text-muted-foreground" />
                    {title}
                </span>
                {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {expanded && (
                <div className="p-4 space-y-3">
                    {loading ? (
                        <p className="text-sm text-muted-foreground">Loading...</p>
                    ) : editing ? (
                        <>
                            <textarea
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                className="w-full h-64 px-3 py-2 font-mono text-xs rounded border bg-background resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                            <div className="flex gap-2">
                                <Button size="sm" onClick={save} disabled={saving}>
                                    <Save className="w-3 h-3 mr-1" />
                                    {saving ? 'Saving...' : 'Save'}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={cancelEdit}>
                                    <X className="w-3 h-3 mr-1" />
                                    Cancel
                                </Button>
                            </div>
                        </>
                    ) : (
                        <>
                            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono bg-muted/30 rounded p-3 max-h-48 overflow-y-auto">
                                {content || '(empty)'}
                            </pre>
                            <Button size="sm" variant="outline" onClick={startEdit}>
                                <Edit3 className="w-3 h-3 mr-1" />
                                Edit
                            </Button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// LogRow
// ─────────────────────────────────────────────────────────────────────────────

function LogRow({ log }: { log: HeartbeatLog }) {
    const [open, setOpen] = useState(false);

    const icon =
        log.status === 'action_taken' ? <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" /> :
            log.status === 'error' ? <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" /> :
                <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />;

    const label =
        log.status === 'action_taken' ? 'Acted' :
            log.status === 'error' ? 'Failed' : 'Skipped';

    let result: any = {};
    try { result = JSON.parse(log.result); } catch { }

    const relTime = (iso: string) => {
        const d = new Date(iso);
        const diff = Date.now() - d.getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    };

    return (
        <div className="rounded-lg border bg-card text-card-foreground">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-start gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
            >
                {icon}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
                        <span className="text-xs text-muted-foreground">{relTime(log.timestamp)}</span>
                    </div>
                    <p className="text-sm truncate">
                        {log.action_taken || (result.skipped ? 'Nothing to do this tick' : 'Heartbeat tick')}
                    </p>
                </div>
                {open ? <ChevronUp className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <ChevronDown className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            </button>

            {open && (
                <div className="px-4 pb-3 border-t pt-3 space-y-2">
                    {/* Meta row */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {result.action?.source && (
                            <span><span className="font-medium">Source:</span> {result.action.source} — {result.action.priority} priority</span>
                        )}
                        {result.summary?.total_iterations != null && (
                            <span><span className="font-medium">Iterations:</span> {result.summary.total_iterations}</span>
                        )}
                        {result.summary?.duration_ms != null && (
                            <span><span className="font-medium">Duration:</span> {result.summary.duration_ms >= 60000
                                ? `${Math.floor(result.summary.duration_ms / 60000)}m ${Math.floor((result.summary.duration_ms % 60000) / 1000)}s`
                                : `${Math.floor(result.summary.duration_ms / 1000)}s`}
                            </span>
                        )}
                    </div>

                    {/* Artifacts */}
                    {result.summary?.artifacts_created?.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                            <span className="font-medium">Files:</span>{' '}
                            {result.summary.artifacts_created.join(', ')}
                        </p>
                    )}

                    {/* Actual result content */}
                    {result.final_answer && (
                        <div className="mt-2">
                            <p className="text-xs font-medium text-muted-foreground mb-1">Result</p>
                            <pre className="text-xs bg-muted/40 rounded p-2 whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
                                {result.final_answer}
                            </pre>
                        </div>
                    )}

                    {/* Failure */}
                    {result.failure_reason && (
                        <p className="text-xs text-red-500">
                            <span className="font-medium">Reason:</span> {result.failure_reason}
                        </p>
                    )}
                    {result.suggestions?.length > 0 && (
                        <p className="text-xs text-muted-foreground">{result.suggestions.join('; ')}</p>
                    )}
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProactiveIntelligence (main)
// ─────────────────────────────────────────────────────────────────────────────

export function ProactiveIntelligence() {
    const [status, setStatus] = useState<HeartbeatStatus | null>(null);
    const [logs, setLogs] = useState<HeartbeatLog[]>([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [triggering, setTriggering] = useState(false);
    const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
    const [channelDraft, setChannelDraft] = useState('');
    const [chatIdDraft, setChatIdDraft] = useState('');
    const [channelSaving, setChannelSaving] = useState(false);
    const [channelSaved, setChannelSaved] = useState(false);

    const loadStatus = useCallback(async () => {
        try {
            const r = await fetch(`${API_BASE}/api/heartbeat/status`);
            const data = await r.json();
            setStatus(data);
            setChannelDraft(data.preferredChannel || '');
            setChatIdDraft(data.channelChatId || '');
        } catch { }
    }, []);

    const loadLogs = useCallback(async () => {
        setLogsLoading(true);
        try {
            const r = await fetch(`${API_BASE}/api/heartbeat/logs`);
            const data = await r.json();
            setLogs(Array.isArray(data) ? data : []);
        } catch { }
        finally { setLogsLoading(false); }
    }, []);

    useEffect(() => {
        loadStatus();
        loadLogs();

        // Real-time updates: refresh logs immediately when a heartbeat tick completes
        const socket = getSocket();
        const handleTick = () => { loadLogs(); loadStatus(); };
        socket.on('heartbeat:tick', handleTick);
        return () => { socket.off('heartbeat:tick', handleTick); };
    }, [loadStatus, loadLogs]);

    const changeInterval = async (interval: '15m' | '30m' | '1h' | '24h') => {
        await fetch(`${API_BASE}/api/heartbeat/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interval }),
        });
        loadStatus();
    };

    const toggleEnabled = async () => {
        if (!status) return;
        await fetch(`${API_BASE}/api/heartbeat/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !status.enabled }),
        });
        loadStatus();
    };

    const runNow = async () => {
        setTriggering(true);
        setTriggerMsg(null);
        try {
            await fetch(`${API_BASE}/api/heartbeat/trigger`, { method: 'POST' });
            setTriggerMsg('Heartbeat tick triggered — check logs in a moment');
            setTimeout(() => { loadLogs(); loadStatus(); }, 3000);
        } catch {
            setTriggerMsg('Failed to trigger heartbeat');
        } finally {
            setTriggering(false);
        }
    };

    const saveChannel = async () => {
        setChannelSaving(true);
        setChannelSaved(false);
        try {
            await fetch(`${API_BASE}/api/heartbeat/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preferredChannel: channelDraft || undefined,
                    channelChatId: chatIdDraft || undefined,
                }),
            });
            setChannelSaved(true);
            setTimeout(() => setChannelSaved(false), 2500);
            loadStatus();
        } finally {
            setChannelSaving(false);
        }
    };

    const acted = logs.filter(l => l.status === 'action_taken').length;
    const failed = logs.filter(l => l.status === 'error').length;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex-shrink-0 border-b px-6 py-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Heart className="w-5 h-5 text-primary" />
                        <div>
                            <h1 className="text-lg font-semibold">Proactive Intelligence</h1>
                            <p className="text-sm text-muted-foreground">
                                The agent monitors HEARTBEAT.md and takes actions autonomously
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => { loadStatus(); loadLogs(); }}>
                            <RefreshCw className="w-4 h-4" />
                        </Button>
                        <Button
                            size="sm"
                            onClick={runNow}
                            disabled={triggering}
                            className="flex items-center gap-1"
                        >
                            <Play className="w-4 h-4" />
                            {triggering ? 'Running...' : 'Run Now'}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* Status card */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                            <Zap className="w-4 h-4 text-primary" />
                            Heartbeat Status
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {status ? (
                            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">State</p>
                                    <button
                                        onClick={toggleEnabled}
                                        className={`text-sm font-semibold px-3 py-1 rounded-full transition-colors ${status.enabled
                                            ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20'
                                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                                            }`}
                                    >
                                        {status.enabled ? 'Enabled' : 'Disabled'}
                                    </button>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">Interval</p>
                                    <div className="flex gap-1 flex-wrap">
                                        {(['15m', '30m', '1h', '24h'] as const).map(v => (
                                            <button
                                                key={v}
                                                onClick={() => changeInterval(v)}
                                                className={`text-xs px-2 py-1 rounded-lg transition-colors font-medium ${status.interval === v
                                                        ? 'bg-primary text-primary-foreground'
                                                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                                                    }`}
                                            >
                                                {v}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">Last tick</p>
                                    <p className="text-sm">{status.lastTick ? new Date(status.lastTick).toLocaleTimeString() : 'Never'}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">Next tick</p>
                                    <p className="text-sm">{status.nextTick}</p>
                                </div>
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground">Loading status...</p>
                        )}

                        {triggerMsg && (
                            <p className="text-sm text-muted-foreground flex items-center gap-2">
                                <AlertCircle className="w-4 h-4" />
                                {triggerMsg}
                            </p>
                        )}
                    </CardContent>
                </Card>

                {/* Notification channel */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                            <Zap className="w-4 h-4 text-primary" />
                            Notification Channel
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                            When a heartbeat task completes, results are sent to this channel. Leave blank for web-only notifications.
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">Channel</label>
                                <select
                                    value={channelDraft}
                                    onChange={e => setChannelDraft(e.target.value)}
                                    className="w-full text-sm border rounded-md px-2 py-1.5 bg-background"
                                >
                                    <option value="">Web only</option>
                                    <option value="telegram">Telegram</option>
                                    <option value="discord">Discord</option>
                                    <option value="slack">Slack</option>
                                    <option value="whatsapp">WhatsApp</option>
                                </select>
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">
                                    {channelDraft === 'telegram' ? 'Telegram Chat ID' :
                                     channelDraft === 'discord' ? 'Discord Channel ID' :
                                     channelDraft === 'slack' ? 'Slack Channel ID' :
                                     'Chat / Channel ID'}
                                </label>
                                <input
                                    type="text"
                                    value={chatIdDraft}
                                    onChange={e => setChatIdDraft(e.target.value)}
                                    placeholder={channelDraft === 'telegram' ? 'e.g. 123456789' : 'Channel or chat ID'}
                                    className="w-full text-sm border rounded-md px-2 py-1.5 bg-background"
                                    disabled={!channelDraft}
                                />
                            </div>
                        </div>
                        {channelDraft === 'telegram' && (
                            <p className="text-xs text-muted-foreground">
                                To find your Telegram chat ID: send a message to your bot, then visit
                                <code className="mx-1 bg-muted px-1 rounded">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code>
                                and copy the <code className="bg-muted px-1 rounded">chat.id</code> value.
                            </p>
                        )}
                        <button
                            onClick={saveChannel}
                            disabled={channelSaving}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                        >
                            <Save className="w-3.5 h-3.5" />
                            {channelSaving ? 'Saving...' : channelSaved ? 'Saved!' : 'Save Channel'}
                        </button>
                    </CardContent>
                </Card>

                {/* Config editors */}
                <div className="space-y-3">
                    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Configuration</h2>
                    <MarkdownEditor
                        title="HEARTBEAT.md — Standing tasks (what to monitor)"
                        getUrl={`${API_BASE}/api/heartbeat/heartbeat-md`}
                        putUrl={`${API_BASE}/api/heartbeat/heartbeat-md`}
                    />
                    <MarkdownEditor
                        title="SOUL.md — Agent character (personality, quiet hours, preferences)"
                        getUrl={`${API_BASE}/api/heartbeat/soul-md`}
                        putUrl={`${API_BASE}/api/heartbeat/soul-md`}
                    />
                </div>

                {/* Logs */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                            Recent Activity
                        </h2>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="text-green-600 font-medium">{acted} acted</span>
                            {failed > 0 && <span className="text-red-500 font-medium">{failed} failed</span>}
                            <button onClick={loadLogs} className="hover:text-foreground transition-colors">
                                Refresh
                            </button>
                        </div>
                    </div>

                    {logsLoading ? (
                        <p className="text-sm text-muted-foreground">Loading logs...</p>
                    ) : logs.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-8 text-center">
                            <Heart className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                            <p className="text-sm text-muted-foreground">No heartbeat activity yet.</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Click "Run Now" to trigger the first proactive check.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {logs.map(log => <LogRow key={log.id} log={log} />)}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
