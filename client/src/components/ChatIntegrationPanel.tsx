import { API_BASE } from '@/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import {
    MessageSquare, Loader2, Check, Settings,
    ChevronDown, ChevronUp, RefreshCw, AlertCircle
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

type AdapterState = 'connected' | 'configured' | 'not_configured';

interface AdapterStatus {
    platform: string;
    connected: boolean;
}

interface PlatformInfo {
    configured: boolean;
    enabled: boolean;
    connected: boolean;
    status: AdapterState;
}

interface ChatStatus {
    adapters: AdapterStatus[];
    discord: PlatformInfo;
    telegram: PlatformInfo;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ChatIntegrationPanel() {
    const [status, setStatus] = useState<ChatStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(false);

    // Discord config
    const [discordToken, setDiscordToken] = useState('');
    const [discordEnabled, setDiscordEnabled] = useState(false);
    const [discordSaving, setDiscordSaving] = useState(false);

    // Telegram config
    const [telegramToken, setTelegramToken] = useState('');
    const [telegramEnabled, setTelegramEnabled] = useState(false);
    const [telegramSaving, setTelegramSaving] = useState(false);

    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [reconnecting, setReconnecting] = useState(false);

    // Load status on mount and refresh every 10s so the widget stays in sync
    // with actual adapter connection state (e.g. Telegram connects after mount)
    useEffect(() => {
        loadStatus();
        const interval = setInterval(loadStatus, 10_000);
        return () => clearInterval(interval);
    }, []);

    const loadStatus = async () => {
        try {
            const response = await fetch(`${API_BASE}/api/chat/adapters/status`);
            if (response.ok) {
                const data = await response.json();
                setStatus(data);
                setDiscordEnabled(data.discord?.enabled || false);
                setTelegramEnabled(data.telegram?.enabled || false);
            }
        } catch (e) {
            console.error('Failed to load chat status:', e);
        } finally {
            setLoading(false);
        }
    };

    const saveDiscord = async () => {
        setDiscordSaving(true);
        setMessage(null);
        try {
            const response = await fetch(`${API_BASE}/api/chat/adapters/discord/configure`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: discordToken,
                    enabled: discordEnabled
                })
            });
            const data = await response.json();
            if (data.success) {
                setMessage({ type: 'success', text: data.message });
                loadStatus();
            } else {
                setMessage({ type: 'error', text: data.message || 'Failed to configure Discord' });
            }
        } catch (e: any) {
            setMessage({ type: 'error', text: e.message });
        } finally {
            setDiscordSaving(false);
        }
    };

    const saveTelegram = async () => {
        setTelegramSaving(true);
        setMessage(null);
        try {
            const response = await fetch(`${API_BASE}/api/chat/adapters/telegram/configure`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: telegramToken,
                    enabled: telegramEnabled
                })
            });
            const data = await response.json();
            if (data.success) {
                setMessage({ type: 'success', text: data.message });
                loadStatus();
            } else {
                setMessage({ type: 'error', text: data.message || 'Failed to configure Telegram' });
            }
        } catch (e: any) {
            setMessage({ type: 'error', text: e.message });
        } finally {
            setTelegramSaving(false);
        }
    };

    const getAdapterState = (platform: 'discord' | 'telegram'): AdapterState => {
        return status?.[platform]?.status ?? 'not_configured';
    };

    const handleReconnect = async () => {
        setReconnecting(true);
        setMessage(null);
        try {
            const response = await fetch(`${API_BASE}/api/chat/adapters/reconnect`, { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                setMessage({ type: 'success', text: 'Reconnected successfully' });
                loadStatus();
            } else {
                setMessage({ type: 'error', text: 'Reconnect failed' });
            }
        } catch (e: any) {
            setMessage({ type: 'error', text: e.message });
        } finally {
            setReconnecting(false);
        }
    };

    return (
        <Card>
            <CardHeader className="pb-2">
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center justify-between w-full"
                >
                    <CardTitle className="flex items-center gap-2 text-lg">
                        <MessageSquare className="w-5 h-5" />
                        Chat Integrations
                    </CardTitle>
                    <div className="flex items-center gap-2">
                        {/* Status indicators */}
                        <div className="flex gap-1">
                            {(['discord', 'telegram'] as const).map(p => {
                                const s = getAdapterState(p);
                                return (
                                    <span
                                        key={p}
                                        className={`w-2 h-2 rounded-full ${s === 'connected' ? 'bg-green-500' : s === 'configured' ? 'bg-yellow-400' : 'bg-gray-400'}`}
                                        title={`${p}: ${s}`}
                                    />
                                );
                            })}
                        </div>
                        {expanded ? (
                            <ChevronUp className="w-4 h-4" />
                        ) : (
                            <ChevronDown className="w-4 h-4" />
                        )}
                    </div>
                </button>
            </CardHeader>

            {expanded && (
                <CardContent className="space-y-4">
                    {loading ? (
                        <div className="flex items-center justify-center py-4">
                            <Loader2 className="w-5 h-5 animate-spin" />
                        </div>
                    ) : (
                        <>
                            {/* Status message */}
                            {message && (
                                <div className={`p-2 rounded text-sm ${message.type === 'success'
                                    ? 'bg-green-500/10 text-green-500'
                                    : 'bg-red-500/10 text-red-500'
                                    }`}>
                                    {message.text}
                                </div>
                            )}

                            {/* Discord Section */}
                            <div className="space-y-2 p-3 border rounded-md">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">Discord</span>
                                        {getAdapterState('discord') === 'connected' ? (
                                            <span className="text-xs text-green-500 flex items-center gap-1">
                                                <Check className="w-3 h-3" /> Connected
                                            </span>
                                        ) : getAdapterState('discord') === 'configured' ? (
                                            <span className="text-xs text-yellow-500 flex items-center gap-1">
                                                <AlertCircle className="w-3 h-3" /> Configured (not running)
                                            </span>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">Not configured</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {getAdapterState('discord') === 'configured' && (
                                            <button
                                                onClick={handleReconnect}
                                                disabled={reconnecting}
                                                className="flex items-center gap-1 px-2 py-1 text-xs bg-yellow-500/10 text-yellow-600 border border-yellow-500/30 rounded hover:bg-yellow-500/20 disabled:opacity-50"
                                            >
                                                {reconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                                Reconnect
                                            </button>
                                        )}
                                        <label className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={discordEnabled}
                                                onChange={(e) => setDiscordEnabled(e.target.checked)}
                                                className="rounded"
                                            />
                                            Enabled
                                        </label>
                                    </div>
                                </div>

                                <input
                                    type="password"
                                    placeholder="Discord Bot Token"
                                    value={discordToken}
                                    onChange={(e) => setDiscordToken(e.target.value)}
                                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background"
                                />

                                <button
                                    onClick={saveDiscord}
                                    disabled={discordSaving}
                                    className="flex items-center gap-2 px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                                >
                                    {discordSaving ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                        <Settings className="w-3 h-3" />
                                    )}
                                    Configure
                                </button>

                                <p className="text-xs text-muted-foreground">
                                    Requires: npm install discord.js
                                </p>
                            </div>

                            {/* Telegram Section */}
                            <div className="space-y-2 p-3 border rounded-md">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">Telegram</span>
                                        {getAdapterState('telegram') === 'connected' ? (
                                            <span className="text-xs text-green-500 flex items-center gap-1">
                                                <Check className="w-3 h-3" /> Connected
                                            </span>
                                        ) : getAdapterState('telegram') === 'configured' ? (
                                            <span className="text-xs text-yellow-500 flex items-center gap-1">
                                                <AlertCircle className="w-3 h-3" /> Configured (not running)
                                            </span>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">Not configured</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {getAdapterState('telegram') === 'configured' && (
                                            <button
                                                onClick={handleReconnect}
                                                disabled={reconnecting}
                                                className="flex items-center gap-1 px-2 py-1 text-xs bg-yellow-500/10 text-yellow-600 border border-yellow-500/30 rounded hover:bg-yellow-500/20 disabled:opacity-50"
                                            >
                                                {reconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                                Reconnect
                                            </button>
                                        )}
                                        <label className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={telegramEnabled}
                                                onChange={(e) => setTelegramEnabled(e.target.checked)}
                                                className="rounded"
                                            />
                                            Enabled
                                        </label>
                                    </div>
                                </div>

                                <input
                                    type="password"
                                    placeholder="Telegram Bot Token (from @BotFather)"
                                    value={telegramToken}
                                    onChange={(e) => setTelegramToken(e.target.value)}
                                    className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background"
                                />

                                <button
                                    onClick={saveTelegram}
                                    disabled={telegramSaving}
                                    className="flex items-center gap-2 px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                                >
                                    {telegramSaving ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                        <Settings className="w-3 h-3" />
                                    )}
                                    Configure
                                </button>

                                <p className="text-xs text-muted-foreground">
                                    Requires: npm install node-telegram-bot-api
                                </p>
                            </div>
                        </>
                    )}
                </CardContent>
            )}
        </Card>
    );
}
