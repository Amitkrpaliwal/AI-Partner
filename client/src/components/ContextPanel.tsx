import { API_BASE } from '@/lib/api';
import { useEffect, useState } from 'react';
import { User, Clock, CheckCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface Persona {
    name: string;
    role: string;
    preferences: Record<string, any>;
}

interface Event {
    event_text: string;
    timestamp: string;
}

interface Task {
    id: string;
    name: string;
    next_run: string;
}

export function ContextPanel() {
    const [persona, setPersona] = useState<Persona | null>(null);
    const [events, setEvents] = useState<Event[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch Persona
                const pRes = await fetch(`${API_BASE}/api/memory/persona`);
                if (pRes.ok) setPersona(await pRes.json());

                // Fetch Events
                const eRes = await fetch(`${API_BASE}/api/memory/events?limit=5`);
                if (eRes.ok) {
                    const data = await eRes.json();
                    setEvents(Array.isArray(data) ? data : (data.events || []));
                }

                // Fetch Tasks
                const tRes = await fetch(`${API_BASE}/api/tasks`);
                if (tRes.ok) {
                    const data = await tRes.json();
                    setTasks(Array.isArray(data) ? data : (data.tasks || []));
                }
            } catch (e) {
                console.error("Failed to load context data", e);
            }
        };

        fetchData();
        // Refresh every minute
        const interval = setInterval(fetchData, 60000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="h-full flex flex-col gap-4 p-4 border-l border-border bg-muted/10 overflow-y-auto w-80">
            <h2 className="text-sm font-bold uppercase text-muted-foreground tracking-wider mb-2">
                Unified Context
            </h2>

            {/* Persona Card */}
            <Card className="shadow-none border-border/50 bg-card/50">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center">
                        <User className="w-4 h-4 mr-2 text-primary" />
                        Persona
                    </CardTitle>
                </CardHeader>
                <CardContent className="text-xs space-y-2">
                    {persona ? (
                        <>
                            <div className="font-semibold text-foreground">{persona.name}</div>
                            <div className="text-muted-foreground">{persona.role}</div>
                            <div className="mt-2 pt-2 border-t border-border/50">
                                <div className="font-medium mb-1">Preferences:</div>
                                <div className="space-y-1">
                                    {Object.entries(persona.preferences || {}).slice(0, 3).map(([k, v]) => (
                                        <div key={k} className="flex justify-between">
                                            <span className="text-muted-foreground">{k}:</span>
                                            <span>{String(v)}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    ) : (
                        <span className="italic text-muted-foreground">Loading...</span>
                    )}
                </CardContent>
            </Card>

            {/* Recent Events */}
            <Card className="shadow-none border-border/50 bg-card/50">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center">
                        <Clock className="w-4 h-4 mr-2 text-blue-500" />
                        Recent Memory
                    </CardTitle>
                </CardHeader>
                <CardContent className="text-xs space-y-2">
                    {events.length === 0 ? (
                        <div className="text-muted-foreground italic">No recent events</div>
                    ) : (
                        events.map((e, i) => (
                            <div key={i} className="flex gap-2 items-start opacity-80 hover:opacity-100 transition-opacity">
                                <div className="min-w-[4px] min-h-[4px] mt-1.5 rounded-full bg-blue-400" />
                                <div>
                                    <div className="line-clamp-2">{e.event_text}</div>
                                    <div className="text-[10px] text-muted-foreground/70">
                                        {new Date(e.timestamp).toLocaleTimeString()}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>

            {/* Active Tasks */}
            <Card className="shadow-none border-border/50 bg-card/50">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center">
                        <CheckCircle className="w-4 h-4 mr-2 text-green-500" />
                        Active Tasks
                    </CardTitle>
                </CardHeader>
                <CardContent className="text-xs space-y-2">
                    {tasks.length === 0 ? (
                        <div className="text-muted-foreground italic">No scheduled tasks</div>
                    ) : (
                        tasks.slice(0, 3).map(t => (
                            <div key={t.id} className="flex justify-between items-center border-b border-border/50 pb-1 last:border-0 last:pb-0">
                                <span className="font-medium truncate max-w-[120px]" title={t.name}>{t.name}</span>
                                <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded text-secondary-foreground">
                                    {new Date(t.next_run).toLocaleDateString(undefined, { weekday: 'short' })}
                                </span>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
