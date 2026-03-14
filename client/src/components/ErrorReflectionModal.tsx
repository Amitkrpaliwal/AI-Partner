
import { AlertTriangle, X, RefreshCw } from 'lucide-react';
import { useStore } from '@/store';
import { useEffect, useState } from 'react';

export function ErrorReflectionModal() {
    const { activeError, clearError } = useStore();
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (activeError) {
            setIsVisible(true);
        }
    }, [activeError]);

    if (!activeError || !isVisible) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-background border border-border w-full max-w-lg rounded-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 leading-normal">

                {/* Header */}
                <div className="bg-destructive/10 border-b border-destructive/20 p-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-destructive font-semibold">
                        <AlertTriangle className="h-5 w-5" />
                        <span>Plan Execution Issue</span>
                    </div>
                    <button
                        onClick={clearError}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 space-y-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Error Details</label>
                        <div className="p-3 bg-red-500/5 border border-red-500/20 rounded text-sm text-red-500 font-mono break-words">
                            {activeError.message}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">AI Reflection & Analysis</label>
                        <div className="bg-accent/50 rounded-lg p-3 max-h-48 overflow-y-auto space-y-2 text-sm border border-border">
                            {activeError.analysis.length === 0 && (
                                <div className="flex items-center text-muted-foreground italic">
                                    <RefreshCw className="h-3 w-3 mr-2 animate-spin" />
                                    Analyzing root cause...
                                </div>
                            )}
                            {activeError.analysis.map((line, i) => (
                                <div key={i} className="flex gap-2">
                                    <span className="text-blue-500 font-mono">Step {i + 1}:</span>
                                    <span className="text-foreground/90">{line}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 bg-muted/30 border-t border-border flex justify-end gap-2">
                    <button
                        onClick={clearError}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 font-medium text-sm"
                    >
                        Acknowledge & Continue
                    </button>
                </div>

            </div>
        </div>
    );
}
