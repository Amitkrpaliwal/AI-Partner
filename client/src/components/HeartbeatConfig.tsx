import { API_BASE } from '@/lib/api';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface HeartbeatConfig {
    enabled: boolean;
    interval: string;
    activeHours: { start: string; end: string };
}

export function HeartbeatConfig() {
    const [config, setConfig] = useState<HeartbeatConfig | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        fetchConfig();
    }, []);

    const fetchConfig = async () => {
        const res = await fetch(`${API_BASE}/api/heartbeat/status`);
        const data = await res.json();
        setConfig({
            enabled: data.enabled,
            interval: data.interval,
            activeHours: { start: '09:00', end: '22:00' } // Mock if missing from status
        });
    };

    const updateConfig = async (newConfig: Partial<HeartbeatConfig>) => {
        setLoading(true);
        try {
            await fetch(`${API_BASE}/api/heartbeat/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newConfig),
            });
            await fetchConfig();
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const triggerHeartbeat = async () => {
        setLoading(true);
        await fetch(`${API_BASE}/api/heartbeat/trigger`, { method: 'POST' });
        setLoading(false);
    };

    if (!config) return <div>Loading config...</div>;

    return (
        <Card className="w-full max-w-md">
            <CardHeader>
                <CardTitle>Heartbeat Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                    <span>Proactive Checks</span>
                    <Button
                        variant={config.enabled ? "default" : "secondary"}
                        onClick={() => updateConfig({ enabled: !config.enabled })}
                    >
                        {config.enabled ? 'Enabled' : 'Disabled'}
                    </Button>
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-medium">Interval</label>
                    <div className="flex gap-2">
                        {(['15m', '30m', '1h', '24h'] as const).map(int => (
                            <Button
                                key={int}
                                variant={config.interval === int ? "default" : "outline"}
                                size="sm"
                                onClick={() => updateConfig({ interval: int })}
                            >
                                {int}
                            </Button>
                        ))}
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-medium">Active Hours</label>
                    <div className="flex gap-2">
                        <Input
                            type="time"
                            value={config.activeHours.start}
                            onChange={(e) => updateConfig({ activeHours: { ...config.activeHours, start: e.target.value } })}
                        />
                        <span className="self-center">to</span>
                        <Input
                            type="time"
                            value={config.activeHours.end}
                            onChange={(e) => updateConfig({ activeHours: { ...config.activeHours, end: e.target.value } })}
                        />
                    </div>
                </div>

                <Button className="w-full mt-4" variant="secondary" disabled={loading} onClick={triggerHeartbeat}>
                    Trigger Manual Check
                </Button>
            </CardContent>
        </Card>
    );
}
