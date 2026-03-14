import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, XCircle, AlertTriangle, Loader2, Code } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import { API_BASE } from '@/lib/api';

interface PlanStep {
    id: string;
    action: string;
    description: string;
    requires_confirmation: boolean;
}

interface PendingPlan {
    plan_id: string;
    description: string;
    steps: PlanStep[];
}

interface GoalApproval {
    approvalId: string;
    executionId: string;
    type: string;
    runtime: string;
    goalDescription: string;
    scriptPreview: string;
    fullScript: string;
    scriptLength: number;
    message: string;
}

export function HITLApproval() {
    const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
    const [goalApproval, setGoalApproval] = useState<GoalApproval | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [showFullScript, setShowFullScript] = useState(false);

    useEffect(() => {
        const socket = getSocket();

        // Listen for orchestrator plan preview events
        const handlePlanPreview = (event: any) => {
            console.log('[HITL] Received plan preview:', event);
            const plan = event.payload || event;
            setPendingPlan(plan);
        };

        // Listen for GoalExecutor script approval events
        const handleGoalApproval = (event: any) => {
            console.log('[HITL] Received goal approval request:', event);
            const data = event.payload || event;
            setGoalApproval(data);
        };

        socket.on('plan:preview', handlePlanPreview);
        socket.on('goal:approval-needed', handleGoalApproval);

        // Also listen for custom event from websocket middleware
        const handleCustomEvent = (e: CustomEvent) => {
            setPendingPlan(e.detail);
        };
        window.addEventListener('hitl:plan-pending', handleCustomEvent as EventListener);

        return () => {
            socket.off('plan:preview', handlePlanPreview);
            socket.off('goal:approval-needed', handleGoalApproval);
            window.removeEventListener('hitl:plan-pending', handleCustomEvent as EventListener);
        };
    }, []);

    // === Orchestrator Plan Approval ===
    const handlePlanApprove = () => {
        if (!pendingPlan) return;
        setIsProcessing(true);
        const socket = getSocket();
        socket.emit('plan:approve', { plan_id: pendingPlan.plan_id });
        setTimeout(() => { setPendingPlan(null); setIsProcessing(false); }, 500);
    };

    const handlePlanReject = () => {
        if (!pendingPlan) return;
        setIsProcessing(true);
        const socket = getSocket();
        socket.emit('plan:reject', { plan_id: pendingPlan.plan_id, reason: 'User rejected' });
        setTimeout(() => { setPendingPlan(null); setIsProcessing(false); }, 500);
    };

    // === Goal Executor Script Approval ===
    const handleGoalApprove = async () => {
        if (!goalApproval) return;
        setIsProcessing(true);
        try {
            await fetch(`${API_BASE}/api/autonomous/goal/approval/${goalApproval.approvalId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ approved: true })
            });
        } catch (e) {
            console.error('[HITL] Failed to send goal approval:', e);
        }
        // Clear immediately — setTimeout had a race condition where a new approval
        // event arriving within 500ms would be wiped out by the delayed setState(null).
        setGoalApproval(null);
        setIsProcessing(false);
        setShowFullScript(false);
    };

    const handleGoalReject = async () => {
        if (!goalApproval) return;
        setIsProcessing(true);
        try {
            await fetch(`${API_BASE}/api/autonomous/goal/approval/${goalApproval.approvalId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ approved: false })
            });
        } catch (e) {
            console.error('[HITL] Failed to send goal rejection:', e);
        }
        setGoalApproval(null);
        setIsProcessing(false);
        setShowFullScript(false);
    };

    // Nothing to show
    if (!goalApproval && !pendingPlan) return null;

    // Shared backdrop wrapper — renders via portal directly into document.body
    // so no ancestor stacking context can affect it.
    const modal = goalApproval ? (
        /* ── Script Execution Approval ── */
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            {/* Card */}
            <div className="relative bg-card border-2 border-yellow-500/50 rounded-xl shadow-2xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0" />
                    <span className="font-semibold text-yellow-500">Script Execution Approval</span>
                    <span className="ml-auto text-xs bg-muted px-2 py-0.5 rounded shrink-0">
                        {goalApproval.runtime} · {goalApproval.scriptLength} chars
                    </span>
                </div>

                {/* Description */}
                <div className="mb-3">
                    <p className="text-sm text-foreground font-medium">{goalApproval.message}</p>
                    <p className="text-xs text-muted-foreground mt-1">Goal: {goalApproval.goalDescription}</p>
                </div>

                {/* Script Preview */}
                <div className="bg-muted/50 rounded-md p-3 mb-4 max-h-60 overflow-y-auto">
                    <div className="flex items-center justify-between mb-2">
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Code className="w-3 h-3" /> Script Preview:
                        </div>
                        <button onClick={() => setShowFullScript(!showFullScript)} className="text-xs text-primary hover:underline">
                            {showFullScript ? 'Show less' : 'Show full script'}
                        </button>
                    </div>
                    <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-relaxed">
                        {showFullScript ? goalApproval.fullScript : goalApproval.scriptPreview}
                    </pre>
                </div>

                {/* Buttons */}
                <div className="flex gap-2">
                    <button onClick={handleGoalApprove} disabled={isProcessing}
                        className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-50">
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                        Approve &amp; Execute
                    </button>
                    <button onClick={handleGoalReject} disabled={isProcessing}
                        className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-50">
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                        Reject
                    </button>
                </div>
                <p className="text-xs text-muted-foreground text-center mt-2">Auto-rejects in 10 minutes if not approved</p>
            </div>
        </div>
    ) : (
        /* ── Action Approval Required (plan:preview) ── */
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            {/* Card */}
            <div className="relative bg-card border-2 border-yellow-500/50 rounded-xl shadow-2xl p-5 w-full max-w-lg">
                {/* Header */}
                <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="w-5 h-5 text-yellow-500" />
                    <span className="font-semibold text-yellow-500">Action Approval Required</span>
                </div>

                {/* Description */}
                <div className="mb-3">
                    <p className="text-sm text-foreground font-medium">{pendingPlan!.description}</p>
                </div>

                {/* Steps */}
                <div className="bg-muted/50 rounded-md p-3 mb-4 max-h-48 overflow-y-auto">
                    <div className="text-xs text-muted-foreground mb-2">Planned Steps:</div>
                    {pendingPlan!.steps.map((step, index) => (
                        <div key={step.id} className="flex items-start gap-2 text-sm mb-1.5">
                            <span className="text-muted-foreground shrink-0">{index + 1}.</span>
                            <span className="text-foreground">
                                <code className="bg-primary/20 px-1 rounded text-xs">{step.action}</code>
                                {step.description && <span className="ml-1 text-muted-foreground">— {step.description}</span>}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Buttons */}
                <div className="flex gap-2">
                    <button onClick={handlePlanApprove} disabled={isProcessing}
                        className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-50">
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                        Approve
                    </button>
                    <button onClick={handlePlanReject} disabled={isProcessing}
                        className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white py-2.5 px-4 rounded-lg font-medium transition-colors disabled:opacity-50">
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                        Reject
                    </button>
                </div>
                <p className="text-xs text-muted-foreground text-center mt-2">Auto-rejects in 5 minutes if not approved</p>
            </div>
        </div>
    );

    // Portal into document.body — escapes all stacking contexts
    return createPortal(modal, document.body);
}
