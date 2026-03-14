import { Play, Copy, Check } from 'lucide-react';
import { useState } from 'react';

interface CodeBlockProps {
  language: string;
  code: string;
  isRunnable?: boolean;
  onRun?: (code: string) => void;
}

export function CodeBlock({ language, code, isRunnable, onRun }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-md border border-border bg-muted/30 overflow-hidden my-2 w-full max-w-3xl">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {language}
        </span>
        <div className="flex items-center space-x-1">
          {isRunnable && (
            <button 
              onClick={() => onRun?.(code)}
              className="flex items-center px-2 py-0.5 text-xs text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 rounded transition-colors mr-1"
            >
              <Play size={12} className="mr-1" />
              Run
            </button>
          )}
          <button 
            onClick={handleCopy}
            className="p-1 hover:bg-background rounded text-muted-foreground transition-colors"
          >
            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      <div className="p-3 overflow-x-auto">
        <pre className="text-sm font-mono leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}