import { API_BASE } from '@/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Lock, User, AlertCircle } from 'lucide-react';

interface LoginPageProps {
    onLogin: (token: string, userId: string, username: string) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [isSetup, setIsSetup] = useState(false);
    const [checkingStatus, setCheckingStatus] = useState(true);

    useEffect(() => {
        checkAuthStatus();
    }, []);

    const checkAuthStatus = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/auth/status`);
            if (res.ok) {
                const data = await res.json();
                setIsSetup(data.requiresSetup);
            }
        } catch (e) {
            console.error('Failed to check auth status:', e);
        } finally {
            setCheckingStatus(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!username || !password) return;

        setLoading(true);
        setError('');

        try {
            const endpoint = isSetup ? '/api/auth/register' : '/api/auth/login';
            const res = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password }),
            });

            const data = await res.json();

            if (res.ok && data.success) {
                onLogin(data.token, data.userId, data.username);
            } else {
                setError(data.error || 'Authentication failed');
            }
        } catch (e: any) {
            setError('Connection failed. Is the server running?');
        } finally {
            setLoading(false);
        }
    };

    if (checkingStatus) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-background">
                <p className="text-muted-foreground">Checking authentication status...</p>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center min-h-screen bg-background">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <CardTitle className="flex items-center justify-center gap-2 text-2xl">
                        <Lock className="w-6 h-6" />
                        AI Partner
                    </CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                        {isSetup
                            ? 'Create your admin account to get started'
                            : 'Sign in to continue'
                        }
                    </p>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {error && (
                            <div className="flex items-center gap-2 text-sm text-red-500 bg-red-500/10 p-3 rounded-lg">
                                <AlertCircle className="w-4 h-4 shrink-0" />
                                {error}
                            </div>
                        )}

                        <div className="space-y-2">
                            <label className="text-sm font-medium">Username</label>
                            <div className="relative">
                                <User className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                                <Input
                                    type="text"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    placeholder="Enter username"
                                    className="pl-10"
                                    autoFocus
                                    autoComplete="username"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium">Password</label>
                            <div className="relative">
                                <Lock className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder={isSetup ? 'Choose a password (6+ chars)' : 'Enter password'}
                                    className="pl-10"
                                    autoComplete={isSetup ? 'new-password' : 'current-password'}
                                />
                            </div>
                        </div>

                        <Button type="submit" className="w-full" disabled={loading || !username || !password}>
                            {loading ? 'Please wait...' : isSetup ? 'Create Account' : 'Sign In'}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
