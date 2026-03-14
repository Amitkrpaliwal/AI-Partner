import { API_BASE } from '@/lib/api';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import {
    Play, Loader2, Zap, History, ChevronDown, ChevronUp,
    CheckCircle, XCircle, Clock, MessageCircleQuestion, ArrowRight
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

interface ClarifyingQuestion {
    id: string;
    question: string;
    hint?: string;
    type: 'text' | 'choice' | 'yesno';
    options?: string[];
    required: boolean;
}

interface ExecutionHistoryItem {
    id: string;
    description: string;
    status: 'success' | 'failed' | 'cancelled';
    completed_steps: number;
    total_steps: number;
    duration_ms: number;
    created_at: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function AutonomousTaskLauncher() {
    const [taskDescription, setTaskDescription] = useState('');
    const [isLaunching, setIsLaunching] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState<ExecutionHistoryItem[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Clarification Q&A state
    const [clarifyingQuestions, setClarifyingQuestions] = useState<ClarifyingQuestion[]>([]);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [isClarifying, setIsClarifying] = useState(false);
    const [pendingTask, setPendingTask] = useState('');

    // Step 1: Check if clarification is needed before launching
    const handleLaunch = async () => {
        if (!taskDescription.trim()) {
            setError('Please enter a task description');
            return;
        }

        setIsLaunching(true);
        setError(null);

        try {
            const res = await fetch(`${API_BASE}/api/autonomous/goal/clarify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request: taskDescription })
            });

            if (!res.ok) throw new Error('Failed to check clarification');
            const data = await res.json();

            if (data.questions && data.questions.length > 0) {
                // Show inline Q&A instead of launching immediately
                setClarifyingQuestions(data.questions);
                setAnswers({});
                setPendingTask(taskDescription);
                setIsClarifying(true);
                setIsLaunching(false);
                return;
            }

            // No questions — launch directly
            await submitGoal(taskDescription);
        } catch (e: any) {
            // On clarify-check failure, launch directly anyway
            await submitGoal(taskDescription);
        } finally {
            setIsLaunching(false);
        }
    };

    // Step 2: Submit goal (with or without answers)
    const submitGoal = async (task: string) => {
        const response = await fetch(`${API_BASE}/api/autonomous/goal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                request: task,
                options: {
                    max_iterations: 20,
                    enableNetwork: true
                }
            })
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody.error || 'Failed to start execution');
        }

        const data = await response.json();
        console.log('[AutonomousTaskLauncher] Started goal execution:', data.execution_id);
        setTaskDescription('');
        setIsClarifying(false);
        setClarifyingQuestions([]);
        setAnswers({});
        setPendingTask('');
    };

    // Handle clarification form submission
    const handleAnswerSubmit = async () => {
        setIsLaunching(true);
        setError(null);
        try {
            // Build enriched task by appending answers
            const answered = clarifyingQuestions
                .filter(q => answers[q.id]?.trim())
                .map(q => `- ${q.question}: ${answers[q.id].trim()}`);

            const enriched = answered.length > 0
                ? `${pendingTask}\n\nAdditional context:\n${answered.join('\n')}`
                : pendingTask;

            await submitGoal(enriched);
        } catch (e: any) {
            setError(e.message || 'Failed to start autonomous execution');
        } finally {
            setIsLaunching(false);
        }
    };

    // Skip clarification and run with original task
    const handleSkipClarification = async () => {
        setIsLaunching(true);
        setError(null);
        try {
            await submitGoal(pendingTask);
        } catch (e: any) {
            setError(e.message || 'Failed to start autonomous execution');
        } finally {
            setIsLaunching(false);
        }
    };

    const handleAnswerChange = (questionId: string, value: string) => {
        setAnswers(prev => ({ ...prev, [questionId]: value }));
    };

    // Load execution history from goal API
    const loadHistory = async () => {
        setHistoryLoading(true);
        try {
            const response = await fetch(`${API_BASE}/api/autonomous/goal`);
            if (response.ok) {
                const data = await response.json();
                const executions = (data.executions || []).map((e: any) => ({
                    id: e.execution_id || e.id,
                    description: e.request || e.goal?.description || 'Unknown task',
                    status: e.status === 'completed' ? 'success' : e.status === 'failed' ? 'failed' : 'cancelled',
                    completed_steps: e.current_iteration || 0,
                    total_steps: e.max_iterations || 20,
                    duration_ms: e.duration_ms || 0,
                    created_at: e.started_at || e.created_at || new Date().toISOString()
                }));
                setHistory(executions);
            }
        } catch (e) {
            console.error('Failed to load history:', e);
        } finally {
            setHistoryLoading(false);
        }
    };

    const toggleHistory = () => {
        const newState = !showHistory;
        setShowHistory(newState);
        if (newState && history.length === 0) {
            loadHistory();
        }
    };

    const formatDuration = (ms: number): string => {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    };

    const formatRelativeTime = (isoString: string): string => {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMin = Math.floor(diffMs / 60000);
        const diffHour = Math.floor(diffMs / 3600000);
        const diffDay = Math.floor(diffMs / 86400000);

        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return `${diffMin}m ago`;
        if (diffHour < 24) return `${diffHour}h ago`;
        return `${diffDay}d ago`;
    };

    return (
        <Card className="border-primary/20">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                    <Zap className="w-5 h-5 text-primary" />
                    Autonomous Task Execution
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">

                {/* ── Task Input (shown when not in clarification mode) ── */}
                {!isClarifying && (
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">
                            What would you like me to build?
                        </label>
                        <div className="flex gap-2">
                            <textarea
                                value={taskDescription}
                                onChange={(e) => setTaskDescription(e.target.value)}
                                placeholder="e.g., Create a React login form with email/password validation"
                                className="flex-1 min-h-[60px] px-3 py-2 rounded-md border border-input bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                                disabled={isLaunching}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && e.ctrlKey) {
                                        handleLaunch();
                                    }
                                }}
                            />
                        </div>

                        {error && (
                            <p className="text-sm text-destructive">{error}</p>
                        )}

                        <div className="flex items-center justify-between">
                            <button
                                onClick={handleLaunch}
                                disabled={isLaunching || !taskDescription.trim()}
                                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {isLaunching ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Checking...
                                    </>
                                ) : (
                                    <>
                                        <Play className="w-4 h-4" />
                                        Execute Task
                                    </>
                                )}
                            </button>

                            <button
                                onClick={toggleHistory}
                                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <History className="w-4 h-4" />
                                History
                                {showHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>
                        </div>

                        <p className="text-xs text-muted-foreground">
                            Press Ctrl+Enter to execute
                        </p>
                    </div>
                )}

                {/* ── Inline Clarification Q&A ── */}
                {isClarifying && (
                    <div className="space-y-4">
                        <div className="flex items-start gap-2 p-3 rounded-md bg-muted/60 border border-border">
                            <MessageCircleQuestion className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                            <div className="text-sm">
                                <p className="font-medium mb-1">A few quick questions before I start:</p>
                                <p className="text-xs text-muted-foreground truncate">{pendingTask}</p>
                            </div>
                        </div>

                        <div className="space-y-3">
                            {clarifyingQuestions.map((q) => (
                                <div key={q.id} className="space-y-1">
                                    <label className="text-sm font-medium flex items-center gap-1">
                                        {q.question}
                                        {q.required && <span className="text-destructive text-xs">*</span>}
                                    </label>

                                    {q.type === 'choice' && q.options ? (
                                        <div className="flex flex-wrap gap-2">
                                            {q.options.map((opt) => (
                                                <button
                                                    key={opt}
                                                    onClick={() => handleAnswerChange(q.id, opt)}
                                                    className={`px-3 py-1 text-sm rounded-md border transition-colors ${
                                                        answers[q.id] === opt
                                                            ? 'bg-primary text-primary-foreground border-primary'
                                                            : 'bg-background border-input hover:border-primary/50'
                                                    }`}
                                                >
                                                    {opt}
                                                </button>
                                            ))}
                                        </div>
                                    ) : q.type === 'yesno' ? (
                                        <div className="flex gap-2">
                                            {['Yes', 'No'].map((opt) => (
                                                <button
                                                    key={opt}
                                                    onClick={() => handleAnswerChange(q.id, opt)}
                                                    className={`px-4 py-1 text-sm rounded-md border transition-colors ${
                                                        answers[q.id] === opt
                                                            ? 'bg-primary text-primary-foreground border-primary'
                                                            : 'bg-background border-input hover:border-primary/50'
                                                    }`}
                                                >
                                                    {opt}
                                                </button>
                                            ))}
                                        </div>
                                    ) : (
                                        <input
                                            type="text"
                                            value={answers[q.id] || ''}
                                            onChange={(e) => handleAnswerChange(q.id, e.target.value)}
                                            placeholder={q.hint || ''}
                                            className="w-full px-3 py-1.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleAnswerSubmit();
                                            }}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>

                        {error && (
                            <p className="text-sm text-destructive">{error}</p>
                        )}

                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleAnswerSubmit}
                                disabled={isLaunching}
                                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {isLaunching ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Starting...
                                    </>
                                ) : (
                                    <>
                                        <ArrowRight className="w-4 h-4" />
                                        Submit & Run
                                    </>
                                )}
                            </button>

                            <button
                                onClick={handleSkipClarification}
                                disabled={isLaunching}
                                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground border border-input rounded-md transition-colors disabled:opacity-50"
                            >
                                Skip & Run
                            </button>

                            <button
                                onClick={() => { setIsClarifying(false); setClarifyingQuestions([]); }}
                                disabled={isLaunching}
                                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* ── History Panel ── */}
                {showHistory && !isClarifying && (
                    <div className="border-t pt-3 space-y-2">
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-medium">Recent Executions</h4>
                            <button
                                onClick={loadHistory}
                                disabled={historyLoading}
                                className="text-xs text-muted-foreground hover:text-foreground"
                            >
                                {historyLoading ? 'Loading...' : 'Refresh'}
                            </button>
                        </div>

                        {history.length === 0 && !historyLoading ? (
                            <p className="text-sm text-muted-foreground py-2">
                                No executions yet
                            </p>
                        ) : (
                            <div className="space-y-2 max-h-48 overflow-y-auto">
                                {history.map((item) => (
                                    <div
                                        key={item.id}
                                        className="flex items-start gap-2 p-2 rounded bg-muted/50 text-sm"
                                    >
                                        {item.status === 'success' ? (
                                            <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                                        ) : item.status === 'failed' ? (
                                            <XCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                                        ) : (
                                            <Clock className="w-4 h-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <p className="truncate font-medium">
                                                {item.description}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {item.completed_steps}/{item.total_steps} steps · {formatDuration(item.duration_ms)} · {formatRelativeTime(item.created_at)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
