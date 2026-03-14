import { API_BASE } from '@/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, RefreshCw, ChevronLeft, ChevronRight, Filter } from 'lucide-react';

interface AuditEntry {
    id: number;
    timestamp: string;
    category: string;
    severity: string;
    action: string;
    userId: string;
    details: string;
    ip?: string;
}

interface AuditStats {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
}

export function AuditLog() {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [stats, setStats] = useState<AuditStats | null>(null);
    const [page, setPage] = useState(0);
    const [filterCategory, setFilterCategory] = useState('');
    const [filterSeverity, setFilterSeverity] = useState('');
    const [filterAction, setFilterAction] = useState('');
    const [showFilters, setShowFilters] = useState(false);
    const pageSize = 30;

    useEffect(() => {
        fetchLogs();
        fetchStats();
    }, [page, filterCategory, filterSeverity, filterAction]);

    const fetchLogs = async () => {
        try {
            const params = new URLSearchParams({
                limit: String(pageSize),
                offset: String(page * pageSize),
            });
            if (filterCategory) params.set('category', filterCategory);
            if (filterSeverity) params.set('severity', filterSeverity);
            if (filterAction) params.set('action', filterAction);

            const res = await fetch(`${API_BASE}/api/audit/logs?${params}`);
            if (res.ok) {
                const data = await res.json();
                setEntries(data.entries || []);
                setTotal(data.total || 0);
            }
        } catch (e) {
            console.error('Failed to fetch audit logs:', e);
        }
    };

    const fetchStats = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/audit/stats`);
            if (res.ok) {
                const data = await res.json();
                setStats(data);
            }
        } catch (e) {
            console.error('Failed to fetch stats:', e);
        }
    };

    const severityColor = (severity: string) => {
        switch (severity) {
            case 'critical': return 'text-red-600 bg-red-500/10';
            case 'error': return 'text-red-500 bg-red-500/10';
            case 'warn': return 'text-yellow-500 bg-yellow-500/10';
            default: return 'text-blue-500 bg-blue-500/10';
        }
    };

    const categoryColor = (category: string) => {
        switch (category) {
            case 'security': return 'text-red-500';
            case 'auth': return 'text-orange-500';
            case 'tool_call': return 'text-blue-500';
            case 'goal': return 'text-purple-500';
            case 'system': return 'text-gray-500';
            default: return 'text-muted-foreground';
        }
    };

    const parseDetails = (details: string): Record<string, any> => {
        try {
            return JSON.parse(details);
        } catch {
            return {};
        }
    };

    const totalPages = Math.ceil(total / pageSize);

    return (
        <div className="space-y-4">
            {/* Stats Summary */}
            {stats && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Card>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold">{stats.total}</div>
                            <div className="text-xs text-muted-foreground">Total Events</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold text-blue-500">
                                {stats.byCategory?.tool_call || 0}
                            </div>
                            <div className="text-xs text-muted-foreground">Tool Calls</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold text-orange-500">
                                {stats.byCategory?.auth || 0}
                            </div>
                            <div className="text-xs text-muted-foreground">Auth Events</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold text-red-500">
                                {stats.byCategory?.security || 0}
                            </div>
                            <div className="text-xs text-muted-foreground">Security Events</div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* Log Table */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                        <Shield className="w-5 h-5" /> Audit Log
                        <span className="text-xs text-muted-foreground font-normal">
                            ({total} entries)
                        </span>
                    </CardTitle>
                    <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setShowFilters(!showFilters)}>
                            <Filter className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { fetchLogs(); fetchStats(); }}>
                            <RefreshCw className="w-4 h-4" />
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-3">
                    {/* Filters */}
                    {showFilters && (
                        <div className="flex gap-2 items-end flex-wrap">
                            <div>
                                <label className="text-xs text-muted-foreground">Category</label>
                                <select
                                    value={filterCategory}
                                    onChange={(e) => { setFilterCategory(e.target.value); setPage(0); }}
                                    className="block mt-1 text-xs border rounded px-2 py-1.5 bg-background"
                                >
                                    <option value="">All</option>
                                    <option value="tool_call">Tool Calls</option>
                                    <option value="auth">Auth</option>
                                    <option value="security">Security</option>
                                    <option value="goal">Goals</option>
                                    <option value="system">System</option>
                                </select>
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground">Severity</label>
                                <select
                                    value={filterSeverity}
                                    onChange={(e) => { setFilterSeverity(e.target.value); setPage(0); }}
                                    className="block mt-1 text-xs border rounded px-2 py-1.5 bg-background"
                                >
                                    <option value="">All</option>
                                    <option value="info">Info</option>
                                    <option value="warn">Warning</option>
                                    <option value="error">Error</option>
                                    <option value="critical">Critical</option>
                                </select>
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground">Action</label>
                                <Input
                                    value={filterAction}
                                    onChange={(e) => { setFilterAction(e.target.value); setPage(0); }}
                                    placeholder="Search actions..."
                                    className="h-8 text-xs w-40"
                                />
                            </div>
                            <Button size="sm" variant="ghost" onClick={() => {
                                setFilterCategory('');
                                setFilterSeverity('');
                                setFilterAction('');
                                setPage(0);
                            }}>
                                Clear
                            </Button>
                        </div>
                    )}

                    {/* Entries */}
                    <div className="border rounded-md overflow-hidden">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="border-b bg-muted/50">
                                    <th className="h-8 px-3 text-left font-medium">Time</th>
                                    <th className="h-8 px-3 text-left font-medium">Category</th>
                                    <th className="h-8 px-3 text-left font-medium">Severity</th>
                                    <th className="h-8 px-3 text-left font-medium">Action</th>
                                    <th className="h-8 px-3 text-left font-medium">User</th>
                                    <th className="h-8 px-3 text-left font-medium">Details</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entries.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="p-4 text-center text-muted-foreground">
                                            No audit log entries
                                        </td>
                                    </tr>
                                ) : (
                                    entries.map(entry => {
                                        const details = parseDetails(entry.details);
                                        return (
                                            <tr key={entry.id} className="border-b last:border-0 hover:bg-muted/30">
                                                <td className="p-2 px-3 text-muted-foreground whitespace-nowrap">
                                                    {new Date(entry.timestamp).toLocaleString()}
                                                </td>
                                                <td className={`p-2 px-3 font-medium ${categoryColor(entry.category)}`}>
                                                    {entry.category}
                                                </td>
                                                <td className="p-2 px-3">
                                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${severityColor(entry.severity)}`}>
                                                        {entry.severity}
                                                    </span>
                                                </td>
                                                <td className="p-2 px-3 font-mono">{entry.action}</td>
                                                <td className="p-2 px-3 text-muted-foreground">{entry.userId}</td>
                                                <td className="p-2 px-3 max-w-xs truncate text-muted-foreground">
                                                    {Object.entries(details)
                                                        .filter(([k]) => k !== 'result')
                                                        .map(([k, v]) => `${k}=${typeof v === 'object' ? '...' : v}`)
                                                        .join(', ')
                                                    }
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">
                                Page {page + 1} of {totalPages}
                            </span>
                            <div className="flex gap-1">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setPage(p => Math.max(0, p - 1))}
                                    disabled={page === 0}
                                >
                                    <ChevronLeft className="w-4 h-4" />
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                                    disabled={page >= totalPages - 1}
                                >
                                    <ChevronRight className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
