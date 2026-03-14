/**
 * BrowserControlPopup — opens as a separate window for human browser control.
 * Full-size view, click/type/scroll forwarding, CAPTCHA-friendly.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import { MousePointer, StopCircle, RefreshCw, Globe, Maximize2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function BrowserControlPopup() {
  const [screenshot, setScreenshot] = useState<{
    base64: string;
    mimeType: string;
    url: string;
    iteration: number;
    cursor?: { xRatio: number; yRatio: number };
  } | null>(null);
  const [controlActive, setControlActive] = useState(false);
  const [status, setStatus] = useState<'waiting' | 'live' | 'released'>('waiting');
  const [connectTimedOut, setConnectTimedOut] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Socket wiring ───────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    const onShot = (data: any) => {
      setScreenshot(data);
      if (status === 'waiting') setStatus('live');
    };

    const onGranted = () => {
      setControlActive(true);
      setStatus('live');
    };

    const onReleased = () => {
      setControlActive(false);
      setStatus('released');
      // Close popup after short delay
      setTimeout(() => window.close(), 1500);
    };

    socket.on('browser:screenshot', onShot);
    socket.on('browser:control_granted', onGranted);
    socket.on('browser:control_released', onReleased);

    const params = new URLSearchParams(window.location.search);
    const targetUrl = params.get('targetUrl') || undefined;
    const autoControl = params.get('autoControl') === 'true';

    if (autoControl) {
      // User explicitly clicked "Take Control" or "Fill in Browser Instead" — grant immediately.
      socket.emit('browser:take_control', { targetUrl });
    } else {
      // Auto-opened by HITL — preview only, user clicks "Take Control" when ready.
      socket.emit('browser:launch_preview', { targetUrl });
    }

    // Request a fresh screenshot
    socket.emit('browser:screenshot_request');

    return () => {
      socket.off('browser:screenshot', onShot);
      socket.off('browser:control_granted', onGranted);
      socket.off('browser:control_released', onReleased);
    };
  }, []);

  // Connection timeout — if no screenshot arrives within 10s, show error instead of
  // spinning forever. Cleared as soon as the first frame lands (status → 'live').
  useEffect(() => {
    if (status !== 'waiting') return;
    const t = setTimeout(() => setConnectTimedOut(true), 10000);
    return () => clearTimeout(t);
  }, [status]);

  // ── Click forwarding ────────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!controlActive || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    getSocket().emit('browser:click', { xRatio, yRatio });
    // Show click ripple
    setTimeout(() => getSocket().emit('browser:screenshot_request'), 700);
  }, [controlActive]);

  // ── Scroll forwarding ───────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (!controlActive || !imgRef.current) return;
    e.preventDefault();
    const rect = imgRef.current.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    getSocket().emit('browser:scroll', { xRatio, yRatio, deltaY: e.deltaY });
    setTimeout(() => getSocket().emit('browser:screenshot_request'), 500);
  }, [controlActive]);

  // ── Keyboard forwarding ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!controlActive) return;
    const SPECIAL_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
      'PageUp', 'PageDown', 'F5', 'F12'];

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture browser shortcuts
      if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) return;

      if (SPECIAL_KEYS.includes(e.key)) {
        e.preventDefault();
        getSocket().emit('browser:key', { key: e.key });
        setTimeout(() => getSocket().emit('browser:screenshot_request'), 400);
      } else if (e.ctrlKey) {
        if (['a', 'c', 'v', 'x', 'z'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          getSocket().emit('browser:key', { key: `Ctrl+${e.key.toUpperCase()}` });
          setTimeout(() => getSocket().emit('browser:screenshot_request'), 400);
        }
      } else if (e.key.length === 1) {
        getSocket().emit('browser:type', { text: e.key });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controlActive]);

  // ── Release control ─────────────────────────────────────────────────────────
  const handleRelease = () => {
    getSocket().emit('browser:release_control');
    setControlActive(false);
    setStatus('released');
  };

  const handleRefresh = () => {
    getSocket().emit('browser:screenshot_request');
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="flex flex-col h-screen bg-gray-950 text-white select-none"
      style={{ fontFamily: 'system-ui, sans-serif' }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-5 py-3 bg-gray-900 border-b border-gray-700 shrink-0">
        <Globe size={20} className="text-blue-400" />
        <span className="text-base font-semibold text-gray-200 flex-1 truncate" title={screenshot?.url}>
          {screenshot?.url || 'Waiting for browser…'}
        </span>

        {/* Status badge */}
        {status === 'live' && controlActive && (
          <span className="px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 text-xs font-medium animate-pulse">
            YOU CONTROL
          </span>
        )}
        {status === 'live' && !controlActive && (
          <span className="px-2 py-0.5 rounded-full bg-green-500/20 text-green-300 text-xs font-medium animate-pulse">
            LIVE
          </span>
        )}
        {status === 'released' && (
          <span className="px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 text-xs font-medium">
            Released — closing…
          </span>
        )}

        <button
          onClick={handleRefresh}
          className="p-2 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          title="Refresh screenshot"
        >
          <RefreshCw size={16} />
        </button>

        {controlActive ? (
          <button
            onClick={handleRelease}
            className="flex items-center gap-2 px-4 py-2 rounded bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors"
          >
            <StopCircle size={16} />
            Release Control
          </button>
        ) : (
          <button
            onClick={() => { getSocket().emit('browser:take_control'); }}
            className="flex items-center gap-2 px-4 py-2 rounded bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium transition-colors"
          >
            <MousePointer size={16} />
            Take Control
          </button>
        )}
      </div>

      {/* Hint bar */}
      {controlActive && (
        <div className="px-4 py-1.5 bg-orange-900/30 border-b border-orange-700/30 text-xs text-orange-300 shrink-0">
          Click anywhere on the page · Type to enter text · Scroll to scroll · Enter/Tab/Backspace/Arrows work normally
        </div>
      )}

      {/* Browser viewport */}
      <div className="flex-1 relative overflow-y-auto bg-gray-900">
        {!screenshot ? (
          connectTimedOut ? (
            <div className="flex flex-col items-center gap-3 text-center px-8">
              <AlertTriangle size={40} className="text-yellow-500 opacity-80" />
              <p className="text-sm text-gray-200 font-medium">No browser session available</p>
              <p className="text-xs text-gray-400 max-w-xs">
                The browser couldn't be started. This can happen if Playwright is not installed
                in the container, or the browser failed to launch.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { setConnectTimedOut(false); getSocket().emit('browser:take_control'); getSocket().emit('browser:screenshot_request'); }}
                  className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors"
                >
                  Retry
                </button>
                <button
                  onClick={() => window.close()}
                  className="px-3 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs font-medium transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-gray-500">
              <Globe size={48} className="animate-pulse opacity-40" />
              <p className="text-sm">Connecting to browser…</p>
              <p className="text-xs opacity-60">The agent will pause while you have control</p>
            </div>
          )
        ) : (
          <div
            className={cn(
              'relative w-full',
              controlActive ? 'cursor-crosshair' : 'cursor-default'
            )}
          >
            <img
              ref={imgRef}
              src={`data:${screenshot.mimeType};base64,${screenshot.base64}`}
              alt="Browser"
              className="w-full block"
              onClick={handleClick}
              onWheel={handleWheel}
              draggable={false}
              tabIndex={controlActive ? 0 : -1}
            />
            {/* Agent cursor dot */}
            {!controlActive && screenshot.cursor && (
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <circle
                  cx={screenshot.cursor.xRatio * 100}
                  cy={screenshot.cursor.yRatio * 100}
                  r="1.5"
                  fill="rgba(239,68,68,0.85)"
                  stroke="white"
                  strokeWidth="0.5"
                />
              </svg>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-2 bg-gray-900 border-t border-gray-700 flex items-center gap-4 text-xs text-gray-500 shrink-0">
        <Maximize2 size={13} />
        <span>Full-size browser control · {screenshot ? `Iter #${screenshot.iteration}` : 'waiting…'}</span>
        <span className="ml-auto">Close this window or click "Release Control" to hand back to agent</span>
      </div>
    </div>
  );
}
