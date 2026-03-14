import { API_BASE } from '@/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Network, Search } from 'lucide-react';

export function ModelRoutingDashboard() {
    const [providers, setProviders] = useState<string[]>([]);
    const [testQuery, setTestQuery] = useState('');
    const [routingResult, setRoutingResult] = useState<{ query?: string; classified_as: string } | null>(null);

    useEffect(() => {
        loadProviders();
    }, []);

    const loadProviders = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/models/providers`);
            const data = await res.json();
            // API returns { providers: string[], active_provider, active_model }
            setProviders(data.providers || []);
        } catch (e) {
            console.error('Failed to load providers:', e);
            setProviders([]);
        }
    };

    const testRouting = async () => {
        if (!testQuery.trim()) return;

        try {
            const res = await fetch(`${API_BASE}/api/models/routing?query=${encodeURIComponent(testQuery)}`);
            const data = await res.json();
            setRoutingResult(data);
        } catch (e) {
            console.error('Routing test failed:', e);
        }
    };

    const taskTypes = [
        { type: 'classification', description: 'Simple classification or routing decisions' },
        { type: 'code_generation', description: 'Writing code or complex logic' },
        { type: 'reasoning', description: 'Deep analysis and problem-solving' },
        { type: 'embedding', description: 'Generating vector embeddings' },
        { type: 'chat', description: 'Conversational responses' },
        { type: 'summarization', description: 'Text summarization and compression' }
    ];

    return (
        <div className="p-4 space-y-4 h-full overflow-auto">
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Network className="w-5 h-5" />
                        Smart Model Routing
                    </CardTitle>
                    <CardDescription>
                        Automatically routes different tasks to optimal models based on complexity
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 gap-4">
                        {taskTypes.map(({ type, description }) => (
                            <div key={type} className="border rounded-lg p-3">
                                <p className="font-medium text-sm">{type}</p>
                                <p className="text-xs text-muted-foreground mt-1">{description}</p>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Available Providers</CardTitle>
                </CardHeader>
                <CardContent>
                    {providers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Loading providers...</p>
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            {providers.map((provider) => (
                                <div key={provider} className="border rounded-lg px-3 py-2">
                                    <p className="font-medium text-sm">{provider}</p>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Search className="w-5 h-5" />
                        Test Routing
                    </CardTitle>
                    <CardDescription>
                        Enter a prompt to see how it would be routed
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex gap-2">
                        <Input
                            placeholder="Enter a test prompt..."
                            value={testQuery}
                            onChange={(e) => setTestQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && testRouting()}
                        />
                        <Button onClick={testRouting} disabled={!testQuery.trim()}>
                            <Search className="w-4 h-4" />
                        </Button>
                    </div>

                    {routingResult && (
                        <div className="border rounded-lg p-4 space-y-2 bg-muted/50">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <p className="text-xs text-muted-foreground">Query</p>
                                    <p className="font-medium text-sm">{routingResult.query || testQuery}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Classified As</p>
                                    <p className="font-medium">{routingResult.classified_as}</p>
                                </div>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
