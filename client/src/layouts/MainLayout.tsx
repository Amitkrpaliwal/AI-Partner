import { API_BASE } from '@/lib/api';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { ChatArea } from '@/components/ChatArea';
import { Inspector } from '@/components/Inspector';
import { ErrorReflectionModal } from '@/components/ErrorReflectionModal';
import { useEffect } from 'react';
import { useStore } from '@/store';

export function MainLayout({ children }: { children?: React.ReactNode }) {
  const { updateConfig } = useStore();

  useEffect(() => {
    // Sync active model from backend on startup
    fetch(`${API_BASE}/api/models`)
      .then(res => res.json())
      .then(data => {
        if (data.active) {
          updateConfig('activeModel', data.active);
        }
      })
      .catch(console.error);
  }, []);

  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground overflow-hidden">
      {/* Top Navigation */}
      <Header />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar (Workspace) */}
        <Sidebar />

        {/* Center Chat or Dashboard */}
        <main className="flex-1 relative overflow-auto min-w-0">
          {children || <ChatArea />}
        </main>

        {/* Right Sidebar (Inspector) */}
        <Inspector />
      </div>

      {/* Global Modals */}
      <ErrorReflectionModal />
    </div>
  );
}