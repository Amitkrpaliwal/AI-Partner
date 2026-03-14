import { API_BASE } from '@/lib/api';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';

interface ServerStatus {
    name: string;
    status: string;
}

interface Tool {
    server: string;
    tool: {
        name: string;
        description?: string;
        inputSchema: any;
    };
}

export function MCPManager() {
    const [servers, setServers] = useState<ServerStatus[]>([]);
    const [tools, setTools] = useState<Tool[]>([]);
    const [loading, _setLoading] = useState(false);

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            const sRes = await fetch(`${API_BASE}/api/mcp/servers`);
            const sData = await sRes.json();
            setServers(sData.servers || []);

            const tRes = await fetch(`${API_BASE}/api/mcp/tools`);
            const tData = await tRes.json();
            setTools(tData.tools || []);
        } catch (e) {
            console.error(e);
        }
    };

    return (
        <Card className="w-full">
            <CardHeader>
                <CardTitle>Model Context Protocol (MCP)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Servers List */}
                <div className="space-y-2">
                    <h3 className="font-semibold text-sm">Connected Servers</h3>
                    <div className="grid gap-2">
                        {servers.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No servers connected.</p>
                        ) : (
                            servers.map(s => (
                                <div key={s.name} className="flex items-center justify-between p-2 pb-2 border rounded-md bg-muted/20">
                                    <span className="font-medium">{s.name}</span>
                                    <span className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded-full">{s.status}</span>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Tools List */}
                <div className="space-y-2">
                    <div className="flex justify-between items-center">
                        <h3 className="font-semibold text-sm">Available Tools</h3>
                        <Button size="sm" variant="outline" onClick={fetchData} disabled={loading}>
                            Refresh
                        </Button>
                    </div>

                    <div className="border rounded-md max-h-[300px] overflow-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b bg-muted/50">
                                    <th className="h-8 px-4 text-left font-medium">Server</th>
                                    <th className="h-8 px-4 text-left font-medium">Tool</th>
                                    <th className="h-8 px-4 text-left font-medium">Description</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tools.length === 0 ? (
                                    <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">No tools found</td></tr>
                                ) : (
                                    tools.map((t, i) => (
                                        <tr key={i} className="border-b last:border-0">
                                            <td className="p-2 px-4 text-muted-foreground">{t.server}</td>
                                            <td className="p-2 px-4 font-mono text-xs">{t.tool.name}</td>
                                            <td className="p-2 px-4 text-muted-foreground truncate max-w-[200px]">{t.tool.description}</td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
