import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DollarSign, Zap, Clock, BarChart3, AlertCircle, RefreshCw } from 'lucide-react';
import { API_BASE } from '@/lib/api';

interface UsageSummary {
    totalCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCost: number;
    avgLatencyMs: number;
}

interface ProviderUsage {
    provider: string;
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalCost: number;
    avgLatencyMs: number;
}

export function UsageDashboard() {
    const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [providers, setProviders] = useState<ProviderUsage[]>([]);
    const [dailyCost, setDailyCost] = useState(0);
    const [alertThreshold, setAlertThreshold] = useState(10);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { fetchData(); }, [period]);

    const fetchData = async () => {
        setLoading(true);
        setError(null);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const [summaryRes, providersRes, dailyRes, alertRes] = await Promise.all([
                fetch(`${API_BASE}/api/usage/summary?period=${period}`, { signal: controller.signal }),
                fetch(`${API_BASE}/api/usage/by-provider?period=${period}`, { signal: controller.signal }),
                fetch(`${API_BASE}/api/usage/daily-cost`, { signal: controller.signal }),
                fetch(`${API_BASE}/api/usage/alert-threshold`, { signal: controller.signal }),
            ]);
            clearTimeout(timeout);

            if (!summaryRes.ok) throw new Error(`Server returned ${summaryRes.status}`);

            const summaryData = await summaryRes.json();
            const providersData = await providersRes.json();
            const dailyData = await dailyRes.json();
            const alertData = await alertRes.json();

            setSummary(summaryData);
            setProviders(providersData.breakdown || providersData.providers || []);
            setDailyCost(dailyData.dailyCost || dailyData.cost || 0);
            setAlertThreshold(dailyData.threshold || alertData.threshold || 10);
        } catch (e: any) {
            setError(e.name === 'AbortError' ? 'Server unreachable — is the backend running?' : e.message);
        } finally {
            setLoading(false);
        }
    };

    const updateAlert = async (val: number) => {
        setAlertThreshold(val);
        try {
            await fetch(`${API_BASE}/api/usage/alert-threshold`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold: val }),
            });
        } catch { /* non-critical */ }
    };

    const costColor = dailyCost > alertThreshold ? 'text-red-400' : dailyCost > alertThreshold * 0.8 ? 'text-yellow-400' : 'text-emerald-400';

    return (
        <div className="p-4 h-full overflow-auto space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <DollarSign className="w-6 h-6 text-emerald-400" /> Usage & Cost
                </h1>
                <div className="flex items-center gap-2">
                    {(['daily', 'weekly', 'monthly'] as const).map(p => (
                        <button key={p} onClick={() => setPeriod(p)}
                            className={`px-3 py-1 rounded-lg text-sm capitalize transition-colors ${period === p ? 'bg-emerald-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'}`}>
                            {p}
                        </button>
                    ))}
                    <button onClick={fetchData} className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-muted-foreground/20 transition-colors">
                        <RefreshCw className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                    <button onClick={() => { setError(null); fetchData(); }} className="ml-auto text-red-400 hover:text-red-200 text-xs">Retry</button>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="text-center text-muted-foreground py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full mx-auto mb-2" />
                    Loading usage data...
                </div>
            )}

            {!loading && !error && summary && (
                <>
                    {/* Stats Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <Card className="border-border">
                            <CardContent className="p-4 text-center">
                                <Zap className="w-5 h-5 mx-auto mb-1 text-blue-400" />
                                <div className="text-2xl font-bold text-foreground">{summary.totalCalls.toLocaleString()}</div>
                                <div className="text-xs text-muted-foreground/70">Total Calls</div>
                            </CardContent>
                        </Card>
                        <Card className="border-border">
                            <CardContent className="p-4 text-center">
                                <BarChart3 className="w-5 h-5 mx-auto mb-1 text-violet-400" />
                                <div className="text-2xl font-bold text-foreground">{(summary.totalTokens / 1000).toFixed(1)}k</div>
                                <div className="text-xs text-muted-foreground/70">Total Tokens</div>
                            </CardContent>
                        </Card>
                        <Card className="border-border">
                            <CardContent className="p-4 text-center">
                                <DollarSign className="w-5 h-5 mx-auto mb-1 text-emerald-400" />
                                <div className="text-2xl font-bold text-foreground">${summary.totalCost.toFixed(4)}</div>
                                <div className="text-xs text-muted-foreground/70">Total Cost</div>
                            </CardContent>
                        </Card>
                        <Card className="border-border">
                            <CardContent className="p-4 text-center">
                                <Clock className="w-5 h-5 mx-auto mb-1 text-amber-400" />
                                <div className="text-2xl font-bold text-foreground">{summary.avgLatencyMs}ms</div>
                                <div className="text-xs text-muted-foreground/70">Avg Latency</div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Daily Cost Monitor */}
                    <Card className="border-border">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm flex items-center justify-between">
                                <span>Today's Cost</span>
                                <span className={`text-lg font-bold ${costColor}`}>${dailyCost.toFixed(4)}</span>
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="relative w-full h-3 bg-muted rounded-full overflow-hidden">
                                <div className={`absolute left-0 top-0 h-full rounded-full transition-all ${dailyCost > alertThreshold ? 'bg-red-500' : 'bg-emerald-500'}`}
                                    style={{ width: `${Math.min((dailyCost / alertThreshold) * 100, 100)}%` }} />
                            </div>
                            <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                                <span>Alert threshold:</span>
                                <div className="flex items-center gap-1">
                                    $<input type="number" value={alertThreshold} onChange={e => updateAlert(Number(e.target.value))}
                                        className="w-16 px-1 py-0.5 bg-muted border border-border rounded text-foreground text-xs" step="1" min="0" />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Provider Breakdown */}
                    <Card className="border-border">
                        <CardHeader className="pb-2"><CardTitle className="text-sm">Provider Breakdown</CardTitle></CardHeader>
                        <CardContent>
                            {providers.length === 0 ? (
                                <p className="text-muted-foreground/70 text-sm text-center py-4">No usage data for this period</p>
                            ) : (
                                <div className="space-y-2">
                                    {providers.map((p, i) => (
                                        <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-none">
                                            <div>
                                                <span className="text-sm font-medium text-foreground">{p.provider}</span>
                                                <span className="text-xs text-muted-foreground/70 ml-2">{p.model}</span>
                                            </div>
                                            <div className="text-right">
                                                <span className="text-sm text-foreground">${(p.totalCost || 0).toFixed(4)}</span>
                                                <span className="text-xs text-muted-foreground/70 ml-2">{p.calls} calls</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </>
            )}

            {/* Empty State */}
            {!loading && !error && summary && summary.totalCalls === 0 && (
                <div className="text-center text-muted-foreground/70 py-8">
                    <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    <p>No usage data yet</p>
                    <p className="text-xs mt-1">Start chatting to generate usage data</p>
                </div>
            )}
        </div>
    );
}
