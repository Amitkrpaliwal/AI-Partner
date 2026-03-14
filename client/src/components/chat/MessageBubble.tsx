import { cn } from '@/lib/utils';
import { Message } from '@/types';
import { PlanPreviewCard } from './PlanPreviewCard';
import { CodeBlock } from './CodeBlock';
import { GoalExecutionLog } from './GoalExecutionLog';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, PauseCircle } from 'lucide-react';

interface MessageBubbleProps {
  message: Message;
  onApprovePlan?: (planId: string) => void;
  onCancelPlan?: (planId: string) => void;
  onRunCode?: (code: string) => void;
}

export function MessageBubble({ message, onApprovePlan, onCancelPlan, onRunCode }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [imageExpanded, setImageExpanded] = useState(false);

  // System Message
  if (isSystem) {
    return (
      <div className="flex flex-col max-w-3xl mx-auto w-full items-center my-4">
        <span className="text-xs font-bold uppercase text-muted-foreground mb-1">System</span>
        <div className="bg-accent/50 text-muted-foreground w-full text-center border border-dashed border-border py-2 px-4 rounded-lg text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  const isHitl = !isUser && message.metadata?.isHitl === true;

  return (
    <div className={cn("flex flex-col max-w-3xl mx-auto w-full", isUser ? "items-end" : "items-start")}>
      {/* Role Label */}
      <div className="flex items-center space-x-2 mb-1">
        {isHitl ? (
          <span className="flex items-center gap-1 text-xs font-bold uppercase text-amber-400">
            <PauseCircle size={12} />
            Action Required
          </span>
        ) : (
          <span className="text-xs font-bold uppercase text-muted-foreground">
            {message.role === 'assistant' ? '🤖 AI' : '👤 You'}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/50">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Message Content */}
      <div className={cn(
        "px-4 py-3 rounded-lg text-sm shadow-sm max-w-full overflow-hidden",
        isUser
          ? "bg-primary text-primary-foreground rounded-tr-none"
          : isHitl
            ? "bg-amber-950/20 border border-amber-600/60 rounded-tl-none w-full"
            : "bg-card border border-border rounded-tl-none w-full"
      )}>
        {/* Text Content */}
        {message.content && (
          isUser ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
          ) : message.content.startsWith('⚙️') ? (
            <GoalExecutionLog
              content={message.content}
              isDone={message.metadata?.done === true}
            />
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1 text-foreground">{children}</h1>,
                h2: ({ children }) => <h2 className="text-base font-bold mt-3 mb-1 text-foreground">{children}</h2>,
                h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-0.5 text-foreground">{children}</h3>,
                p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
                a: ({ href, children }) => {
                  if (href?.startsWith('workspace:')) {
                    const path = href.replace('workspace:', '');
                    const name = String(children);
                    return (
                      <button
                        onClick={() => window.dispatchEvent(new CustomEvent('file-preview', { detail: { path, name } }))}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent hover:bg-accent/70 text-accent-foreground text-xs font-medium cursor-pointer transition-colors"
                      >
                        <FileText size={11} />
                        {name}
                      </button>
                    );
                  }
                  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{children}</a>;
                },
                ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-2 ml-2">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-2 ml-2">{children}</ol>,
                li: ({ children }) => <li className="text-sm">{children}</li>,
                blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic">{children}</blockquote>,
                hr: () => <hr className="my-3 border-border" />,
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  return isBlock
                    ? <code className={cn("block bg-black/30 rounded p-3 text-xs font-mono overflow-x-auto my-2 whitespace-pre", className)}>{children}</code>
                    : <code className="bg-black/30 text-blue-300 px-1 py-0.5 rounded text-xs font-mono">{children}</code>;
                },
                pre: ({ children }) => <>{children}</>,
                table: ({ children }) => (
                  <div className="overflow-x-auto my-3">
                    <table className="w-full text-xs border-collapse border border-border rounded">{children}</table>
                  </div>
                ),
                thead: ({ children }) => <thead className="bg-accent/50">{children}</thead>,
                th: ({ children }) => <th className="px-3 py-2 text-left font-semibold border border-border">{children}</th>,
                td: ({ children }) => <td className="px-3 py-2 border border-border">{children}</td>,
              }}
            >
              {message.content}
            </ReactMarkdown>
          )
        )}

        {/* Rich Content: Execution Plan */}
        {message.richContent?.type === 'plan' && message.richContent.plan && (
          <div className="mt-3">
            <PlanPreviewCard
              plan={message.richContent.plan}
              onApprove={onApprovePlan!}
              onCancel={onCancelPlan!}
            />
          </div>
        )}

        {/* Rich Content: Code Block */}
        {message.richContent?.type === 'code' && message.richContent.code && (
          <div className="mt-2">
            <CodeBlock
              language={message.richContent.code.language}
              code={message.richContent.code.content}
              isRunnable={message.richContent.code.isRunnable}
              onRun={onRunCode}
            />
          </div>
        )}

        {/* Rich Content: Screenshot / Image */}
        {message.richContent?.type === 'image' && message.richContent.image && (
          <div className="mt-2">
            <button
              onClick={() => setImageExpanded(!imageExpanded)}
              className="block rounded-lg overflow-hidden border border-border hover:border-primary transition-colors cursor-pointer"
            >
              <img
                src={`data:${message.richContent.image.mimeType || 'image/png'};base64,${message.richContent.image.base64}`}
                alt={message.richContent.image.alt || 'Screenshot'}
                className={cn(
                  "rounded-lg transition-all",
                  imageExpanded ? "max-w-full" : "max-w-xs max-h-48 object-cover"
                )}
              />
            </button>
            <span className="text-[10px] text-muted-foreground mt-1 block">
              {message.richContent.image.alt || 'Browser screenshot'} — click to {imageExpanded ? 'shrink' : 'expand'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}