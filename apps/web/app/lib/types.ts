"use client";

/** Shared types across the control-plane views. */

export type View = "agents" | "activity" | "approvals" | "settings";

export type ActionStatus =
  | "allowed"
  | "pending_approval"
  | "approved"
  | "blocked"
  | "frozen";

export interface ActionRecord {
  id: string;
  action: string;
  actorId?: string;
  resource?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  status: ActionStatus;
  decision?: { outcome?: string; reason?: string; riskScore?: number; labels?: string[]; policy?: string };
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  resolutionNote?: string;
}

export interface FeedItem {
  kind: "action" | "sandbox_event";
  id: string;
  ts: string;
  actor: string;
  title?: string;
  resource?: string;
  status?: ActionStatus;
  riskScore?: number;
  labels?: string[];
  payload?: unknown;
  type?: string;
  detail?: Record<string, unknown>;
}

export type SandboxMode = "observe" | "enforce";

export interface SandboxRecordUi {
  id: string;
  name: string;
  command: string[];
  mode: SandboxMode | string;
  status: string;
  interactive?: boolean;
  project?: { name: string; path: string; readOnly?: boolean };
  homeProfile?: boolean;
  exitCode?: number;
  report?: { filesystem?: Array<{ kind: string; path: string }>; eventCounts?: Record<string, number> };
  createdAt: string;
  updatedAt: string;
}

export interface SandboxEventUi {
  id: string;
  type: string;
  detail: Record<string, unknown>;
  ts: string;
}

export const SANDBOX_TEMPLATES = [
  { id: "shell", label: "Shell", command: "" },
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
  { id: "antigravity", label: "Antigravity", command: "agy" },
] as const;

export const actorDisplayName = (actor: string): string => {
  const id = actor.toLowerCase();
  if (id.startsWith("mcp:") || id === "mcp-client" || id.includes("antigravity")) return "Antigravity";
  if (id.includes("claude")) return "Claude Code";
  if (id.includes("cursor")) return "Cursor";
  if (id.includes("codex")) return "Codex";
  if (id.startsWith("sb_")) return `sandbox ${actor.slice(3, 11)}`;
  return actor || "agent";
};
