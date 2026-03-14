import { Brain, Activity, Database, CheckSquare, Search, User, Clock, CheckCircle, Globe, MousePointer, RefreshCw, StopCircle, ChevronRight, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { EditMemoryModal } from './EditMemoryModal';
import { API_BASE } from '@/lib/api';
import { getSocket } from '@/lib/socket';

export function Inspector() {
  const {
    oodaLogs,
    debugMode,
    toggleDebugMode,
    coreMemory,
    fetchCoreMemory,
    conversations,
    activeConversationId,
    config,
  } = useStore();

  // Estimate token usage from active conversation messages (4 chars ≈ 1 token)
  const tokenUsage = useMemo(() => {
    const conv = activeConversationId ? conversations.get(activeConversationId) : null;
    const msgs = conv?.messages ?? [];
    const totalChars = msgs.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const estimated = Math.round(totalChars / 4);
    // Context limit varies by model; use 32K for cloud models, 8K for local
    const isCloud = config.activeModel?.provider?.toLowerCase().includes('openai') ||
                    config.activeModel?.provider?.toLowerCase().includes('anthropic') ||
                    config.activeModel?.provider?.toLowerCase().includes('cloud');
    const limit = isCloud ? 32000 : 8000;
    return { current: estimated, limit };
  }, [conversations, activeConversationId, config.activeModel]);

  const [isMemoryModalOpen, setIsMemoryModalOpen] = useState(false);

  // Browser live preview + human-control state
  const [browserScreenshot, setBrowserScreenshot] = useState<{ base64: string; mimeType: string; url: string; iteration: number; cursor?: { xRatio: number; yRatio: number } } | null>(null);
  const [browserControlActive, setBrowserControlActive] = useState(false);
  const [browserActive, setBrowserActive] = useState(false);   // true from browser:started until dismissed
  const [browserBlocked, setBrowserBlocked] = useState<{ blockType: string; message: string } | null>(null);
  const browserImgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const socket = getSocket();
    // Server already caps at 15fps; client throttle is a safety net for slow renders.
    // Manual screenshots (iteration >= 0) and user-control frames pass through immediately.
    let lastFrameTs = 0;
    const LIVE_FRAME_INTERVAL = 66; // ms — matches server 15fps cap
    const onShot = (data: any) => {
      if (!data.base64) return;
      const now = Date.now();
      if (data.isLive && now - lastFrameTs < LIVE_FRAME_INTERVAL) return;
      lastFrameTs = now;
      setBrowserActive(true);
      setBrowserScreenshot({ base64: data.base64, mimeType: data.mimeType || 'image/png', url: data.url || '', iteration: data.iteration ?? 0, cursor: data.cursor });
      setBrowserBlocked(null); // clear block alert when new screenshot arrives
    };
    const onStarted = () => { setBrowserActive(true); };
    const onBlocked = (data: any) => {
      setBrowserBlocked({ blockType: data.blockType, message: data.message });
      setBrowserControlActive(true); // mirror server-side auto-pause
    };
    const onGranted = () => setBrowserControlActive(true);
    const onReleased = () => { setBrowserControlActive(false); setBrowserBlocked(null); };
    socket.on('browser:screenshot', onShot);
    socket.on('browser:started', onStarted);
    socket.on('browser:blocked', onBlocked);
    socket.on('browser:control_granted', onGranted);
    socket.on('browser:control_released', onReleased);
    return () => {
      socket.off('browser:screenshot', onShot);
      socket.off('browser:started', onStarted);
      socket.off('browser:blocked', onBlocked);
      socket.off('browser:control_granted', onGranted);
      socket.off('browser:control_released', onReleased);
    };
  }, []);

  const popupRef = useRef<Window | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);

  const handleTakeControl = useCallback(() => {
    // Open full-size popup — autoControl=true grants control immediately (user explicitly clicked)
    const popup = window.open(
      '?popup=browser-control&autoControl=true',
      'browser-control',
      'width=1600,height=1000,toolbar=no,menubar=no,scrollbars=no,resizable=yes'
    );
    if (popup) {
      popupRef.current = popup;
      setPopupOpen(true);
      // When popup closes, ensure control is released back to agent
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          getSocket().emit('browser:release_control');
          setBrowserControlActive(false);
          setPopupOpen(false);
          popupRef.current = null;
        }
      }, 500);
    } else {
      // Popup blocked — fall back to inline control
      getSocket().emit('browser:take_control');
    }
  }, []);

  const handleReleaseControl = useCallback(() => {
    getSocket().emit('browser:release_control');
    setBrowserControlActive(false);
    setPopupOpen(false);
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
      popupRef.current = null;
    }
  }, []);

  const handleRefreshScreenshot = useCallback(() => {
    getSocket().emit('browser:screenshot_request');
  }, []);

  // Forward clicks on the image as proportional coordinates
  const handleBrowserImageClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!browserControlActive) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    getSocket().emit('browser:click', { xRatio, yRatio });
  }, [browserControlActive]);

  // Forward scroll events
  const handleBrowserImageWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (!browserControlActive) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    getSocket().emit('browser:scroll', { xRatio, yRatio, deltaY: e.deltaY });
  }, [browserControlActive]);

  // Keyboard capture when control is active — attached to a focusable div wrapper
  const handleBrowserKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!browserControlActive) return;
    const SPECIAL_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'F5'];
    if (SPECIAL_KEYS.includes(e.key)) {
      e.preventDefault();
      getSocket().emit('browser:key', { key: e.key });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Printable character
      e.preventDefault();
      getSocket().emit('browser:type', { text: e.key });
    } else if (e.ctrlKey && e.key === 'a') {
      e.preventDefault();
      getSocket().emit('browser:key', { key: 'Control+a' });
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      getSocket().emit('browser:key', { key: 'Control+c' });
    } else if (e.ctrlKey && e.key === 'v') {
      e.preventDefault();
      getSocket().emit('browser:key', { key: 'Control+v' });
    }
  }, [browserControlActive]);

  // Unified context state (soul preview, recent memory events, active tasks)
  const [soulPreview, setSoulPreview] = useState<string | null>(null);
  const [memoryEvents, setMemoryEvents] = useState<{ event_text: string; timestamp: string }[]>([]);
  const [activeTasks, setActiveTasks] = useState<{ id: string; name: string; next_run: string }[]>([]);

  useEffect(() => {
    fetchCoreMemory();
  }, [fetchCoreMemory]);

  useEffect(() => {
    const fetchContext = async () => {
      try {
        const [sRes, eRes, tRes] = await Promise.all([
          fetch(`${API_BASE}/api/workspace/soul`),
          fetch(`${API_BASE}/api/memory/events?limit=5`),
          fetch(`${API_BASE}/api/tasks`),
        ]);
        if (sRes.ok) {
          const d = await sRes.json();
          setSoulPreview(d.content || null);
        }
        if (eRes.ok) {
          const d = await eRes.json();
          setMemoryEvents(Array.isArray(d) ? d : (d.events || []));
        }
        if (tRes.ok) {
          const d = await tRes.json();
          setActiveTasks(Array.isArray(d) ? d : (d.tasks || []));
        }
      } catch { /* non-fatal */ }
    };
    fetchContext();
    const iv = setInterval(fetchContext, 60000);
    return () => clearInterval(iv);
  }, []);

  const getPhaseColor = (phase: string) => {
    switch (phase) {
      case 'OBSERVE': return 'text-blue-400';
      case 'ORIENT': return 'text-yellow-400';
      case 'DECIDE': return 'text-purple-400';
      case 'ACT': return 'text-green-400';
      case 'REFLECT': return 'text-orange-400';
      default: return 'text-muted-foreground';
    }
  };

  const [collapsed, setCollapsed] = useState(false);

  // Auto-expand when browser becomes active or CAPTCHA blocks it
  useEffect(() => {
    if (browserActive) setCollapsed(false);
  }, [browserActive]);

  useEffect(() => {
    if (browserBlocked) setCollapsed(false); // always uncollapse on block — user must see it
  }, [browserBlocked]);

  // Collapsed state: show a thin strip with a toggle button
  if (collapsed) {
    return (
      <div className="border-l border-border bg-card flex flex-col h-full w-8 shrink-0 items-center pt-3 gap-2">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Expand Inspector"
        >
          <ChevronLeft size={14} />
        </button>
        {browserActive && (
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Browser active" />
        )}
      </div>
    );
  }

  return (
    <div className="w-[640px] border-l border-border bg-card flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div className="font-semibold text-sm flex items-center">
          <Search size={16} className="mr-2" />
          INSPECTOR
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={cn(
              "text-[10px] px-2 py-0.5 rounded cursor-pointer border",
              debugMode ? "bg-red-500/10 text-red-500 border-red-500/20" : "bg-accent text-muted-foreground border-transparent"
            )}
            onClick={toggleDebugMode}
          >
            Debug: {debugMode ? 'ON' : 'OFF'}
          </div>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Collapse Inspector"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Core Memory Section */}
        <section>
          <div className="flex items-center text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wider">
            <Brain size={12} className="mr-1.5" /> Core Memory
          </div>
          <div className="bg-accent/30 rounded-lg p-3 text-sm space-y-2 border border-border/50">
            {Object.entries(coreMemory?.userPreferences || {}).length === 0 && (
              <div className="text-xs text-muted-foreground italic">No user preferences found.</div>
            )}
            {Object.entries(coreMemory?.userPreferences || {}).map(([key, val]) => (
              <div key={key} className="flex items-start">
                <div className="w-1 h-1 bg-blue-400 rounded-full mt-1.5 mr-2" />
                <span>{key}: {String(val)}</span>
              </div>
            ))}

            <button
              className="text-xs text-blue-500 hover:underline mt-2 w-full text-left"
              onClick={() => setIsMemoryModalOpen(true)}
            >
              + Edit Memory
            </button>
          </div>
        </section>

        <EditMemoryModal
          isOpen={isMemoryModalOpen}
          onClose={() => setIsMemoryModalOpen(false)}
        />

        {/* Token Usage */}
        <section>
          <div className="flex items-center justify-between text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wider">
            <div className="flex items-center">
              <Database size={12} className="mr-1.5" /> Context Usage
            </div>
            <span className={tokenUsage.current / tokenUsage.limit > 0.8 ? 'text-orange-400' : ''}>
              ~{tokenUsage.current.toLocaleString()} / {tokenUsage.limit.toLocaleString()} tok
            </span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full transition-all duration-500",
                tokenUsage.current / tokenUsage.limit > 0.8 ? 'bg-orange-500' :
                tokenUsage.current / tokenUsage.limit > 0.5 ? 'bg-yellow-500' : 'bg-blue-500'
              )}
              style={{ width: `${Math.min(100, (tokenUsage.current / tokenUsage.limit) * 100)}%` }}
            />
          </div>
          {tokenUsage.current === 0 && (
            <p className="text-[10px] text-muted-foreground mt-1 italic">No messages in current session</p>
          )}
        </section>

        {/* Browser Live Preview + Human Control — between Context Usage and Recent Events */}
        {browserActive && (
          <section>
            {/* Header row */}
            <div className="flex items-center justify-between text-xs font-bold text-muted-foreground mb-1.5 uppercase tracking-wider">
              <div className="flex items-center gap-1">
                <Globe size={12} className="mr-0.5" /> Browser
                {browserControlActive ? (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-[9px] font-medium">YOU CONTROL</span>
                ) : browserBlocked ? (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[9px] font-medium animate-pulse">BLOCKED</span>
                ) : (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 text-[9px] font-medium animate-pulse">LIVE</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleRefreshScreenshot}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="Refresh screenshot"
                >
                  <RefreshCw size={10} />
                </button>
                <button
                  onClick={() => { setBrowserActive(false); setBrowserScreenshot(null); setBrowserBlocked(null); }}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1"
                  title="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Block alert banner — action-first so user knows exactly what to do */}
            {browserBlocked && (
              <div className="mb-2 px-2 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[10px] text-red-300 leading-relaxed space-y-1.5">
                <div>🚫 <span className="font-semibold">Blocked by {browserBlocked.blockType}</span> — agent is paused, waiting for you.</div>
                <button
                  onClick={handleTakeControl}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 text-[10px] font-semibold transition-colors animate-pulse"
                >
                  <MousePointer size={10} />
                  Solve CAPTCHA — Take Control ↗
                </button>
                <div className="text-[9px] text-red-400/70">Click above, solve the challenge in the popup, then click Release Control.</div>
              </div>
            )}

            {/* Placeholder while waiting for first screenshot */}
            {!browserScreenshot && (
              <div className="rounded-lg border border-border bg-accent/10 flex flex-col items-center justify-center h-28 text-[10px] text-muted-foreground gap-2">
                <Globe size={20} className="animate-pulse opacity-50" />
                <span>Agent is browsing — screenshot loading…</span>
              </div>
            )}

            {/* URL bar */}
            {browserScreenshot?.url && (
              <div className="text-[10px] text-muted-foreground mb-1.5 truncate px-1 bg-accent/20 rounded py-0.5" title={browserScreenshot.url}>
                🌐 {browserScreenshot.url}
              </div>
            )}

            {/* Screenshot image — clickable when control is active */}
            {browserScreenshot && (
              <div
                className={cn(
                  "rounded-lg border overflow-y-auto bg-background outline-none relative",
                  browserControlActive ? "border-orange-500 ring-1 ring-orange-500/50" : "border-border"
                )}
                tabIndex={browserControlActive ? 0 : -1}
                onKeyDown={handleBrowserKeyDown}
              >
                <img
                  ref={browserImgRef}
                  src={`data:${browserScreenshot.mimeType};base64,${browserScreenshot.base64}`}
                  alt="Browser view"
                  className={cn(
                    "w-full block",
                    browserControlActive ? "cursor-crosshair" : "cursor-default"
                  )}
                  onClick={handleBrowserImageClick}
                  onWheel={handleBrowserImageWheel}
                  draggable={false}
                />
                {/* Agent cursor dot — shown when not in user-control mode */}
                {!browserControlActive && browserScreenshot.cursor && (
                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                  >
                    <circle
                      cx={browserScreenshot.cursor.xRatio * 100}
                      cy={browserScreenshot.cursor.yRatio * 100}
                      r="2.5"
                      fill="rgba(239,68,68,0.85)"
                      stroke="white"
                      strokeWidth="0.8"
                    />
                    <circle
                      cx={browserScreenshot.cursor.xRatio * 100}
                      cy={browserScreenshot.cursor.yRatio * 100}
                      r="4"
                      fill="none"
                      stroke="rgba(239,68,68,0.4)"
                      strokeWidth="0.8"
                    />
                  </svg>
                )}
              </div>
            )}

            {/* Control buttons */}
            <div className="flex items-center gap-1.5 mt-2">
              {popupOpen ? (
                <button
                  onClick={handleReleaseControl}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 text-orange-400 text-xs font-medium transition-colors"
                  title="Close popup and return browser to agent"
                >
                  <StopCircle size={11} />
                  Release (popup open)
                </button>
              ) : !browserControlActive ? (
                <button
                  onClick={handleTakeControl}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 text-orange-400 text-xs font-medium transition-colors"
                  title="Open full-size popup to take over the browser (CAPTCHA, login, etc.)"
                >
                  <MousePointer size={11} />
                  Take Control ↗
                </button>
              ) : (
                <button
                  onClick={handleReleaseControl}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 text-green-400 text-xs font-medium transition-colors animate-pulse"
                  title="Hand browser back to the agent and resume execution"
                >
                  <StopCircle size={11} />
                  Release Control
                </button>
              )}
            </div>

            {/* Control hint */}
            {browserControlActive && (
              <div className="mt-1.5 px-2 py-1.5 rounded-md bg-orange-500/5 border border-orange-500/20 text-[10px] text-orange-300/80 leading-relaxed">
                Click on the image to click in the browser. Type to send keystrokes. Press Enter/Tab/Escape as normal. Scroll to scroll the page.
              </div>
            )}

            {browserScreenshot && browserScreenshot.iteration >= 0 && (
              <div className="text-[10px] text-muted-foreground mt-1 text-right">
                Iter #{browserScreenshot.iteration}
              </div>
            )}
          </section>
        )}

        {/* Recent Events — below browser panel */}
        <section>
          <div className="flex items-center text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wider">
            <CheckSquare size={12} className="mr-1.5" /> Recent Events
          </div>
          {oodaLogs.length === 0 ? (
            <div className="text-sm text-muted-foreground italic text-center py-4 bg-accent/10 rounded-lg border border-dashed border-border">
              No recent events
            </div>
          ) : (
            <div className="text-xs space-y-2">
              {oodaLogs.slice(0, 3).map((log, i) => (
                <div key={i} className="p-2 bg-accent/20 border border-border rounded">
                  <span className={cn("font-bold mr-1", getPhaseColor(log.phase))}>{log.phase}</span>
                  {log.message}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Persona — shows live SOUL.md content (the actual active personality) */}
        <section>
          <div className="flex items-center text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wider">
            <User size={12} className="mr-1.5" /> Persona
          </div>
          <div className="bg-accent/30 rounded-lg p-3 text-xs border border-border/50">
            {soulPreview ? (
              <p className="text-foreground/80 leading-relaxed whitespace-pre-wrap line-clamp-4">
                {soulPreview.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3).join('\n')}
              </p>
            ) : (
              <span className="italic text-muted-foreground">No SOUL.md found. Edit it in Proactive view.</span>
            )}
          </div>
        </section>

        {/* Recent Memory */}
        <section>
          <div className="flex items-center text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wider">
            <Clock size={12} className="mr-1.5" /> Recent Memory
          </div>
          {memoryEvents.length === 0 ? (
            <div className="text-xs text-muted-foreground italic text-center py-3 bg-accent/10 rounded-lg border border-dashed border-border">
              No memory events
            </div>
          ) : (
            <div className="space-y-2">
              {memoryEvents.map((e, i) => (
                <div key={i} className="flex gap-2 items-start text-xs p-2 bg-accent/20 border border-border rounded">
                  <div className="min-w-[4px] min-h-[4px] mt-1.5 rounded-full bg-blue-400 shrink-0" />
                  <div>
                    <div className="line-clamp-2 text-foreground/90">{e.event_text}</div>
                    <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Active Tasks */}
        <section>
          <div className="flex items-center text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wider">
            <CheckCircle size={12} className="mr-1.5" /> Active Tasks
          </div>
          {activeTasks.length === 0 ? (
            <div className="text-xs text-muted-foreground italic text-center py-3 bg-accent/10 rounded-lg border border-dashed border-border">
              No scheduled tasks
            </div>
          ) : (
            <div className="space-y-1.5">
              {activeTasks.slice(0, 3).map(t => (
                <div key={t.id} className="flex justify-between items-center text-xs p-2 bg-accent/20 border border-border rounded">
                  <span className="font-medium truncate max-w-[140px]" title={t.name}>{t.name}</span>
                  <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded text-secondary-foreground shrink-0">
                    {new Date(t.next_run).toLocaleDateString(undefined, { weekday: 'short' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Debug Log (Live) */}
        {debugMode && (
          <section className="animate-in fade-in slide-in-from-right-4 duration-300">
            <div className="flex items-center text-xs font-bold text-red-400 mb-2 uppercase tracking-wider">
              <Activity size={12} className="mr-1.5" /> Live OODA Log
            </div>
            <div className="space-y-2 font-mono text-xs">
              {oodaLogs.map((log, i) => (
                <div key={i} className="p-2 bg-background border border-border rounded opacity-90 shadow-sm transition-all hover:opacity-100">
                  <div className="flex justify-between mb-1">
                    <span className={cn("font-bold", getPhaseColor(log.phase))}>{log.phase}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-foreground/90 break-words">{log.message}</div>
                  {log.details && (
                    <pre className="mt-1 text-[10px] text-muted-foreground bg-accent/50 p-1 rounded overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}