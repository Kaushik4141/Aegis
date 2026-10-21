export type EnterpriseTarget = "sql" | "s3" | "git" | "github" | "datadog" | "host";

export interface ActionAnalysis {
  target: EnterpriseTarget;
  operation: string;
  dryRun: boolean;
  risk: "low" | "medium" | "high";
  summary: string;
  affected?: number;
  preview?: Record<string, unknown>[];
  warnings: string[];
  plan: string[];
}

export interface ExecutionResult {
  executed: boolean;
  target: EnterpriseTarget;
  operation: string;
  dryRun: boolean;
  summary: string;
  data?: unknown;
  warnings?: string[];
  error?: string;
}

export interface PendingActionEvent {
  type: "action.created" | "action.updated" | "action.resolved";
  actionId: string;
  action: unknown;
  timestamp: string;
}
