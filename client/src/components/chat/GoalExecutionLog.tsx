import { cn } from '@/lib/utils';

interface GoalExecutionLogProps {
  content: string;
  isDone: boolean;
}

// ─── OLD FORMAT types (iter-based) ───────────────────────────────────────────
interface ParsedLine {
  type: 'header' | 'iter' | 'replan' | 'footer' | 'blank' | 'progress_bar' | 'step' | 'replan_count';
  raw: string;
  // iter fields
  status?: 'active' | 'success' | 'error' | 'thinking';
  iterNum?: number;
  tool?: string;
  args?: string;
  reasoning?: string;
  // replan
  strategy?: string;
  // footer
  elapsed?: string;
  // new format step
  stepIcon?: '✅' | '⏳' | '○' | '❌';
  stepLabel?: string;
  // new format progress bar
  pct?: number;
}

const TOOL_STYLES: Record<string, { bg: string; text: string; label?: string }> = {
  web_search:         { bg: 'bg-blue-500/15',    text: 'text-blue-400',    label: 'search'     },
  web_fetch:          { bg: 'bg-cyan-500/15',     text: 'text-cyan-400',    label: 'fetch'      },
  write_file:         { bg: 'bg-green-500/15',    text: 'text-green-400',   label: 'write'      },
  edit_file:          { bg: 'bg-emerald-500/15',  text: 'text-emerald-400', label: 'edit'       },
  run_command:        { bg: 'bg-orange-500/15',   text: 'text-orange-400',  label: 'run'        },
  run_script:         { bg: 'bg-orange-500/15',   text: 'text-orange-400',  label: 'script'     },
  read_file:          { bg: 'bg-slate-500/15',    text: 'text-slate-400',   label: 'read'       },
  list_directory:     { bg: 'bg-slate-500/15',    text: 'text-slate-400',   label: 'ls'         },
  create_directory:   { bg: 'bg-yellow-500/15',   text: 'text-yellow-400',  label: 'mkdir'      },
  browser_navigate:   { bg: 'bg-purple-500/15',   text: 'text-purple-400',  label: 'navigate'   },
  browser_click:      { bg: 'bg-purple-500/15',   text: 'text-purple-400',  label: 'click'      },
  browser_launch:     { bg: 'bg-purple-500/15',   text: 'text-purple-400',  label: 'browser'    },
  browser_fetch:      { bg: 'bg-violet-500/15',   text: 'text-violet-400',  label: 'browser'    },
  browser_screenshot: { bg: 'bg-violet-500/15',   text: 'text-violet-400',  label: 'screenshot' },
  search_files:       { bg: 'bg-indigo-500/15',   text: 'text-indigo-400',  label: 'grep'       },
  move_file:          { bg: 'bg-amber-500/15',    text: 'text-amber-400',   label: 'move'       },
  delete_file:        { bg: 'bg-red-500/15',      text: 'text-red-400',     label: 'delete'     },
};

function getToolStyle(tool: string) {
  if (TOOL_STYLES[tool]) return TOOL_STYLES[tool];
  if (tool.startsWith('browser_')) return { bg: 'bg-purple-500/15', text: 'text-purple-400', label: tool.replace('browser_', '') };
  return { bg: 'bg-muted/50', text: 'text-muted-foreground', label: tool };
}

