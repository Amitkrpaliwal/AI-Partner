import { useState, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { Check, ChevronRight, Loader2, Eye, EyeOff, AlertCircle, ChevronDown, Trash2 } from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4;

interface WizardState {
    llmProvider: string;
    llmApiKey: string;
    ollamaHost: string;
    agentPersonality: string;
    customPrompt: string;
    integrations: Record<string, string>;
    userName: string;
    workspacePath: string;
}

// ─── Data ──────────────────────────────────────────────────────────────────────

const LLM_PROVIDERS = [
    { id: 'openai', label: 'OpenAI', icon: '🧠', models: 'GPT-4o, GPT-4 Turbo', keyHint: 'sk-...', url: 'https://platform.openai.com/api-keys' },
    { id: 'google', label: 'Google Gemini', icon: '✨', models: 'Gemini 2.0 Flash, Gemini Pro', keyHint: 'AIza...', url: 'https://aistudio.google.com/apikey' },
    { id: 'anthropic', label: 'Anthropic', icon: '🔬', models: 'Claude 3.5 Sonnet, Claude 3', keyHint: 'sk-ant-...', url: 'https://console.anthropic.com/settings/keys' },
    { id: 'groq', label: 'Groq', icon: '⚡', models: 'Llama 3, Mixtral (ultra-fast)', keyHint: 'gsk_...', url: 'https://console.groq.com/keys' },
    { id: 'deepseek', label: 'DeepSeek', icon: '🔍', models: 'DeepSeek R1, DeepSeek V3', keyHint: 'sk-...', url: 'https://platform.deepseek.com/api_keys' },
    { id: 'mistral', label: 'Mistral', icon: '🌬️', models: 'Mistral Large, Codestral', keyHint: 'sk-...', url: 'https://console.mistral.ai/api-keys' },
    { id: 'ollama', label: 'Local / Ollama', icon: '🏠', models: 'Any model on your machine', keyHint: null, url: 'https://ollama.ai' },
] as const;

const PERSONALITIES = [
    { id: 'professional', label: 'Professional', icon: '💼', tagline: 'Efficient, direct, business-focused', description: 'Prioritises clear deliverables and concise communication.', prompt: 'You are a professional AI assistant. Be concise, structured, and results-oriented.' },
    { id: 'coder', label: 'Focused Coder', icon: '💻', tagline: 'Code-first, technically precise', description: 'Always shows code, explains decisions, writes tests.', prompt: 'You are an expert software engineer. Always prefer concrete code over explanations. Write clean, tested, production-ready code.' },
    { id: 'analyst', label: 'Deep Analyst', icon: '🔎', tagline: 'Research-heavy, data-driven', description: 'Explores all angles, cites sources, stress-tests reasoning.', prompt: 'You are a rigorous analyst. Research thoroughly before drawing conclusions. Present multiple perspectives and cite your evidence.' },
    { id: 'creative', label: 'Creative', icon: '🎨', tagline: 'Imaginative, expressive, generative', description: 'Brings creativity, brainstorms alternatives, writes with flair.', prompt: 'You are a creative AI partner. Bring imagination to every task. Generate ideas, explore unexpected angles, and write with personality.' },
];

const INTEGRATIONS = [
    { id: 'telegram', label: 'Telegram Bot', description: 'Receive results and send commands via Telegram.', keyLabel: 'Bot Token', keyHint: '1234567890:ABC...' },
    { id: 'discord', label: 'Discord Bot', description: 'AI Partner joins your Discord server.', keyLabel: 'Bot Token', keyHint: 'MTI3...' },
    { id: 'github', label: 'GitHub', description: 'Create PRs, issues, and manage repos.', keyLabel: 'Personal Access Token', keyHint: 'ghp_...' },
    { id: 'notion', label: 'Notion', description: 'Create pages, update databases, search notes.', keyLabel: 'API Key', keyHint: 'secret_...' },
    { id: 'brave', label: 'Brave Search', description: 'High-quality web search API.', keyLabel: 'API Key', keyHint: 'BSA...' },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function cn(...classes: (string | boolean | undefined)[]) {
    return classes.filter(Boolean).join(' ');
}

// ─── Step Indicator ────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
    const steps = ['LLM Provider', 'Personality', 'Integrations', 'Workspace'];
    return (
        <div className="flex items-center">
            {steps.map((label, i) => {
                const step = (i + 1) as Step;
                const done = step < current;
                const active = step === current;
                return (
                    <div key={step} className="flex items-center">
                        <div className="flex flex-col items-center">
                            <div className={cn(
                                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all',
                                done && 'bg-emerald-500 text-white',
                                active && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
                                !done && !active && 'bg-muted text-muted-foreground'
                            )}>
                                {done ? <Check className="w-3.5 h-3.5" /> : step}
                            </div>
                            <span className={cn('text-[10px] mt-1 font-medium whitespace-nowrap', active ? 'text-foreground' : 'text-muted-foreground')}>
                                {label}
                            </span>
                        </div>
                        {i < steps.length - 1 && (
                            <div className={cn('w-10 h-0.5 mx-1 mb-4 shrink-0', done ? 'bg-emerald-500' : 'bg-border')} />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ─── Step 1: LLM Provider ─────────────────────────────────────────────────────

function Step1LLM({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
    const [showKey, setShowKey] = useState(false);
    const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
    const [testError, setTestError] = useState<string>('');
    const provider = LLM_PROVIDERS.find(p => p.id === state.llmProvider);

    const testConnection = async () => {
        setTestStatus('testing');
        setTestError('');
        try {
            const params = new URLSearchParams({ provider: state.llmProvider });
            if (state.llmProvider === 'ollama') params.set('ollamaHost', state.ollamaHost);
            else params.set('apiKey', state.llmApiKey);
            const r = await fetch(`${API_BASE}/api/setup/llm-test?${params}`);
            const data = await r.json() as { ok: boolean; error?: string };
            if (data.ok) { setTestStatus('ok'); }
            else { setTestStatus('error'); setTestError(data.error || 'Connection failed'); }
        } catch {
            setTestStatus('error');
            setTestError('Could not reach the server');
        }
    };

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-bold text-foreground">Choose your AI provider</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Only one key is required to get started.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
                {LLM_PROVIDERS.map(p => (
                    <button
                        key={p.id}
                        onClick={() => { update({ llmProvider: p.id, llmApiKey: '' }); setTestStatus('idle'); }}
                        className={cn(
                            'flex items-start gap-2.5 p-3 rounded-xl border text-left transition-all',
                            state.llmProvider === p.id
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'border-border hover:border-primary/50 bg-card text-foreground hover:bg-accent/50'
                        )}
                    >
                        <span className="text-xl leading-none mt-0.5">{p.icon}</span>
                        <div className="min-w-0 flex-1">
                            <div className="font-semibold text-sm">{p.label}</div>
                            <div className="text-[10px] text-muted-foreground truncate">{p.models}</div>
                        </div>
                        {state.llmProvider === p.id && <Check className="w-3.5 h-3.5 text-primary ml-auto shrink-0 mt-1" />}
                    </button>
                ))}
            </div>
            {state.llmProvider && (
                state.llmProvider === 'ollama' ? (
                    <div>
                        <label className="text-sm font-medium text-foreground">Ollama Host URL</label>
                        <input
                            value={state.ollamaHost}
                            onChange={e => { update({ ollamaHost: e.target.value }); setTestStatus('idle'); }}
                            placeholder="http://localhost:11434"
                            className="w-full mt-1 px-3 py-2 bg-background border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <div className="flex items-center gap-2 mt-2">
                            <button
                                onClick={testConnection}
                                disabled={state.ollamaHost.trim().length === 0 || testStatus === 'testing'}
                                className="px-3 py-1.5 text-xs font-medium bg-muted hover:bg-muted/80 disabled:opacity-40 rounded-lg transition-colors flex items-center gap-1.5"
                            >
                                {testStatus === 'testing' ? <><Loader2 className="w-3 h-3 animate-spin" />Testing…</> : 'Test connection'}
                            </button>
                            {testStatus === 'ok' && <span className="text-xs text-emerald-500 flex items-center gap-1"><Check className="w-3 h-3" />Ollama reachable</span>}
                            {testStatus === 'error' && <span className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="w-3 h-3" />{testError}</span>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                            Ensure Ollama is running. <a href="https://ollama.ai" target="_blank" rel="noreferrer" className="text-primary underline">Get Ollama →</a>
                        </p>
                    </div>
                ) : (
                    <div>
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-foreground">API Key</label>
                            {provider?.url && (
                                <a href={provider.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">Get key →</a>
                            )}
                        </div>
                        <div className="relative mt-1">
                            <input
                                type={showKey ? 'text' : 'password'}
                                value={state.llmApiKey}
                                onChange={e => { update({ llmApiKey: e.target.value }); setTestStatus('idle'); }}
                                placeholder={provider?.keyHint || 'Enter API key...'}
                                className="w-full px-3 py-2 pr-10 bg-background border border-input rounded-lg text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                            <button onClick={() => setShowKey(!showKey)} className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground">
                                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                            <button
                                onClick={testConnection}
                                disabled={state.llmApiKey.trim().length < 6 || testStatus === 'testing'}
                                className="px-3 py-1.5 text-xs font-medium bg-muted hover:bg-muted/80 disabled:opacity-40 rounded-lg transition-colors flex items-center gap-1.5"
                            >
                                {testStatus === 'testing' ? <><Loader2 className="w-3 h-3 animate-spin" />Testing…</> : 'Test connection'}
                            </button>
                            {testStatus === 'ok' && <span className="text-xs text-emerald-500 flex items-center gap-1"><Check className="w-3 h-3" />Connected</span>}
                            {testStatus === 'error' && <span className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="w-3 h-3" />{testError}</span>}
                        </div>
                    </div>
                )
            )}
        </div>
    );
}

// ─── Step 2: Personality ──────────────────────────────────────────────────────

function Step2Personality({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
    const selected = PERSONALITIES.find(p => p.id === state.agentPersonality);
    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-bold text-foreground">Choose a personality</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Sets the agent's system prompt. Editable anytime in Settings.</p>
            </div>
            <div className="space-y-2">
                {PERSONALITIES.map(p => (
                    <button
                        key={p.id}
                        onClick={() => update({ agentPersonality: p.id, customPrompt: p.prompt })}
                        className={cn(
                            'w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all',
                            state.agentPersonality === p.id
                                ? 'border-primary bg-primary/10'
                                : 'border-border hover:border-primary/50 bg-card hover:bg-accent/50'
                        )}
                    >
                        <span className="text-xl leading-none mt-0.5">{p.icon}</span>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="font-semibold text-sm text-foreground">{p.label}</span>
                                <span className="text-[10px] text-muted-foreground">{p.tagline}</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                        </div>
                        {state.agentPersonality === p.id && <Check className="w-3.5 h-3.5 text-primary shrink-0 mt-1" />}
                    </button>
                ))}
            </div>
            {selected && (
                <div>
                    <label className="text-xs text-muted-foreground">System prompt (editable):</label>
                    <textarea
                        value={state.customPrompt}
                        onChange={e => update({ customPrompt: e.target.value })}
                        rows={2}
                        className="w-full mt-1 px-3 py-2 bg-background border border-input rounded-lg text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                </div>
            )}
        </div>
    );
}

// ─── Step 3: Integrations ─────────────────────────────────────────────────────

function Step3Integrations({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const setIntegration = (id: string, value: string) =>
        update({ integrations: { ...state.integrations, [id]: value } });

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-bold text-foreground">Connect integrations</h2>
                <p className="text-sm text-muted-foreground mt-0.5">All optional — add from Settings → Integrations anytime.</p>
            </div>
            <div className="space-y-2">
                {INTEGRATIONS.map(integration => {
                    const hasValue = !!(state.integrations[integration.id]);
                    const isOpen = expanded === integration.id;
                    return (
                        <div key={integration.id} className={cn(
                            'border rounded-xl transition-all',
                            hasValue ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border bg-card'
                        )}>
                            <button
                                className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
                                onClick={() => setExpanded(isOpen ? null : integration.id)}
                            >
                                <div className="flex-1">
                                    <span className="font-medium text-sm text-foreground">{integration.label}</span>
                                    <span className="text-xs text-muted-foreground ml-2">{integration.description}</span>
                                </div>
                                {hasValue && <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                                <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                            </button>
                            {isOpen && (
                                <div className="px-4 pb-3">
                                    <label className="text-xs text-muted-foreground">{integration.keyLabel}</label>
                                    <input
                                        autoFocus
                                        type="password"
                                        value={state.integrations[integration.id] || ''}
                                        onChange={e => setIntegration(integration.id, e.target.value)}
                                        placeholder={integration.keyHint}
                                        className="w-full mt-1 px-3 py-1.5 bg-background border border-input rounded-lg text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Step 4: Workspace & User ─────────────────────────────────────────────────

function Step4Workspace({ state, update, runMode }: { state: WizardState; update: (p: Partial<WizardState>) => void; runMode: string }) {
    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-bold text-foreground">Final details</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Almost done.</p>
            </div>
            <div className="space-y-4">
                <div>
                    <label className="text-sm font-medium text-foreground">Your name</label>
                    <p className="text-xs text-muted-foreground">Used in greetings and proactive messages.</p>
                    <input
                        value={state.userName}
                        onChange={e => update({ userName: e.target.value })}
                        placeholder="e.g. Alex"
                        className="w-full mt-1 px-3 py-2 bg-background border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                </div>
                <div>
                    <label className="text-sm font-medium text-foreground">Workspace folder</label>
                    <p className="text-xs text-muted-foreground">
                        {runMode === 'docker' ? 'Leave blank for built-in Docker volume.' : 'Folder where the agent reads and writes files.'}
                    </p>
                    <input
                        value={state.workspacePath}
                        onChange={e => update({ workspacePath: e.target.value })}
                        placeholder={runMode === 'docker' ? 'e.g. C:\\Users\\you\\ai-work (optional)' : 'e.g. C:\\Users\\you\\ai-work'}
                        className="w-full mt-1 px-3 py-2 bg-background border border-input rounded-lg text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                </div>
                {/* Summary card */}
                <div className="bg-muted/30 border border-border rounded-xl p-4 space-y-1.5">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Setup Summary</div>
                    <SummaryRow label="LLM Provider" value={state.llmProvider || '—'} ok={!!state.llmProvider} />
                    <SummaryRow label="Personality" value={PERSONALITIES.find(p => p.id === state.agentPersonality)?.label || '—'} ok={!!state.agentPersonality} />
                    <SummaryRow label="Integrations" value={`${Object.values(state.integrations).filter(Boolean).length} connected`} ok neutral />
                    <SummaryRow label="Your name" value={state.userName || '(skipped)'} ok neutral />
                    <SummaryRow label="Workspace" value={state.workspacePath || 'Built-in volume'} ok neutral />
                </div>
            </div>
        </div>
    );
}

function SummaryRow({ label, value, ok, neutral }: { label: string; value: string; ok: boolean; neutral?: boolean }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground truncate max-w-40">{value}</span>
                {neutral
                    ? <div className="w-2.5 h-2.5 rounded-full bg-muted-foreground/30 shrink-0" />
                    : ok
                        ? <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                        : <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
                }
            </div>
        </div>
    );
}

// ─── Factory Reset Panel ──────────────────────────────────────────────────────

function FactoryResetPanel() {
    const [confirming, setConfirming] = useState(false);
    const [typedText, setTypedText] = useState('');
    const [resetting, setResetting] = useState(false);
    const [done, setDone] = useState(false);
    const [wipeWorkspace, setWipeWorkspace] = useState(false);

    const CONFIRM_PHRASE = 'RESET EVERYTHING';

    const handleReset = async () => {
        setResetting(true);
        try {
            await fetch(`${API_BASE}/api/setup/factory-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wipeWorkspace }),
            });
            setDone(true);
            setTimeout(() => window.location.reload(), 2500);
        } catch {
            setResetting(false);
        }
    };

    if (done) {
        return (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
                <Check className="w-10 h-10 text-emerald-500" />
                <p className="font-semibold text-foreground">Factory reset complete</p>
                <p className="text-sm text-muted-foreground">Restarting application...</p>
            </div>
        );
    }

    return (
        <div className="mt-8 border border-destructive/40 rounded-xl bg-destructive/5 p-5 space-y-3">
            <div className="flex items-center gap-2 text-destructive font-semibold">
                <Trash2 className="w-4 h-4" />
                Factory Reset
            </div>
            <p className="text-sm text-muted-foreground">
                Permanently erases <strong className="text-foreground">all memories, conversations, API keys, agent profiles, skills, tasks, and connections</strong>.
                The app will restart and show the setup wizard again.
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={wipeWorkspace}
                    onChange={e => setWipeWorkspace(e.target.checked)}
                    className="w-4 h-4 accent-destructive"
                />
                <span className="text-sm text-muted-foreground">
                    Also delete workspace files <span className="text-xs">(generated files, scripts, output folders — preserves SOUL.md, HEARTBEAT.md, AGENTS.md, skill configs)</span>
                </span>
            </label>
            {!confirming ? (
                <button
                    onClick={() => setConfirming(true)}
                    className="px-4 py-2 bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/30 rounded-lg text-sm font-medium transition-colors"
                >
                    Erase all data &amp; reset to defaults
                </button>
            ) : (
                <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                        Type <code className="bg-muted px-1 py-0.5 rounded text-foreground font-mono font-bold">{CONFIRM_PHRASE}</code> to confirm:
                    </p>
                    <input
                        autoFocus
                        value={typedText}
                        onChange={e => setTypedText(e.target.value)}
                        placeholder={CONFIRM_PHRASE}
                        className="w-full px-3 py-2 bg-background border border-destructive/40 rounded-lg text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-destructive"
                    />
                    <div className="flex gap-2">
                        <button
                            onClick={() => { setConfirming(false); setTypedText(''); }}
                            className="px-3 py-1.5 bg-muted hover:bg-muted/80 text-muted-foreground rounded-lg text-xs font-medium transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleReset}
                            disabled={typedText !== CONFIRM_PHRASE || resetting}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-destructive hover:bg-destructive/90 disabled:opacity-40 text-destructive-foreground rounded-lg text-xs font-bold transition-colors"
                        >
                            {resetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            {resetting ? 'Resetting...' : 'Confirm & Reset'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────

interface SetupWizardProps {
    onComplete: () => void;
    runMode?: string;
    inline?: boolean;
}

export function SetupWizard({ onComplete, runMode = 'docker', inline = false }: SetupWizardProps) {
    const [step, setStep] = useState<Step>(1);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [state, setState] = useState<WizardState>({
        llmProvider: '',
        llmApiKey: '',
        ollamaHost: runMode === 'docker' ? 'http://host.docker.internal:11434' : 'http://localhost:11434',
        agentPersonality: 'professional',
        customPrompt: PERSONALITIES[0].prompt,
        integrations: {},
        userName: '',
        workspacePath: '',
    });

    const update = useCallback((patch: Partial<WizardState>) => {
        setState(prev => ({ ...prev, ...patch }));
    }, []);

    const canProceed = (): boolean => {
        if (step === 1) {
            if (!state.llmProvider) return false;
            if (state.llmProvider === 'ollama') return state.ollamaHost.trim().length > 0;
            return state.llmApiKey.trim().length > 5;
        }
        if (step === 2) return !!state.agentPersonality;
        return true;
    };

    const handleFinish = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/api/setup/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    llm: { provider: state.llmProvider, apiKey: state.llmApiKey, ollamaHost: state.ollamaHost },
                    integrations: state.integrations,
                    workspace: { hostPath: state.workspacePath || undefined },
                    persona: { userName: state.userName, agentPersonality: state.agentPersonality, customPrompt: state.customPrompt },
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Setup failed');
            setTimeout(() => { onComplete(); window.location.reload(); }, 2500);
        } catch (e: any) {
            setError(e.message);
            setSaving(false);
        }
    };

    const cardCls = inline
        ? 'w-full bg-card border border-border rounded-2xl shadow-sm overflow-hidden'
        : 'fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4';

    return (
        <div className={inline ? '' : 'fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4'}>
            <div className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">

                {/* Header */}
                <div className="border-b border-border px-6 py-4 bg-muted/30">
                    <div className="flex items-center gap-3 mb-4">
                        <img src="/logo.png" alt="AI Partner" className="w-8 h-8 rounded-lg object-cover" />
                        <span className="font-bold text-lg text-foreground">AI Partner Setup</span>
                        <span className="ml-auto text-xs text-muted-foreground">Step {step} of 4</span>
                    </div>
                    <StepIndicator current={step} />
                </div>

                {/* Body */}
                <div className="px-6 py-5 min-h-[340px] overflow-y-auto">
                    {step === 1 && <Step1LLM state={state} update={update} />}
                    {step === 2 && <Step2Personality state={state} update={update} />}
                    {step === 3 && <Step3Integrations state={state} update={update} />}
                    {step === 4 && <Step4Workspace state={state} update={update} runMode={runMode} />}
                </div>

                {/* Footer */}
                <div className="px-6 pb-5 space-y-2.5 border-t border-border pt-4">
                    {error && (
                        <div className="flex gap-2 items-center text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg p-3">
                            <AlertCircle className="w-4 h-4 shrink-0" />{error}
                        </div>
                    )}
                    <div className="flex gap-2">
                        {step > 1 && (
                            <button
                                onClick={() => setStep(s => (s - 1) as Step)}
                                disabled={saving}
                                className="px-4 py-2.5 bg-muted hover:bg-muted/80 text-muted-foreground rounded-xl text-sm font-medium disabled:opacity-40 transition-colors"
                            >
                                Back
                            </button>
                        )}
                        {step < 4 && (
                            <button
                                onClick={() => setStep(s => (s + 1) as Step)}
                                disabled={!canProceed()}
                                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed text-primary-foreground rounded-xl text-sm font-semibold transition-colors"
                            >
                                {step === 3 ? 'Skip & Continue' : 'Next'}
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        )}
                        {step === 4 && (
                            <button
                                onClick={handleFinish}
                                disabled={saving}
                                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-xl text-sm font-bold transition-colors"
                            >
                                {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</> : <><Check className="w-4 h-4" /> Finish Setup</>}
                            </button>
                        )}
                    </div>
                    {step === 3 && (
                        <p className="text-xs text-center text-muted-foreground">
                            All integrations optional — add anytime from <strong>Settings → Integrations</strong>
                        </p>
                    )}
                </div>
            </div>

            {/* Factory Reset — only shown in inline (re-run) mode */}
            {inline && (
                <div className="w-full max-w-lg mt-0">
                    <FactoryResetPanel />
                </div>
            )}
        </div>
    );
}
