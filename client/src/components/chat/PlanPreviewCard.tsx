import { CheckCircle2, Circle, Clock, AlertTriangle, Play, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ExecutionPlan, PlanStep } from '@/types/plan';

interface PlanPreviewCardProps {
  plan: ExecutionPlan;
  onApprove: (id: string) => void;
  onCancel: (id: string) => void;
}

export function PlanPreviewCard({ plan, onApprove, onCancel }: PlanPreviewCardProps) {
  const isExecuting = plan.status === 'executing';

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm overflow-hidden w-full max-w-2xl my-2">
      {/* Header */}
      <div className="bg-accent/30 p-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="bg-blue-500/10 p-1.5 rounded-md text-blue-500">
            <Clock size={16} />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{plan.title}</h3>
            <div className="text-xs text-muted-foreground flex items-center space-x-2">
              <span>{plan.estimatedDuration}</span>
              <span>•</span>
              <span className={cn(
                "uppercase font-bold text-[10px]",
                plan.riskLevel === 'high' ? "text-red-500" : 
                plan.riskLevel === 'medium' ? "text-yellow-500" : "text-green-500"
              )}>
                {plan.riskLevel} Risk
              </span>
            </div>
          </div>
        </div>
        {isExecuting && (
          <div className="flex items-center text-xs text-blue-500 animate-pulse font-medium">
            <Loader2 size={12} className="mr-1 animate-spin" />
            EXECUTING
          </div>
        )}
      </div>

      {/* Steps List */}
      <div className="p-0">
        {plan.steps.map((step, index) => (
          <PlanStepItem 
            key={step.id} 
            step={step} 
            isLast={index === plan.steps.length - 1} 
          />
        ))}
      </div>

      {/* Actions Footer */}
      {plan.status === 'proposed' && (
        <div className="p-3 bg-accent/10 border-t border-border flex items-center justify-end space-x-2">
          <button 
            onClick={() => onCancel(plan.id)}
            className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
          >
            Customize
          </button>
          <button 
            onClick={() => onCancel(plan.id)}
            className="flex items-center px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10 rounded-md transition-colors"
          >
            <X size={14} className="mr-1.5" />
            Cancel
          </button>
          <button 
            onClick={() => onApprove(plan.id)}
            className="flex items-center px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 rounded-md transition-colors shadow-sm"
          >
            <Play size={14} className="mr-1.5 fill-current" />
            Approve Plan
          </button>
        </div>
      )}
    </div>
  );
}

function PlanStepItem({ step, isLast }: { step: PlanStep; isLast: boolean }) {
  const getIcon = () => {
    switch (step.status) {
      case 'success': return <CheckCircle2 size={16} className="text-green-500" />;
      case 'running': return <Loader2 size={16} className="text-blue-500 animate-spin" />;
      case 'failed': return <X size={16} className="text-red-500" />;
      case 'skipped': return <Circle size={16} className="text-muted-foreground/30" />;
      default: return <Circle size={16} className="text-muted-foreground" />;
    }
  };

  return (
    <div className={cn(
      "flex items-start p-3 text-sm hover:bg-accent/20 transition-colors",
      !isLast && "border-b border-border/50"
    )}>
      <div className="mt-0.5 mr-3 flex-shrink-0">
        {getIcon()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className={cn(
            "font-medium truncate",
            step.status === 'skipped' && "text-muted-foreground line-through"
          )}>
            {step.description}
          </span>
          {step.requiresConfirmation && step.status === 'pending' && (
            <span className="flex-shrink-0 ml-2 px-1.5 py-0.5 bg-yellow-500/10 text-yellow-600 text-[10px] rounded font-medium border border-yellow-500/20 flex items-center">
              <AlertTriangle size={10} className="mr-1" />
              NEEDS APPROVAL
            </span>
          )}
        </div>
        {step.toolCall && (
          <div className="mt-1 text-xs font-mono text-muted-foreground bg-accent/30 rounded px-1.5 py-0.5 inline-block truncate max-w-full">
            {step.toolCall.name}
          </div>
        )}
      </div>
    </div>
  );
}