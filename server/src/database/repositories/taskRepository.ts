import { db } from '../index';

export interface ExecutionPlan {
    id: string;
    conversationId: string;
    title: string;
    status: 'pending' | 'approved' | 'running' | 'completed' | 'failed' | 'cancelled';
    riskLevel: string;
    estimatedDuration: number;
    createdAt?: string;
    steps: PlanStep[];
}

export interface PlanStep {
    id: string;
    planId: string;
    stepNumber: number;
    description: string;
    toolName: string;
    parameters: any;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    requiresApproval: boolean;
    result?: any;
    error?: string;
}

export class TaskRepository {
    async createPlan(plan: ExecutionPlan): Promise<void> {
        await db.run(
            `INSERT INTO execution_plans (id, conversation_id, title, status, risk_level, estimated_duration)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [plan.id, plan.conversationId, plan.title, plan.status, plan.riskLevel, plan.estimatedDuration]
        );

        let stepNum = 1;
        for (const step of plan.steps) {
            // Ensure step number is set if not
            step.stepNumber = step.stepNumber || stepNum++;
            await this.createStep(step);
        }
    }

    async createStep(step: PlanStep): Promise<void> {
        await db.run(
            `INSERT INTO plan_steps (id, plan_id, step_number, description, tool_name, parameters, requires_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [step.id, step.planId, step.stepNumber, step.description, step.toolName, JSON.stringify(step.parameters), step.requiresApproval ? 1 : 0]
        );
    }

    async updatePlanStatus(planId: string, status: string, error?: string): Promise<void> {
        const timestamp = new Date().toISOString();
        if (status === 'running') {
            await db.run(
                'UPDATE execution_plans SET status = ?, started_at = ? WHERE id = ?',
                [status, timestamp, planId]
            );
        } else if (status === 'completed' || status === 'failed') {
            await db.run(
                'UPDATE execution_plans SET status = ?, completed_at = ?, error = ? WHERE id = ?',
                [status, timestamp, error || null, planId]
            );
        } else {
            await db.run(
                'UPDATE execution_plans SET status = ? WHERE id = ?',
                [status, planId]
            );
        }
    }

    async updateStepStatus(stepId: string, status: string, result?: any, error?: string): Promise<void> {
        const timestamp = new Date().toISOString();
        if (status === 'running') {
            await db.run(
                'UPDATE plan_steps SET status = ?, started_at = ? WHERE id = ?',
                [status, timestamp, stepId]
            );
        } else if (status === 'completed' || status === 'failed') {
            await db.run(
                'UPDATE plan_steps SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?',
                [status, result ? JSON.stringify(result) : null, error || null, timestamp, stepId]
            );
        } else {
            await db.run(
                'UPDATE plan_steps SET status = ? WHERE id = ?',
                [status, stepId]
            );
        }
    }

    async getPlan(planId: string): Promise<ExecutionPlan | null> {
        const plan = await db.get('SELECT * FROM execution_plans WHERE id = ?', [planId]);

        if (!plan) return null;

        const steps = await db.all(
            'SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_number',
            [planId]
        );

        return {
            id: plan.id,
            conversationId: plan.conversation_id,
            title: plan.title,
            status: plan.status,
            riskLevel: plan.risk_level,
            estimatedDuration: plan.estimated_duration,
            createdAt: plan.created_at,
            steps: steps.map(s => ({
                id: s.id,
                planId: s.plan_id,
                stepNumber: s.step_number,
                description: s.description,
                toolName: s.tool_name,
                parameters: JSON.parse(s.parameters),
                status: s.status,
                requiresApproval: Boolean(s.requires_approval),
                result: s.result ? JSON.parse(s.result) : undefined,
                error: s.error
            })),
        };
    }
    async getRunningPlans(): Promise<ExecutionPlan[]> {
        const plans = await db.all("SELECT * FROM execution_plans WHERE status = 'running'");
        const results: ExecutionPlan[] = [];

        for (const plan of plans) {
            const fullPlan = await this.getPlan(plan.id);
            if (fullPlan) results.push(fullPlan);
        }

        return results;
    }
}
