import { API_BASE } from '@/lib/api';
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Activity, CheckCircle, XCircle, Clock, StopCircle, RefreshCw } from 'lucide-react';
import { getSocket } from '@/lib/socket';

interface AgentTask {
    id: string;
    parentId: string | null;
    depth: number;
    role: string;
    task: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    result: string | null;
    artifacts: string[];
    startedAt: string | null;
    completedAt: string | null;
}

interface AgentPoolStatus {
    active: number;
    totalSpawned: number;
    tasks: AgentTask[];
}

export function AgentPoolMonitor() {
    const [poolStatus, setPoolStatus] = useState<AgentPoolStatus>({ active: 0, totalSpawned: 0, tasks: [] });
    const [cancelling, setCancelling] = useState<string | null>(null);

    const loadPoolStatus = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/agents`);
            const data = await res.json();
            setPoolStatus(data);
        } catch (e) {
            console.error('Failed to load agent pool status:', e);
        }
    }, []);

    useEffect(() => {
        loadPoolStatus();

        // Real-time updates via socket events (no more polling)
        const socket = getSocket();
        const refresh = () => loadPoolStatus();

        socket.on('agent:spawned', refresh);
        socket.on('agent:completed', refresh);
        socket.on('agent:failed', refresh);

        return () => {
            socket.off('agent:spawned', refresh);
            socket.off('agent:completed', refresh);
            socket.off('agent:failed', refresh);
        };
    }, [loadPoolStatus]);

    const cancelAgent = async (taskId: string) => {
        setCancelling(taskId);
        try {
            await fetch(`${API_BASE}/api/agents/${taskId}/cancel`, { method: 'POST' });
            setTimeout(loadPoolStatus, 500);
        } catch (e) { console.error('Cancel failed:', e); }
        finally { setCancelling(null); }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'completed': return <CheckCircle className="w-4 h-4 text-green-500" />;
            case 'failed': return <XCircle className="w-4 h-4 text-red-500" />;
            case 'running': return <Activity className="w-4 h-4 text-blue-500 animate-pulse" />;
            default: return <Clock className="w-4 h-4 text-gray-500" />;
        }
    };

    const formatDuration = (start: string | null, end: string | null) => {
        if (!start) return '-';
        const duration = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
        return `${(duration / 1000).toFixed(1)}s`;
    };

    const runningTasks = poolStatus.tasks.filter(t => t.status === 'running');
    const completedTasks = poolStatus.tasks.filter(t => t.status === 'completed');
    const failedTasks = poolStatus.tasks.filter(t => t.status === 'failed');

    return (
        <div className="p-4 space-y-4 h-full overflow-auto">
            {/* Summary stats */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                            <Users className="w-5 h-5" /> Agent Pool
                        </span>
                        <button onClick={loadPoolStatus} className="p-1 hover:bg-accent rounded" title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-4 gap-4">
                        {[
                            { label: 'Active', value: poolStatus.active, color: 'text-blue-500' },
                            { label: 'Running', value: runningTasks.length, color: 'text-yellow-500' },
                            { label: 'Completed', value: completedTasks.length, color: 'text-green-500' },
                            { label: 'Failed', value: failedTasks.length, color: 'text-red-400' },
                        ].map(({ label, value, color }) => (
                            <div key={label} className="text-center p-3 bg-muted/30 rounded-lg">
                                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-3 text-center">
                        Updates in real-time via WebSocket events
                    </p>
                </CardContent>
            </Card>

            {/* Task tree */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Task Tree</CardTitle>
                </CardHeader>
                <CardContent>
                    {poolStatus.tasks.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">
                            No agent tasks yet. Run a Goal to see delegated sub-tasks appear here in real-time.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {poolStatus.tasks.map((task) => (
                                <div
                                    key={task.id}
                                    className="border rounded-lg p-3 space-y-1.5 hover:bg-muted/20 transition-colors"
                                    style={{ marginLeft: `${task.depth * 20}px` }}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            {getStatusIcon(task.status)}
                                            <span className="font-medium text-sm">{task.role}</span>
                                            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                                                depth {task.depth}
                                            </span>
                                            <span className="text-[10px] text-muted-foreground font-mono">
                                                {task.id.substring(0, 8)}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <span className="text-xs text-muted-foreground">
                                                {formatDuration(task.startedAt, task.completedAt)}
                                            </span>
                                            {task.status === 'running' && (
                                                <button
                                                    onClick={() => cancelAgent(task.id)}
                                                    disabled={cancelling === task.id}
                                                    title="Cancel this agent"
                                                    className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                                                >
                                                    <StopCircle size={14} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <p className="text-sm text-muted-foreground">{task.task}</p>
                                    {task.artifacts.length > 0 && (
                                        <div className="text-xs text-muted-foreground">
                                            📄 {task.artifacts.join(', ')}
                                        </div>
                                    )}
                                    {task.result && task.status === 'completed' && (
                                        <p className="text-xs p-2 bg-muted rounded">
                                            {task.result.substring(0, 200)}
                                            {task.result.length > 200 && '...'}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
