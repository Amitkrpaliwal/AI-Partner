import { useState, useEffect } from 'react';
import { getSocket } from '@/lib/socket';
import {
    Play, Pause, Square, ChevronDown, ChevronUp,
    CheckCircle, XCircle, Loader2, Clock, AlertTriangle,
    RefreshCw, FileText
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

interface StepInfo {
    id: string;
    description: string;
    status: 'pending' | 'executing' | 'completed' | 'failed' | 'retrying';
    artifacts?: string[];
    duration_ms?: number;
    retry_count?: number;
    error?: string;
}

interface ExecutionState {
    execution_id: string;
    status: 'planning' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';
    steps: StepInfo[];
    current_step: number;
    total_steps: number;
    current_iteration: number;
    max_iterations: number;
    duration_ms: number;
    artifacts: string[];
}

// ============================================================================
// COMPONENT
// ============================================================================

export function AutonomousProgress() {
    const [execution, setExecution] = useState<ExecutionState | null>(null);
    const [isExpanded, setIsExpanded] = useState(true);
    const [isProcessing, setIsProcessing] = useState(false);

    useEffect(() => {
        const socket = getSocket();

        // Plan created
        socket.on('autonomous:plan_created', (event: any) => {
            console.log('[AutonomousProgress] Plan created:', event);
            setExecution({
                execution_id: event.execution_id,
                status: 'executing',
                steps: event.steps.map((s: any) => ({
                    id: s.id,
                    description: s.description,
                    status: 'pending'
                })),
                current_step: 0,
                total_steps: event.steps.length,
                current_iteration: 0,
                max_iterations: 20,
                duration_ms: 0,
                artifacts: []
            });
        });

        // Step started
        socket.on('autonomous:step_started', (event: any) => {
            setExecution(prev => {
                if (!prev) return prev;
                const steps = [...prev.steps];
                if (steps[event.step - 1]) {
                    steps[event.step - 1].status = 'executing';
                }
                return {
                    ...prev,
                    steps,
                    current_step: event.step,
                    current_iteration: event.iteration,
                    max_iterations: event.max_iterations || 20
                };
            });
        });

        // Step completed
        socket.on('autonomous:step_completed', (event: any) => {
            setExecution(prev => {
                if (!prev) return prev;
                const steps = [...prev.steps];
                if (steps[event.step - 1]) {
                    steps[event.step - 1].status = 'completed';
                    steps[event.step - 1].artifacts = event.artifacts;
                    steps[event.step - 1].duration_ms = event.duration_ms;
                }
                return {
                    ...prev,
                    steps,
                    artifacts: [...prev.artifacts, ...(event.artifacts || [])]
                };
            });
        });

        // Step failed
        socket.on('autonomous:step_failed', (event: any) => {
            setExecution(prev => {
                if (!prev) return prev;
                const steps = [...prev.steps];
                if (steps[event.step - 1]) {
                    steps[event.step - 1].status = 'failed';
                    steps[event.step - 1].error = event.reason;
                }
                return { ...prev, steps, status: 'failed' };
            });
        });

        // Step retry
        socket.on('autonomous:step_retry', (event: any) => {
            setExecution(prev => {
                if (!prev) return prev;
                const steps = [...prev.steps];
                if (steps[event.step - 1]) {
                    steps[event.step - 1].status = 'retrying';
                    steps[event.step - 1].retry_count = event.retry;
                    steps[event.step - 1].error = event.reason;
                }
                return { ...prev, steps };
            });
        });

        // Execution completed
        socket.on('autonomous:completed', (event: any) => {
            setExecution(prev => {
                if (!prev) return prev;
                return {
                    ...prev,
                    status: event.status === 'success' ? 'completed' : 'failed',
                    duration_ms: event.duration_ms,
                    artifacts: event.artifacts || prev.artifacts
                };
            });
        });

        // Paused
        socket.on('autonomous:paused', (_event: any) => {
            setExecution(prev => prev ? { ...prev, status: 'paused' } : prev);
        });

        // Resumed
        socket.on('autonomous:resumed', (_event: any) => {
            setExecution(prev => prev ? { ...prev, status: 'executing' } : prev);
        });

        // Cancelled
        socket.on('autonomous:cancelled', (_event: any) => {
            setExecution(prev => prev ? { ...prev, status: 'cancelled' } : prev);
        });

        return () => {
            socket.off('autonomous:plan_created');
            socket.off('autonomous:step_started');
            socket.off('autonomous:step_completed');
            socket.off('autonomous:step_failed');
            socket.off('autonomous:step_retry');
            socket.off('autonomous:completed');
            socket.off('autonomous:paused');
            socket.off('autonomous:resumed');
            socket.off('autonomous:cancelled');
        };
    }, []);

    // Handle pause
    const handlePause = () => {
        if (!execution) return;
        setIsProcessing(true);
        const socket = getSocket();
        socket.emit('autonomous:pause', { execution_id: execution.execution_id });
        setTimeout(() => setIsProcessing(false), 500);
    };

    // Handle resume
    const handleResume = () => {
        if (!execution) return;
        setIsProcessing(true);
        const socket = getSocket();
        socket.emit('autonomous:resume', { execution_id: execution.execution_id });
        setTimeout(() => setIsProcessing(false), 500);
    };

    // Handle stop
    const handleStop = () => {
        if (!execution) return;
        setIsProcessing(true);
        const socket = getSocket();
        socket.emit('autonomous:stop', { execution_id: execution.execution_id });
        setTimeout(() => setIsProcessing(false), 500);
    };

    // Dismiss completed execution
    const handleDismiss = () => {
        setExecution(null);
    };

    // Don't render if no execution
    if (!execution) {
        return null;
    }

    // Calculate progress
    const completedSteps = execution.steps.filter(s => s.status === 'completed').length;
    const progressPercent = Math.round((completedSteps / execution.total_steps) * 100);

    // Status colors
    const statusColors: Record<string, string> = {
        planning: 'text-blue-500',
        executing: 'text-yellow-500',
        paused: 'text-orange-500',
        completed: 'text-green-500',
        failed: 'text-red-500',
        cancelled: 'text-gray-500'
    };

    // Format duration
    const formatDuration = (ms: number) => {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60000).toFixed(1)}m`;
    };

    return (
        <div className="fixed bottom-4 right-4 z-50 w-96 max-h-[70vh] overflow-hidden">
            <div className="bg-card border border-border rounded-lg shadow-2xl">
                {/* Header */}
                <div
                    className="flex items-center justify-between p-3 border-b border-border cursor-pointer hover:bg-muted/50"
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    <div className="flex items-center gap-2">
                        {execution.status === 'executing' && (
                            <Loader2 className="w-4 h-4 text-yellow-500 animate-spin" />
                        )}
                        {execution.status === 'completed' && (
                            <CheckCircle className="w-4 h-4 text-green-500" />
                        )}
                        {execution.status === 'failed' && (
                            <XCircle className="w-4 h-4 text-red-500" />
                        )}
                        {execution.status === 'paused' && (
                            <Pause className="w-4 h-4 text-orange-500" />
                        )}
                        <span className="font-semibold text-sm">Autonomous Execution</span>
                        <span className={`text-xs ${statusColors[execution.status]}`}>
                            ({execution.status})
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            {completedSteps}/{execution.total_steps} steps
                        </span>
                        {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                        ) : (
                            <ChevronUp className="w-4 h-4 text-muted-foreground" />
                        )}
                    </div>
                </div>

                {isExpanded && (
                    <>
                        {/* Progress bar */}
                        <div className="px-3 py-2 border-b border-border">
                            <div className="flex items-center justify-between text-xs mb-1">
                                <span>Step {execution.current_step} of {execution.total_steps}</span>
                                <span>Iteration {execution.current_iteration}/{execution.max_iterations}</span>
                            </div>
                            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary transition-all duration-300"
                                    style={{ width: `${progressPercent}%` }}
                                />
                            </div>
                            <div className="text-xs text-muted-foreground mt-1 text-right">
                                {progressPercent}% complete
                            </div>
                        </div>

                        {/* Steps list */}
                        <div className="max-h-60 overflow-y-auto p-2 space-y-1">
                            {execution.steps.map((step, index) => (
                                <div
                                    key={step.id}
                                    className={`flex items-start gap-2 p-2 rounded text-sm ${step.status === 'executing' ? 'bg-yellow-500/10' :
                                        step.status === 'retrying' ? 'bg-orange-500/10' :
                                            step.status === 'completed' ? 'bg-green-500/10' :
                                                step.status === 'failed' ? 'bg-red-500/10' :
                                                    'bg-muted/30'
                                        }`}
                                >
                                    <div className="mt-0.5">
                                        {step.status === 'completed' && (
                                            <CheckCircle className="w-4 h-4 text-green-500" />
                                        )}
                                        {step.status === 'failed' && (
                                            <XCircle className="w-4 h-4 text-red-500" />
                                        )}
                                        {step.status === 'executing' && (
                                            <Loader2 className="w-4 h-4 text-yellow-500 animate-spin" />
                                        )}
                                        {step.status === 'retrying' && (
                                            <RefreshCw className="w-4 h-4 text-orange-500 animate-spin" />
                                        )}
                                        {step.status === 'pending' && (
                                            <Clock className="w-4 h-4 text-muted-foreground" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium truncate">
                                            Step {index + 1}: {step.description}
                                        </div>
                                        {step.status === 'retrying' && step.retry_count && (
                                            <div className="text-xs text-orange-500 flex items-center gap-1">
                                                <AlertTriangle className="w-3 h-3" />
                                                Retry {step.retry_count}/3: {step.error}
                                            </div>
                                        )}
                                        {step.status === 'failed' && step.error && (
                                            <div className="text-xs text-red-500">
                                                {step.error}
                                            </div>
                                        )}
                                        {step.status === 'completed' && step.duration_ms && (
                                            <div className="text-xs text-muted-foreground">
                                                Completed in {formatDuration(step.duration_ms)}
                                                {step.artifacts && step.artifacts.length > 0 && (
                                                    <span className="ml-2">
                                                        <FileText className="w-3 h-3 inline" /> {step.artifacts.length} file(s)
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Controls */}
                        <div className="p-3 border-t border-border flex items-center justify-between">
                            <div className="text-xs text-muted-foreground">
                                {execution.duration_ms > 0 && (
                                    <span>Duration: {formatDuration(execution.duration_ms)}</span>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                {execution.status === 'executing' && (
                                    <>
                                        <button
                                            onClick={handlePause}
                                            disabled={isProcessing}
                                            className="flex items-center gap-1 px-2 py-1 text-xs bg-orange-500/20 text-orange-500 rounded hover:bg-orange-500/30 disabled:opacity-50"
                                        >
                                            <Pause className="w-3 h-3" />
                                            Pause
                                        </button>
                                        <button
                                            onClick={handleStop}
                                            disabled={isProcessing}
                                            className="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 disabled:opacity-50"
                                        >
                                            <Square className="w-3 h-3" />
                                            Stop
                                        </button>
                                    </>
                                )}
                                {execution.status === 'paused' && (
                                    <>
                                        <button
                                            onClick={handleResume}
                                            disabled={isProcessing}
                                            className="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-500 rounded hover:bg-green-500/30 disabled:opacity-50"
                                        >
                                            <Play className="w-3 h-3" />
                                            Resume
                                        </button>
                                        <button
                                            onClick={handleStop}
                                            disabled={isProcessing}
                                            className="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 disabled:opacity-50"
                                        >
                                            <Square className="w-3 h-3" />
                                            Stop
                                        </button>
                                    </>
                                )}
                                {(execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') && (
                                    <button
                                        onClick={handleDismiss}
                                        className="flex items-center gap-1 px-2 py-1 text-xs bg-muted text-muted-foreground rounded hover:bg-muted/80"
                                    >
                                        Dismiss
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Artifacts */}
                        {execution.artifacts.length > 0 && (
                            <div className="px-3 pb-3">
                                <div className="text-xs font-medium mb-1">Files Created:</div>
                                <div className="flex flex-wrap gap-1">
                                    {execution.artifacts.slice(0, 5).map((artifact, i) => (
                                        <span
                                            key={i}
                                            className="text-xs bg-muted px-2 py-0.5 rounded truncate max-w-[150px]"
                                            title={artifact}
                                        >
                                            {artifact.split('/').pop()}
                                        </span>
                                    ))}
                                    {execution.artifacts.length > 5 && (
                                        <span className="text-xs text-muted-foreground">
                                            +{execution.artifacts.length - 5} more
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
