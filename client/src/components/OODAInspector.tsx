import { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { useStore } from '../store';

const phaseColors: Record<string, string> = {
    OBSERVE: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
    ORIENT: 'bg-purple-500/20 text-purple-400 border-purple-500/40',
    DECIDE: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
    ACT: 'bg-green-500/20 text-green-400 border-green-500/40',
    REFLECT: 'bg-gray-500/20 text-gray-400 border-gray-500/40'
};

const phaseIcons: Record<string, string> = {
    OBSERVE: '👁️',
    ORIENT: '🧭',
    DECIDE: '🎯',
    ACT: '⚡',
    REFLECT: '💭'
};

export function OODAInspector() {
    const oodaLogs = useStore(state => state.oodaLogs);
    const clearOODALogs = useStore(state => state.clearOODALogs);
    const debugMode = useStore(state => state.debugMode);
    const toggleDebugMode = useStore(state => state.toggleDebugMode);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to top when new events arrive (logs are prepended)
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = 0;
        }
    }, [oodaLogs.length]);

    const formatTime = (iso: string) => {
        return new Date(iso).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    return (
        <Card className="h-full flex flex-col">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                    <span className="text-lg">🧠 Agent Reasoning</span>
                    {debugMode && (
                        <span className="flex items-center gap-1 text-xs text-green-400">
                            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                            Debug
                        </span>
                    )}
                </CardTitle>
                <div className="flex gap-2">
                    <button
                        onClick={toggleDebugMode}
                        className={`px-2 py-1 text-xs rounded ${debugMode ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                            }`}
                    >
                        {debugMode ? 'Debug On' : 'Debug Off'}
                    </button>
                    <button
                        onClick={clearOODALogs}
                        className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                    >
                        Clear
                    </button>
                </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0">
                <div
                    ref={scrollRef}
                    className="h-full overflow-y-auto p-4 space-y-2"
                    style={{ maxHeight: '400px' }}
                >
                    {oodaLogs.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            <p className="text-sm">Waiting for agent activity...</p>
                            <p className="text-xs mt-2">OODA events will appear here in real-time</p>
                        </div>
                    ) : (
                        oodaLogs.map((event, index) => (
                            <div
                                key={`${event.timestamp}-${index}`}
                                className={`flex items-start gap-3 p-3 rounded-lg border ${phaseColors[event.phase] || 'bg-gray-500/20'}`}
                            >
                                <span className="text-xl" title={event.phase}>
                                    {phaseIcons[event.phase] || '📝'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-xs font-semibold uppercase tracking-wide">
                                            {event.phase}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {formatTime(event.timestamp)}
                                        </span>
                                    </div>
                                    <p className="text-sm break-words">
                                        {event.message}
                                    </p>
                                    {event.details && debugMode && (
                                        <details className="mt-2">
                                            <summary className="text-xs cursor-pointer text-muted-foreground hover:text-foreground">
                                                Show details
                                            </summary>
                                            <pre className="mt-1 p-2 text-xs bg-black/20 rounded overflow-x-auto">
                                                {JSON.stringify(event.details, null, 2)}
                                            </pre>
                                        </details>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