function parseLine(raw: string): ParsedLine {
  if (!raw.trim()) return { type: 'blank', raw };

  // Header: ⚙️ ...
  if (raw.startsWith('⚙️')) return { type: 'header', raw };

  // Footer: _Xs elapsed_
  const footerMatch = raw.match(/^_(.+elapsed.*)_$/);
  if (footerMatch) return { type: 'footer', raw, elapsed: footerMatch[1] };

  // NEW FORMAT: Progress bar line (contains █ or ░)
  if (/[█░]/.test(raw)) {
    const pctMatch = raw.match(/(\d+)%/);
    return { type: 'progress_bar', raw, pct: pctMatch ? parseInt(pctMatch[1], 10) : 0 };
  }

  // NEW FORMAT: Step lines — "  ✅  label", "  ⏳  label", "  ○   label", "  ❌  label"
  const stepMatch = raw.match(/^\s{1,4}([✅⏳○❌])\s{1,4}(.+)$/);
  if (stepMatch) {
    return {
      type: 'step',
      raw,
      stepIcon: stepMatch[1] as '✅' | '⏳' | '○' | '❌',
      stepLabel: stepMatch[2].trim(),
    };
  }

  // NEW FORMAT: Replan count "  🔄  Replanned N×"
  if (/Replanned\s+\d+/.test(raw)) return { type: 'replan_count', raw };

  // OLD FORMAT: Replan banner "🔄 **Replanning**: ..."
  if (raw.startsWith('🔄')) {
    const strategy = raw.replace(/^🔄 \*\*Replanning\*\*: ?/, '').trim();
    return { type: 'replan', raw, strategy };
  }

  // OLD FORMAT: Iter line
  const iterMatch = raw.match(/^([⏳✅❌🔧]) \*\*Iter (\d+)\*\*: (.*)$/s);
  if (iterMatch) {
    const [, emoji, numStr, rest] = iterMatch;
    const iterNum = parseInt(numStr, 10);
    const status =
      emoji === '✅' ? 'success' :
      emoji === '❌' ? 'error' :
      emoji === '⏳' ? 'thinking' : 'active';

    const toolMatch = rest.match(/^`([^`]+)`\s*(.*)?$/s);
    let tool = '', args = '', reasoning = '';
    if (toolMatch) {
      tool = toolMatch[1];
      const after = toolMatch[2] || '';
      const reasonMatch = after.match(/^(.*?)(?:\s*\n\s*_(.+)_\s*)?$/s);
      args = reasonMatch?.[1]?.trim() ?? after.trim();
      reasoning = reasonMatch?.[2]?.trim() ?? '';
    } else {
      const reasonMatch = rest.match(/^reasoning(.*?)(?:\n\s*_(.+)_\s*)?$/s);
      reasoning = reasonMatch?.[2]?.trim() ?? '';
    }
    return { type: 'iter', raw, status, iterNum, tool, args, reasoning };
  }

  return { type: 'blank', raw };
}

// ─── OLD FORMAT: Iteration row ─────────────────────────────────────────────
function IterRow({ line, isLast, isDone }: { line: ParsedLine; isLast: boolean; isDone: boolean }) {
  const { status, iterNum, tool, args, reasoning } = line;
  const isActive = isLast && !isDone && (status === 'active' || status === 'thinking');

  const borderColor =
    status === 'success' ? 'border-l-green-500' :
    status === 'error'   ? 'border-l-red-500' :
    isActive             ? 'border-l-yellow-400' : 'border-l-border';

  const statusIcon =
    status === 'success' ? <span className="text-green-400 text-sm leading-none">✓</span> :
    status === 'error'   ? <span className="text-red-400 text-sm leading-none">✗</span> :
    isActive             ? <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse inline-block" /> :
                           <span className="w-2 h-2 rounded-full bg-muted-foreground/30 inline-block" />;

  const toolStyle = tool ? getToolStyle(tool) : null;
  const displayLabel = toolStyle?.label ?? tool;

  return (
    <div className={cn(
      'flex items-start gap-2 px-2 py-1.5 border-l-2 rounded-r-sm transition-all',
      borderColor,
      isActive ? 'bg-yellow-500/5' : 'bg-transparent',
    )}>
      <div className="flex items-center justify-center w-4 mt-0.5 shrink-0">{statusIcon}</div>
      <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 w-6 mt-0.5">{iterNum}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {tool && (
            <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold shrink-0', toolStyle?.bg, toolStyle?.text)}>
              {displayLabel}
            </span>
          )}
          {args && <span className="text-xs text-muted-foreground/80 truncate max-w-[220px] font-mono" title={args}>{args}</span>}
          {!tool && !args && <span className="text-xs text-muted-foreground/50 italic">thinking…</span>}
        </div>
        {reasoning && (
          <div className="text-[10px] text-muted-foreground/50 italic mt-0.5 leading-snug line-clamp-1" title={reasoning}>
            {reasoning}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NEW FORMAT: Plan-step row ──────────────────────────────────────────────
function StepRow({ icon, label, isRunning }: { icon: '✅' | '⏳' | '○' | '❌'; label: string; isRunning: boolean }) {
  const textColor =
    icon === '✅' ? 'text-green-400' :
    icon === '⏳' ? 'text-yellow-400' :
    icon === '❌' ? 'text-red-400' :
                   'text-muted-foreground/50';

  return (
    <div className={cn('flex items-center gap-2 py-0.5 px-1 rounded', isRunning && 'bg-yellow-500/5')}>
      <span className="text-sm w-5 shrink-0 text-center leading-none">
        {icon === '⏳' ? (
          <span className="inline-flex items-center justify-center w-3 h-3">
            <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse inline-block" />
          </span>
        ) : icon === '○' ? (
          <span className="text-[10px] text-muted-foreground/30">○</span>
        ) : icon}
      </span>
      <span className={cn('text-xs leading-snug', textColor, icon === '○' && 'text-muted-foreground/40')}>
        {label}
      </span>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
export function GoalExecutionLog({ content, isDone }: GoalExecutionLogProps) {
  const rawLines = content.split('\n');
  const parsed = rawLines.map(parseLine);

  const header      = parsed.find(l => l.type === 'header');
  const footer      = parsed.find(l => l.type === 'footer');
  const progressBar = parsed.find(l => l.type === 'progress_bar');
  const steps       = parsed.filter(l => l.type === 'step');
  const iters       = parsed.filter(l => l.type === 'iter');
  const replans     = parsed.filter(l => l.type === 'replan');
  const replanCount = parsed.find(l => l.type === 'replan_count');

  // Detect format: if we have steps OR a progress bar → new plan-step format
  const isNewFormat = steps.length > 0 || progressBar !== undefined;

  // Header text: strip ⚙️ prefix and ** bold markers
  const headerRaw = header?.raw ?? '⚙️  Working on it...';
  // Extract just the left part before the spaces (step counter is visual padding)
  const headerText = headerRaw
    .replace(/^⚙️\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s{3,}.+$/, '')   // strip the right-aligned "Step N of M" (was space-padded)
    .trim();

  // Extract "Step N of M" from header for badge
  const stepCounterMatch = headerRaw.match(/Step\s+(\d+)\s+of\s+(\d+)/i);
  const stepBadge = stepCounterMatch ? `${stepCounterMatch[1]} / ${stepCounterMatch[2]}` : null;

  // Extract elapsed from progress bar line (not the footer) for new format
  const elapsedFromBar = progressBar?.raw.match(/elapsed:\s*(.+)$/)?.[1]?.trim();

  // ── NEW FORMAT RENDER ──────────────────────────────────────────────────────
  if (isNewFormat) {
    return (
      <div className="w-full space-y-1.5">
        {/* Header row */}
        <div className="flex items-center justify-between pb-1.5 border-b border-border/60">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground/80">{headerText}</span>
            {!isDone && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block" />}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {stepBadge && <span className="font-mono">{stepBadge}</span>}
            {(elapsedFromBar || footer?.elapsed) && (
              <span className="text-muted-foreground/60">{elapsedFromBar ?? footer?.elapsed}</span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {progressBar && (
          <div className="px-1">
            <div className="h-1 rounded-full bg-border overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-500', isDone ? 'bg-green-500' : 'bg-yellow-400')}
                style={{ width: `${progressBar.pct ?? 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Step list */}
        <div className="space-y-0 pt-0.5">
          {steps.length > 0 ? (
            steps.map((s, i) => (
              <StepRow
                key={i}
                icon={s.stepIcon!}
                label={s.stepLabel!}
                isRunning={s.stepIcon === '⏳'}
              />
            ))
          ) : (
            <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground/60 italic">
              <span className="w-2 h-2 rounded-full bg-yellow-400/60 animate-pulse inline-block" />
              Preparing execution plan…
            </div>
          )}
        </div>

        {/* Replan count */}
        {replanCount && (
          <div className="flex items-center gap-1.5 mt-1 px-1 py-0.5 text-[10px] text-amber-400/70">
            <span>↺</span>
            <span>{replanCount.raw.trim().replace(/^\s*🔄\s+/, '')}</span>
          </div>
        )}
      </div>
    );
  }

  // ── OLD FORMAT RENDER (iter-based, used by OODA escalation + parallel lookup) ─
  const successCount = iters.filter(l => l.status === 'success').length;
  const errorCount   = iters.filter(l => l.status === 'error').length;
  const totalIters   = iters.length;

  return (
    <div className="w-full space-y-1">
      {/* Header strip */}
      <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-border/60">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-foreground/80">
            {headerRaw.replace('⚙️ ', '').replace(/\*\*/g, '').trim()}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {totalIters > 0 && (
            <>
              <span className="text-green-400">{successCount} ok</span>
              {errorCount > 0 && <span className="text-red-400">{errorCount} err</span>}
              <span>{totalIters} steps</span>
            </>
          )}
          {footer && <span className="text-muted-foreground/60">{footer.elapsed}</span>}
        </div>
      </div>

      {/* Iteration rows */}
      <div className="space-y-0.5">
        {iters.map((line, i) => (
          <IterRow key={i} line={line} isLast={i === iters.length - 1} isDone={isDone} />
        ))}
        {iters.length === 0 && !isDone && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground/60 italic">
            <span className="w-2 h-2 rounded-full bg-yellow-400/60 animate-pulse inline-block" />
            Planning…
          </div>
        )}
      </div>

      {/* Replan banners */}
      {replans.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 mt-1.5 px-2 py-1 bg-amber-500/10 border border-amber-500/25 rounded text-[10px] text-amber-400">
          <span>↺</span>
          <span className="font-medium">Replanning:</span>
          <span className="text-muted-foreground truncate">{r.strategy}</span>
        </div>
      ))}
    </div>
  );
}
