import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Package, Search, Trash2, Play, Plus, Tag, Download, Upload, AlertCircle, Code, CheckCircle2, Server, Plug, PlugZap } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { getSocket } from '@/lib/socket';

interface DynamicTool {
    id: string;
    name: string;
    description: string;
    version: string;
    createdBy: string;
    inputSchema: any;
    tags: string[];
    usageCount: number;
    successCount: number;
    code?: string;
}

interface ExternalServer {
    name: string;
    description?: string;
    command: string;
    args: string[];
    addedAt: string;
    connected: boolean;
    toolCount: number;
}

export function ToolMarketplace() {
    const [tab, setTab] = useState<'tools' | 'servers'>('tools');
    const [tools, setTools] = useState<DynamicTool[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [testPanelTool, setTestPanelTool] = useState<string | null>(null);
    const [testArgs, setTestArgs] = useState<Record<string, string>>({});
    const [testResult, setTestResult] = useState<{ name: string; result: string; success: boolean } | null>(null);
    const [testRunning, setTestRunning] = useState(false);
    const [expandedCode, setExpandedCode] = useState<string | null>(null);
    const [newTool, setNewTool] = useState({ name: '', description: '', code: '', tags: '' });
    const importRef = useRef<HTMLInputElement>(null);

    // External MCP servers state
    const [servers, setServers] = useState<ExternalServer[]>([]);
    const [serversLoading, setServersLoading] = useState(false);
    const [serversError, setServersError] = useState<string | null>(null);
    const [showAddServer, setShowAddServer] = useState(false);
    const [newServer, setNewServer] = useState({ name: '', command: 'npx', args: '', description: '' });
    const [connectingServer, setConnectingServer] = useState(false);

    useEffect(() => {
        fetchTools();
    }, []);

    useEffect(() => {
        if (tab === 'servers') fetchServers();
    }, [tab]);

    // Sprint 3: real-time tool events via Socket.IO
    useEffect(() => {
        const socket = getSocket();
        if (!socket) return;

        const onToolRegistered = () => fetchTools();
        const onToolDeleted = () => fetchTools();

        socket.on('tool:registered', onToolRegistered);
        socket.on('tool:deleted', onToolDeleted);

        return () => {
            socket.off('tool:registered', onToolRegistered);
            socket.off('tool:deleted', onToolDeleted);
        };
    }, []);

    const fetchTools = async () => {
        setLoading(true);
        setError(null);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`${API_BASE}/api/tools/marketplace`, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            setTools(data.tools || []);
        } catch (e: any) {
            setError(e.name === 'AbortError' ? 'Server unreachable — is the backend running?' : e.message);
        } finally {
            setLoading(false);
        }
    };

    const createTool = async () => {
        if (!newTool.name || !newTool.description || !newTool.code) {
            setError('Name, description, and code are required');
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/api/tools/marketplace`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newTool.name,
                    description: newTool.description,
                    code: newTool.code,
                    tags: newTool.tags.split(',').map(t => t.trim()).filter(Boolean),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Create failed: ${res.status}`);
            }
            setNewTool({ name: '', description: '', code: '', tags: '' });
            setShowCreate(false);
            fetchTools();
        } catch (e: any) {
            setError(e.message);
        }
    };

    const deleteTool = async (name: string) => {
        try {
            await fetch(`${API_BASE}/api/tools/marketplace/${name}`, { method: 'DELETE' });
            fetchTools();
        } catch (e: any) {
            setError(e.message);
        }
    };

    const openTestPanel = (tool: DynamicTool) => {
        if (testPanelTool === tool.name) {
            setTestPanelTool(null);
            return;
        }
        // Pre-populate args from inputSchema properties
        const schema = tool.inputSchema?.properties || {};
        const initial: Record<string, string> = {};
        Object.keys(schema).forEach(k => { initial[k] = ''; });
        setTestArgs(initial);
        setTestResult(null);
        setTestPanelTool(tool.name);
    };

    const runTest = async (tool: DynamicTool) => {
        setTestRunning(true);
        setTestResult(null);
        try {
            // Parse args — try JSON for each, fall back to string
            const parsedArgs: Record<string, any> = {};
            Object.entries(testArgs).forEach(([k, v]) => {
                try { parsedArgs[k] = JSON.parse(v); } catch { parsedArgs[k] = v; }
            });
            const res = await fetch(`${API_BASE}/api/tools/marketplace/${encodeURIComponent(tool.name)}/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ args: parsedArgs }),
            });
            const data = await res.json();
            setTestResult({
                name: tool.name,
                result: JSON.stringify(data.output ?? data, null, 2),
                success: data.success !== false,
            });
        } catch (e: any) {
            setTestResult({ name: tool.name, result: `Error: ${e.message}`, success: false });
        } finally {
            setTestRunning(false);
        }
    };

    const exportTools = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/tools/marketplace/export`);
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'tools_export.json'; a.click();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            setError(e.message);
        }
    };

    const importTools = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const toolsToImport = Array.isArray(data) ? data : data.tools || [data];
            for (const tool of toolsToImport) {
                await fetch(`${API_BASE}/api/tools/marketplace/import`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(tool),
                });
            }
            fetchTools();
        } catch (err: any) {
            setError(`Import failed: ${err.message}`);
        }
        if (importRef.current) importRef.current.value = '';
    };

    const fetchServers = async () => {
        setServersLoading(true);
        setServersError(null);
        try {
            const res = await fetch(`${API_BASE}/api/mcp/external`);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            setServers(data.servers || []);
        } catch (e: any) {
            setServersError(e.message);
        } finally {
            setServersLoading(false);
        }
    };

    const connectServer = async () => {
        if (!newServer.name || !newServer.command || !newServer.args.trim()) {
            setServersError('Name, command, and args are required');
            return;
        }
        setConnectingServer(true);
        setServersError(null);
        try {
            const res = await fetch(`${API_BASE}/api/mcp/external`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newServer.name,
                    command: newServer.command,
                    args: newServer.args.split(' ').map(s => s.trim()).filter(Boolean),
                    description: newServer.description || undefined,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Failed: ${res.status}`);
            setNewServer({ name: '', command: 'npx', args: '', description: '' });
            setShowAddServer(false);
            fetchServers();
        } catch (e: any) {
            setServersError(e.message);
        } finally {
            setConnectingServer(false);
        }
    };

    const disconnectServer = async (name: string) => {
        try {
            await fetch(`${API_BASE}/api/mcp/external/${encodeURIComponent(name)}`, { method: 'DELETE' });
            fetchServers();
        } catch (e: any) {
            setServersError(e.message);
        }
    };

    const successRate = (t: DynamicTool) => {
        if (!t.usageCount) return null;
        return Math.round((t.successCount / t.usageCount) * 100);
    };

    const filtered = tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.description.toLowerCase().includes(search.toLowerCase()) ||
        t.tags?.some(tag => tag.toLowerCase().includes(search.toLowerCase()))
    );

    return (
        <div className="p-4 h-full overflow-auto space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <Package className="w-6 h-6 text-violet-400" /> Tool Marketplace
                </h1>
                {tab === 'tools' && (
                    <div className="flex gap-2">
                        <button onClick={() => setShowCreate(!showCreate)}
                            className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm flex items-center gap-1 transition-colors">
                            <Plus className="w-4 h-4" /> Create
                        </button>
                        <button onClick={() => importRef.current?.click()}
                            className="px-3 py-1.5 bg-muted-foreground/20 hover:bg-muted-foreground/30 text-white rounded-lg text-sm flex items-center gap-1 transition-colors">
                            <Upload className="w-4 h-4" /> Import
                        </button>
                        <button onClick={exportTools}
                            className="px-3 py-1.5 bg-muted-foreground/20 hover:bg-muted-foreground/30 text-white rounded-lg text-sm flex items-center gap-1 transition-colors">
                            <Download className="w-4 h-4" /> Export
                        </button>
                        <input ref={importRef} type="file" accept=".json" className="hidden" onChange={importTools} />
                    </div>
                )}
                {tab === 'servers' && (
                    <button onClick={() => setShowAddServer(!showAddServer)}
                        className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm flex items-center gap-1 transition-colors">
                        <Plus className="w-4 h-4" /> Connect Server
                    </button>
                )}
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
                <button
                    onClick={() => setTab('tools')}
                    className={`px-4 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${tab === 'tools' ? 'bg-violet-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                    <Package className="w-3.5 h-3.5" /> Dynamic Tools
                </button>
                <button
                    onClick={() => setTab('servers')}
                    className={`px-4 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${tab === 'servers' ? 'bg-violet-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                    <Server className="w-3.5 h-3.5" /> External MCP Servers
                </button>
            </div>

            {/* ── DYNAMIC TOOLS TAB ── */}
            {tab === 'tools' && (<>
                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
                    <input
                        value={search} onChange={e => setSearch(e.target.value)}
                        placeholder="Search tools by name, description, or tag..."
                        className="w-full pl-10 pr-4 py-2 bg-muted border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                </div>

                {/* Error State */}
                {error && (
                    <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>{error}</span>
                        <button onClick={() => { setError(null); fetchTools(); }} className="ml-auto text-red-400 hover:text-red-200 text-xs">Retry</button>
                    </div>
                )}

                {/* Create Form */}
                {showCreate && (
                    <Card className="border-violet-600/50">
                        <CardHeader className="pb-2"><CardTitle className="text-sm">Create New Tool</CardTitle></CardHeader>
                        <CardContent className="space-y-2">
                            <input value={newTool.name} onChange={e => setNewTool({ ...newTool, name: e.target.value })}
                                placeholder="Tool name (snake_case, e.g. parse_csv)" className="w-full px-3 py-2 bg-muted border border-border rounded text-sm text-foreground" />
                            <input value={newTool.description} onChange={e => setNewTool({ ...newTool, description: e.target.value })}
                                placeholder="Description (what the tool does)" className="w-full px-3 py-2 bg-muted border border-border rounded text-sm text-foreground" />
                            <input value={newTool.tags} onChange={e => setNewTool({ ...newTool, tags: e.target.value })}
                                placeholder="Tags (comma-separated, e.g. data, utility)" className="w-full px-3 py-2 bg-muted border border-border rounded text-sm text-foreground" />
                            <textarea value={newTool.code} onChange={e => setNewTool({ ...newTool, code: e.target.value })}
                                placeholder="Tool code (JavaScript function body, receives `args`)" rows={5}
                                className="w-full px-3 py-2 bg-muted border border-border rounded text-sm text-foreground font-mono" />
                            <button onClick={createTool}
                                className="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded text-sm transition-colors">
                                Create Tool
                            </button>
                        </CardContent>
                    </Card>
                )}

                {/* Loading */}
                {loading && (
                    <div className="text-center text-muted-foreground py-12">
                        <div className="animate-spin w-6 h-6 border-2 border-violet-400 border-t-transparent rounded-full mx-auto mb-2" />
                        Loading tools...
                    </div>
                )}

                {/* Empty State */}
                {!loading && !error && filtered.length === 0 && (
                    <div className="text-center text-muted-foreground/70 py-12">
                        <Package className="w-10 h-10 mx-auto mb-2 opacity-40" />
                        <p>{search ? 'No tools match your search' : 'No tools created yet'}</p>
                        <p className="text-xs mt-1">Click "Create" to add your first tool, or agents will auto-create tools when needed</p>
                    </div>
                )}

                {/* Tools Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {filtered.map(tool => (
                        <Card key={tool.name} className="border-border hover:border-zinc-500 transition-colors">
                            <CardContent className="p-4">
                                <div className="flex justify-between items-start mb-2">
                                    <div>
                                        <h3 className="font-semibold text-foreground">{tool.name}</h3>
                                        <p className="text-xs text-muted-foreground mt-1">{tool.description}</p>
                                    </div>
                                    <div className="flex gap-1">
                                        <button onClick={() => setExpandedCode(expandedCode === tool.name ? null : tool.name)} title="View code"
                                            className="p-1.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-violet-400 transition-colors">
                                            <Code className="w-3.5 h-3.5" />
                                        </button>
                                        <button onClick={() => openTestPanel(tool)} title="Test tool"
                                            className={`p-1.5 rounded hover:bg-muted-foreground/20 transition-colors ${testPanelTool === tool.name ? 'text-emerald-400 bg-muted-foreground/20' : 'text-muted-foreground hover:text-emerald-400'
                                                }`}>
                                            <Play className="w-3.5 h-3.5" />
                                        </button>
                                        <button onClick={() => deleteTool(tool.name)} title="Delete"
                                            className="p-1.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-red-400 transition-colors">
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 mt-2 flex-wrap">
                                    {tool.tags?.map(tag => (
                                        <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 bg-violet-900/40 text-violet-300 rounded text-xs">
                                            <Tag className="w-3 h-3" /> {tag}
                                        </span>
                                    ))}
                                    <span className="text-xs text-muted-foreground/70">v{tool.version}</span>
                                    <span className="text-xs text-muted-foreground/70">{tool.usageCount} uses</span>
                                    {successRate(tool) !== null && (
                                        <span className={`text-xs flex items-center gap-0.5 ${successRate(tool)! >= 80 ? 'text-emerald-400' : successRate(tool)! >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                                            <CheckCircle2 className="w-3 h-3" /> {successRate(tool)}%
                                        </span>
                                    )}
                                    <span className="text-xs text-zinc-600 ml-auto">by {tool.createdBy}</span>
                                </div>
                                {expandedCode === tool.name && tool.code && (
                                    <pre className="mt-2 p-2 bg-card rounded text-xs text-muted-foreground overflow-auto max-h-40 font-mono border border-border">
                                        {tool.code}
                                    </pre>
                                )}

                                {/* ── Test Panel ── */}
                                {testPanelTool === tool.name && (
                                    <div className="mt-3 border border-emerald-700/40 rounded-lg p-3 space-y-2 bg-emerald-950/20">
                                        <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1">
                                            <Play className="w-3 h-3" /> Test Tool
                                        </p>
                                        {Object.keys(tool.inputSchema?.properties || {}).length > 0 ? (
                                            Object.entries(tool.inputSchema.properties).map(([key, def]: [string, any]) => (
                                                <div key={key}>
                                                    <label className="text-[10px] text-muted-foreground">
                                                        {key}{def.description ? ` — ${def.description}` : ''}
                                                        {tool.inputSchema.required?.includes(key) && <span className="text-red-400 ml-1">*</span>}
                                                    </label>
                                                    <input
                                                        value={testArgs[key] || ''}
                                                        onChange={e => setTestArgs(prev => ({ ...prev, [key]: e.target.value }))}
                                                        placeholder={def.type === 'object' ? 'JSON...' : `${def.type || 'string'}`}
                                                        className="w-full mt-0.5 px-2 py-1 bg-muted border border-border rounded text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                                    />
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-xs text-muted-foreground/70">No input parameters — tool runs with empty args</p>
                                        )}
                                        <button
                                            onClick={() => runTest(tool)}
                                            disabled={testRunning}
                                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded text-xs flex items-center gap-1 transition-colors"
                                        >
                                            {testRunning ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Running...</> : <><Play className="w-3 h-3" /> Run</>}
                                        </button>
                                        {testResult?.name === tool.name && (
                                            <pre className={`p-2 rounded text-xs overflow-auto max-h-32 border font-mono ${testResult.success
                                                    ? 'bg-card text-emerald-300 border-border'
                                                    : 'bg-red-950/30 text-red-300 border-red-700/40'
                                                }`}>
                                                {testResult.result}
                                            </pre>
                                        )}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </>)}

            {/* ── EXTERNAL MCP SERVERS TAB ── */}
            {tab === 'servers' && (<>
                <p className="text-xs text-muted-foreground/70">
                    Connect any MCP-compatible server (Playwright, Puppeteer, custom APIs, etc.). Its tools become available to the agent immediately and persist across restarts.
                </p>

                {/* Error */}
                {serversError && (
                    <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
                        <AlertCircle className="w-4 h-4 shrink-0" /><span>{serversError}</span>
                        <button onClick={() => setServersError(null)} className="ml-auto text-red-400 hover:text-red-200 text-xs">Dismiss</button>
                    </div>
                )}

                {/* Add Server Form */}
                {showAddServer && (
                    <Card className="border-violet-600/50">
                        <CardHeader className="pb-2"><CardTitle className="text-sm">Connect External MCP Server</CardTitle></CardHeader>
                        <CardContent className="space-y-2">
                            <input value={newServer.name} onChange={e => setNewServer({ ...newServer, name: e.target.value })}
                                placeholder="Server name (e.g. playwright, my_api)" className="w-full px-3 py-2 bg-muted border border-border rounded text-sm text-foreground" />
                            <input value={newServer.description} onChange={e => setNewServer({ ...newServer, description: e.target.value })}
                                placeholder="Description (optional)" className="w-full px-3 py-2 bg-muted border border-border rounded text-sm text-foreground" />
                            <div className="flex gap-2">
                                <input value={newServer.command} onChange={e => setNewServer({ ...newServer, command: e.target.value })}
                                    placeholder="Command (e.g. npx)" className="w-28 px-3 py-2 bg-muted border border-border rounded text-sm text-foreground font-mono" />
                                <input value={newServer.args} onChange={e => setNewServer({ ...newServer, args: e.target.value })}
                                    placeholder="Args (space-separated, e.g. @playwright/mcp)" className="flex-1 px-3 py-2 bg-muted border border-border rounded text-sm text-foreground font-mono" />
                            </div>
                            <p className="text-xs text-zinc-600">Example: command=<code>npx</code> args=<code>@playwright/mcp</code></p>
                            <button onClick={connectServer} disabled={connectingServer}
                                className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded text-sm transition-colors flex items-center gap-2">
                                {connectingServer ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Connecting...</> : <><Plug className="w-3.5 h-3.5" /> Connect</>}
                            </button>
                        </CardContent>
                    </Card>
                )}

                {/* Loading */}
                {serversLoading && (
                    <div className="text-center text-muted-foreground py-12">
                        <div className="animate-spin w-6 h-6 border-2 border-violet-400 border-t-transparent rounded-full mx-auto mb-2" />
                        Loading servers...
                    </div>
                )}

                {/* Empty State */}
                {!serversLoading && servers.length === 0 && (
                    <div className="text-center text-muted-foreground/70 py-12">
                        <Server className="w-10 h-10 mx-auto mb-2 opacity-40" />
                        <p>No external servers connected</p>
                        <p className="text-xs mt-1">Click "Connect Server" to add a Playwright, Puppeteer, or custom MCP server</p>
                    </div>
                )}

                {/* Server Cards */}
                <div className="space-y-3">
                    {servers.map(srv => (
                        <Card key={srv.name} className="border-border hover:border-zinc-500 transition-colors">
                            <CardContent className="p-4">
                                <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full mt-0.5 ${srv.connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                        <div>
                                            <span className="font-semibold text-foreground">{srv.name}</span>
                                            {srv.description && <p className="text-xs text-muted-foreground mt-0.5">{srv.description}</p>}
                                        </div>
                                    </div>
                                    <button onClick={() => disconnectServer(srv.name)} title="Disconnect"
                                        className="p-1.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-red-400 transition-colors">
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground/70">
                                    <code className="bg-muted px-1.5 py-0.5 rounded">{srv.command} {srv.args.join(' ')}</code>
                                    <span className="flex items-center gap-1">
                                        <PlugZap className="w-3 h-3" /> {srv.toolCount} tools
                                    </span>
                                    <span>Added {new Date(srv.addedAt).toLocaleDateString()}</span>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </>)}
        </div>
    );
}
