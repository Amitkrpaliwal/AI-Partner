import { MainLayout } from '@/layouts/MainLayout';
import { useEffect, useState } from 'react';
import { initializeSocket } from '@/lib/socket';
import { useStore } from '@/store';
import { useGlobalChatSocket } from '@/hooks/useGlobalChatSocket';
import { LoginPage } from './components/LoginPage';
import { API_BASE } from '@/lib/api';

// Views
import { Dashboard } from './components/Dashboard';
import { ChatArea } from './components/ChatArea';
import { MemoryInspector } from './components/MemoryInspector';
import { TaskScheduler } from './components/TaskScheduler';
import { MCPManager } from './components/MCPManager'; // This serves as "Skills Manager" for now
import { SettingsView } from './components/SettingsView';
import { HITLApproval } from './components/HITLApproval';
import { AutonomousProgress } from './components/AutonomousProgress';
import { GoalProgressPanel } from './components/GoalProgressPanel';
import { KnowledgeBase } from './components/KnowledgeBase';
import { AgentPoolMonitor } from './components/AgentPoolMonitor';
import { ModelRoutingDashboard } from './components/ModelRoutingDashboard';
import { ToolMarketplace } from './components/ToolMarketplace';
import { UsageDashboard } from './components/UsageDashboard';
import { MessagingConfig } from './components/MessagingConfig';
import { LearnedSkillsPanel } from './components/LearnedSkillsPanel';
import { DeliverableDownloader } from './components/DeliverableDownloader';
import { IntegrationsView } from './components/IntegrationsView';
import { ProactiveIntelligence } from './components/ProactiveIntelligence';
import { VoiceMode } from './components/VoiceMode';
import { AgentProfilesPanel } from './components/AgentProfilesPanel';
import { CapabilitiesPanel } from './components/CapabilitiesPanel';
import { SetupWizard } from './components/SetupWizard';

function App() {
  const { currentView, setView, config } = useStore();
  // Global socket handler — registered once, survives all sidebar navigation
  useGlobalChatSocket();
  // Auth state — null = still checking, false = not logged in, true = logged in
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  // Setup wizard state
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [runMode, setRunMode] = useState<string>('docker');

  // Apply dark/light theme class to <html> whenever theme setting changes
  useEffect(() => {
    const root = document.documentElement;
    if (config.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [config.theme]);

  // Check setup status on first load
  useEffect(() => {
    fetch(`${API_BASE}/api/setup/status`)
      .then(res => res.json())
      .then(data => {
        setSetupComplete(data.setupComplete);
        setRunMode(data.runMode || 'docker');
      })
      .catch(() => setSetupComplete(true)); // if endpoint missing, assume setup done
  }, []);

  useEffect(() => {
    initializeSocket();
    // Check if auth is required by the server
    fetch(`${API_BASE}/api/auth/status`)
      .then(res => res.json())
      .then(data => {
        // If auth is disabled server-side, data.authEnabled === false → skip login
        if (!data.authEnabled) {
          setAuthRequired(false);
          setIsAuthenticated(true);
        } else {
          setAuthRequired(true);
          // Try to restore existing token
          const token = localStorage.getItem('auth_token');
          if (token) {
            // Validate token via a light endpoint
            fetch(`${API_BASE}/api/auth/me`, {
              headers: { Authorization: `Bearer ${token}` }
            })
              .then(r => { if (r.ok) setIsAuthenticated(true); })
              .catch(() => { });
          }
        }
      })
      .catch(() => {
        // If endpoint unreachable (e.g. old server without auth), skip auth
        setAuthRequired(false);
        setIsAuthenticated(true);
      });
  }, []);

  const handleLogin = (token: string, _userId: string, _username: string) => {
    localStorage.setItem('auth_token', token);
    setIsAuthenticated(true);
  };

  // Still checking auth or setup status — show nothing
  if (authRequired === null || setupComplete === null) return null;

  // First-run setup wizard — show before anything else
  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} runMode={runMode} />;
  }

  // Auth required but not authenticated — show login
  if (authRequired && !isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <Dashboard />;
      case 'chat': return <ChatArea />;
      case 'memory': return (
        <div className="p-4 h-full overflow-auto">
          <h1 className="text-2xl font-bold mb-4">Memory Inspector</h1>
          <MemoryInspector />
        </div>
      );
      case 'tasks': return (
        <div className="p-4 h-full overflow-auto">
          <h1 className="text-2xl font-bold mb-4">Task Scheduler</h1>
          <TaskScheduler />
        </div>
      );
      case 'skills': return (
        <div className="p-4 h-full overflow-auto">
          <h1 className="text-2xl font-bold mb-4">Skills Manager</h1>
          <MCPManager />
        </div>
      );
      case 'knowledge': return (
        <div className="h-full overflow-auto">
          <h1 className="text-2xl font-bold p-4 pb-0">Knowledge Base</h1>
          <KnowledgeBase />
        </div>
      );
      case 'agents': return (
        <div className="h-full overflow-auto">
          <AgentsTabbedView />
        </div>
      );
      case 'routing': return (
        <div className="h-full overflow-auto">
          <h1 className="text-2xl font-bold p-4 pb-0">Model Routing</h1>
          <ModelRoutingDashboard />
        </div>
      );
      case 'toolMarketplace': return <ToolMarketplace />;
      case 'usage': return <UsageDashboard />;
      case 'messaging': return <MessagingConfig />;
      case 'learnedSkills': return <LearnedSkillsPanel />;
      case 'files': return <DeliverableDownloader />;
      case 'integrations': return <IntegrationsView />;
      case 'proactive': return <ProactiveIntelligence />;
      case 'voice': return <VoiceMode onClose={() => setView('chat')} />;
      case 'capabilities': return <CapabilitiesPanel />;
      case 'setup': return (
        <div className="p-6 h-full overflow-auto">
          <h1 className="text-2xl font-bold mb-4">Re-run Setup Wizard</h1>
          <SetupWizard onComplete={() => setView('dashboard')} runMode={runMode} inline />
        </div>
      );
      case 'settings': return <SettingsView />;
      default: return <Dashboard />;
    }
  };

  return (
    <>
      <MainLayout>
        {renderView()}
      </MainLayout>
      {/* HITL Approval dialog - appears when a plan needs approval */}
      <HITLApproval />
      {/* Autonomous Progress - shows real-time step-by-step execution */}
      <AutonomousProgress />
      {/* Goal-Oriented Progress - shows goal execution with success criteria */}
      <GoalProgressPanel />
    </>
  );
}
// ─── Agents Tabbed View ───────────────────────────────────────────────────────
function AgentsTabbedView() {
  const [agentsTab, setAgentsTab] = useState<'pool' | 'profiles'>('pool');
  const { setActiveAgent, setView } = useStore();

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agents</h1>
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {(['pool', 'profiles'] as const).map(t => (
            <button
              key={t}
              onClick={() => setAgentsTab(t)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${agentsTab === t ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {t === 'pool' ? '🤖 Pool Monitor' : '🧠 Profiles'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {agentsTab === 'pool' ? <AgentPoolMonitor /> : (
          <AgentProfilesPanel
            onSelectProfile={(profile) => {
              if (profile) {
                setActiveAgent({ slug: profile.slug, name: profile.name, avatarColor: profile.avatarColor });
                setView('chat');
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

export default App;