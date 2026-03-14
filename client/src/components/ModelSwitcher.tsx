import { API_BASE } from '@/lib/api';
import { useStore } from '@/store';
import { useState, useEffect, useRef } from 'react';
import { Loader2, ChevronDown, Check, Search } from 'lucide-react';

const PROVIDER_COLORS: Record<string, string> = {
    ollama:      'bg-purple-500/20 text-purple-400',
    lmstudio:    'bg-indigo-500/20 text-indigo-400',
    gemini:      'bg-blue-500/20 text-blue-400',
    openai:      'bg-green-500/20 text-green-400',
    anthropic:   'bg-orange-500/20 text-orange-400',
    groq:        'bg-yellow-500/20 text-yellow-400',
    deepseek:    'bg-cyan-500/20 text-cyan-400',
    mistral:     'bg-red-500/20 text-red-400',
    together:    'bg-pink-500/20 text-pink-400',
    perplexity:  'bg-teal-500/20 text-teal-400',
    openrouter:  'bg-violet-500/20 text-violet-400',
    cerebras:    'bg-amber-500/20 text-amber-400',
    fireworks:   'bg-rose-500/20 text-rose-400',
    cohere:      'bg-lime-500/20 text-lime-400',
    litellm:     'bg-sky-500/20 text-sky-400',
};

export function ModelSwitcher() {
    const { config, updateConfig } = useStore();
    const [models, setModels] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [initLoading, setInitLoading] = useState(true);
    const [open, setOpen] = useState(false);
    const [searchFilter, setSearchFilter] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fetchModels();
        const handleRefresh = () => fetchModels();
        window.addEventListener('models:refresh', handleRefresh);
        return () => window.removeEventListener('models:refresh', handleRefresh);
    }, []);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Focus search input when dropdown opens
    useEffect(() => {
        if (open && searchRef.current) {
            setTimeout(() => searchRef.current?.focus(), 50);
        }
        if (!open) setSearchFilter('');
    }, [open]);

    async function fetchModels() {
        try {
            const response = await fetch(`${API_BASE}/api/models`);
            const data = await response.json();
            setModels(data.models || []);
            if (data.active) {
                updateConfig('activeModel', data.active);
            }
        } catch (e) {
            console.error('Failed to fetch models', e);
        } finally {
            setInitLoading(false);
        }
    }

    async function handleSwitch(model: any) {
        setOpen(false);
        setLoading(true);
        try {
            await fetch(`${API_BASE}/api/models/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: model.id, provider: model.provider }),
            });
            updateConfig('activeModel', { model: model.id, provider: model.provider });
        } catch (error) {
            console.error('Model switch failed:', error);
        } finally {
            setLoading(false);
        }
    }

    // Filter + group models by provider
    const filteredModels = searchFilter.trim()
        ? models.filter(m => {
            const q = searchFilter.toLowerCase();
            return (m.name || m.id).toLowerCase().includes(q) || m.provider.toLowerCase().includes(q);
          })
        : models;

    const grouped = filteredModels.reduce((acc: Record<string, any[]>, m) => {
        if (!acc[m.provider]) acc[m.provider] = [];
        acc[m.provider].push(m);
        return acc;
    }, {});

    const activeProvider = config.activeModel?.provider || '';
    const activeModelId = config.activeModel?.model || '';
    const activeModel = models.find(m => m.provider === activeProvider && m.id === activeModelId);
    const displayLabel = activeModel
        ? `${activeModel.provider.toUpperCase()} — ${activeModel.name || activeModel.id}`
        : 'Select a model...';

    if (initLoading) return <div className="text-xs text-muted-foreground">Loading models...</div>;

    return (
        <div className="relative w-full" ref={dropdownRef}>
            {/* Trigger button */}
            <button
                onClick={() => setOpen(o => !o)}
                disabled={loading}
                className="flex items-center justify-between w-full h-9 px-3 rounded-md border border-input bg-background text-sm shadow-sm hover:bg-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                <span className="truncate text-left">{displayLabel}</span>
                <span className="flex items-center gap-1 ml-2 shrink-0">
                    {loading
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        : <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
                    }
                </span>
            </button>

            {/* Dropdown panel */}
            {open && (
                <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg overflow-hidden">
                    {/* Search filter */}
                    <div className="px-2 py-1.5 border-b border-border/60">
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/60">
                            <Search className="h-3 w-3 text-muted-foreground shrink-0" />
                            <input
                                ref={searchRef}
                                type="text"
                                value={searchFilter}
                                onChange={e => setSearchFilter(e.target.value)}
                                placeholder={`Filter ${models.length} models...`}
                                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                                onKeyDown={e => e.key === 'Escape' && setOpen(false)}
                            />
                            {searchFilter && (
                                <button onClick={() => setSearchFilter('')} className="text-muted-foreground hover:text-foreground leading-none">
                                    <span className="text-[10px]">✕</span>
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto py-1">
                        {Object.entries(grouped).map(([provider, providerModels]) => (
                            <div key={provider}>
                                {/* Provider header */}
                                <div className="px-3 py-1.5 flex items-center gap-2 sticky top-0 bg-popover border-b border-border/50">
                                    <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${PROVIDER_COLORS[provider] || 'bg-muted text-muted-foreground'}`}>
                                        {provider}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">{providerModels.length} model{providerModels.length !== 1 ? 's' : ''}</span>
                                </div>
                                {/* Models */}
                                {providerModels.map(model => {
                                    const isActive = model.provider === activeProvider && model.id === activeModelId;
                                    return (
                                        <button
                                            key={`${model.provider}::${model.id}`}
                                            onClick={() => handleSwitch(model)}
                                            className={`w-full flex items-center justify-between px-4 py-2 text-sm text-left hover:bg-accent transition-colors ${isActive ? 'bg-accent/60 font-medium' : ''}`}
                                        >
                                            <span className="truncate">{model.name || model.id}</span>
                                            {isActive && <Check className="h-3.5 w-3.5 text-primary shrink-0 ml-2" />}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                        {filteredModels.length === 0 && (
                            <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                                {searchFilter ? `No models match "${searchFilter}"` : 'No models found'}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
