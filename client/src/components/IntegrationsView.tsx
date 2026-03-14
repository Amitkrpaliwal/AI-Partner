/**
 * IntegrationsView — Configure third-party integrations (GitHub, Notion, Gmail, etc.)
 *
 * Credentials are saved as encrypted secrets via /api/secrets and applied to
 * process.env immediately (no restart required).
 */

import { API_BASE } from '@/lib/api';
import { useState, useEffect, useCallback } from 'react';
import { Check, X, ExternalLink, Eye, EyeOff, Save, RefreshCw, Link2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '@/lib/utils';

interface IntegrationStatus {
    id: string;
    label: string;
    category: string;
    description: string;
    icon: string;
    requiredKeys: string[];
    optionalKeys: string[];
    docsUrl: string;
    connected: boolean;
    configuredKeys: string[];
}

interface IntegrationsResponse {
    success: boolean;
    integrations: IntegrationStatus[];
    connected: number;
    total: number;
}

const CATEGORY_ORDER = ['Developer', 'Productivity', 'Communication', 'Social', 'Media', 'AI'];

export function IntegrationsView() {
    const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
    const [loading, setLoading] = useState(true);
    const [summary, setSummary] = useState({ connected: 0, total: 0 });

    // Per-integration key input values
    const [keyValues, setKeyValues] = useState<Record<string, string>>({});
    // Track which keys are being revealed
    const [revealed, setRevealed] = useState<Record<string, boolean>>({});
    // Saving state per integration
    const [saving, setSaving] = useState<Record<string, boolean>>({});
    // Result message per integration
    const [results, setResults] = useState<Record<string, { ok: boolean; msg: string } | null>>({});

    const fetchIntegrations = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/integrations`);
            const data: IntegrationsResponse = await res.json();
            if (data.success) {
                setIntegrations(data.integrations);
                setSummary({ connected: data.connected, total: data.total });
            }
        } catch (e) {
            console.error('Failed to load integrations:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchIntegrations(); }, [fetchIntegrations]);

    const handleSave = async (integration: IntegrationStatus) => {
        const allKeys = [...integration.requiredKeys, ...integration.optionalKeys];
        const keysToSave = allKeys.filter(key => keyValues[key]?.trim());
        if (keysToSave.length === 0) {
            setResults(r => ({ ...r, [integration.id]: { ok: false, msg: 'Enter at least one credential to save.' } }));
            return;
        }

        setSaving(s => ({ ...s, [integration.id]: true }));
        setResults(r => ({ ...r, [integration.id]: null }));

        try {
            const errors: string[] = [];
            for (const key of keysToSave) {
                const val = keyValues[key].trim();
                const res = await fetch(`${API_BASE}/api/secrets/${encodeURIComponent(key)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: val }),
                });
                const data = await res.json();
                if (!data.success) errors.push(`${key}: ${data.error}`);
            }

            if (errors.length > 0) {
                setResults(r => ({ ...r, [integration.id]: { ok: false, msg: errors.join('; ') } }));
            } else {
                setResults(r => ({ ...r, [integration.id]: { ok: true, msg: `${keysToSave.length} credential(s) saved. Integration active!` } }));
                // Clear input fields for saved keys
                setKeyValues(v => {
                    const next = { ...v };
                    keysToSave.forEach(k => { next[k] = ''; });
                    return next;
                });
                // Refresh status
                await fetchIntegrations();
            }
        } catch (e: any) {
            setResults(r => ({ ...r, [integration.id]: { ok: false, msg: e.message } }));
        } finally {
            setSaving(s => ({ ...s, [integration.id]: false }));
        }
    };

    const toggleReveal = (key: string) => {
        setRevealed(r => ({ ...r, [key]: !r[key] }));
    };

    const grouped = CATEGORY_ORDER.reduce<Record<string, IntegrationStatus[]>>((acc, cat) => {
        const items = integrations.filter(i => i.category === cat);
        if (items.length > 0) acc[cat] = items;
        return acc;
    }, {});

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full text-muted-foreground">
                <RefreshCw className="animate-spin mr-2" size={16} />
                Loading integrations...
            </div>
        );
    }

    return (
        <div className="h-full overflow-auto p-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Link2 size={22} />
                        Integrations
                    </h1>
                    <p className="text-muted-foreground text-sm mt-1">
                        Connect third-party services. Credentials are encrypted and applied immediately — no restart needed.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="text-sm text-muted-foreground">
                        <span className="text-green-500 font-semibold">{summary.connected}</span>
                        <span> / {summary.total} connected</span>
                    </div>
                    <Button variant="outline" size="sm" onClick={fetchIntegrations}>
                        <RefreshCw size={14} className="mr-1" />
                        Refresh
                    </Button>
                </div>
            </div>

            {/* Integration Cards by Category */}
            {Object.entries(grouped).map(([category, items]) => (
                <div key={category} className="mb-8">
                    <h2 className="text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-3 px-1">
                        {category}
                    </h2>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
                        {items.map(integration => (
                            <IntegrationCard
                                key={integration.id}
                                integration={integration}
                                keyValues={keyValues}
                                revealed={revealed}
                                saving={!!saving[integration.id]}
                                result={results[integration.id] ?? null}
                                onKeyChange={(key, val) => setKeyValues(v => ({ ...v, [key]: val }))}
                                onToggleReveal={toggleReveal}
                                onSave={() => handleSave(integration)}
                            />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ─── Individual Card ──────────────────────────────────────────────────────────

interface CardProps {
    integration: IntegrationStatus;
    keyValues: Record<string, string>;
    revealed: Record<string, boolean>;
    saving: boolean;
    result: { ok: boolean; msg: string } | null;
    onKeyChange: (key: string, val: string) => void;
    onToggleReveal: (key: string) => void;
    onSave: () => void;
}

function IntegrationCard({ integration, keyValues, revealed, saving, result, onKeyChange, onToggleReveal, onSave }: CardProps) {
    const allKeys = [...integration.requiredKeys, ...integration.optionalKeys];
    const hasInput = allKeys.some(k => keyValues[k]?.trim());

    return (
        <Card className={cn(
            'border transition-colors',
            integration.connected ? 'border-green-500/30 bg-green-500/5' : 'border-border'
        )}>
            <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">{integration.icon}</span>
                        <div>
                            <CardTitle className="text-base">{integration.label}</CardTitle>
                            <p className="text-xs text-muted-foreground">{integration.description}</p>
                        </div>
                    </div>
                    <StatusBadge connected={integration.connected} />
                </div>
            </CardHeader>

            <CardContent className="space-y-3">
                {/* Required keys */}
                {integration.requiredKeys.length > 0 && (
                    <div>
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                            Required
                        </label>
                        <div className="space-y-2">
                            {integration.requiredKeys.map(key => (
                                <KeyInput
                                    key={key}
                                    keyName={key}
                                    configured={integration.configuredKeys.includes(key)}
                                    value={keyValues[key] || ''}
                                    isRevealed={!!revealed[key]}
                                    onChange={val => onKeyChange(key, val)}
                                    onToggleReveal={() => onToggleReveal(key)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* Optional keys */}
                {integration.optionalKeys.length > 0 && (
                    <div>
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                            Optional{integration.requiredKeys.length === 0 ? ' (one required)' : ''}
                        </label>
                        <div className="space-y-2">
                            {integration.optionalKeys.map(key => (
                                <KeyInput
                                    key={key}
                                    keyName={key}
                                    configured={integration.configuredKeys.includes(key)}
                                    value={keyValues[key] || ''}
                                    isRevealed={!!revealed[key]}
                                    onChange={val => onKeyChange(key, val)}
                                    onToggleReveal={() => onToggleReveal(key)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* Result message */}
                {result && (
                    <div className={cn(
                        'text-xs px-2 py-1.5 rounded flex items-start gap-1.5',
                        result.ok ? 'bg-green-500/10 text-green-600' : 'bg-destructive/10 text-destructive'
                    )}>
                        {result.ok ? <Check size={12} className="mt-0.5 shrink-0" /> : <X size={12} className="mt-0.5 shrink-0" />}
                        {result.msg}
                    </div>
                )}

                {/* Footer actions */}
                <div className="flex items-center justify-between pt-1">
                    <a
                        href={integration.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                    >
                        <ExternalLink size={11} />
                        Get credentials
                    </a>

                    <Button
                        size="sm"
                        disabled={saving || !hasInput}
                        onClick={onSave}
                        className="h-7 text-xs"
                    >
                        {saving ? (
                            <RefreshCw size={11} className="animate-spin mr-1" />
                        ) : (
                            <Save size={11} className="mr-1" />
                        )}
                        {saving ? 'Saving...' : 'Save'}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ connected }: { connected: boolean }) {
    return (
        <span className={cn(
            'inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0',
            connected
                ? 'bg-green-500/15 text-green-600 border border-green-500/30'
                : 'bg-muted text-muted-foreground border border-border'
        )}>
            {connected
                ? <><Check size={9} />Connected</>
                : <>Not configured</>
            }
        </span>
    );
}

// ─── Key Input Row ────────────────────────────────────────────────────────────

interface KeyInputProps {
    keyName: string;
    configured: boolean;
    value: string;
    isRevealed: boolean;
    onChange: (val: string) => void;
    onToggleReveal: () => void;
}

function KeyInput({ keyName, configured, value, isRevealed, onChange, onToggleReveal }: KeyInputProps) {
    return (
        <div className="space-y-0.5">
            <div className="flex items-center gap-1.5">
                <span className={cn(
                    'w-2 h-2 rounded-full shrink-0',
                    configured ? 'bg-green-500' : 'bg-muted-foreground/30'
                )} />
                <code className="text-[10px] text-muted-foreground font-mono">{keyName}</code>
                {configured && (
                    <span className="text-[9px] text-green-600 font-medium">● set</span>
                )}
            </div>
            <div className="relative">
                <Input
                    type={isRevealed ? 'text' : 'password'}
                    placeholder={configured ? '••••••• (already set — enter new value to update)' : `Paste ${keyName} here`}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    className="h-8 text-xs pr-8 font-mono"
                />
                <button
                    type="button"
                    onClick={onToggleReveal}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                    {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
            </div>
        </div>
    );
}
