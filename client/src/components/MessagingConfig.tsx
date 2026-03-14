import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Radio, Send, Power, PowerOff, AlertCircle, RefreshCw, Inbox, MessageSquare } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { getSocket } from '@/lib/socket';

interface ProviderStatus {
    connected: boolean;
    info?: any;
}

interface InboxMessage {
    id: string;
    provider: string;
    username: string;
    text: string;
    timestamp: string;
    chatId: string;
}

const PROVIDER_META: Record<string, { label: string; color: string; fields: Array<{ key: string; label: string; help: string; type?: string }> }> = {
    telegram: {
        label: 'Telegram', color: 'text-blue-400',
        fields: [{ key: 'token', label: 'Bot Token', help: 'Get from @BotFather' }],
    },
    discord: {
        label: 'Discord', color: 'text-indigo-400',
        fields: [{ key: 'token', label: 'Bot Token', help: 'From Discord Developer Portal' }],
    },
    whatsapp: {
        label: 'WhatsApp', color: 'text-green-400',
        fields: [{ key: 'authDir', label: 'Auth Directory', help: 'QR code will appear in server terminal' }],
    },
    slack: {
        label: 'Slack', color: 'text-purple-400',
        fields: [
            { key: 'token', label: 'Bot Token (xoxb-)', help: 'From Slack App Settings > OAuth' },
            { key: 'appToken', label: 'App Token (xapp-)', help: 'From Slack App Settings > Basic Info' },
        ],
    },
    signal: {
        label: 'Signal', color: 'text-sky-400',
        fields: [
            { key: 'phoneNumber', label: 'Phone Number', help: 'e.g. +1234567890' },
            { key: 'apiUrl', label: 'API URL', help: 'Default: http://localhost:8080' },
        ],
    },
};

