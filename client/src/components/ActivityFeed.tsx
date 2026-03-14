import { API_BASE } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

interface ActivityEvent {
    id: string;
    type: string;
    text: string;
    timestamp: string;
}

const MAX_EVENTS = 10;

export function ActivityFeed() {
    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Initial load from REST
        const fetchEvents = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/memory/events?limit=${MAX_EVENTS}`);
                const data = await res.json();
                setEvents(data.events?.map((e: any) => ({
                    id: e.id,
                    type: e.event_type,
                    text: e.event_text,
                    timestamp: e.timestamp
                })) || []);
            } catch (e) {
                console.error('Failed to fetch events:', e);
            } finally {
                setLoading(false);
            }
        };

        fetchEvents();

        // Real-time push — prepend new events and keep list at MAX_EVENTS
        const socket = getSocket();
        const onEventNew = (event: ActivityEvent) => {
            setEvents(prev => [event, ...prev].slice(0, MAX_EVENTS));
        };
        socket.on('event:new', onEventNew);

        return () => {
            socket.off('event:new', onEventNew);
        };
    }, []);

    const typeIcons: Record<string, string> = {
        conversation: '💬',
        task_execution: '⚡',
        decision: '🎯',
        learning: '📚',
        action: '⚙️'
    };

    const typeColors: Record<string, string> = {
        conversation: 'border-l-blue-500',
        task_execution: 'border-l-green-500',
        decision: 'border-l-amber-500',
        learning: 'border-l-purple-500',
        action: 'border-l-cyan-500'
    };

    const formatTime = (iso: string) => {
        const date = new Date(iso);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
        return date.toLocaleDateString();
    };

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-lg">
                    <span>🔥 Recent Activity</span>
                </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
                {loading ? (
                    <div className="p-4 text-center text-muted-foreground">
                        Loading...
                    </div>
                ) : events.length === 0 ? (
                    <div className="p-4 text-center text-muted-foreground">
                        No recent activity
                    </div>
                ) : (
                    <div className="divide-y divide-border">
                        {events.map(event => (
                            <div
                                key={event.id}
                                className={`flex items-start gap-3 p-3 border-l-2 ${typeColors[event.type] || 'border-l-gray-500'}`}
                            >
                                <span className="text-lg flex-shrink-0">
                                    {typeIcons[event.type] || '📋'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm line-clamp-2">
                                        {event.text}
                                    </p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-xs text-muted-foreground capitalize">
                                            {event.type.replace('_', ' ')}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            · {formatTime(event.timestamp)}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
