import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { AlertTriangle, Shield, Info, Check, Loader2 } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Capability {
    id: string;
    label: string;
    icon: string;
    description: string;
    risk: 'none' | 'low' | 'medium' | 'high';
    availableInCurrentMode: boolean;
    enabled: boolean;
    value: string | null;
    requiresValue: boolean;
    valuePlaceholder?: string;
    valueLabel?: string;
    confirmationRequired: boolean;
    confirmText?: string;
}

interface CapabilitiesData {
    runMode: 'docker' | 'native';
    capabilities: Capability[];
}

// ─── Risk Badge ───────────────────────────────────────────────────────────────

function RiskBadge({ risk }: { risk: Capability['risk'] }) {
    const styles: Record<string, string> = {
        none: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-700/40',
        low: 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-700/40',
        medium: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-700/40',
        high: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-700/40',
    };
    const labels: Record<string, string> = {
        none: 'Safe', low: 'Low risk', medium: 'Medium risk', high: 'High risk'
    };
    return (
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${styles[risk]}`}>
            {labels[risk]}
        </span>
    );
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !disabled && onChange(!checked)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${checked ? 'bg-primary' : 'bg-muted-foreground/30'
                }`}
        >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'
                }`} />
        </button>
    );
}

// ─── Confirmation Dialog ──────────────────────────────────────────────────────

function ConfirmDialog({
    confirmText,
    onConfirm,
    onCancel,
}: {
    confirmText: string;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const [typed, setTyped] = useState('');
    const TARGET = 'I UNDERSTAND';

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <div className="bg-card border border-destructive/40 rounded-xl p-6 max-w-md w-full space-y-4 shadow-2xl">
                <div className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="w-5 h-5" />
                    <h2 className="font-bold">High-Risk Capability</h2>
                </div>
                <p className="text-sm text-muted-foreground">{confirmText}</p>
                <p className="text-xs text-muted-foreground">
                    Type <span className="font-mono text-foreground bg-muted px-1 py-0.5 rounded">{TARGET}</span> to confirm:
                </p>
                <input
                    autoFocus
                    value={typed}
                    onChange={e => setTyped(e.target.value.toUpperCase())}
                    placeholder={TARGET}
                    className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-destructive"
                />
                <div className="flex gap-2">
                    <button
                        onClick={onConfirm}
                        disabled={typed !== TARGET}
                        className="flex-1 py-2 bg-destructive hover:bg-destructive/90 disabled:opacity-40 text-destructive-foreground rounded-lg text-sm font-medium transition-colors"
                    >
                        Enable anyway
                    </button>
                    <button
                        onClick={onCancel}
                        className="flex-1 py-2 bg-muted hover:bg-muted/80 text-muted-foreground rounded-lg text-sm font-medium transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function CapabilitiesPanel() {
    const [data, setData] = useState<CapabilitiesData | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [local, setLocal] = useState<Capability[]>([]);
    const [confirmCap, setConfirmCap] = useState<Capability | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/capabilities`);
            const json: CapabilitiesData = await res.json();
            setData(json);
            setLocal(json.capabilities.map(c => ({ ...c })));
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleToggle = (cap: Capability, next: boolean) => {
        if (next && cap.confirmationRequired) {
            setConfirmCap(cap);
            return;
        }
        setLocal(prev => prev.map(c => c.id === cap.id ? { ...c, enabled: next } : c));
    };

    const handleConfirm = () => {
        if (!confirmCap) return;
        setLocal(prev => prev.map(c => c.id === confirmCap.id ? { ...c, enabled: true } : c));
        setConfirmCap(null);
    };

    const handleValue = (id: string, value: string) => {
        setLocal(prev => prev.map(c => c.id === id ? { ...c, value } : c));
    };

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            await fetch(`${API_BASE}/api/capabilities`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ capabilities: local.map(c => ({ id: c.id, enabled: c.enabled, value: c.value })) }),
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading capabilities...
            </div>
        );
    }

    const runMode = data?.runMode ?? 'docker';

    return (
        <div className="p-6 max-w-2xl mx-auto space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2 text-foreground">
                        <Shield className="w-6 h-6 text-primary" /> Capabilities
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        All capabilities are off by default. You control what the agent can do.
                    </p>
                </div>

                {/* Run mode badge */}
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border ${runMode === 'native'
                        ? 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700/40'
                        : 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/40'
                    }`}>
                    {runMode === 'native' ? '💻 Native mode' : '🐳 Docker mode'}
                </div>
            </div>

            {/* Mode explanation */}
            {runMode === 'docker' && (
                <div className="flex gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 dark:bg-blue-900/20 dark:border-blue-700/30 dark:text-blue-300">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>
                        Running in Docker (safe mode). Some capabilities are only available in Native mode.
                        To unlock full OS access, stop Docker and run: <code className="bg-blue-100 dark:bg-black/30 px-1 py-0.5 rounded text-xs font-mono">npm run dev</code>
                    </p>
                </div>
            )}
            {runMode === 'native' && (
                <div className="flex gap-2 p-3 bg-purple-50 border border-purple-200 rounded-lg text-sm text-purple-700 dark:bg-purple-900/20 dark:border-purple-700/30 dark:text-purple-300">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>
                        Running in Native mode. All capabilities are available. The agent runs with your user's permissions.
                    </p>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
                    {error}
                </div>
            )}

            {/* Capability cards */}
            <div className="space-y-3">
                {local.map(cap => {
                    const disabled = !cap.availableInCurrentMode;
                    return (
                        <div
                            key={cap.id}
                            className={`border rounded-xl p-4 transition-colors ${disabled
                                    ? 'border-border bg-muted/30 opacity-60'
                                    : cap.enabled
                                        ? 'border-primary/40 bg-primary/5'
                                        : 'border-border bg-card hover:bg-muted/20'
                                }`}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3 flex-1 min-w-0">
                                    <span className="text-2xl leading-none mt-0.5">{cap.icon}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-semibold text-sm text-foreground">{cap.label}</span>
                                            <RiskBadge risk={cap.risk} />
                                            {disabled && (
                                                <span className="text-[10px] px-1.5 py-0.5 rounded border bg-muted text-muted-foreground border-border">
                                                    Native mode only
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-1">{cap.description}</p>

                                        {/* Value input */}
                                        {cap.requiresValue && cap.enabled && !disabled && (
                                            <div className="mt-2">
                                                <label className="text-[10px] text-muted-foreground">{cap.valueLabel}</label>
                                                <input
                                                    value={cap.value ?? ''}
                                                    onChange={e => handleValue(cap.id, e.target.value)}
                                                    placeholder={cap.valuePlaceholder}
                                                    type={cap.id === 'payment_tools' ? 'password' : 'text'}
                                                    className="w-full mt-1 px-2 py-1.5 bg-background border border-input rounded-lg text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <Toggle
                                    checked={cap.enabled}
                                    onChange={next => handleToggle(cap, next)}
                                    disabled={disabled}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Save button */}
            <button
                onClick={save}
                disabled={saving}
                className="w-full py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            >
                {saving ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
                ) : saved ? (
                    <><Check className="w-4 h-4" /> Saved!</>
                ) : (
                    'Save Capabilities'
                )}
            </button>

            {/* High-risk confirmation dialog */}
            {confirmCap && (
                <ConfirmDialog
                    confirmText={confirmCap.confirmText ?? 'Are you sure?'}
                    onConfirm={handleConfirm}
                    onCancel={() => setConfirmCap(null)}
                />
            )}
        </div>
    );
}
