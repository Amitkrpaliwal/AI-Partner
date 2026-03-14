import { API_BASE } from '@/lib/api';
import { Settings as SettingsIcon, Brain, Plus, Save, Key, RefreshCw, Check, X, Loader2, Search, Globe, Shield, Cpu, Trash2, Pencil } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useStore } from '@/store';
import { ModelSwitcher } from './ModelSwitcher';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';

interface ProviderConfig {
    name: string;
    label: string;
    baseURL: string;
    defaultModel: string;
    configured: boolean;
    connected: boolean;
    keyMasked: string;
}

export function SettingsView() {
    const { coreMemory, fetchCoreMemory } = useStore();

    // New Memory State
    const [newMemCategory, setNewMemCategory] = useState('userPreferences');
    const [newMemKey, setNewMemKey] = useState('');
    const [newMemValue, setNewMemValue] = useState('');

    // Config State
    const [systemPrompt, setSystemPrompt] = useState('Loading...');
    const [mcpEnabled, setMcpEnabled] = useState(true);
    const [activeStart, setActiveStart] = useState('09:00');
    const [activeEnd, setActiveEnd] = useState('22:00');

    // LLM Provider State
    const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([]);
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [savingProvider, setSavingProvider] = useState<string | null>(null);
    const [providerStatus, setProviderStatus] = useState<Record<string, 'success' | 'error' | null>>({});
    const [removingProvider, setRemovingProvider] = useState<string | null>(null);
    const [editingProvider, setEditingProvider] = useState<string | null>(null); // show input for already-configured provider
    const [refreshingModels, setRefreshingModels] = useState(false);

    // Local provider URL state (Ollama + LM Studio)
    const [ollamaHost, setOllamaHost] = useState('http://localhost:11434');
    const [lmStudioUrl, setLmStudioUrl] = useState('http://localhost:1234/v1');
    const [savingLocalProvider, setSavingLocalProvider] = useState<string | null>(null);
    const [localProviderStatus, setLocalProviderStatus] = useState<Record<string, 'success' | 'error' | null>>({});

    // Search Provider State
    const [searchProviders, setSearchProviders] = useState<any[]>([]);
    const [preferredSearch, setPreferredSearch] = useState('auto');
    const [searxngEndpoint, setSearxngEndpoint] = useState('http://localhost:8888/search');
    const [braveApiKey, setBraveApiKey] = useState('');
    const [savingSearch, setSavingSearch] = useState(false);
    const [searchTestResult, setSearchTestResult] = useState<string | null>(null);

    // Embedding Provider State
    const [embeddingProvider, setEmbeddingProvider] = useState('auto');
    const [ollamaModel, setOllamaModel] = useState('nomic-embed-text');
    const [openaiEmbedKey, setOpenaiEmbedKey] = useState('');
    const [openaiEmbedModel, setOpenaiEmbedModel] = useState('text-embedding-3-small');
    const [cohereEmbedKey, setCohereEmbedKey] = useState('');
    const [embeddingStatus, setEmbeddingStatus] = useState<any>(null);
    const [savingEmbedding, setSavingEmbedding] = useState(false);
    const [embeddingSaveResult, setEmbeddingSaveResult] = useState<string | null>(null);

    // Container State
    const [containerStatus, setContainerStatus] = useState<any>(null);

    // Approval mode state
    const [approvalMode, setApprovalMode] = useState<'none' | 'script' | 'all'>('script');
    const [hitlTimeout, setHitlTimeout] = useState(60);
    const [savingApproval, setSavingApproval] = useState(false);

    useEffect(() => {
        fetchCoreMemory();
        fetchConfig();
        fetchProviderConfigs();
        fetchSearchProviders();
        fetchContainerStatus();
        fetchEmbeddingStatus();
    }, [fetchCoreMemory]);

    const fetchConfig = () => {
        fetch(`${API_BASE}/api/config`)
            .then(res => res.json())
            .then(data => {
                setSystemPrompt(data.systemPrompt || '');
                setMcpEnabled(data.mcpEnabled);
                if (data.activeHours) {
                    setActiveStart(data.activeHours.start);
                    setActiveEnd(data.activeHours.end);
                }
                if (data.execution?.approval_mode) {
                    setApprovalMode(data.execution.approval_mode);
                }
                if (data.execution?.hitl_timeout_seconds) {
                    setHitlTimeout(data.execution.hitl_timeout_seconds);
                }
            })
            .catch(console.error);
    }

    const handleSaveApprovalMode = async () => {
        setSavingApproval(true);
        try {
            await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ execution: { approval_mode: approvalMode, hitl_timeout_seconds: hitlTimeout } })
            });
        } finally {
            setSavingApproval(false);
        }
    };

    const handleSaveConfig = async () => {
        try {
            await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemPrompt,
                    mcpEnabled,
                    activeHours: { start: activeStart, end: activeEnd }
                })
            });
            alert('Configuration Saved!');
        } catch (e) {
            console.error(e);
            alert('Failed to save config');
        }
    };

    const handleAddMemory = async () => {
        if (!newMemKey || !newMemValue) return;

        try {
            await fetch(`${API_BASE}/api/memory/core`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    category: newMemCategory,
                    key: newMemKey,
                    value: newMemValue
                })
            });

            // Refresh global store
            fetchCoreMemory();

            setNewMemKey('');
            setNewMemValue('');
        } catch (e) {
            console.error('Failed to save memory', e);
        }
    };

    const fetchProviderConfigs = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/models/providers/configs`);
            const data = await res.json();
            setProviderConfigs(data.providers || []);
        } catch (e) {
            console.error('Failed to fetch provider configs:', e);
        }
        // Also load saved local provider URLs from config
        try {
            const res = await fetch(`${API_BASE}/api/config`);
            const cfg = await res.json();
            if (cfg.localProviders?.ollama?.host) setOllamaHost(cfg.localProviders.ollama.host);
            if (cfg.localProviders?.lmstudio?.baseUrl) setLmStudioUrl(cfg.localProviders.lmstudio.baseUrl);
        } catch { /* non-fatal */ }
    };

    const handleSaveLocalProvider = async (name: 'ollama' | 'lmstudio') => {
        const baseURL = name === 'ollama' ? ollamaHost : lmStudioUrl;
        if (!baseURL.trim()) return;
        setSavingLocalProvider(name);
        setLocalProviderStatus(prev => ({ ...prev, [name]: null }));
        try {
            const res = await fetch(`${API_BASE}/api/models/providers/local`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, baseURL: baseURL.trim() }),
            });
            const data = await res.json();
            setLocalProviderStatus(prev => ({ ...prev, [name]: data.success ? 'success' : 'error' }));
            if (data.success) {
                await fetchProviderConfigs();
                window.dispatchEvent(new CustomEvent('models:refresh'));
            }
        } catch {
            setLocalProviderStatus(prev => ({ ...prev, [name]: 'error' }));
        } finally {
            setSavingLocalProvider(null);
            setTimeout(() => setLocalProviderStatus(prev => ({ ...prev, [name]: null })), 3000);
        }
    };

    const handleSaveProvider = async (providerName: string) => {
        const key = apiKeys[providerName];
        if (!key?.trim()) return;

        setSavingProvider(providerName);
        setProviderStatus(prev => ({ ...prev, [providerName]: null }));

        try {
            const res = await fetch(`${API_BASE}/api/models/providers/configure`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: providerName, apiKey: key.trim() })
            });
            const data = await res.json();

            if (data.success) {
                setProviderStatus(prev => ({ ...prev, [providerName]: 'success' }));
                setApiKeys(prev => ({ ...prev, [providerName]: '' }));
                await fetchProviderConfigs();
                // Trigger ModelSwitcher to re-fetch models from the newly registered provider
                window.dispatchEvent(new CustomEvent('models:refresh'));
            } else {
                setProviderStatus(prev => ({ ...prev, [providerName]: 'error' }));
            }
        } catch (e) {
            console.error('Failed to save provider:', e);
            setProviderStatus(prev => ({ ...prev, [providerName]: 'error' }));
        } finally {
            setSavingProvider(null);
            setTimeout(() => setProviderStatus(prev => ({ ...prev, [providerName]: null })), 3000);
        }
    };

    const handleRemoveProvider = async (providerName: string) => {
        if (!confirm(`Remove API key for ${providerName}? The provider will be disconnected.`)) return;
        setRemovingProvider(providerName);
        try {
            await fetch(`${API_BASE}/api/models/providers/${providerName}`, { method: 'DELETE' });
            setEditingProvider(null);
            await fetchProviderConfigs();
            window.dispatchEvent(new CustomEvent('models:refresh'));
        } catch (e) {
            console.error('Failed to remove provider:', e);
        } finally {
            setRemovingProvider(null);
        }
    };

    const handleRefreshModels = async () => {
        setRefreshingModels(true);
        try {
            await fetch(`${API_BASE}/api/models/refresh`, { method: 'POST' });
            await fetchProviderConfigs();
            // Trigger ModelSwitcher to re-fetch its model list
            window.dispatchEvent(new CustomEvent('models:refresh'));
        } catch (e) {
            console.error('Failed to refresh models:', e);
        } finally {
            setRefreshingModels(false);
        }
    };

    const handleDeleteMemory = async (key: string) => {
        await fetch(`${API_BASE}/api/memory/core`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: 'userPreferences', key: key })
        });
        fetchCoreMemory();
    }

    // Search provider methods
    const fetchSearchProviders = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/search/providers`);
            const data = await res.json();
            setSearchProviders(data.providers || []);
            if (data.preferred) setPreferredSearch(data.preferred);
        } catch (e) {
            console.error('Failed to fetch search providers:', e);
        }
    };

    const handleSaveSearchConfig = async () => {
        setSavingSearch(true);
        try {
            await fetch(`${API_BASE}/api/search/providers/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preferred_provider: preferredSearch,
                    searxng_endpoint: searxngEndpoint,
                    brave_api_key: braveApiKey || undefined,
                }),
            });
            await fetchSearchProviders();
            setSearchTestResult('Configuration saved');
            setTimeout(() => setSearchTestResult(null), 3000);
        } catch (e) {
            setSearchTestResult('Failed to save');
        } finally {
            setSavingSearch(false);
        }
    };

    const handleTestSearch = async () => {
        setSearchTestResult('Testing...');
        try {
            const res = await fetch(`${API_BASE}/api/search/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'hello world', limit: 2 }),
            });
            const data = await res.json();
            if (data.success) {
                setSearchTestResult(`${data.provider}: ${data.resultCount} results found`);
            } else {
                setSearchTestResult(`Failed: ${data.error}`);
            }
        } catch (e: any) {
            setSearchTestResult(`Error: ${e.message}`);
        }
        setTimeout(() => setSearchTestResult(null), 5000);
    };

    // Embedding methods
    const fetchEmbeddingStatus = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/config`);
            const data = await res.json();
            if (data.embedding) {
                setEmbeddingProvider(data.embedding.preferred_provider || 'auto');
                setOllamaModel(data.embedding.ollama_model || 'nomic-embed-text');
                setOpenaiEmbedModel(data.embedding.openai_model || 'text-embedding-3-small');
            }
        } catch (e) {
            console.error('Failed to fetch embedding config:', e);
        }
        try {
            const res = await fetch(`${API_BASE}/api/memory/search?q=__status_check__&limit=0`);
            // Just checking if vector is enabled
            const data = await res.json();
            setEmbeddingStatus({ vectorEnabled: data.vectorEnabled });
        } catch { /* ignore */ }
    };

    const handleSaveEmbeddingConfig = async () => {
        setSavingEmbedding(true);
        try {
            await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embedding: {
                        preferred_provider: embeddingProvider,
                        ollama_model: ollamaModel,
                        openai_api_key: openaiEmbedKey || undefined,
                        openai_model: openaiEmbedModel,
                        cohere_api_key: cohereEmbedKey || undefined,
                    },
                }),
            });
            setEmbeddingSaveResult('Saved! Restart server to apply changes.');
            setTimeout(() => setEmbeddingSaveResult(null), 5000);
        } catch (e) {
            setEmbeddingSaveResult('Failed to save');
        } finally {
            setSavingEmbedding(false);
        }
    };

    // Container methods
    const fetchContainerStatus = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/containers/status`);
            const data = await res.json();
            setContainerStatus(data);
        } catch (e) {
            console.error('Failed to fetch container status:', e);
        }
    };

    return (
        <div className="p-4 space-y-6 max-w-4xl mx-auto h-full overflow-y-auto">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold flex items-center">
                    <SettingsIcon className="mr-2" /> Global Settings
                </h1>
                <Button onClick={handleSaveConfig}>
                    <Save className="mr-2 h-4 w-4" /> Save Configuration
                </Button>
            </div>

            {/* 1. System Configuration */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">System Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div>
                        <label className="text-sm font-medium block mb-2">System Prompt (Persona)</label>
                        <textarea
                            className="w-full h-32 p-3 text-sm bg-background border border-input rounded-md ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={systemPrompt}
                            onChange={e => setSystemPrompt(e.target.value)}
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Active Hours</label>
                            <div className="flex gap-2">
                                <Input
                                    type="time"
                                    value={activeStart}
                                    onChange={e => setActiveStart(e.target.value)}
                                    className="flex-1"
                                />
                                <span className="self-center">-</span>
                                <Input
                                    type="time"
                                    value={activeEnd}
                                    onChange={e => setActiveEnd(e.target.value)}
                                    className="flex-1"
                                />
                            </div>
                        </div>

                        <div className="flex items-center space-x-2 pt-8">
                            <input
                                type="checkbox"
                                id="mcpParams"
                                checked={mcpEnabled}
                                onChange={e => setMcpEnabled(e.target.checked)}
                                className="w-4 h-4 rounded border-primary text-primary focus:ring-primary"
                            />
                            <label htmlFor="mcpParams" className="text-sm font-medium leading-none cursor-pointer">
                                Enable MCP Tool Integration
                            </label>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* 2. LLM Model */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">Language Model</CardTitle>
                </CardHeader>
                <CardContent>
                    <ModelSwitcher />
                    <div className="flex items-center gap-2 mt-3">
                        <Button variant="outline" size="sm" onClick={handleRefreshModels} disabled={refreshingModels}>
                            <RefreshCw className={`h-3 w-3 mr-1 ${refreshingModels ? 'animate-spin' : ''}`} />
                            Refresh Models
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            Re-discover models from all connected providers.
                        </p>
                    </div>
                </CardContent>
            </Card>

            {/* 2b. LLM Provider API Keys */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center">
                        <Key className="mr-2 h-5 w-5 text-orange-500" />
                        LLM Provider API Keys
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground mb-2">
                        Configure API keys for cloud LLM providers. Local providers (Ollama, LM Studio) are auto-detected.
                    </p>
                    {providerConfigs.filter(p => p.name !== 'ollama' && p.name !== 'lmstudio').map(provider => {
                        const isEditing = editingProvider === provider.name;
                        const showInput = !provider.configured || isEditing;
                        return (
                            <div key={provider.name} className="flex items-center gap-2 p-3 border rounded-lg bg-card">
                                <div className="min-w-[110px]">
                                    <div className="text-sm font-medium">{provider.label}</div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {provider.configured ? (
                                            <span className="text-green-500 flex items-center gap-1">
                                                <Check className="h-3 w-3" /> {provider.keyMasked}
                                            </span>
                                        ) : (
                                            <span className="text-muted-foreground">Not configured</span>
                                        )}
                                    </div>
                                </div>

                                {showInput ? (
                                    <>
                                        <Input
                                            type="password"
                                            placeholder={`Enter ${provider.label} API key`}
                                            value={apiKeys[provider.name] || ''}
                                            onChange={e => setApiKeys(prev => ({ ...prev, [provider.name]: e.target.value }))}
                                            className="flex-1 h-8 text-sm"
                                            autoFocus={isEditing}
                                        />
                                        <Button
                                            size="sm"
                                            className="h-8"
                                            disabled={!apiKeys[provider.name]?.trim() || savingProvider === provider.name}
                                            onClick={() => { handleSaveProvider(provider.name); setEditingProvider(null); }}
                                        >
                                            {savingProvider === provider.name ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : providerStatus[provider.name] === 'success' ? (
                                                <Check className="h-3 w-3 text-green-500" />
                                            ) : providerStatus[provider.name] === 'error' ? (
                                                <X className="h-3 w-3 text-red-500" />
                                            ) : (
                                                <span>Save</span>
                                            )}
                                        </Button>
                                        {isEditing && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 px-2"
                                                onClick={() => { setEditingProvider(null); setApiKeys(prev => ({ ...prev, [provider.name]: '' })); }}
                                            >
                                                <X className="h-3 w-3" />
                                            </Button>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <div className="flex-1" />
                                        {/* Edit: show input to replace key */}
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-8 gap-1 text-xs"
                                            onClick={() => setEditingProvider(provider.name)}
                                        >
                                            <Pencil className="h-3 w-3" /> Replace
                                        </Button>
                                        {/* Delete: remove key entirely */}
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                                            disabled={removingProvider === provider.name}
                                            onClick={() => handleRemoveProvider(provider.name)}
                                        >
                                            {removingProvider === provider.name ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : (
                                                <Trash2 className="h-3 w-3" />
                                            )}
                                        </Button>
                                    </>
                                )}
                            </div>
                        );
                    })}

                    {/* Local providers — configurable URLs (persisted to config.json in Docker volume) */}
                    <div className="mt-4 pt-3 border-t space-y-4">
                        <div className="text-xs font-medium text-muted-foreground">Local Providers</div>

                        {/* Ollama */}
                        {(() => {
                            const p = providerConfigs.find(x => x.name === 'ollama');
                            return (
                                <div className="space-y-1.5">
                                    <div className="flex items-center gap-2">
                                        <div className={`h-2 w-2 rounded-full ${p?.connected ? 'bg-green-500' : 'bg-gray-400'}`} />
                                        <span className="text-sm font-medium">Ollama</span>
                                        <span className="text-xs text-muted-foreground">{p?.connected ? 'Connected' : 'Not running'}</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <Input
                                            placeholder="http://localhost:11434"
                                            value={ollamaHost}
                                            onChange={e => setOllamaHost(e.target.value)}
                                            className="h-8 text-xs font-mono"
                                        />
                                        <Button
                                            size="sm"
                                            className="h-8 px-3 text-xs shrink-0"
                                            disabled={savingLocalProvider === 'ollama'}
                                            onClick={() => handleSaveLocalProvider('ollama')}
                                        >
                                            {savingLocalProvider === 'ollama' ? 'Saving…' : localProviderStatus.ollama === 'success' ? '✓ Saved' : 'Save'}
                                        </Button>
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">
                                        Docker: use <code className="bg-muted px-1 rounded">http://host.docker.internal:11434</code>. Saved to /data/config.json — survives rebuilds.
                                    </p>
                                </div>
                            );
                        })()}

                        {/* LM Studio */}
                        {(() => {
                            const p = providerConfigs.find(x => x.name === 'lmstudio');
                            return (
                                <div className="space-y-1.5">
                                    <div className="flex items-center gap-2">
                                        <div className={`h-2 w-2 rounded-full ${p?.connected ? 'bg-green-500' : 'bg-gray-400'}`} />
                                        <span className="text-sm font-medium">LM Studio</span>
                                        <span className="text-xs text-muted-foreground">{p?.connected ? 'Connected' : 'Not running'}</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <Input
                                            placeholder="http://localhost:1234/v1"
                                            value={lmStudioUrl}
                                            onChange={e => setLmStudioUrl(e.target.value)}
                                            className="h-8 text-xs font-mono"
                                        />
                                        <Button
                                            size="sm"
                                            className="h-8 px-3 text-xs shrink-0"
                                            disabled={savingLocalProvider === 'lmstudio'}
                                            onClick={() => handleSaveLocalProvider('lmstudio')}
                                        >
                                            {savingLocalProvider === 'lmstudio' ? 'Saving…' : localProviderStatus.lmstudio === 'success' ? '✓ Saved' : 'Save'}
                                        </Button>
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                </CardContent>
            </Card>

            {/* 3. Search Engine Configuration */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center">
                        <Search className="mr-2 h-5 w-5 text-green-500" />
                        Search Engine
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-xs text-muted-foreground">
                        Configure web search providers. SearXNG (self-hosted) is preferred, with Brave and DuckDuckGo as fallbacks.
                    </p>

                    {/* Provider Status */}
                    <div className="space-y-2">
                        <div className="text-sm font-medium">Provider Status</div>
                        {searchProviders.map(p => (
                            <div key={p.name} className="flex items-center gap-2 text-sm">
                                <div className={`h-2 w-2 rounded-full ${p.available ? 'bg-green-500' : 'bg-gray-400'}`} />
                                <span>{p.displayName}</span>
                                <span className="text-xs text-muted-foreground">
                                    {p.available ? 'Available' : p.requiresApiKey ? 'Needs API key' : p.requiresService ? 'Service not running' : 'Unavailable'}
                                </span>
                            </div>
                        ))}
                        {searchProviders.length === 0 && (
                            <div className="text-xs text-muted-foreground italic">Loading providers...</div>
                        )}
                    </div>

                    {/* Configuration */}
                    <div className="space-y-3 pt-2 border-t">
                        <div>
                            <label className="text-sm font-medium block mb-1">Preferred Provider</label>
                            <select
                                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                                value={preferredSearch}
                                onChange={e => setPreferredSearch(e.target.value)}
                            >
                                <option value="auto">Auto (best available)</option>
                                <option value="searxng">SearXNG (self-hosted)</option>
                                <option value="brave">Brave Search</option>
                                <option value="duckduckgo">DuckDuckGo</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">SearXNG Endpoint</label>
                            <Input
                                placeholder="http://localhost:8888/search"
                                value={searxngEndpoint}
                                onChange={e => setSearxngEndpoint(e.target.value)}
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                                Start SearXNG: docker-compose -f docker-compose.searxng.yml up -d
                            </p>
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">Brave Search API Key</label>
                            <Input
                                type="password"
                                placeholder="Enter Brave Search API key (optional)"
                                value={braveApiKey}
                                onChange={e => setBraveApiKey(e.target.value)}
                            />
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 items-center">
                        <Button size="sm" onClick={handleSaveSearchConfig} disabled={savingSearch}>
                            {savingSearch ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                            Save
                        </Button>
                        <Button size="sm" variant="outline" onClick={handleTestSearch}>
                            <Globe className="h-3 w-3 mr-1" />
                            Test Search
                        </Button>
                        {searchTestResult && (
                            <span className="text-xs text-muted-foreground">{searchTestResult}</span>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* 4. Embedding Provider */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center">
                        <Cpu className="mr-2 h-5 w-5 text-indigo-500" />
                        Embedding Provider
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-xs text-muted-foreground">
                        Configure embedding providers for semantic memory search. Falls back through the chain: Ollama → OpenAI → Cohere → Local TF-IDF.
                    </p>

                    {embeddingStatus && (
                        <div className="flex items-center gap-2 text-sm">
                            <div className={`h-2 w-2 rounded-full ${embeddingStatus.vectorEnabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                            <span>Vector Search: {embeddingStatus.vectorEnabled ? 'Active' : 'Inactive'}</span>
                        </div>
                    )}

                    <div className="space-y-3 pt-2 border-t">
                        <div>
                            <label className="text-sm font-medium block mb-1">Preferred Provider</label>
                            <select
                                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                                value={embeddingProvider}
                                onChange={e => setEmbeddingProvider(e.target.value)}
                            >
                                <option value="auto">Auto (best available)</option>
                                <option value="ollama">Ollama (local)</option>
                                <option value="openai">OpenAI</option>
                                <option value="cohere">Cohere</option>
                                <option value="local-tfidf">Local TF-IDF (no deps)</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">Ollama Model</label>
                            <Input
                                placeholder="nomic-embed-text"
                                value={ollamaModel}
                                onChange={e => setOllamaModel(e.target.value)}
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                                Pull with: ollama pull nomic-embed-text
                            </p>
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">OpenAI Embedding API Key</label>
                            <Input
                                type="password"
                                placeholder="Enter OpenAI API key (for embeddings)"
                                value={openaiEmbedKey}
                                onChange={e => setOpenaiEmbedKey(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">OpenAI Embedding Model</label>
                            <Input
                                placeholder="text-embedding-3-small"
                                value={openaiEmbedModel}
                                onChange={e => setOpenaiEmbedModel(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">Cohere Embedding API Key</label>
                            <Input
                                type="password"
                                placeholder="Enter Cohere API key (optional)"
                                value={cohereEmbedKey}
                                onChange={e => setCohereEmbedKey(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="flex gap-2 items-center">
                        <Button size="sm" onClick={handleSaveEmbeddingConfig} disabled={savingEmbedding}>
                            {savingEmbedding ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                            Save
                        </Button>
                        {embeddingSaveResult && (
                            <span className="text-xs text-muted-foreground">{embeddingSaveResult}</span>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* 5. Container Execution */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center">
                        <Shield className="mr-2 h-5 w-5 text-purple-500" />
                        Sandboxed Execution (Docker)
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                        Commands run inside Docker containers for safety. Containers persist across calls and auto-stop after idle timeout.
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 bg-muted/50 rounded-lg">
                            <div className="text-xs text-muted-foreground mb-1">Docker</div>
                            <div className="flex items-center gap-2">
                                <div className={`h-2.5 w-2.5 rounded-full ${containerStatus?.dockerAvailable ? 'bg-green-500' : 'bg-red-500'}`} />
                                <span className="text-sm font-medium">
                                    {containerStatus?.dockerAvailable ? 'Available' : 'Not found'}
                                </span>
                            </div>
                        </div>
                        <div className="p-3 bg-muted/50 rounded-lg">
                            <div className="text-xs text-muted-foreground mb-1">Active Sessions</div>
                            <span className="text-sm font-medium">{containerStatus?.sessionCount ?? 0}</span>
                        </div>
                        <div className="p-3 bg-muted/50 rounded-lg">
                            <div className="text-xs text-muted-foreground mb-1">Image</div>
                            <span className="text-sm font-mono">{containerStatus?.config?.image || 'node:20-slim'}</span>
                        </div>
                        <div className="p-3 bg-muted/50 rounded-lg">
                            <div className="text-xs text-muted-foreground mb-1">Memory / CPU</div>
                            <span className="text-sm font-mono">
                                {containerStatus?.config?.memoryLimit || '512m'} / {containerStatus?.config?.cpuLimit || '1.0'}
                            </span>
                        </div>
                    </div>

                    {!containerStatus?.dockerAvailable && (
                        <div className="text-xs text-yellow-500 bg-yellow-500/10 p-2 rounded">
                            Docker not detected. Install Docker Desktop to enable sandboxed execution.
                        </div>
                    )}

                    <div className="border-t border-border pt-4">
                        <div className="text-sm font-medium mb-1">Approval Mode</div>
                        <p className="text-xs text-muted-foreground mb-3">
                            Controls when the agent pauses for confirmation during goal execution.
                        </p>
                        <div className="space-y-2">
                            {([
                                { value: 'none',   dot: 'bg-green-500',  label: 'Autonomous',    desc: 'Agent runs end-to-end — no pauses' },
                                { value: 'script', dot: 'bg-yellow-500', label: 'Script Review',  desc: 'Generated scripts pause for your review before running' },
                                { value: 'all',    dot: 'bg-red-500',    label: 'Manual',         desc: 'Every file write and command waits for approval' },
                            ] as const).map(opt => (
                                <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${approvalMode === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}>
                                    <input
                                        type="radio"
                                        name="approvalMode"
                                        value={opt.value}
                                        checked={approvalMode === opt.value}
                                        onChange={() => setApprovalMode(opt.value)}
                                        className="mt-0.5"
                                    />
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className={`h-2 w-2 rounded-full ${opt.dot}`} />
                                            <span className="text-sm font-medium">{opt.label}</span>
                                        </div>
                                        <span className="text-xs text-muted-foreground">{opt.desc}</span>
                                    </div>
                                </label>
                            ))}
                        </div>

                        {approvalMode === 'all' && (
                            <div className="mt-3 flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Auto-deny after</span>
                                <input
                                    type="number"
                                    min={10}
                                    max={600}
                                    value={hitlTimeout}
                                    onChange={e => setHitlTimeout(Number(e.target.value))}
                                    className="w-16 px-2 py-1 text-xs border border-border rounded bg-background text-center"
                                />
                                <span className="text-xs text-muted-foreground">seconds if no response</span>
                            </div>
                        )}

                        <Button size="sm" className="mt-3" onClick={handleSaveApprovalMode} disabled={savingApproval}>
                            {savingApproval ? <><RefreshCw className="h-3 w-3 mr-1 animate-spin" />Saving...</> : 'Save Approval Mode'}
                        </Button>
                    </div>

                    <div className="border-t border-border pt-3">
                        <Button size="sm" variant="outline" onClick={fetchContainerStatus}>
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Refresh Status
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* 5. Core Memory */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center">
                        <Brain className="mr-2 h-5 w-5 text-blue-500" />
                        Core Memory & Facts
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="bg-muted/50 rounded-md p-4 min-h-[100px] max-h-[300px] overflow-y-auto space-y-2">
                        {(!coreMemory.userPreferences || Object.keys(coreMemory.userPreferences).length === 0) ? (
                            <div className="text-center text-muted-foreground italic py-8">No core memories stored yet.</div>
                        ) : (
                            Object.entries(coreMemory.userPreferences).map(([k, v]) => (
                                <div key={k} className="flex items-center justify-between p-2 bg-card rounded border border-border/50 group">
                                    <div className="text-sm">
                                        <span className="font-mono text-yellow-600 dark:text-yellow-400 mr-2">{k}</span>
                                        <span className="text-muted-foreground mr-2">=</span>
                                        <span>{String(v)}</span>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                                        onClick={() => handleDeleteMemory(k)}
                                    >
                                        <span className="sr-only">Delete</span>
                                        �
                                    </Button>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="flex gap-2">
                        <select
                            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={newMemCategory}
                            onChange={(e) => setNewMemCategory(e.target.value)}
                        >
                            <option value="userPreferences">Preference</option>
                            <option value="projectConstraints">Constraint</option>
                        </select>
                        <Input
                            placeholder="Key (e.g. theme)"
                            value={newMemKey}
                            onChange={e => setNewMemKey(e.target.value)}
                        />
                        <Input
                            placeholder="Value (e.g. dark)"
                            value={newMemValue}
                            onChange={e => setNewMemValue(e.target.value)}
                        />
                        <Button onClick={handleAddMemory}>
                            <Plus className="h-4 w-4 mr-1" /> Add
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
