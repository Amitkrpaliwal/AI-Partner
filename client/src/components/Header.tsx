import { Moon, Sun, Menu, ChevronDown, Network, Settings as SettingsIcon } from 'lucide-react';

import { useStore } from '@/store';

export function Header() {
  const { config, updateConfig } = useStore();
  const { activeModel } = config;

  const toggleTheme = () => {
    updateConfig('theme', config.theme === 'dark' ? 'light' : 'dark');
  };

  return (
    <header className="h-12 border-b border-border bg-card flex items-center justify-between px-4 select-none">
      {/* ... (Left & Center remain same) ... */}
      <div className="flex items-center space-x-2">
        <Menu className="w-5 h-5 text-muted-foreground cursor-pointer" />
        <img src="/logo.png" alt="AI Partner" className="w-6 h-6 rounded-md object-cover" />
        <span className="font-semibold text-sm">AI Partner</span>
      </div>

      <div className="flex items-center space-x-2 bg-accent/30 px-3 py-1.5 rounded-md cursor-pointer hover:bg-accent/50 transition-colors">
        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
        <span className="text-sm font-medium truncate max-w-[200px]">
          {activeModel?.model || 'Unknown'} ({activeModel?.provider || 'Offline'})
        </span>
        <ChevronDown className="w-4 h-4 opacity-50" />
      </div>

      {/* Right: Controls */}
      <div className="flex items-center space-x-2">
        <div className="hidden md:flex items-center space-x-1 px-2 py-1 bg-blue-500/10 text-blue-500 rounded text-xs font-medium">
          <Network className="w-3 h-3" />
          <span>MCP: 2 active</span>
        </div>

        <button
          className="p-2 hover:bg-accent rounded-md text-muted-foreground"
          title="Settings"
          onClick={() => useStore.getState().setView('settings')}
        >
          {/* We could use the icon from lucide-react if imported */}
          <span className="sr-only">Settings</span>
          <SettingsIcon className="w-5 h-5" />
        </button>

        <button
          className="p-2 hover:bg-accent rounded-md text-muted-foreground"
          title={config.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggleTheme}
        >
          {config.theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </div>
    </header>
  );
}