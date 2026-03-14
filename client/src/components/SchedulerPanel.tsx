import { API_BASE } from '@/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Clock, Play, Pause, Trash2, ChevronDown, ChevronRight,
    Webhook, Plus, Copy, CheckCircle, XCircle, RefreshCw,
    Heart, Save, Zap
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

interface ScheduledTask {
    id: string;
    name: string;
    cronExpression: string;
    taskMessage: string;
    mode: 'chat' | 'goal';
    userId: string;
    enabled: boolean;
    createdAt: string;
    lastRunAt?: string;
    runCount: number;
}

interface TaskRun {
    id: string;
    taskId: string;
    startTime: string;
    endTime?: string;
    status: 'running' | 'completed' | 'failed';
    result?: string;
    error?: string;
}

interface WebhookInfo {
    id: string;
    name: string;
    taskTemplate: string;
    mode: string;
    enabled: boolean;
    createdAt: string;
    lastTriggeredAt?: string;
    triggerCount: number;
}

interface HeartbeatStatus {
    enabled: boolean;
    interval: '15m' | '30m' | '1h' | '24h';
    lastTick: string | null;
    nextTick: string;
}

interface HeartbeatConfig {
    enabled: boolean;
    interval: '15m' | '30m' | '1h' | '24h';
    activeHours: { start: string; end: string };
    preferredChannel?: string;
    channelChatId?: string;
}

interface HeartbeatLog {
    id: string;
    status: string;
    action_taken: string;
    result: string;
    timestamp: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function SchedulerPanel() {
    // Scheduler state
    const [tasks, setTasks] = useState<ScheduledTask[]>([]);
    const [activeJobs, setActiveJobs] = useState(0);
    const [expandedTask, setExpandedTask] = useState<string | null>(null);
    const [taskRuns, setTaskRuns] = useState<Record<string, TaskRun[]>>({});

    // Create task form
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newName, setNewName] = useState('');
    const [newCron, setNewCron] = useState('0 * * * *');
    const [newMessage, setNewMessage] = useState('');
    const [newMode, setNewMode] = useState<'chat' | 'goal'>('chat');
    const [creating, setCreating] = useState(false);

    // Webhooks state
    const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
    const [showWebhookForm, setShowWebhookForm] = useState(false);
    const [whName, setWhName] = useState('');
    const [whTemplate, setWhTemplate] = useState('Process this data: {{payload}}');
    const [whMode, setWhMode] = useState<'chat' | 'goal'>('chat');
    const [createdSecret, setCreatedSecret] = useState<string | null>(null);
    const [copiedSecret, setCopiedSecret] = useState(false);

    // Heartbeat state
    const [hbStatus, setHbStatus] = useState<HeartbeatStatus | null>(null);
    const [hbConfig, setHbConfig] = useState<HeartbeatConfig>({
        enabled: false,
        interval: '30m',
        activeHours: { start: '08:00', end: '22:00' },
        preferredChannel: 'web',
        channelChatId: '',
    });
    const [hbLogs, setHbLogs] = useState<HeartbeatLog[]>([]);
    const [hbSaving, setHbSaving] = useState(false);
    const [hbTriggering, setHbTriggering] = useState(false);

    const [tab, setTab] = useState<'scheduler' | 'webhooks' | 'heartbeat'>('scheduler');

    useEffect(() => {
        fetchTasks();
        fetchWebhooks();
        fetchHeartbeat();
    }, []);

    // ========================================================================
    // SCHEDULER API
    // ========================================================================

