export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  order: number;
  type: 'file' | 'command' | 'mcp' | 'dependency';
  description: string;
  status: StepStatus;
  requiresConfirmation: boolean;
  toolCall?: {
    name: string;
    args: any;
  };
}

export interface ExecutionPlan {
  id: string;
  title: string;
  description: string;
  steps: PlanStep[];
  estimatedDuration: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'proposed' | 'approved' | 'executing' | 'completed' | 'failed' | 'cancelled';
}

export interface RichContent {
  type: 'text' | 'plan' | 'code' | 'tool_result' | 'image';
  text?: string;
  plan?: ExecutionPlan;
  code?: {
    language: string;
    content: string;
    isRunnable?: boolean;
  };
  toolResult?: {
    toolName: string;
    output: any;
    isError?: boolean;
  };
  image?: {
    base64: string;
    alt?: string;
    mimeType?: string;
  };
}
