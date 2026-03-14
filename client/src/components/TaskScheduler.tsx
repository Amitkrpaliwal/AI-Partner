/**
 * TaskScheduler — Upgraded with:
 * - Correct API endpoint (/api/scheduler/tasks)
 * - Task message (the AI prompt to run)
 * - CRON expression human-readable preview
 * - Run History tab with live socket updates
 */
import { API_BASE } from '@/lib/api';
import { useEffect, useState, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { CheckCircle, XCircle, Clock, Zap, History, Plus, Trash2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduledTask {
    id: string;
    name: string;
    cronExpression: string;
    taskMessage: string;
    mode: 'chat' | 'goal';
    enabled: boolean;
    createdAt: string;
    lastRunAt?: string;
    runCount: number;
}

interface TaskRun {
    id: string;
    taskId: string;
    taskName?: string;
    startTime: string;
    endTime?: string;
    status: 'running' | 'completed' | 'failed';
    result?: string;
    error?: string;
}

// ─── CRON Preview ─────────────────────────────────────────────────────────────

function cronPreview(expr: string): string {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return 'Custom schedule';
    const [min, hour, dom, month, dow] = parts;

    if (min === '*' && hour === '*') return 'Every minute';
    if (dom === '*' && month === '*' && dow === '*') {
        if (min !== '*' && hour !== '*') return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    if (dow !== '*' && dom === '*') {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const day = days[parseInt(dow)] || `Day ${dow}`;
        return `Weekly on ${day} at ${hour}:${min?.padStart(2, '0')}`;
    }
    if (dom !== '*' && month === '*') return `Monthly on day ${dom} at ${hour}:${min?.padStart(2, '0')}`;
    return expr;
}

// ─── Main Component ────────────────────────────────────────────────────────────

type Tab = 'tasks' | 'history';

export function TaskScheduler() {
    const [tab, setTab] = useState<Tab>('tasks');
    const [tasks, setTasks] = useState<ScheduledTask[]>([]);
    const [history, setHistory] = useState<TaskRun[]>([]);
    const [loadingTasks, setLoadingTasks] = useState(false);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [adding, setAdding] = useState(false);

    // Form state
    const [name, setName] = useState('');
    const [cronExpr, setCronExpr] = useState('0 8 * * *');
    const [message, setMessage] = useState('');
    const [mode, setMode] = useState<'chat' | 'goal'>('chat');

    const fetchTasks = useCallback(async () => {
        setLoadingTasks(true);
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/tasks`);
            const data = await res.json();
            setTasks(data.tasks || []);
        } catch (e) { console.error(e); }
        finally { setLoadingTasks(false); }
    }, []);

    const fetchHistory = useCallback(async () => {
        setLoadingHistory(true);
        try {
            // Get recent runs across all tasks by fetching each task's runs
            const res = await fetch(`${API_BASE}/api/scheduler/tasks`);
            const data = await res.json();
            const taskList: ScheduledTask[] = data.tasks || [];

            const allRuns: TaskRun[] = [];
            await Promise.all(taskList.slice(0, 10).map(async (t) => {
                const r = await fetch(`${API_BASE}/api/scheduler/tasks/${t.id}/runs`);
                const d = await r.json();
                (d.runs || []).forEach((run: TaskRun) => {
                    allRuns.push({ ...run, taskName: t.name });
                });
            }));

            allRuns.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
            setHistory(allRuns.slice(0, 50));
        } catch (e) { console.error(e); }
        finally { setLoadingHistory(false); }
    }, []);

    useEffect(() => {
        fetchTasks();
    }, [fetchTasks]);

    useEffect(() => {
        if (tab === 'history') fetchHistory();
    }, [tab, fetchHistory]);

    // Live socket updates
    useEffect(() => {
        const socket = getSocket();

        const handleRun = (data: any) => {
            setHistory(prev => [{
                id: data.runId,
                taskId: data.taskId,
                taskName: data.taskName,
                startTime: data.startTime,
                status: data.status,
                error: data.error,
            }, ...prev].slice(0, 50));
            // Refresh task list to update lastRunAt
            fetchTasks();
        };

        socket.on('scheduler:task_run', handleRun);
        return () => { socket.off('scheduler:task_run', handleRun); };
    }, [fetchTasks]);

    const addTask = async () => {
        if (!name.trim() || !cronExpr.trim() || !message.trim()) return;
        setAdding(true);
        try {
            const res = await fetch(`${API_BASE}/api/scheduler/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, cronExpression: cronExpr, taskMessage: message, mode }),
            });
            if (!res.ok) {
                const err = await res.json();
                alert(err.error || 'Failed to create task');
                return;
            }
            setName(''); setCronExpr('0 8 * * *'); setMessage('');
            await fetchTasks();
        } catch (e) { console.error(e); }
        finally { setAdding(false); }
    };

    const deleteTask = async (id: string) => {
        if (!confirm('Delete this scheduled task?')) return;
        try {
            await fetch(`${API_BASE}/api/scheduler/tasks/${id}`, { method: 'DELETE' });
            await fetchTasks();
        } catch (e) { console.error(e); }
    };

    const toggleTask = async (task: ScheduledTask) => {
        const endpoint = task.enabled ? 'disable' : 'enable';
        try {
            await fetch(`${API_BASE}/api/scheduler/tasks/${task.id}/${endpoint}`, { method: 'POST' });
            await fetchTasks();
        } catch (e) { console.error(e); }
    };

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="p-4 space-y-4 h-full overflow-auto">
            <Card className="w-full">
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <Zap className="w-5 h-5" />
                            Task Scheduler
                        </CardTitle>
                        <div className="flex gap-1 bg-muted rounded-lg p-1">
                            <button
                                onClick={() => setTab('tasks')}
                                className={cn('px-3 py-1 text-sm rounded-md transition-colors', tab === 'tasks' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                            >
                                <span className="flex items-center gap-1.5"><Zap size={13} /> Tasks</span>
                            </button>
                            <button
                                onClick={() => setTab('history')}
                                className={cn('px-3 py-1 text-sm rounded-md transition-colors', tab === 'history' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                            >
                                <span className="flex items-center gap-1.5"><History size={13} /> History</span>
                            </button>
                        </div>
                    </div>
                </CardHeader>

                <CardContent className="space-y-4">
                    {/* ── TASKS TAB ── */}
                    {tab === 'tasks' && (
                        <>
                            {/* Add Task Form */}
                            <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
                                <p className="text-sm font-medium flex items-center gap-1.5"><Plus size={14} /> New Scheduled Task</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="text-xs text-muted-foreground">Task Name *</label>
                                        <input
                                            className="w-full mt-1 px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
                                            placeholder="e.g. Daily Standup Check"
                                            value={name}
                                            onChange={e => setName(e.target.value)}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-muted-foreground">
                                            CRON Expression *
                                            <span className="ml-2 text-primary">{cronPreview(cronExpr)}</span>
                                        </label>
                                        <input
                                            className="w-full mt-1 px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                                            placeholder="0 8 * * *"
                                            value={cronExpr}
                                            onChange={e => setCronExpr(e.target.value)}
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="text-xs text-muted-foreground">Agent Task (what to ask the AI) *</label>
                                    <textarea
                                        className="w-full mt-1 px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                                        rows={2}
                                        placeholder="e.g. Review my workspace for any TODO items and summarize them"
                                        value={message}
                                        onChange={e => setMessage(e.target.value)}
                                    />
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="flex gap-2">
                                        {(['chat', 'goal'] as const).map(m => (
                                            <button
                                                key={m}
                                                onClick={() => setMode(m)}
                                                className={cn('px-3 py-1 text-xs rounded-lg transition-colors', mode === m ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent')}
                                            >
                                                {m === 'chat' ? '💬 Chat' : '🎯 Goal'}
                                            </button>
                                        ))}
                                    </div>
                                    <Button
                                        onClick={addTask}
                                        disabled={adding || !name || !cronExpr || !message}
                                        size="sm"
                                        className="ml-auto"
                                    >
                                        {adding ? 'Adding...' : 'Add Task'}
                                    </Button>
                                </div>
                            </div>

                            {/* Task List */}
                            <div className="border rounded-md">
                                <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
                                    <span className="text-xs font-medium text-muted-foreground">{tasks.length} TASKS</span>
                                    <button onClick={fetchTasks} className="p-1 hover:bg-accent rounded">
                                        <RefreshCw size={12} className={loadingTasks ? 'animate-spin' : ''} />
                                    </button>
                                </div>
                                {tasks.length === 0 ? (
                                    <div className="p-6 text-center text-muted-foreground text-sm">No tasks scheduled yet.</div>
                                ) : (
                                    tasks.map(task => (
                                        <div key={task.id} className="flex items-center gap-3 p-3 border-b last:border-0 hover:bg-muted/20 transition-colors">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-sm">{task.name}</span>
                                                    <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded font-mono">{task.cronExpression}</span>
                                                    <span className="text-[10px] text-muted-foreground">{cronPreview(task.cronExpression)}</span>
                                                </div>
                                                <p className="text-xs text-muted-foreground truncate mt-0.5">{task.taskMessage}</p>
                                                <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                                                    <span>Mode: {task.mode}</span>
                                                    <span>Runs: {task.runCount}</span>
                                                    {task.lastRunAt && <span>Last: {new Date(task.lastRunAt).toLocaleString()}</span>}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <button
                                                    onClick={() => toggleTask(task)}
                                                    className={cn('px-2 py-1 text-xs rounded-lg transition-colors', task.enabled ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20' : 'bg-muted text-muted-foreground hover:bg-muted/80')}
                                                >
                                                    {task.enabled ? 'Enabled' : 'Disabled'}
                                                </button>
                                                <button
                                                    onClick={() => deleteTask(task.id)}
                                                    className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                                                >
                                                    <Trash2 size={13} />
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </>
                    )}

                    {/* ── HISTORY TAB ── */}
                    {tab === 'history' && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <p className="text-xs text-muted-foreground">Last 50 runs — updates in real-time</p>
                                <button onClick={fetchHistory} className="p-1 hover:bg-accent rounded">
                                    <RefreshCw size={12} className={loadingHistory ? 'animate-spin' : ''} />
                                </button>
                            </div>
                            {loadingHistory ? (
                                <div className="text-center py-8 text-muted-foreground text-sm">Loading history...</div>
                            ) : history.length === 0 ? (
                                <div className="text-center py-8 text-muted-foreground text-sm">
                                    <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
                                    No runs yet. Scheduled tasks will appear here after they execute.
                                </div>
                            ) : (
                                history.map(run => (
                                    <div key={run.id} className="flex items-start gap-3 p-3 border rounded-lg hover:bg-muted/20 transition-colors">
                                        <div className="mt-0.5 shrink-0">
                                            {run.status === 'completed' ? (
                                                <CheckCircle className="w-4 h-4 text-green-500" />
                                            ) : run.status === 'failed' ? (
                                                <XCircle className="w-4 h-4 text-destructive" />
                                            ) : (
                                                <Clock className="w-4 h-4 text-yellow-500 animate-pulse" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium text-sm">{run.taskName || run.taskId.substring(0, 8)}</span>
                                                <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                                                    run.status === 'completed' ? 'bg-green-500/10 text-green-600' :
                                                        run.status === 'failed' ? 'bg-destructive/10 text-destructive' :
                                                            'bg-yellow-500/10 text-yellow-600'
                                                )}>
                                                    {run.status}
                                                </span>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-0.5">
                                                {new Date(run.startTime).toLocaleString()}
                                                {run.endTime && ` — ${((new Date(run.endTime).getTime() - new Date(run.startTime).getTime()) / 1000).toFixed(1)}s`}
                                            </p>
                                            {run.result && (
                                                <p className="text-xs text-muted-foreground mt-1 p-2 bg-muted/30 rounded truncate">
                                                    {typeof run.result === 'string' ? run.result.replace(/^"/, '').replace(/"$/, '').substring(0, 150) : ''}
                                                </p>
                                            )}
                                            {run.error && (
                                                <p className="text-xs text-destructive mt-1">{run.error}</p>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