    const fetchTasks = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/tasks`);
            if (res.ok) {
                const data = await res.json();
                setTasks(data.tasks || []);
                setActiveJobs(data.activeJobs || 0);
            }
        } catch (e) {
            console.error('Failed to fetch tasks:', e);
        }
    };

    const createTask = async () => {
        if (!newName || !newCron || !newMessage) return;
        setCreating(true);
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newName,
                    cronExpression: newCron,
                    taskMessage: newMessage,
                    mode: newMode,
                }),
            });
            if (res.ok) {
                setNewName('');
                setNewCron('0 * * * *');
                setNewMessage('');
                setShowCreateForm(false);
                await fetchTasks();
            }
        } catch (e) {
            console.error('Failed to create task:', e);
        } finally {
            setCreating(false);
        }
    };

    const toggleTask = async (id: string, currentlyEnabled: boolean) => {
        try {
            await fetch(`${API_BASE}/api/scheduler/tasks/${id}/${currentlyEnabled ? 'disable' : 'enable'}`, {
                method: 'POST',
            });
            await fetchTasks();
        } catch (e) {
            console.error('Failed to toggle task:', e);
        }
    };

    const deleteTask = async (id: string) => {
        try {
            await fetch(`${API_BASE}/api/scheduler/tasks/${id}`, { method: 'DELETE' });
            await fetchTasks();
        } catch (e) {
            console.error('Failed to delete task:', e);
        }
    };

    const loadTaskRuns = async (taskId: string) => {
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/tasks/${taskId}/runs`);
            if (res.ok) {
                const data = await res.json();
                setTaskRuns(prev => ({ ...prev, [taskId]: data.runs || [] }));
            }
        } catch (e) {
            console.error('Failed to load runs:', e);
        }
    };

    const toggleExpanded = (taskId: string) => {
        if (expandedTask === taskId) {
            setExpandedTask(null);
        } else {
            setExpandedTask(taskId);
            loadTaskRuns(taskId);
        }
    };

    // ========================================================================
    // WEBHOOK API
    // ========================================================================

    const fetchWebhooks = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/webhooks`);
            if (res.ok) {
                const data = await res.json();
                setWebhooks(data.webhooks || []);
            }
        } catch (e) {
            console.error('Failed to fetch webhooks:', e);
        }
    };

    const createWebhook = async () => {
        if (!whName || !whTemplate) return;
        try {
            const res = await fetch(`${API_BASE}/api/webhooks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: whName, taskTemplate: whTemplate, mode: whMode }),
            });
            if (res.ok) {
                const data = await res.json();
                setCreatedSecret(data.webhook?.secret || null);
                setWhName('');
                setWhTemplate('Process this data: {{payload}}');
                await fetchWebhooks();
            }
        } catch (e) {
            console.error('Failed to create webhook:', e);
        }
    };

    const deleteWebhook = async (id: string) => {
        try {
            await fetch(`${API_BASE}/api/webhooks/${id}`, { method: 'DELETE' });
            await fetchWebhooks();
        } catch (e) {
            console.error('Failed to delete webhook:', e);
        }
    };

    // ========================================================================
    // HEARTBEAT API
    // ========================================================================

    const fetchHeartbeat = async () => {
        try {
            const [statusRes, logsRes] = await Promise.all([
                fetch(`${API_BASE}/api/heartbeat/status`),
                fetch(`${API_BASE}/api/heartbeat/logs`),
            ]);
            if (statusRes.ok) {
                const data = await statusRes.json();
                setHbStatus(data);
                setHbConfig(prev => ({
                    ...prev,
                    enabled: data.enabled,
                    interval: data.interval,
                }));
            }
            if (logsRes.ok) {
                const data = await logsRes.json();
                setHbLogs(Array.isArray(data) ? data.slice(0, 20) : []);
            }
        } catch (e) {
            console.error('Failed to fetch heartbeat:', e);
        }
    };

    const saveHeartbeatConfig = async () => {
        setHbSaving(true);
        try {
            const res = await fetch(`${API_BASE}/api/heartbeat/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(hbConfig),
            });
            if (res.ok) {
                await fetchHeartbeat();
            }
        } catch (e) {
            console.error('Failed to save heartbeat config:', e);
        } finally {
            setHbSaving(false);
        }
    };

    const triggerHeartbeat = async () => {
        setHbTriggering(true);
        try {
            await fetch(`${API_BASE}/api/heartbeat/trigger`, { method: 'POST' });
            // Refresh after short delay to show result
            setTimeout(() => fetchHeartbeat(), 2000);
        } catch (e) {
            console.error('Failed to trigger heartbeat:', e);
        } finally {
            setHbTriggering(false);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 2000);
    };

    // ========================================================================
    // RENDER
    // ========================================================================

    return (
        <div className="space-y-4">
            {/* Tab Selection */}
            <div className="flex gap-2">
                <Button
                    variant={tab === 'scheduler' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTab('scheduler')}
                >
                    <Clock className="w-4 h-4 mr-1" /> Scheduled Tasks
                </Button>
                <Button
                    variant={tab === 'webhooks' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTab('webhooks')}
                >
                    <Webhook className="w-4 h-4 mr-1" /> Webhooks
                </Button>
                <Button
                    variant={tab === 'heartbeat' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTab('heartbeat')}
                >
                    <Heart className="w-4 h-4 mr-1" /> Heartbeat
                </Button>
            </div>

            {/* ============================================================ */}
            {/* SCHEDULER TAB */}
            {/* ============================================================ */}
            {tab === 'scheduler' && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <Clock className="w-5 h-5" /> Scheduled Tasks
                            <span className="text-xs text-muted-foreground font-normal">
                                ({activeJobs} active)
                            </span>
                        </CardTitle>
                        <div className="flex gap-2">
                            <Button variant="ghost" size="sm" onClick={fetchTasks}>
                                <RefreshCw className="w-4 h-4" />
                            </Button>
                            <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
                                <Plus className="w-4 h-4 mr-1" /> New Task
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Create Form */}
                        {showCreateForm && (
                            <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="text-xs font-medium">Task Name</label>
                                        <Input
                                            value={newName}
                                            onChange={(e) => setNewName(e.target.value)}
                                            placeholder="Daily report"
                                            className="mt-1"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-medium">Cron Expression</label>
                                        <Input
                                            value={newCron}
                                            onChange={(e) => setNewCron(e.target.value)}
                                            placeholder="0 9 * * *"
                                            className="mt-1 font-mono text-xs"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="text-xs font-medium">Task Message (prompt sent to AI)</label>
                                    <Input
                                        value={newMessage}
                                        onChange={(e) => setNewMessage(e.target.value)}
                                        placeholder="Generate a daily status report..."
                                        className="mt-1"
                                    />
                                </div>
                                <div className="flex items-center gap-4">
                                    <label className="text-xs font-medium">Mode:</label>
                                    <label className="flex items-center gap-1 text-xs">
                                        <input type="radio" checked={newMode === 'chat'} onChange={() => setNewMode('chat')} />
                                        Chat
                                    </label>
                                    <label className="flex items-center gap-1 text-xs">
                                        <input type="radio" checked={newMode === 'goal'} onChange={() => setNewMode('goal')} />
                                        Goal
                                    </label>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="sm" onClick={createTask} disabled={creating || !newName || !newCron || !newMessage}>
                                        {creating ? 'Creating...' : 'Create Task'}
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)}>Cancel</Button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Cron format: minute hour day month weekday (e.g., "0 9 * * 1-5" = weekdays at 9 AM)
                                </p>
                            </div>
                        )}

                        {/* Task List */}
                        {tasks.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">
                                No scheduled tasks. Create one to automate recurring work.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {tasks.map(task => (
                                    <div key={task.id} className="border rounded-lg">
                                        <div className="flex items-center justify-between p-3">
                                            <div className="flex items-center gap-3 flex-1">
                                                <button onClick={() => toggleExpanded(task.id)}>
                                                    {expandedTask === task.id
                                                        ? <ChevronDown className="w-4 h-4" />
                                                        : <ChevronRight className="w-4 h-4" />
                                                    }
                                                </button>
                                                <div>
                                                    <div className="font-medium text-sm">{task.name}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        <span className="font-mono">{task.cronExpression}</span>
                                                        {' '}&middot;{' '}
                                                        <span className={task.mode === 'goal' ? 'text-orange-500' : ''}>
                                                            {task.mode}
                                                        </span>
                                                        {' '}&middot;{' '}
                                                        {task.runCount} runs
                                                        {task.lastRunAt && (
                                                            <> &middot; last: {new Date(task.lastRunAt).toLocaleString()}</>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => toggleTask(task.id, task.enabled)}
                                                    className="h-7 px-2"
                                                >
                                                    {task.enabled
                                                        ? <Pause className="w-3.5 h-3.5 text-yellow-500" />
                                                        : <Play className="w-3.5 h-3.5 text-green-500" />
                                                    }
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => deleteTask(task.id)}
                                                    className="h-7 px-2"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                                </Button>
                                            </div>
                                        </div>

                                        {/* Expanded: Run History */}
                                        {expandedTask === task.id && (
                                            <div className="border-t p-3 bg-muted/20">
                                                <div className="text-xs font-medium mb-2">Task: "{task.taskMessage}"</div>
                                                <div className="text-xs font-medium mb-1">Run History:</div>
                                                {(taskRuns[task.id] || []).length === 0 ? (
                                                    <p className="text-xs text-muted-foreground">No runs yet</p>
                                                ) : (
                                                    <div className="space-y-1">
                                                        {(taskRuns[task.id] || []).slice(0, 10).map(run => (
                                                            <div key={run.id} className="flex items-center gap-2 text-xs">
                                                                {run.status === 'completed'
                                                                    ? <CheckCircle className="w-3 h-3 text-green-500" />
                                                                    : run.status === 'failed'
                                                                    ? <XCircle className="w-3 h-3 text-red-500" />
                                                                    : <RefreshCw className="w-3 h-3 text-blue-500 animate-spin" />
                                                                }
                                                                <span className="text-muted-foreground">
                                                                    {new Date(run.startTime).toLocaleString()}
                                                                </span>
                                                                {run.error && <span className="text-red-400">{run.error}</span>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* ============================================================ */}
            {/* WEBHOOKS TAB */}
            {/* ============================================================ */}
            {tab === 'webhooks' && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <Webhook className="w-5 h-5" /> Webhooks
                        </CardTitle>
                        <Button size="sm" onClick={() => { setShowWebhookForm(!showWebhookForm); setCreatedSecret(null); }}>
                            <Plus className="w-4 h-4 mr-1" /> New Webhook
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Created Secret Banner */}
                        {createdSecret && (
                            <div className="border border-yellow-500/50 bg-yellow-500/10 rounded-lg p-3">
                                <div className="text-xs font-medium text-yellow-600 mb-1">
                                    Save this secret — it cannot be retrieved later!
                                </div>
                                <div className="flex items-center gap-2">
                                    <code className="text-xs bg-black/10 px-2 py-1 rounded flex-1 overflow-x-auto">
                                        {createdSecret}
                                    </code>
                                    <Button size="sm" variant="outline" onClick={() => copyToClipboard(createdSecret)}>
                                        {copiedSecret ? <CheckCircle className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* Create Webhook Form */}
                        {showWebhookForm && (
                            <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                                <div>
                                    <label className="text-xs font-medium">Webhook Name</label>
                                    <Input
                                        value={whName}
                                        onChange={(e) => setWhName(e.target.value)}
                                        placeholder="GitHub Push"
                                        className="mt-1"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-medium">
                                        Task Template <span className="text-muted-foreground">(use {'{{payload}}'} for incoming data)</span>
                                    </label>
                                    <Input
                                        value={whTemplate}
                                        onChange={(e) => setWhTemplate(e.target.value)}
                                        placeholder="Process this webhook data: {{payload}}"
                                        className="mt-1"
                                    />
                                </div>
                                <div className="flex items-center gap-4">
                                    <label className="text-xs font-medium">Mode:</label>
                                    <label className="flex items-center gap-1 text-xs">
                                        <input type="radio" checked={whMode === 'chat'} onChange={() => setWhMode('chat')} />
                                        Chat
                                    </label>
                                    <label className="flex items-center gap-1 text-xs">
                                        <input type="radio" checked={whMode === 'goal'} onChange={() => setWhMode('goal')} />
                                        Goal
                                    </label>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="sm" onClick={createWebhook} disabled={!whName || !whTemplate}>
                                        Create Webhook
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setShowWebhookForm(false)}>Cancel</Button>
                                </div>
                            </div>
                        )}

                        {/* Webhook List */}
                        {webhooks.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">
                                No webhooks configured.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {webhooks.map(wh => (
                                    <div key={wh.id} className="flex items-center justify-between border rounded-lg p-3">
                                        <div>
                                            <div className="font-medium text-sm">{wh.name}</div>
                                            <div className="text-xs text-muted-foreground">
                                                <span className="font-mono">/api/webhooks/{wh.id}</span>
                                                {' '}&middot;{' '}
                                                {wh.triggerCount} triggers
                                                {wh.lastTriggeredAt && (
                                                    <> &middot; last: {new Date(wh.lastTriggeredAt).toLocaleString()}</>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => copyToClipboard(`${window.location.origin}/api/webhooks/${wh.id}`)}
                                                className="h-7 px-2"
                                            >
                                                <Copy className="w-3.5 h-3.5" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => deleteWebhook(wh.id)}
                                                className="h-7 px-2"
                                            >
                                                <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* ============================================================ */}
            {/* HEARTBEAT TAB */}
            {/* ============================================================ */}
            {tab === 'heartbeat' && (
                <div className="space-y-4">
                    {/* Heartbeat Configuration */}
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="flex items-center gap-2">
                                <Heart className="w-5 h-5" /> Heartbeat Configuration
                                {hbStatus && (
                                    <span className={`text-xs font-normal px-2 py-0.5 rounded-full ${
                                        hbStatus.enabled
                                            ? 'bg-green-500/20 text-green-600'
                                            : 'bg-gray-500/20 text-gray-500'
                                    }`}>
                                        {hbStatus.enabled ? 'Active' : 'Disabled'}
                                    </span>
                                )}
                            </CardTitle>
                            <div className="flex gap-2">
                                <Button variant="ghost" size="sm" onClick={fetchHeartbeat}>
                                    <RefreshCw className="w-4 h-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={triggerHeartbeat}
                                    disabled={hbTriggering}
                                >
                                    <Zap className="w-4 h-4 mr-1" />
                                    {hbTriggering ? 'Running...' : 'Trigger Now'}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {/* Enable/Disable */}
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-sm font-medium">Enable Heartbeat</div>
                                    <div className="text-xs text-muted-foreground">
                                        Periodically check for issues and opportunities
                                    </div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={hbConfig.enabled}
                                        onChange={(e) => setHbConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                                        className="sr-only peer"
                                    />
                                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-green-500"></div>
                                </label>
                            </div>

                            {/* Interval */}
                            <div>
                                <label className="text-xs font-medium">Check Interval</label>
                                <div className="flex gap-2 mt-1">
                                    {(['15m', '30m', '1h', '24h'] as const).map(interval => (
                                        <Button
                                            key={interval}
                                            size="sm"
                                            variant={hbConfig.interval === interval ? 'default' : 'outline'}
                                            onClick={() => setHbConfig(prev => ({ ...prev, interval }))}
                                            className="text-xs"
                                        >
                                            {interval === '15m' ? '15 min' : interval === '30m' ? '30 min' : interval === '1h' ? '1 hour' : '24 hours'}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            {/* Active Hours */}
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs font-medium">Active From</label>
                                    <Input
                                        type="time"
                                        value={hbConfig.activeHours.start}
                                        onChange={(e) => setHbConfig(prev => ({
                                            ...prev,
                                            activeHours: { ...prev.activeHours, start: e.target.value }
                                        }))}
                                        className="mt-1"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-medium">Active Until</label>
                                    <Input
                                        type="time"
                                        value={hbConfig.activeHours.end}
                                        onChange={(e) => setHbConfig(prev => ({
                                            ...prev,
                                            activeHours: { ...prev.activeHours, end: e.target.value }
                                        }))}
                                        className="mt-1"
                                    />
                                </div>
                            </div>

                            {/* Preferred Channel */}
                            <div>
                                <label className="text-xs font-medium">Notification Channel</label>
                                <select
                                    value={hbConfig.preferredChannel || 'web'}
                                    onChange={(e) => setHbConfig(prev => ({ ...prev, preferredChannel: e.target.value }))}
                                    className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                                >
                                    <option value="web">Web (in-app only)</option>
                                    <option value="discord">Discord</option>
                                    <option value="telegram">Telegram</option>
                                </select>
                            </div>

                            {/* Channel Chat ID (only if not web) */}
                            {hbConfig.preferredChannel && hbConfig.preferredChannel !== 'web' && (
                                <div>
                                    <label className="text-xs font-medium">
                                        {hbConfig.preferredChannel === 'discord' ? 'Discord Channel ID' : 'Telegram Chat ID'}
                                    </label>
                                    <Input
                                        value={hbConfig.channelChatId || ''}
                                        onChange={(e) => setHbConfig(prev => ({ ...prev, channelChatId: e.target.value }))}
                                        placeholder={hbConfig.preferredChannel === 'discord' ? '123456789012345678' : '-1001234567890'}
                                        className="mt-1 font-mono text-xs"
                                    />
                                </div>
                            )}

                            {/* Save Button */}
                            <Button onClick={saveHeartbeatConfig} disabled={hbSaving} className="w-full">
                                <Save className="w-4 h-4 mr-1" />
                                {hbSaving ? 'Saving...' : 'Save Configuration'}
                            </Button>

                            {/* Status Info */}
                            {hbStatus && (
                                <div className="border-t pt-3 mt-3">
                                    <div className="text-xs text-muted-foreground space-y-1">
                                        <div>Last tick: {hbStatus.lastTick ? new Date(hbStatus.lastTick).toLocaleString() : 'Never'}</div>
                                        <div>Next tick: {hbStatus.nextTick}</div>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* Heartbeat Logs */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Clock className="w-4 h-4" /> Recent Heartbeat Logs
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {hbLogs.length === 0 ? (
                                <p className="text-sm text-muted-foreground text-center py-4">
                                    No heartbeat logs yet. Trigger a heartbeat or wait for the next scheduled tick.
                                </p>
                            ) : (
                                <div className="space-y-2">
                                    {hbLogs.map(log => (
                                        <div key={log.id} className="flex items-start gap-2 border rounded-lg p-2">
                                            {log.status === 'ok'
                                                ? <CheckCircle className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
                                                : <Zap className="w-3.5 h-3.5 text-orange-500 mt-0.5 shrink-0" />
                                            }
                                            <div className="flex-1 min-w-0">
                                                <div className="text-xs text-muted-foreground">
                                                    {new Date(log.timestamp).toLocaleString()}
                                                    <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] ${
                                                        log.status === 'ok'
                                                            ? 'bg-green-500/20 text-green-600'
                                                            : 'bg-orange-500/20 text-orange-600'
                                                    }`}>
                                                        {log.status === 'ok' ? 'OK' : 'Action Taken'}
                                                    </span>
                                                </div>
                                                <div className="text-xs mt-1 truncate">{log.action_taken}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
}
