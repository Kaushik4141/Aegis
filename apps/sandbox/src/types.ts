export type SandboxMode = "observe" | "enforce";
export type SandboxStatus = "running" | "exited" | "stopped" | "created";

export type SandboxEventType =
  | "net_connect"
  | "dns_lookup"
  | "file_write"
  | "process"
  | "exec"
  | "alert"
  | "lifecycle"
  | "enforce_rule";

export interface SandboxEventInput {
  type: SandboxEventType;
  detail: Record<string, unknown>;
  ts: string;
}

export interface SandboxEvent extends SandboxEventInput {
  id: string;
  sandboxId: string;
}

export interface SandboxRecord {
  id: string;
  name: string;
  command: string[];
  mode: SandboxMode;
  status: SandboxStatus;
  createdAt: string;
  updatedAt: string;
  exitCode?: number;
  report?: {
    filesystem?: Array<{ kind: string; path: string }>;
    eventCounts?: Record<string, number>;
  };
}

export interface CreateSandboxInput {
  name: string;
  command: string[];
  env?: Record<string, string>;
  mode?: SandboxMode;
  enforceDefault?: "allow" | "deny";
}
