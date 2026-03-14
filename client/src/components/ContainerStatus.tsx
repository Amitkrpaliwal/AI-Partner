import { API_BASE } from '@/lib/api';
import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Box, ExternalLink, Play, RefreshCw, Terminal, Trash2 } from 'lucide-react';

interface ContainerSession {
    sessionId: string;
    containerId: string;
    status: string;
    createdAt: string;
    lastUsed: string;
    ports?: Record<string, string>;
}

interface ContainerInfo {
    dockerAvailable: boolean;
    enabled: boolean;
    config: {
        image: string;
        memoryLimit: string;
        cpuLimit: string;
        idleTimeoutMinutes: number;
    };
    sessions: ContainerSession[];
    sessionCount: number;
}

interface ExecResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
}

export function ContainerStatus() {
    const [info, setInfo] = useState<ContainerInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [command, setCommand] = useState('');
    const [sessionId, setSessionId] = useState('default');
    const [output, setOutput] = useState<Array<{ type: 'cmd' | 'stdout' | 'stderr' | 'info'; text: string }>>([]);
    const [executing, setExecuting] = useState(false);
    const outputRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 10000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [output]);

    const fetchStatus = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/containers/status`);
            if (res.ok) {
                const data = await res.json();
                setInfo(data);
            }
        } catch (e) {
            console.error('Failed to fetch container status:', e);
        } finally {
            setLoading(false);
        }
    };

    const executeCommand = async () => {
        if (!command.trim() || executing) return;

        setOutput(prev => [...prev, { type: 'cmd', text: `$ ${command}` }]);
        setExecuting(true);

        try {
            const res = await fetch(`${API_BASE}/api/containers/exec`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, command, timeout: 30000 }),
            });

            const result: ExecResult = await res.json();

            if (result.stdout) {
                setOutput(prev => [...prev, { type: 'stdout', text: result.stdout }]);
            }
            if (result.stderr) {
                setOutput(prev => [...prev, { type: 'stderr', text: result.stderr }]);
            }
            if (result.timedOut) {
                setOutput(prev => [...prev, { type: 'info', text: `[Timed out after ${result.durationMs}ms]` }]);
            }

            setOutput(prev => [...prev, {
                type: 'info',
                text: `[Exit code: ${result.exitCode} | ${result.durationMs}ms]`,
            }]);

            fetchStatus();
        } catch (e: any) {
            setOutput(prev => [...prev, { type: 'stderr', text: `Error: ${e.message}` }]);
        } finally {
            setExecuting(false);
            setCommand('');
        }
    };

    const destroySession = async (id: string) => {
        try {
            await fetch(`${API_BASE}/api/containers/sessions/${id}`, { method: 'DELETE' });
            setOutput(prev => [...prev, { type: 'info', text: `[Session ${id} destroyed]` }]);
            fetchStatus();
        } catch (e: any) {
            setOutput(prev => [...prev, { type: 'stderr', text: `Failed to destroy: ${e.message}` }]);
        }
    };

    if (loading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Box className="w-5 h-5" /> Container Execution
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">Loading...</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            {/* Status Card */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Box className="w-5 h-5" /> Container Execution
                        <Button variant="ghost" size="sm" onClick={fetchStatus}>
                            <RefreshCw className="w-4 h-4" />
                        </Button>
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                            <span className="text-muted-foreground">Docker:</span>{' '}
                            <span className={info?.dockerAvailable ? 'text-green-500' : 'text-red-500'}>
                                {info?.dockerAvailable ? 'Available' : 'Unavailable'}
                            </span>
                        </div>
                        <div>
                            <span className="text-muted-foreground">Image:</span>{' '}
                            <span className="font-mono text-xs">{info?.config.image}</span>
                        </div>
                        <div>
                            <span className="text-muted-foreground">Memory:</span> {info?.config.memoryLimit}
                        </div>
                        <div>
                            <span className="text-muted-foreground">CPU:</span> {info?.config.cpuLimit}
                        </div>
                    </div>

                    {/* Active Sessions */}
                    {info && info.sessions.length > 0 && (
                        <div className="mt-4">
                            <h4 className="text-sm font-medium mb-2">Active Sessions ({info.sessionCount})</h4>
                            <div className="space-y-2">
                                {info.sessions.map((session) => (
                                    <div key={session.sessionId} className="bg-muted p-2 rounded text-xs space-y-1">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <Play className="w-3 h-3 text-green-500" />
                                                <span className="font-mono">{session.sessionId}</span>
                                                <span className="text-muted-foreground">
                                                    ({session.status})
                                                </span>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => destroySession(session.sessionId)}
                                                className="h-6 px-2"
                                            >
                                                <Trash2 className="w-3 h-3 text-red-400" />
                                            </Button>
                                        </div>
                                        {/* Phase 11C.4: Port forwarding mappings */}
                                        {session.ports && Object.keys(session.ports).length > 0 && (
                                            <div className="flex flex-wrap gap-2 pl-5">
                                                {Object.entries(session.ports).map(([hostPort, containerPort]) => (
                                                    <a
                                                        key={hostPort}
                                                        href={`http://localhost:${hostPort}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded hover:bg-blue-500/20 transition-colors"
                                                    >
                                                        <ExternalLink className="w-3 h-3" />
                                                        :{hostPort} &rarr; :{containerPort}
                                                    </a>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Terminal Card */}
            {info?.dockerAvailable && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Terminal className="w-4 h-4" /> Container Terminal
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {/* Output */}
                        <div
                            ref={outputRef}
                            className="bg-black text-green-400 font-mono text-xs p-3 rounded mb-3 h-64 overflow-y-auto"
                        >
                            {output.length === 0 && (
                                <span className="text-gray-500">
                                    Type a command below to execute inside a Docker container...
                                </span>
                            )}
                            {output.map((line, i) => (
                                <div key={i} className={
                                    line.type === 'cmd' ? 'text-blue-400 font-bold' :
                                    line.type === 'stderr' ? 'text-red-400' :
                                    line.type === 'info' ? 'text-gray-500' :
                                    'text-green-400'
                                }>
                                    <pre className="whitespace-pre-wrap">{line.text}</pre>
                                </div>
                            ))}
                            {executing && <span className="animate-pulse">Running...</span>}
                        </div>

                        {/* Input */}
                        <div className="flex gap-2">
                            <Input
                                value={sessionId}
                                onChange={(e) => setSessionId(e.target.value)}
                                placeholder="Session ID"
                                className="w-28 font-mono text-xs"
                            />
                            <Input
                                value={command}
                                onChange={(e) => setCommand(e.target.value)}
                                placeholder="Enter command..."
                                className="flex-1 font-mono text-xs"
                                onKeyDown={(e) => e.key === 'Enter' && executeCommand()}
                                disabled={executing}
                            />
                            <Button onClick={executeCommand} disabled={executing || !command.trim()} size="sm">
                                <Play className="w-4 h-4 mr-1" /> Run
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
