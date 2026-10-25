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

export interface SandboxProject {
  /** Display name of the project. */
  name: string;
  /** Host folder bind-mounted at /workspace — the user's real project. */
  path: string;
  /** Mount the project folder read-only (agent can read, not write). */
  readOnly?: boolean;
}

export interface SandboxRecord {
  id: string;
  name: string;
  command: string[];
  mode: SandboxMode;
  status: SandboxStatus;
  /** Interactive sandboxes run a keepalive and are driven via exec sessions; they persist across stop/restart. */
  interactive: boolean;
  project?: SandboxProject;
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
  /** Empty command creates an interactive workspace (keepalive + exec terminals). */
  command?: string[];
  env?: Record<string, string>;
  mode?: SandboxMode;
  enforceDefault?: "allow" | "deny";
  /** Host directory whose contents are copied into the sandbox workspace before start. */
  workspace?: string;
  /** Lines fed to the agent's stdin at startup (drives interactive REPL agents). */
  stdin?: string;
  /** Open a real host folder as the project (bind-mounted, local daemon only). */
  project?: SandboxProject;
}
