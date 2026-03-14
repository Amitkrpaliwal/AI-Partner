import { useState, useEffect, useRef, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import {
    Play, Pause, Square, ChevronDown, ChevronUp, Target,
    CheckCircle, XCircle, Loader2, Clock,
    RefreshCw, Zap, TrendingUp, HelpCircle, Send, Brain,
    FileText, Timer, Repeat, MousePointer
} from 'lucide-react';
import { API_BASE } from '@/lib/api';

// ============================================================================
// TYPES
// ============================================================================

interface SuccessCriterion {
    id: string;
    type: string;
    config: Record<string, any>;
    weight: number;
    required: boolean;
    status: 'pending' | 'passed' | 'failed';
    message?: string;
}

interface GoalDefinition {
    id: string;
    description: string;
    success_criteria: SuccessCriterion[];
    acceptance_test?: string;
    estimated_complexity: number;
}

interface GoalExecutionState {
    execution_id: string;
    goal: GoalDefinition;
    status: 'planning' | 'executing' | 'validating' | 'replanning' | 'completed' | 'failed' | 'paused' | 'cancelled';
    current_iteration: number;
    max_iterations: number;
    progress_percent: number;
    strategy_changes: number;
    artifacts: string[];
    started_at?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function GoalProgressPanel() {
    const [execution, setExecution] = useState<GoalExecutionState | null>(null);
    const [isExpanded, setIsExpanded] = useState(true);
    const [isProcessing, setIsProcessing] = useState(false);
    const [replanHistory, setReplanHistory] = useState<string[]>([]);
    // Agent thinking / reasoning state
    const [lastReasoning, setLastReasoning] = useState('');
    const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
    // User-input escalation state
    type InputField = { name: string; label: string; type?: string; required?: boolean; placeholder?: string; options?: string[] };
    const [pendingInput, setPendingInput] = useState<{
        inputId: string;
        message: string;
        fields?: InputField[] | null;
        proactive?: boolean;
        browserAvailable?: boolean;  // server signals browser is relevant to this HITL
        browserTargetUrl?: string;   // URL to navigate to when browser control opens
    } | null>(null);
    const [userHint, setUserHint] = useState('');
    const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
    const [hitlSecondsLeft, setHitlSecondsLeft] = useState<number | null>(null);
    // Providers that already have an API key configured (parsed from HITL field placeholder)
    const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(new Set());

    // Common models per provider — shown as datalist suggestions on the model field
    const MODEL_SUGGESTIONS: Record<string, string[]> = {
        openai:      ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini', 'o3-mini'],
        anthropic:   ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
        gemini:      ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.5-pro-preview-05-06'],
        groq:        ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
        deepseek:    ['deepseek-chat', 'deepseek-reasoner'],
        ollama:      ['llama3.2', 'mistral', 'codellama', 'qwen2.5', 'phi3'],
        'ollama-cloud': ['gemini-3-flash-preview', 'llama3.2', 'mistral', 'qwen2.5'],
        lmstudio:    ['llama3.2', 'mistral', 'phi-3-mini'],
        perplexity:  ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
        mistral:     ['mistral-large-latest', 'mistral-small-latest', 'open-mixtral-8x22b'],
        openrouter:  ['anthropic/claude-3-5-sonnet', 'openai/gpt-4o', 'google/gemini-pro-1.5'],
        together:    ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    };
    // Final result shown when goal completes
    const [finalAnswer, setFinalAnswer] = useState<string>('');
    const [fileContentPreview, setFileContentPreview] = useState<string>('');
    const [primaryFilePath, setPrimaryFilePath] = useState<string>('');
    // Stats for the completion header
    const [completionStats, setCompletionStats] = useState<{ durationSec: number; iterations: number; files: number } | null>(null);
    const [isContentExpanded, setIsContentExpanded] = useState(false);
    // Browser control popup
    const popupRef = useRef<Window | null>(null);
    const [popupOpen, setPopupOpen] = useState(false);

    /** Open the browser control popup.
     *  autoControl=true: grants control immediately (explicit user click).
     *  autoControl=false (default): preview only — user clicks "Take Control" inside popup. */
    const handleOpenBrowserControl = useCallback((targetUrl?: string, autoControl = false) => {
        const params = new URLSearchParams({ popup: 'browser-control' });
        if (targetUrl) params.set('targetUrl', targetUrl);
        if (autoControl) params.set('autoControl', 'true');
        const popup = window.open(
            `?${params.toString()}`,
            'browser-control',
            'width=1600,height=1000,toolbar=no,menubar=no,scrollbars=no,resizable=yes'
        );
        if (popup) {
            popupRef.current = popup;
            setPopupOpen(true);
            // BrowserControlPopup will emit browser:take_control with the targetUrl on mount —
            // do NOT emit it here too or the server gets a duplicate (no targetUrl) first.
            // Auto-release when user closes popup
            const check = setInterval(() => {
                if (popup.closed) {
                    clearInterval(check);
                    setPopupOpen(false);
                    getSocket().emit('browser:release_control');
                }
            }, 500);
        } else {
            // Popup blocked — emit take_control directly (no popup URL params available)
            getSocket().emit('browser:take_control', { targetUrl });
        }
    }, []);

    useEffect(() => {
        const socket = getSocket();

        // Goal started
        socket.on('goal:started', (event: any) => {
            console.log('[GoalProgress] Goal started:', event);
            setReplanHistory([]);
            setLastReasoning('');
            setIsThinkingExpanded(false);
            setFinalAnswer('');
            setFileContentPreview('');
            setPrimaryFilePath('');
            setCompletionStats(null);
            setIsContentExpanded(false);
        });

        // Plan created
        socket.on('goal:plan_created', (event: any) => {
            console.log('[GoalProgress] Plan created:', event);
            setExecution({
                execution_id: event.execution_id,
                goal: event.goal,
                status: 'executing',
                current_iteration: 0,
                max_iterations: event.max_iterations,
                progress_percent: 0,
                strategy_changes: 0,
                artifacts: []
            });
        });

        // Progress update
        socket.on('goal:progress', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return {
                    ...prev,
                    status: event.status || prev.status,
                    current_iteration: event.iteration ?? prev.current_iteration,
                    progress_percent: event.progress_percent ?? prev.progress_percent
                };
            });
        });

        // Action executed
        socket.on('goal:action', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return {
                    ...prev,
                    current_iteration: event.iteration
                };
            });
        });

        // Validation result
        socket.on('goal:validation', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return {
                    ...prev,
                    progress_percent: event.score,
                    status: event.complete ? 'completed' : 'executing'
                };
            });
        });

        // Replanning
        socket.on('goal:replanning', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return {
                    ...prev,
                    status: 'replanning',
                    strategy_changes: event.strategy_changes
                };
            });
            setReplanHistory(prev => [...prev, event.new_strategy]);
        });

        // Completed
        socket.on('goal:completed', (event: any) => {
            const result = event.result || {};
            const summary = result.summary || {};

            // ── Rich content from the primary output file ──────────────────
            const preview = result.file_content_preview || result.final_answer || '';
            const filePath = result.primary_file_path || '';
            if (preview && preview !== '{}') {
                setFileContentPreview(preview);
                setFinalAnswer(preview);
            }
            if (filePath) setPrimaryFilePath(filePath);

            // ── Completion stats for the header strip ──────────────────────
            const durationSec = summary.duration_ms ? Math.round(summary.duration_ms / 1000) : 0;
            const iterations = summary.total_iterations || 0;
            const files = (summary.artifacts_created || []).length;
            setCompletionStats({ durationSec, iterations, files });

            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return {
                    ...prev,
                    status: 'completed',
                    progress_percent: 100,
                    artifacts: summary.artifacts_created ||
                        result.artifacts_created ||
                        prev.artifacts
                };
            });
        });

        // Failed — mirror the goal:completed handler so criteria statuses + stats are captured
        socket.on('goal:failed', (event: any) => {
            const result = event.result || {};
            const summary = result.summary || {};
            const durationSec = summary.duration_ms ? Math.round(summary.duration_ms / 1000) : 0;
            const iterations = summary.total_iterations || 0;
            const files = (summary.artifacts_created || []).filter((f: string) => !f.includes('_goal_script')).length;
            setCompletionStats({ durationSec, iterations, files });

            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                // Patch criteria with final statuses from result so the UI shows accurate pass/fail
                const updatedCriteria: SuccessCriterion[] =
                    result.goal?.success_criteria || prev.goal.success_criteria;
                return {
                    ...prev,
                    status: 'failed',
                    artifacts: summary.artifacts_created?.filter((f: string) => !f.includes('_goal_script')) || prev.artifacts,
                    goal: { ...prev.goal, success_criteria: updatedCriteria }
                };
            });
        });

        // Paused
        socket.on('goal:paused', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return { ...prev, status: 'paused' };
            });
        });

        // Cancelled
        socket.on('goal:cancelled', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return { ...prev, status: 'cancelled' };
            });
        });

        // CAPTCHA / Cloudflare block detected — auto-open browser popup immediately.
        // This is the only case where we auto-trigger. User must actively solve it visually.
        socket.on('browser:blocked', () => {
            handleOpenBrowserControl();
        });

        // User-input escalation: agent needs info (proactive) or is stuck.
        // If browserAvailable + browserTargetUrl, auto-open browser immediately so user
        // sees the stuck page before filling in credentials.
        socket.on('goal:user-input-needed', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return { ...prev, status: 'paused' };
            });
            setPendingInput({
                inputId: event.inputId,
                message: event.message,
                fields: event.fields || null,
                proactive: event.proactive || false,
                browserAvailable: event.browserAvailable || false,
                browserTargetUrl: event.browserTargetUrl || undefined,
            });
            setUserHint('');
            setFieldValues({});
            // Parse configured providers from the provider field's placeholder
            // (pipe-separated list sent by GoalOrientedExecutor, e.g. "ollama|lmstudio")
            const providerField = event.fields?.find((f: any) => f.name === 'provider');
            if (providerField?.placeholder?.includes('|') || providerField?.placeholder) {
                const configured = (providerField.placeholder as string).split('|').map((s: string) => s.trim()).filter(Boolean);
                setConfiguredProviders(new Set(configured));
            } else {
                setConfiguredProviders(new Set());
            }
            // Auto-open browser popup when agent is stuck on a page needing human interaction.
            if (event.browserAvailable && event.browserTargetUrl) {
                handleOpenBrowserControl(event.browserTargetUrl);
            }
        });

        // Browser control released — clear popup state.
        // If there was a pending HITL, the server auto-resolved it (resolveAnyPendingInput).
        // Clear it on the client too so the form disappears immediately.
        socket.on('browser:control_released', () => {
            setPopupOpen(false);
            setPendingInput(null);
            setUserHint('');
            setFieldValues({});
        });

        // Resumed (also clears pending input if user provided hint)
        socket.on('goal:resumed', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return { ...prev, status: 'executing' };
            });
            if (event.reason === 'user_hint') {
                setPendingInput(null);
                setUserHint('');
            }
        });

        // Agent reasoning — shows LLM "thinking" before each action
        socket.on('goal:reasoning', (event: any) => {
            setExecution(prev => {
                if (!prev || prev.execution_id !== event.execution_id) return prev;
                return prev;
            });
            if (event.reasoning) {
                setLastReasoning(event.reasoning);
            }
        });

        return () => {
            socket.off('goal:started');
            socket.off('goal:plan_created');
            socket.off('goal:progress');
            socket.off('goal:action');
            socket.off('goal:validation');
            socket.off('goal:replanning');
            socket.off('goal:completed');
            socket.off('goal:failed');
            socket.off('goal:paused');
            socket.off('goal:resumed');
            socket.off('goal:cancelled');
            socket.off('goal:user-input-needed');
            socket.off('goal:reasoning');
            socket.off('browser:blocked');
            socket.off('browser:control_released');
        };
    }, [handleOpenBrowserControl]);

    // 5-minute countdown when HITL form is open
    useEffect(() => {
        if (!pendingInput) { setHitlSecondsLeft(null); return; }
        setHitlSecondsLeft(5 * 60);
        const t = setInterval(() => {
            setHitlSecondsLeft(prev => {
                if (prev === null || prev <= 1) { clearInterval(t); return 0; }
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(t);
    }, [pendingInput?.inputId]);

    // Control handlers
    const handlePause = async () => {
        if (!execution) return;
        setIsProcessing(true);
        try {
            await fetch(`${API_BASE}/api/autonomous/goal/${execution.execution_id}/pause`, {
                method: 'POST'
            });
        } catch (e) {
            console.error('Pause failed:', e);
        }
        setIsProcessing(false);
    };

    const handleResume = async () => {
        if (!execution) return;
        setIsProcessing(true);
        try {
            await fetch(`${API_BASE}/api/autonomous/goal/${execution.execution_id}/resume`, {
                method: 'POST'
            });
        } catch (e) {
            console.error('Resume failed:', e);
        }
        setIsProcessing(false);
    };

    const handleCancel = async () => {
        if (!execution) return;
        setIsProcessing(true);
        try {
            await fetch(`${API_BASE}/api/autonomous/goal/${execution.execution_id}/cancel`, {
                method: 'POST'
            });
        } catch (e) {
            console.error('Cancel failed:', e);
        }
        setIsProcessing(false);
    };

    const handleDismiss = () => {
        setExecution(null);
        setReplanHistory([]);
        setPendingInput(null);
        setUserHint('');
        setFieldValues({});
        setFinalAnswer('');
        setFileContentPreview('');
        setPrimaryFilePath('');
        setCompletionStats(null);
        setIsContentExpanded(false);
    };

    const handleSubmitHint = async () => {
        if (!execution || !pendingInput) return;
        setIsProcessing(true);
        try {
            // For structured fields, serialize values as JSON; for plain hint, send as-is
            const hint = pendingInput.fields?.length
                ? JSON.stringify(fieldValues)
                : userHint;
            await fetch(`${API_BASE}/api/autonomous/goal/${execution.execution_id}/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputId: pendingInput.inputId, hint })
            });

            // If the user entered an API key for a new provider, persist it to settings
            // so it survives restarts and appears in the Integrations panel.
            const apiKey = fieldValues['api_key']?.trim();
            const provider = fieldValues['provider']?.trim();
            if (apiKey && provider) {
                const PROVIDER_KEY_MAP: Record<string, string> = {
                    openai: 'OPENAI_API_KEY',
                    anthropic: 'ANTHROPIC_API_KEY',
                    gemini: 'GEMINI_API_KEY',
                    groq: 'GROQ_API_KEY',
                    deepseek: 'DEEPSEEK_API_KEY',
                    perplexity: 'PERPLEXITY_API_KEY',
                    mistral: 'MISTRAL_API_KEY',
                    openrouter: 'OPENROUTER_API_KEY',
                    together: 'TOGETHER_API_KEY',
                };
                const envKey = PROVIDER_KEY_MAP[provider.toLowerCase()];
                if (envKey) {
                    fetch(`${API_BASE}/api/secrets/${envKey}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ value: apiKey }),
                    }).catch(() => {/* non-fatal */});
                }
            }

            setPendingInput(null);
            setUserHint('');
            setFieldValues({});
        } catch (e) {
            console.error('Submit hint failed:', e);
        }
        setIsProcessing(false);
    };

    const handleSkipHint = async () => {
        if (!execution || !pendingInput) return;
        setIsProcessing(true);
        try {
            // Sending empty hint causes the executor to fail gracefully
            await fetch(`${API_BASE}/api/autonomous/goal/${execution.execution_id}/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputId: pendingInput.inputId, hint: '' })
            });
            setPendingInput(null);
        } catch (e) {
            console.error('Skip hint failed:', e);
        }
        setIsProcessing(false);
    };

    // Don't render if no execution
    if (!execution) {
        return null;
    }

    // Criteria counts — computed before statusConfig so failed label can reference them
    const passedCriteria = execution.goal.success_criteria.filter(c => c.status === 'passed').length;
    const totalCriteria = execution.goal.success_criteria.length;
    const isPartialFail = execution.status === 'failed' && passedCriteria > 0;

    // Status styling
    const statusConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
        planning:   { color: 'text-blue-500',   icon: <Loader2 className="w-4 h-4 animate-spin" />,        label: 'Planning' },
        executing:  { color: 'text-yellow-500', icon: <Zap className="w-4 h-4" />,                          label: 'Executing' },
        validating: { color: 'text-purple-500', icon: <CheckCircle className="w-4 h-4 animate-pulse" />,    label: 'Validating' },
        replanning: { color: 'text-orange-500', icon: <RefreshCw className="w-4 h-4 animate-spin" />,       label: 'Re-planning' },
        completed:  { color: 'text-green-500',  icon: <CheckCircle className="w-4 h-4" />,                  label: 'Completed' },
        failed:     {
            color: isPartialFail ? 'text-amber-500' : 'text-red-500',
            icon:  isPartialFail
                ? <XCircle className="w-4 h-4" />
                : <XCircle className="w-4 h-4" />,
            label: isPartialFail ? `Partial (${passedCriteria}/${totalCriteria})` : 'Failed'
        },
        paused:     { color: pendingInput ? 'text-amber-500' : 'text-orange-500', icon: pendingInput ? <HelpCircle className="w-4 h-4 animate-pulse" /> : <Pause className="w-4 h-4" />, label: pendingInput ? 'Needs Your Help' : 'Paused' },
        cancelled:  { color: 'text-gray-500',   icon: <Square className="w-4 h-4" />,                       label: 'Cancelled' }
    };

    const currentStatus = statusConfig[execution.status] || statusConfig.executing;

    // Human-readable criterion label — replaces raw type + path display
    const criterionLabel = (c: SuccessCriterion): string => {
        const file = (c.config.path as string | undefined)?.split('/').pop() || '';
        switch (c.type) {
            case 'file_exists':    return file ? `${file} created` : 'File created';
            case 'file_contains': {
                const pat = String(c.config.pattern || c.config.expected || '').replace(/\\/g, '').substring(0, 30);
                return file ? `${file} has ${pat}` : `Content check: ${pat}`;
            }
            case 'tests_pass':     return 'npm tests pass';
            case 'output_matches': return 'Test output captured';
            case 'code_compiles':  return file ? `${file} compiles` : 'Code compiles';
            case 'llm_evaluates':  return String(c.config.expected || 'Quality check').substring(0, 50);
            default:               return c.type.replace(/_/g, ' ');
        }
    };

    // Map internal/technical error messages to plain English
    const humanizeError = (msg: string): string => {
        if (!msg) return '';
        if (/ENOENT|no such file/i.test(msg))                       return 'File not created yet';
        if (/STALE.*predates/i.test(msg))                            return 'File predates this run — needs rewriting';
        if (/describe is not defined|reading 'describe'/i.test(msg)) return 'Test runner (jest/mocha) not installed';
        if (/it is not defined|reading 'it'\b/i.test(msg))           return 'Test runner not installed';
        if (/Cannot find module '([^']+)'/.test(msg)) {
            const m = msg.match(/Cannot find module '([^']+)'/);
            const pkg = m ? m[1].split('/').pop() : 'dependency';
            return `Missing package: ${pkg} — run npm install`;
        }
        if (/Missing script.*test/i.test(msg))                       return 'package.json has no "test" script';
        if (/ECONNREFUSED/i.test(msg))                               return 'Server not running during tests';
        if (/SyntaxError|unexpected token/i.test(msg))               return 'Syntax error in test file';
        if (/Test Suites:.*failed/i.test(msg))                       return 'Tests failed — see test output';
        if (/Pattern.*NOT found/i.test(msg)) {
            const m = msg.match(/Pattern "([^"]+)" NOT found/);
            return m ? `Missing: ${m[1].substring(0, 40)}` : 'Pattern not found in file';
        }
        // Trim long technical output — first line only
        return msg.split('\n')[0].substring(0, 100);
    };

    return (
        <div className="fixed bottom-4 right-4 z-50 w-[420px] max-h-[80vh] overflow-hidden">
            <div className="bg-card border border-border rounded-lg shadow-2xl">
                {/* Header */}
                <div
                    className="flex items-center justify-between p-3 border-b border-border cursor-pointer hover:bg-muted/50"
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    <div className="flex items-center gap-2">
                        <Target className="w-5 h-5 text-primary" />
                        <span className="font-semibold text-sm">Goal-Oriented Execution</span>
                        <span className={`text-xs flex items-center gap-1 ${currentStatus.color}`}>
                            {currentStatus.icon}
                            {currentStatus.label}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            {execution.progress_percent}%
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
                        {/* Goal description */}
                        <div className="px-3 py-2 border-b border-border bg-muted/30">
                            <div className="text-sm font-medium truncate">
                                {execution.goal.description}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                                Complexity: {execution.goal.estimated_complexity}/10
                            </div>
                        </div>

                        {/* Progress bar */}
                        <div className="px-3 py-2 border-b border-border">
                            <div className="flex items-center justify-between text-xs mb-1">
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <TrendingUp className="w-3 h-3" />
                                    {/* While running: show step count. When done: show duration + limit flag. */}
                                    {(execution.status === 'completed' || execution.status === 'failed') && completionStats
                                        ? completionStats.durationSec >= 60
                                            ? `${Math.floor(completionStats.durationSec / 60)}m ${completionStats.durationSec % 60}s`
                                            : `${completionStats.durationSec}s`
                                        : `Step ${execution.current_iteration}/${execution.max_iterations}`
                                    }
                                    {/* Flag when iteration limit was hit */}
                                    {execution.status === 'failed' &&
                                     completionStats &&
                                     execution.current_iteration >= execution.max_iterations && (
                                        <span className="text-amber-500 ml-1">· hit limit</span>
                                    )}
                                </span>
                                <span className="text-muted-foreground">
                                    {passedCriteria}/{totalCriteria} done
                                </span>
                            </div>
                            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                    className={`h-full transition-all duration-500 ${
                                        execution.status === 'completed' ? 'bg-green-500' :
                                        execution.status === 'failed' && passedCriteria > 0 ? 'bg-amber-500' :
                                        execution.status === 'failed' ? 'bg-red-500' :
                                        'bg-primary'
                                    }`}
                                    style={{ width: `${execution.progress_percent}%` }}
                                />
                            </div>
                            {/* Strategy change — only during execution, not after. Post-run it's noise. */}
                            {execution.strategy_changes > 0 &&
                             execution.status !== 'completed' &&
                             execution.status !== 'failed' && (
                                <div className="text-xs text-orange-400 mt-1 flex items-center gap-1">
                                    <RefreshCw className="w-3 h-3" />
                                    Trying a different approach…
                                </div>
                            )}
                        </div>

                        {/* Success Criteria */}
                        <div className="max-h-48 overflow-y-auto p-2 space-y-1">
                            <div className="text-xs font-medium text-muted-foreground mb-1 px-1">
                                Success Criteria:
                            </div>
                            {execution.goal.success_criteria.map((criterion) => (
                                <div
                                    key={criterion.id}
                                    className={`flex items-start gap-2 px-2 py-1.5 rounded text-xs ${
                                        criterion.status === 'passed' ? 'bg-green-500/10' :
                                        criterion.status === 'failed' ? 'bg-red-500/10' :
                                        'bg-muted/30'
                                    }`}
                                >
                                    <div className="mt-0.5 shrink-0">
                                        {criterion.status === 'passed' && <CheckCircle className="w-3 h-3 text-green-500" />}
                                        {criterion.status === 'failed'  && <XCircle    className="w-3 h-3 text-red-400"   />}
                                        {criterion.status === 'pending' && <Clock      className="w-3 h-3 text-muted-foreground" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {/* Human-readable label — no raw type, no raw path */}
                                        <div className={`font-medium truncate ${
                                            criterion.status === 'passed' ? 'text-green-700 dark:text-green-400' :
                                            criterion.status === 'failed' ? 'text-foreground' :
                                            'text-muted-foreground'
                                        }`}>
                                            {criterionLabel(criterion)}
                                            {!criterion.required && (
                                                <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">(optional)</span>
                                            )}
                                        </div>
                                        {/* Error detail — humanized, only for failed */}
                                        {criterion.status === 'failed' && criterion.message && (
                                            <div className="text-red-400 mt-0.5 leading-snug">
                                                {humanizeError(criterion.message)}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Replan history — only shown while executing, not after completion.
                            Post-run it's internal noise; the criteria breakdown tells the real story. */}
                        {replanHistory.length > 0 &&
                         execution.status !== 'completed' &&
                         execution.status !== 'failed' && (
                            <div className="px-3 py-2 border-t border-border">
                                <div className="text-xs text-orange-400 flex items-center gap-1">
                                    <RefreshCw className="w-3 h-3" />
                                    Tried a different approach ({replanHistory.length}×)
                                </div>
                            </div>
                        )}

                        {/* Agent Thinking (last reasoning block) */}
                        {lastReasoning && (
                            <div className="border-t border-border">
                                <button
                                    onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                                    className="w-full px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
                                >
                                    <Brain className="w-3 h-3 text-purple-400 shrink-0" />
                                    <span className="font-medium text-purple-400">Agent Thinking</span>
                                    <span className="flex-1 truncate italic text-left opacity-70">
                                        {lastReasoning.substring(0, 60)}{lastReasoning.length > 60 ? '…' : ''}
                                    </span>
                                    {isThinkingExpanded
                                        ? <ChevronUp className="w-3 h-3 shrink-0" />
                                        : <ChevronDown className="w-3 h-3 shrink-0" />}
                                </button>
                                {isThinkingExpanded && (
                                    <div className="px-3 pb-2">
                                        <div className="bg-purple-500/5 border border-purple-500/20 rounded p-2 text-xs text-muted-foreground italic leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap">
                                            {lastReasoning}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Final Result — shown when goal completes */}
                        {execution.status === 'completed' && (fileContentPreview || finalAnswer) && (
                            <div className="border-t border-green-500/30 bg-green-500/5">
                                {/* Header + stats */}
                                <div className="px-3 pt-2 pb-1">
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs font-semibold text-green-600 flex items-center gap-1">
                                            <CheckCircle className="w-3 h-3" />
                                            Goal Completed
                                        </div>
                                        <button
                                            onClick={() => setIsContentExpanded(v => !v)}
                                            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                                        >
                                            {isContentExpanded ? 'Collapse' : 'Expand'}
                                            {isContentExpanded
                                                ? <ChevronUp className="w-3 h-3" />
                                                : <ChevronDown className="w-3 h-3" />}
                                        </button>
                                    </div>

                                    {/* Stats strip */}
                                    {completionStats && (
                                        <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                                            <span className="flex items-center gap-1">
                                                <Timer className="w-3 h-3" />{completionStats.durationSec}s
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <Repeat className="w-3 h-3" />{completionStats.iterations} iters
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <FileText className="w-3 h-3" />{completionStats.files} file{completionStats.files !== 1 ? 's' : ''}
                                            </span>
                                        </div>
                                    )}

                                    {/* Primary file badge */}
                                    {primaryFilePath && (
                                        <div className="mt-1.5 flex items-center gap-1">
                                            <FileText className="w-3 h-3 text-green-500 shrink-0" />
                                            <span
                                                className="text-xs font-medium text-green-600 truncate"
                                                title={primaryFilePath}
                                            >
                                                {primaryFilePath.split('/').pop()}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {/* Content area — collapsible */}
                                <div
                                    className={`px-3 pb-2 transition-all duration-200 ${isContentExpanded ? 'max-h-[60vh]' : 'max-h-52'
                                        } overflow-y-auto`}
                                >
                                    <pre className="text-xs text-foreground whitespace-pre-wrap leading-relaxed bg-background border border-border rounded p-2 font-mono">
                                        {fileContentPreview || finalAnswer}
                                    </pre>
                                </div>
                            </div>
                        )}

                        {/* Artifacts */}
                        {execution.artifacts.length > 0 && (
                            <div className="px-3 py-2 border-t border-border">
                                <div className="text-xs font-medium mb-1">Files Created:</div>
                                <div className="flex flex-wrap gap-1">
                                    {execution.artifacts.slice(0, 5).map((artifact, i) => (
                                        <span
                                            key={i}
                                            className="text-xs bg-green-500/10 text-green-600 px-2 py-0.5 rounded truncate max-w-[120px]"
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

                        {/* User-input escalation prompt */}
                        {pendingInput && (
                            <div className="px-3 py-3 border-t border-amber-500/40 bg-amber-500/10">
                                <div className="flex items-start gap-2 mb-2">
                                    <HelpCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                    <div className="flex-1 text-xs text-amber-600 font-medium leading-snug">
                                        {pendingInput.message}
                                    </div>
                                    {hitlSecondsLeft !== null && (
                                        <span className={`shrink-0 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${hitlSecondsLeft <= 60 ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-amber-100 text-amber-600'}`}>
                                            {Math.floor(hitlSecondsLeft / 60)}:{String(hitlSecondsLeft % 60).padStart(2, '0')}
                                        </span>
                                    )}
                                </div>

                                {/* Structured fields (proactive credential/detail request) */}
                                {pendingInput.fields?.length ? (
                                    <div className="space-y-2">
                                        {pendingInput.fields.map(f => {
                                            const selectedProvider = fieldValues['provider'] || '';
                                            // api_key is required only when the chosen provider isn't already configured
                                            const isApiKeyField = f.name === 'api_key';
                                            const apiKeyRequired = isApiKeyField && selectedProvider
                                                ? !configuredProviders.has(selectedProvider)
                                                : (f.required !== false);
                                            const isRequired = isApiKeyField ? apiKeyRequired : (f.required !== false);

                                            // Model suggestions for the selected provider
                                            const isModelField = f.name === 'model';
                                            const modelSuggestions = isModelField && selectedProvider
                                                ? (MODEL_SUGGESTIONS[selectedProvider] || [])
                                                : [];
                                            const datalistId = isModelField ? 'model-suggestions' : undefined;

                                            return (
                                            <div key={f.name}>
                                                <label className="block text-xs text-amber-700 font-medium mb-0.5">
                                                    {isApiKeyField
                                                        ? (selectedProvider && !configuredProviders.has(selectedProvider)
                                                            ? 'API Key * (required — provider not configured)'
                                                            : selectedProvider && configuredProviders.has(selectedProvider)
                                                                ? 'API Key (optional — already configured)'
                                                                : f.label)
                                                        : f.label + (isRequired ? ' *' : '')
                                                    }
                                                </label>
                                                {f.type === 'select' && f.options?.length ? (
                                                    <select
                                                        value={fieldValues[f.name] || ''}
                                                        onChange={e => setFieldValues(prev => ({ ...prev, [f.name]: e.target.value, model: '' }))}
                                                        className="w-full text-xs border border-amber-300 rounded px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-amber-400"
                                                    >
                                                        <option value="">Select provider…</option>
                                                        {f.options.map(opt => (
                                                            <option key={opt} value={opt}>
                                                                {opt}{configuredProviders.has(opt) ? ' ✓' : ''}
                                                            </option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <>
                                                        <input
                                                            type={f.type === 'password' ? 'password' : f.type === 'tel' ? 'tel' : f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
                                                            value={fieldValues[f.name] || ''}
                                                            onChange={e => setFieldValues(prev => ({ ...prev, [f.name]: e.target.value }))}
                                                            placeholder={isModelField && modelSuggestions.length
                                                                ? `e.g. ${modelSuggestions[0]}`
                                                                : (f.placeholder || '')}
                                                            list={datalistId}
                                                            className="w-full text-xs border border-amber-300 rounded px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-amber-400"
                                                            autoComplete={f.type === 'password' ? 'current-password' : f.type === 'otp' ? 'one-time-code' : 'off'}
                                                        />
                                                        {datalistId && modelSuggestions.length > 0 && (
                                                            <datalist id={datalistId}>
                                                                {modelSuggestions.map(m => <option key={m} value={m} />)}
                                                            </datalist>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    /* Plain hint textarea (stuck-state fallback) */
                                    <textarea
                                        value={userHint}
                                        onChange={e => setUserHint(e.target.value)}
                                        placeholder="Type a hint or new approach (e.g. 'try using the GitHub API instead')"
                                        className="w-full text-xs border border-amber-300 rounded p-2 resize-none bg-background focus:outline-none focus:ring-1 focus:ring-amber-400"
                                        rows={3}
                                        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSubmitHint(); }}
                                    />
                                )}

                                {/* Optional browser control — shown when server flags browserAvailable.
                                    User taps this voluntarily; we never auto-trigger for credentials. */}
                                {pendingInput.browserAvailable && (
                                    <button
                                        onClick={() => handleOpenBrowserControl(pendingInput.browserTargetUrl, true)}
                                        className="w-full flex items-center justify-center gap-1.5 mt-2 px-3 py-2 text-xs bg-orange-500/20 text-orange-400 border border-orange-500/40 rounded hover:bg-orange-500/30 font-medium"
                                        title="Open the live browser to fill in credentials visually instead of typing here"
                                    >
                                        <MousePointer className="w-3 h-3" />
                                        {popupOpen ? 'Browser Control Open ↗' : 'Fill in Browser Instead ↗'}
                                    </button>
                                )}

                                <div className="flex gap-2 mt-2">
                                    <button
                                        onClick={handleSubmitHint}
                                        disabled={isProcessing || (
                                            pendingInput.fields?.length
                                                ? pendingInput.fields.some(f => {
                                                    // api_key required only when selected provider isn't already configured
                                                    const effectiveRequired = f.name === 'api_key'
                                                        ? !configuredProviders.has(fieldValues['provider'] || '')
                                                        : f.required !== false;
                                                    return effectiveRequired && !fieldValues[f.name]?.trim();
                                                })
                                                : !userHint.trim()
                                        )}
                                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50"
                                    >
                                        <Send className="w-3 h-3" />
                                        {pendingInput.proactive ? 'Submit' : 'Send Hint'}
                                    </button>
                                    <button
                                        onClick={handleSkipHint}
                                        disabled={isProcessing}
                                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 disabled:opacity-50"
                                    >
                                        <XCircle className="w-3 h-3" />
                                        {pendingInput.proactive ? 'Cancel' : 'Give Up'}
                                    </button>
                                </div>
                                {!pendingInput.fields?.length && (
                                    <div className="text-xs text-muted-foreground mt-1">Ctrl+Enter to send</div>
                                )}
                            </div>
                        )}

                        {/* Controls */}
                        <div className="p-3 border-t border-border flex items-center justify-between">
                            <div className="text-xs text-muted-foreground">
                                ID: {(execution.execution_id || 'unknown').substring(0, 12)}...
                            </div>
                            <div className="flex items-center gap-2">
                                {(execution.status === 'executing' || execution.status === 'validating' || execution.status === 'replanning') && (
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
                                            onClick={handleCancel}
                                            disabled={isProcessing}
                                            className="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 disabled:opacity-50"
                                        >
                                            <Square className="w-3 h-3" />
                                            Cancel
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
                                            onClick={handleCancel}
                                            disabled={isProcessing}
                                            className="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 disabled:opacity-50"
                                        >
                                            <Square className="w-3 h-3" />
                                            Cancel
                                        </button>
                                    </>
                                )}
                                {(execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') && (
                                    <button
                                        onClick={handleDismiss}
                                        className="flex items-center gap-1 px-3 py-1 text-xs bg-muted text-muted-foreground rounded hover:bg-muted/80"
                                    >
                                        Dismiss
                                    </button>
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
