// Shared Event Types (Server <-> Client)

export interface ExecutionPlan {
  id: string;
  title: string;
  description: string;
  steps: PlanStep[];
  estimatedDuration: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'proposed' | 'approved' | 'executing' | 'completed' | 'failed' | 'cancelled';
}

export interface PlanStep {
  id: string;
  order: number;
  type: string;
  description: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  requiresConfirmation: boolean;
}

export interface ServerToClientEvents {
  'message:stream': (data: { id: string; role: 'user' | 'assistant'; content: string; richContent?: any; timestamp: Date }) => void;
  'plan:preview': (plan: ExecutionPlan) => void;
  'ooda:event': (data: { phase: string; message: string; details?: any; timestamp: Date }) => void;
  'task:progress': (data: { taskId: string; progress: number; message: string }) => void;
  'code:output': (data: { type: 'stdout' | 'stderr'; data: string; timestamp: number }) => void;
  'context:update': (data: { tokenCount: number; tokenLimit: number; percentage: number }) => void;
}

export interface ClientToServerEvents {
  'message:send': (data: { content: string }) => void;
  'plan:approve': (planId: string) => void;
  'plan:cancel': (planId: string) => void;
}
