import { API_BASE } from '@/lib/api';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { HeartbeatConfig } from './HeartbeatConfig';
import { MemoryInspector } from './MemoryInspector';
import { TaskScheduler } from './TaskScheduler';
import { MCPManager } from './MCPManager';
import { OODAInspector } from './OODAInspector';
import { SkillsManager } from './SkillsManager';
import { ActivityFeed } from './ActivityFeed';
import { AutonomousProgress } from './AutonomousProgress';
import { ChatIntegrationPanel } from './ChatIntegrationPanel';
import { DeliverableDownloader } from './DeliverableDownloader';

export function Dashboard() {
    const [health, setHealth] = useState<any>(null);

    useEffect(() => {
        fetch(`${API_BASE}/api/health`)
            .then(res => res.json())
            .then(data => setHealth(data))
            .catch(console.error);
    }, []);

    return (
        <div className="p-8 space-y-8 bg-background min-h-screen text-foreground">
            <h1 className="text-3xl font-bold tracking-tight">AI Partner Dashboard</h1>

            {/* Autonomous Execution Progress (shown when active) */}
            <AutonomousProgress />

            {/* Top Row: Status + Activity */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Status Card */}
                <Card>
                    <CardHeader>
                        <CardTitle>System Status</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2">
                            <div className="flex justify-between">
                                <span>Server</span>
                                <span className="text-green-500 font-medium">{health ? 'Online' : 'Connecting...'}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Mode</span>
                                <span className="text-muted-foreground">{health?.mode || '-'}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Workspace</span>
                                <span className="text-muted-foreground text-xs truncate max-w-32" title={health?.workspace}>
                                    {health?.workspace ? '.../' + health.workspace.split(/[/\\]/).pop() : '-'}
                                </span>
                            </div>
                            <div className="flex justify-between">
                                <span>Last Heartbeat</span>
                                <span>{health?.heartbeat?.lastTick ? new Date(health.heartbeat.lastTick).toLocaleTimeString() : 'None'}</span>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Activity Feed */}
                <ActivityFeed />
            </div>

            {/* Second Row: Heartbeat + OODA */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <HeartbeatConfig />
                <OODAInspector />
            </div>

            {/* Third Row: Tasks and Skills */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <TaskScheduler />
                <SkillsManager />
            </div>

            {/* Fourth Row: MCP and Chat Integrations */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <MCPManager />
                <ChatIntegrationPanel />
            </div>

            {/* Fifth Row: Generated Files */}
            <div className="grid grid-cols-1 gap-6">
                <DeliverableDownloader />
            </div>

            {/* Memory Inspector Section */}
            <div>
                <h2 className="text-2xl font-semibold mb-4">Memory Inspector</h2>
                <MemoryInspector />
            </div>
        </div>
    );
}
