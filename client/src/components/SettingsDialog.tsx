import { API_BASE } from '@/lib/api';
import { X, Settings, Brain, Plus, Save } from 'lucide-react';
import * as _Dialog from '@radix-ui/react-dialog';
const Dialog = _Dialog as any;
import { useState, useEffect } from 'react';
import { useStore } from '@/store';
import { ModelSwitcher } from './ModelSwitcher';

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const { coreMemory, fetchCoreMemory } = useStore();

  // New Memory State
  const [newMemCategory, setNewMemCategory] = useState('userPreferences');
  const [newMemKey, setNewMemKey] = useState('');
  const [newMemValue, setNewMemValue] = useState('');

  useEffect(() => {
    if (open) {
      fetchCoreMemory();
    }
  }, [open, fetchCoreMemory]);

  const handleAddMemory = async () => {
    if (!newMemKey || !newMemValue) return;

    try {
      await fetch(`${API_BASE}/api/memory/core`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: newMemCategory,
          key: newMemKey,
          value: newMemValue
        })
      });

      // Refresh global store
      fetchCoreMemory();

      setNewMemKey('');
      setNewMemValue('');
    } catch (e) {
      console.error('Failed to save memory', e);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="p-2 hover:bg-accent rounded-md text-muted-foreground" title="Settings">
          <Settings className="w-5 h-5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] bg-card rounded-lg border border-border shadow-xl p-6 max-h-[85vh] overflow-y-auto z-50">
          <div className="flex justify-between items-center mb-6">
            <Dialog.Title className="text-lg font-semibold flex items-center">
              <Settings className="w-5 h-5 mr-2" />
              Settings
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="p-1 hover:bg-accent rounded-full">
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-8">
            {/* System Config */}
            <SystemConfigSection />

            {/* Model Selection */}
            <section>
              <label className="text-sm font-bold uppercase text-muted-foreground mb-3 block">LLM Provider</label>
              <ModelSwitcher />
              <div className="mt-2 text-xs text-muted-foreground">
                Ensure your local provider (Ollama/LM Studio) is running.
              </div>
            </section>

            {/* Core Memory Management */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center">
                  <Brain className="w-4 h-4 mr-2 text-blue-500" />
                  <label className="text-sm font-bold uppercase text-muted-foreground">Core Memory (Global)</label>
                </div>
              </div>

              {/* List */}
              <div className="bg-accent/20 rounded-md p-3 max-h-40 overflow-y-auto text-xs font-mono border border-border mb-3">
                {(!coreMemory.userPreferences || Object.keys(coreMemory.userPreferences).length === 0) ? (
                  <span className="text-muted-foreground italic">No memory stored yet.</span>
                ) : (
                  Object.entries(coreMemory?.userPreferences || {}).map(([k, v]) => (
                    <div key={k} className="mb-1 pb-1 border-b border-border/50 last:border-0 flex justify-between items-center group">
                      <div>
                        <span className="text-blue-400 font-bold">Preferences</span>
                        <span className="mx-1 text-muted-foreground">::</span>
                        <span className="text-yellow-600 dark:text-yellow-400">{k}</span>
                        <span className="mx-1">=</span>
                        <span className="text-foreground">{String(v)}</span>
                      </div>
                      <button
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/10 text-destructive rounded"
                        onClick={async () => {
                          await fetch(`${API_BASE}/api/memory/core`, {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ category: 'userPreferences', key: k })
                          });
                          fetchCoreMemory();
                        }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Add New */}
              <div className="grid grid-cols-3 gap-2">
                <select
                  className="bg-input border border-border rounded text-xs px-2 py-1"
                  value={newMemCategory}
                  onChange={(e) => setNewMemCategory(e.target.value)}
                >
                  <option value="userPreferences">Preferences</option>
                  <option value="projectConstraints">Constraints</option>
                </select>
                <input
                  placeholder="Key (e.g. 'language')"
                  className="bg-input border border-border rounded text-xs px-2 py-1"
                  value={newMemKey}
                  onChange={(e) => setNewMemKey(e.target.value)}
                />
                <input
                  placeholder="Value (e.g. 'TypeScript')"
                  className="bg-input border border-border rounded text-xs px-2 py-1"
                  value={newMemValue}
                  onChange={(e) => setNewMemValue(e.target.value)}
                />
              </div>
              <button
                onClick={handleAddMemory}
                className="mt-2 w-full flex items-center justify-center px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded text-xs font-medium transition-colors"
              >
                <Plus className="w-3 h-3 mr-1" /> Add Fact
              </button>
            </section>
          </div>

          <div className="mt-8 flex justify-end">
            <Dialog.Close asChild>
              <button
                className="flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
              >
                <Save className="w-4 h-4 mr-2" />
                Done
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const APPROVAL_OPTS = [
  { value: 'none',   dot: 'bg-green-500',  label: '🟢 Autonomous' },
  { value: 'script', dot: 'bg-yellow-500', label: '🟡 Script Review' },
  { value: 'all',    dot: 'bg-red-500',    label: '🔴 Manual' },
] as const;

function SystemConfigSection() {
  const [systemPrompt, setSystemPrompt] = useState('Loading...');
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [activeStart, setActiveStart] = useState('09:00');
  const [activeEnd, setActiveEnd] = useState('22:00');
  const [approvalMode, setApprovalMode] = useState<'none' | 'script' | 'all'>('script');

  useEffect(() => {
    fetch(`${API_BASE}/api/config`)
      .then(res => res.json())
      .then(data => {
        setSystemPrompt(data.systemPrompt);
        setMcpEnabled(data.mcpEnabled);
        if (data.activeHours) {
          setActiveStart(data.activeHours.start);
          setActiveEnd(data.activeHours.end);
        }
        if (data.execution?.approval_mode) {
          setApprovalMode(data.execution.approval_mode);
        }
      })
      .catch(console.error);
  }, []);

  const handleSave = async () => {
    try {
      await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt,
          mcpEnabled,
          activeHours: { start: activeStart, end: activeEnd },
          execution: { approval_mode: approvalMode }
        })
      });
      alert('Configuration Saved!');
    } catch (e) {
      console.error(e);
      alert('Failed to save config');
    }
  };

  return (
    <section>
      <label className="text-sm font-bold uppercase text-muted-foreground mb-3 block">System Configuration</label>
      <div className="space-y-4">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">System Prompt</label>
          <textarea
            className="w-full h-24 p-2 text-xs bg-input border border-border rounded resize-none"
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Active Start</label>
            <input
              type="time"
              className="bg-input border border-border rounded text-xs px-2 py-1 w-full"
              value={activeStart}
              onChange={e => setActiveStart(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Active End</label>
            <input
              type="time"
              className="bg-input border border-border rounded text-xs px-2 py-1 w-full"
              value={activeEnd}
              onChange={e => setActiveEnd(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <input
            type="checkbox"
            id="mcpParams"
            checked={mcpEnabled}
            onChange={e => setMcpEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
          />
          <label htmlFor="mcpParams" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
            Enable MCP Tools
          </label>
        </div>

        {/* Approval Mode — 3-stop segmented control */}
        <div>
          <label className="text-xs text-muted-foreground block mb-2">Approval Mode</label>
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {APPROVAL_OPTS.map((opt, i) => (
              <button
                key={opt.value}
                onClick={() => setApprovalMode(opt.value)}
                className={`flex-1 py-1.5 px-2 transition-colors ${i > 0 ? 'border-l border-border' : ''} ${approvalMode === opt.value ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted/60 text-muted-foreground'}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {approvalMode === 'none'   && 'Agent runs end-to-end without pausing'}
            {approvalMode === 'script' && 'Scripts pause for review; other tools run freely'}
            {approvalMode === 'all'    && 'Every write/command waits · auto-denies after 60s'}
          </p>
        </div>

        <button onClick={handleSave} className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded">
          Update Config
        </button>
      </div>
    </section>
  );
}