export function MessagingConfig() {
    const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
    const [available, setAvailable] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [connecting, setConnecting] = useState<string | null>(null);
    const [configs, setConfigs] = useState<Record<string, Record<string, string>>>({});
    const [testMsg, setTestMsg] = useState({ provider: '', chatId: '', text: '' });
    const [testResult, setTestResult] = useState<string | null>(null);
    const [tab, setTab] = useState<'channels' | 'inbox'>('channels');
    const [inbox, setInbox] = useState<InboxMessage[]>([]);

    useEffect(() => { fetchStatus(); }, []);

    // Listen for real-time messages via Socket.IO for unified inbox
    useEffect(() => {
        const socket = getSocket();
        const handler = (data: any) => {
            const msg: InboxMessage = {
                id: data.id || `msg_${Date.now()}`,
                provider: data.provider || 'unknown',
                username: data.username || data.userId || 'Unknown',
                text: data.text || data.message || '',
                timestamp: data.timestamp || new Date().toISOString(),
                chatId: data.chatId || '',
            };
            setInbox(prev => [msg, ...prev].slice(0, 100));
        };
        socket.on('message:received', handler);
        return () => { socket.off('message:received', handler); };
    }, []);

    const fetchStatus = async () => {
        setLoading(true);
        setError(null);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`${API_BASE}/api/messaging/status`, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            setProviders(data.providers || {});
            setAvailable(data.available || []);
        } catch (e: any) {
            setError(e.name === 'AbortError' ? 'Server unreachable — is the backend running?' : e.message);
        } finally {
            setLoading(false);
        }
    };

    const connectProvider = async (name: string) => {
        setConnecting(name);
        setError(null);
        try {
            const providerConfig = configs[name] || {};
            const config: any = { enabled: true, ...providerConfig };
            const res = await fetch(`${API_BASE}/api/messaging/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: name, config }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Connect failed');
            fetchStatus();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setConnecting(null);
        }
    };

    const setConfigField = (provider: string, key: string, value: string) => {
        setConfigs(prev => ({
            ...prev,
            [provider]: { ...prev[provider], [key]: value },
        }));
    };

    const disconnectProvider = async (name: string) => {
        try {
            await fetch(`${API_BASE}/api/messaging/disconnect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: name }),
            });
            fetchStatus();
        } catch (e: any) {
            setError(e.message);
        }
    };

    const sendTestMessage = async () => {
        setTestResult(null);
        try {
            const res = await fetch(`${API_BASE}/api/messaging/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testMsg),
            });
            const data = await res.json();
            setTestResult(data.success ? '✅ Message sent!' : `❌ ${data.error}`);
        } catch (e: any) {
            setTestResult(`❌ ${e.message}`);
        }
    };

    const connectedCount = available.filter(n => providers[n]?.connected).length;

    return (
        <div className="p-4 h-full overflow-auto space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <Radio className="w-6 h-6 text-blue-400" /> Messaging
                    <span className="text-sm font-normal text-muted-foreground">
                        ({connectedCount}/{available.length} connected)
                    </span>
                </h1>
                <button onClick={fetchStatus} className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-muted-foreground/20 transition-colors">
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

            {/* Tab Selection */}
            <div className="flex gap-2">
                <button
                    onClick={() => setTab('channels')}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded text-sm transition-colors ${
                        tab === 'channels' ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
                    }`}
                >
                    <MessageSquare className="w-4 h-4" /> Channels
                </button>
                <button
                    onClick={() => setTab('inbox')}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded text-sm transition-colors ${
                        tab === 'inbox' ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
                    }`}
                >
                    <Inbox className="w-4 h-4" /> Unified Inbox
                </button>
            </div>

            {/* Error */}
            {error && (
                <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                    <button onClick={() => { setError(null); fetchStatus(); }} className="ml-auto text-red-400 hover:text-red-200 text-xs">Retry</button>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="text-center text-muted-foreground py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full mx-auto mb-2" />
                    Loading providers...
                </div>
            )}

            {/* ============================================================ */}
            {/* CHANNELS TAB */}
            {/* ============================================================ */}
            {tab === 'channels' && !loading && (
                <>
                    {/* Provider Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {available.map(name => {
                            const meta = PROVIDER_META[name] || {
                                label: name, color: 'text-muted-foreground',
                                fields: [{ key: 'token', label: 'Token', help: '' }],
                            };
                            const status = providers[name];
                            const isConnected = status?.connected || false;
                            const providerConfigs = configs[name] || {};

                            return (
                                <Card key={name} className={`border-border ${isConnected ? 'border-l-4 border-l-emerald-500' : ''}`}>
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm flex items-center justify-between">
                                            <span className={`flex items-center gap-2 ${meta.color}`}>
                                                <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/30'}`} />
                                                {meta.label}
                                            </span>
                                            <span className={`text-xs px-2 py-0.5 rounded ${
                                                isConnected ? 'bg-emerald-900/40 text-emerald-300' : 'bg-muted text-muted-foreground/70'
                                            }`}>
                                                {isConnected ? 'Connected' : 'Offline'}
                                            </span>
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        {!isConnected ? (
                                            <div className="space-y-2">
                                                {meta.fields.map(field => (
                                                    <div key={field.key}>
                                                        <label className="text-xs text-muted-foreground">{field.label}</label>
                                                        <input
                                                            type={field.type || 'password'}
                                                            value={providerConfigs[field.key] || ''}
                                                            onChange={e => setConfigField(name, field.key, e.target.value)}
                                                            placeholder={field.help}
                                                            className="w-full mt-1 px-3 py-1.5 bg-muted border border-border rounded text-sm text-foreground"
                                                        />
                                                    </div>
                                                ))}
                                                <button
                                                    onClick={() => connectProvider(name)}
                                                    disabled={connecting === name}
                                                    className="flex items-center gap-1 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded text-sm transition-colors w-full justify-center"
                                                >
                                                    <Power className="w-3.5 h-3.5" />
                                                    {connecting === name ? 'Connecting...' : 'Connect'}
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                <div className="text-xs text-muted-foreground break-all">
                                                    {status?.info
                                                        ? Object.entries(status.info)
                                                            .filter(([, v]) => v)
                                                            .map(([k, v]) => `${k}: ${v}`)
                                                            .join(', ')
                                                        : 'Active'}
                                                </div>
                                                <button
                                                    onClick={() => disconnectProvider(name)}
                                                    className="flex items-center gap-1 px-3 py-1.5 bg-red-800 hover:bg-red-700 text-white rounded text-sm transition-colors w-full justify-center"
                                                >
                                                    <PowerOff className="w-3.5 h-3.5" /> Disconnect
                                                </button>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>

                    {/* Test Message */}
                    <Card className="border-border">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Send className="w-4 h-4" /> Send Test Message
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                <select
                                    value={testMsg.provider}
                                    onChange={e => setTestMsg({ ...testMsg, provider: e.target.value })}
                                    className="px-3 py-2 bg-muted border border-border rounded text-sm text-foreground"
                                >
                                    <option value="">Provider</option>
                                    {available.filter(n => providers[n]?.connected).map(n => (
                                        <option key={n} value={n}>{PROVIDER_META[n]?.label || n}</option>
                                    ))}
                                </select>
                                <input
                                    value={testMsg.chatId}
                                    onChange={e => setTestMsg({ ...testMsg, chatId: e.target.value })}
                                    placeholder="Chat/Channel ID"
                                    className="px-3 py-2 bg-muted border border-border rounded text-sm text-foreground"
                                />
                                <input
                                    value={testMsg.text}
                                    onChange={e => setTestMsg({ ...testMsg, text: e.target.value })}
                                    placeholder="Message text"
                                    className="px-3 py-2 bg-muted border border-border rounded text-sm text-foreground"
                                />
                                <button
                                    onClick={sendTestMessage}
                                    disabled={!testMsg.provider || !testMsg.chatId || !testMsg.text}
                                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-sm transition-colors"
                                >
                                    Send
                                </button>
                            </div>
                            {testResult && <p className="text-sm mt-2">{testResult}</p>}
                        </CardContent>
                    </Card>
                </>
            )}

            {/* ============================================================ */}
            {/* UNIFIED INBOX TAB */}
            {/* ============================================================ */}
            {tab === 'inbox' && (
                <Card className="border-border">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                            <Inbox className="w-4 h-4" /> Unified Inbox
                            <span className="text-xs text-muted-foreground/70 font-normal">
                                Messages from all connected channels
                            </span>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {inbox.length === 0 ? (
                            <div className="text-center text-muted-foreground/70 py-8">
                                <Inbox className="w-8 h-8 mx-auto mb-2 opacity-40" />
                                <p className="text-sm">No messages yet.</p>
                                <p className="text-xs mt-1">Messages will appear here in real-time when received from connected channels.</p>
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-[500px] overflow-y-auto">
                                {inbox.map(msg => {
                                    const meta = PROVIDER_META[msg.provider];
                                    return (
                                        <div key={msg.id} className="flex items-start gap-2 p-2 rounded bg-muted/60 hover:bg-muted">
                                            <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                                                meta ? meta.color + ' bg-muted-foreground/20/50' : 'text-muted-foreground bg-muted-foreground/20/50'
                                            }`}>
                                                {meta?.label || msg.provider}
                                            </span>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-medium text-foreground">{msg.username}</span>
                                                    <span className="text-[10px] text-muted-foreground/70">{new Date(msg.timestamp).toLocaleString()}</span>
                                                </div>
                                                <p className="text-sm text-muted-foreground mt-0.5 break-words">{msg.text}</p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
