"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import {
  Activity,
  AlertTriangle,
  Bot,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Copy,
  Database,
  FileKey2,
  Github,
  GripVertical,
  KeyRound,
  LayoutGrid,
  Link2,
  LockKeyhole,
  Menu,
  Network,
  Pause,
  Plus,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type GatewayState = "idle" | "allowed" | "approved" | "pending_approval" | "blocked" | "frozen";
type Transport = "stdio" | "streamable-http" | "sse";
type View = "topology" | "connections" | "sandboxes";

type Action = {
  id: string;
  actorId: string;
  tool: string;
  target: string;
  targetTitle: string;
  resource: string;
  summary: string;
  state: GatewayState;
  score: number;
  timestamp: string;
  payload?: unknown;
};

type AuditEvent = {
  id: string;
  type: string;
  actionId: string;
  timestamp: string;
  actorId?: string;
  reason?: string;
  toStatus: string;
};

type Connection = {
  id: string;
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
  secretKeys: string[];
  hasSecrets: boolean;
  token?: string;
};

type OAuthStatus = {
  configured?: boolean;
  supported?: boolean;
  authorized?: boolean;
  pending?: boolean;
  error?: string;
  tokenExpiresAt?: string;
  clientRegistration?: string;
};

type OAuthDisplay = {
  label: "not connected" | "signing in" | "connected" | "needs reauth" | "unavailable";
  tone: "red" | "amber" | "green" | "slate";
  detail: string;
};

type Tool = { name: string; description?: string; inputSchema?: unknown };
type Discovery = { tools?: Tool[]; serverInfo?: { name?: string; version?: string }; instructions?: string };
type ClientConfig = {
  connectionId: string;
  mcp: { url: string; headers?: Record<string, string> };
  claudeDesktop: Record<string, unknown>;
  cursor: Record<string, unknown>;
  note?: string;
};

type DbSummary = {
  customers: number;
  billing: number;
  bucketCount: number;
  gitBranch: string;
};

type FormState = {
  name: string;
  transport: Transport;
  url: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  auth: string;
};

const emptyForm: FormState = {
  name: "",
  transport: "streamable-http",
  url: "",
  command: "",
  args: "",
  cwd: "",
  env: "",
  auth: "",
};

const toneForState = (state: GatewayState): "red" | "amber" | "green" | "slate" | "blue" =>
  state === "blocked"
    ? "red"
    : state === "allowed" || state === "approved"
    ? "green"
    : state === "pending_approval" || state === "frozen"
    ? "amber"
    : "slate";

const badgeClass = (tone: "red" | "amber" | "green" | "slate" | "blue") =>
  ({
    red: "bg-red-50 text-red-700 ring-red-100",
    amber: "bg-amber-50 text-amber-700 ring-amber-100",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    slate: "bg-slate-100 text-slate-600 ring-slate-200",
    blue: "bg-blue-50 text-blue-700 ring-blue-100",
  }[tone]);

function oauthDisplay(connection: Connection, status?: OAuthStatus): OAuthDisplay {
  if (connection.transport === "stdio") return { label: "unavailable", tone: "slate", detail: "OAuth is not used for stdio connections." };
  if (!status) return { label: "not connected", tone: "slate", detail: "No account is connected yet." };
  if (status.pending) return { label: "signing in", tone: "amber", detail: "Waiting for sign-in to finish in the browser." };
  if (status.error || status.supported === false) return { label: "unavailable", tone: "red", detail: status.error || "This MCP server does not advertise OAuth." };
  if (status.authorized && status.tokenExpiresAt && new Date(status.tokenExpiresAt).getTime() <= Date.now()) return { label: "needs reauth", tone: "amber", detail: "The saved OAuth session has expired." };
  if (status.authorized) return { label: "connected", tone: "green", detail: "OAuth account connected." };
  return { label: "not connected", tone: "slate", detail: "Connect an account to authorize this MCP server." };
}

function StatusPill({ children, tone = "slate", dot = false }: { children: React.ReactNode; tone?: "red" | "amber" | "green" | "slate" | "blue"; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] ring-1 ${badgeClass(tone)}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-slate-200 bg-white shadow-panel ${className}`}>{children}</section>;
}

function SectionHeading({ icon, eyebrow, title, action }: { icon?: React.ReactNode; eyebrow?: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="flex items-start gap-3">
        {icon && <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">{icon}</div>}
        <div>
          {eyebrow && <p className="text-[9px] font-extrabold uppercase tracking-[.16em] text-slate-400">{eyebrow}</p>}
          <h2 className="mt-1 text-[13px] font-extrabold text-slate-900">{title}</h2>
        </div>
      </div>
      {action}
    </div>
  );
}

function parseMap(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=") >= 0 ? line.indexOf("=") : line.indexOf(":");
      return index > 0 ? ([line.slice(0, index).trim(), line.slice(index + 1).trim()] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function nameFromUrl(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "") || "MCP server";
  } catch {
    return "MCP server";
  }
}

function normalizeActorName(actorId?: string): string {
  if (!actorId) return "Antigravity";
  const id = actorId.toLowerCase();
  if (id === "mcp-client" || id.includes("antigravity")) return "Antigravity";
  if (id.includes("claude")) return "Claude Code";
  if (id.includes("cursor")) return "Cursor";
  if (id.includes("codex")) return "Codex";
  return actorId;
}

function apiAction(raw: Record<string, unknown>, connections: Connection[] = []): Action {
  if (!raw || typeof raw !== "object") {
    return {
      id: "action_unknown",
      actorId: "antigravity",
      tool: "action",
      target: "target_cloudflare_d1",
      targetTitle: "Cloudflare D1 (Cloud)",
      resource: "enterprise",
      summary: "Live gateway action",
      state: "idle",
      score: 0,
      timestamp: "just now",
    };
  }
  const analysis = (raw.analysis && typeof raw.analysis === "object" ? raw.analysis : {}) as Record<string, unknown>;
  const decision = (raw.decision && typeof raw.decision === "object" ? raw.decision : {}) as Record<string, unknown>;
  const payload = (raw.payload && typeof raw.payload === "object" ? raw.payload : {}) as Record<string, unknown>;
  const actorId = String(raw.actorId || "antigravity");
  const tool = String(raw.action || payload.tool || "action");
  const resource = String(raw.resource || analysis.target || "enterprise");
  const text = `${tool} ${resource}`.toLowerCase();

  let target = "target_telemetry";
  let targetTitle = "Host Telemetry";

  const connId = String(payload.connectionId || "");
  const matchedConn = connections.find(
    (c) => c.id === connId || resource.includes(c.id) || text.includes(c.name.toLowerCase())
  );

  if (matchedConn) {
    target = `target_conn_${matchedConn.id}`;
    targetTitle = matchedConn.name === "mcp.cloudflare.com" ? "Cloudflare MCP" : matchedConn.name;
  } else if (text.includes("cloudflare") || text.includes("d1") || text.includes("customer") || text.includes("billing") || text.includes("sql")) {
    target = "target_cloudflare_d1";
    targetTitle = "Cloudflare D1 (Cloud)";
  } else if (text.includes("s3") || text.includes("bucket")) {
    target = "target_s3";
    targetTitle = "Local S3 Bucket";
  } else if (text.includes("git") || text.includes("repo")) {
    target = "target_git";
    targetTitle = "Git Repository";
  }

  const score = Number(decision.riskScore ?? (analysis.risk === "high" ? 90 : analysis.risk === "medium" ? 60 : 15));
  return {
    id: String(raw.id),
    actorId,
    tool,
    target,
    targetTitle,
    resource,
    summary: String(analysis.summary || decision.reason || "Live gateway action"),
    state: (raw.status as GatewayState) || "pending_approval",
    score,
    timestamp: raw.updatedAt ? new Date(String(raw.updatedAt)).toLocaleTimeString() : "just now",
    payload: raw.payload,
  };
}

type IdentityData = { name: string; email: string };
type AgentData = { state: GatewayState; agentName: string; activeTargetTitle?: string };
type TargetData = {
  id: string;
  title: string;
  subtitle: string;
  tone: "red" | "amber" | "green" | "blue";
  icon: React.ReactNode;
  children: React.ReactNode;
  state?: GatewayState;
  isActive?: boolean;
};

type IdentityFlowNode = Node<IdentityData, "identity">;
type AgentFlowNode = Node<AgentData, "agent">;
type TargetFlowNode = Node<TargetData, "target">;

function NodeFrame({ children, warning = false, className = "" }: { children: React.ReactNode; warning?: boolean; className?: string }) {
  return (
    <div className={`relative rounded-xl border bg-white shadow-panel transition-all ${warning ? "border-red-300 ring-2 ring-red-100" : "border-slate-200"} ${className}`}>
      {children}
    </div>
  );
}

function IdentityNode({ data }: NodeProps<IdentityFlowNode>) {
  return (
    <NodeFrame className="w-[230px] overflow-hidden">
      <Handle type="source" position={Position.Right} />
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-900 text-white">
          <UserRound size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-slate-900">{data.name}</p>
          <p className="mt-0.5 text-[10px] font-medium text-slate-500">Identity root · live host</p>
        </div>
      </div>
      <div className="border-t border-slate-100 bg-rose-50/70 px-4 py-2.5">
        <StatusPill tone="red">Host · {data.email}</StatusPill>
      </div>
    </NodeFrame>
  );
}

function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const isPendingOrFrozen = data.state === "pending_approval" || data.state === "frozen";
  const isBlocked = data.state === "blocked";
  const active = isPendingOrFrozen || isBlocked;
  return (
    <div className={active ? "action-pulse rounded-[14px]" : ""}>
      <NodeFrame warning={active} className="w-[245px]">
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
        <div className="flex items-center gap-3 px-4 py-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#171923] text-white">
            <Sparkles size={18} className="text-cyan-300" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-bold text-slate-900">{data.agentName}</p>
            <p className="mt-0.5 truncate text-[10px] font-medium text-slate-500">
              {data.activeTargetTitle ? `Target: ${data.activeTargetTitle}` : "Active gateway client"}
            </p>
          </div>
          {active && <span className="ml-auto h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />}
        </div>
        <div className="border-t border-slate-100 px-4 py-2.5">
          <StatusPill tone={toneForState(data.state)} dot>
            {data.state === "idle" ? "Ready · No active call" : data.state.replace("_", " ")}
          </StatusPill>
        </div>
      </NodeFrame>
    </div>
  );
}

function TargetNode({ data }: NodeProps<TargetFlowNode>) {
  const isPendingOrFrozen = data.state === "pending_approval" || data.state === "frozen";
  const isBlocked = data.state === "blocked";
  const hasWarning = (isPendingOrFrozen || isBlocked) && data.isActive;

  return (
    <NodeFrame warning={hasWarning} className={`w-[268px] overflow-hidden ${data.isActive ? "ring-2 ring-blue-500/50 shadow-md" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ${data.isActive ? "bg-blue-50 text-blue-600 ring-blue-200" : "bg-slate-50 text-slate-700 ring-slate-200"}`}>
          {data.icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-bold text-slate-900">{data.title}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                data.tone === "red"
                  ? "bg-red-500"
                  : data.tone === "green"
                  ? "bg-emerald-500"
                  : data.tone === "blue"
                  ? "bg-blue-500"
                  : "bg-amber-400"
              }`}
            />
            {data.subtitle}
          </p>
        </div>
        {data.isActive && (
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${isPendingOrFrozen || isBlocked ? "animate-pulse bg-red-500" : "animate-ping bg-emerald-500"}`} />
        )}
      </div>
      <div className="border-t border-slate-100 px-4 py-2.5 text-[10px] font-medium text-slate-500">{data.children}</div>
    </NodeFrame>
  );
}

function buildTopology(
  state: GatewayState,
  identity: IdentityData,
  connections: Connection[],
  summary: DbSummary,
  selectedAction: Action | null,
  activeAgentName: string
): { nodes: Node[]; edges: Edge[] } {
  const activeTargetId = selectedAction?.target || "target_cloudflare_d1";

  // Build target list dynamically
  const targets: TargetData[] = [
    {
      id: "target_cloudflare_d1",
      title: "Cloudflare D1 (Cloud)",
      subtitle: "d1 · sentinelgate-d1 (Singapore)",
      tone: "green",
      icon: <Database size={15} />,
      children: (
        <span className="font-mono text-[9px] leading-5 text-slate-500">
          ├── <b className="text-slate-700">CUSTOMERS</b> ({summary.customers} rows)<br />
          └── <b className="text-slate-700">BILLING</b> ({summary.billing} rows)
        </span>
      ),
    },
  ];

  // Add all registered dynamic MCP connections
  for (const conn of connections) {
    const isCloudflare = conn.name.includes("cloudflare");
    targets.push({
      id: `target_conn_${conn.id}`,
      title: isCloudflare ? "Cloudflare MCP" : conn.name,
      subtitle: `${conn.transport} · ${conn.name}`,
      tone: "blue",
      icon: isCloudflare ? <Cloud size={15} /> : <Server size={15} />,
      children: isCloudflare ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[9px]">
            <span className="font-semibold text-slate-700">Cloud API Proxy</span>
            <span className="rounded bg-blue-50 px-1 py-0.5 text-[8px] font-bold text-blue-600">Active</span>
          </div>
          <p className="truncate font-mono text-[9px] text-slate-400">tools: docs, search, execute, whoami</p>
        </div>
      ) : (
        <span className="truncate block font-mono text-[9px] text-slate-500">
          {conn.transport === "stdio" ? [conn.command, ...(conn.args || [])].join(" ") : conn.url}
        </span>
      ),
    });
  }

  // Add Local Enterprise Targets
  targets.push(
    {
      id: "target_s3",
      title: "Local S3 Storage",
      subtitle: "s3 · customer-pii bucket",
      tone: "amber",
      icon: <Cloud size={15} />,
      children: (
        <span>
          <b className="text-slate-700">customer-pii</b> · {summary.bucketCount} export files
        </span>
      ),
    },
    {
      id: "target_git",
      title: "Git Repository",
      subtitle: "git · data/acme-repo",
      tone: "amber",
      icon: <Github size={15} />,
      children: <span>Protected branch: {summary.gitBranch}</span>,
    },
    {
      id: "target_telemetry",
      title: "Host Telemetry",
      subtitle: "system · host monitor",
      tone: "green",
      icon: <Activity size={15} />,
      children: (
        <span className="flex items-center gap-1.5">
          <ShieldCheck size={12} className="text-emerald-600" />
          <span>Host credentials & telemetry isolated</span>
        </span>
      ),
    }
  );

  const spacing = 135;
  const totalHeight = targets.length * spacing;
  const centerY = Math.max(180, (totalHeight / 2) - 30);

  const nodes: Node[] = [
    {
      id: "identity",
      type: "identity",
      position: { x: 20, y: centerY },
      data: identity,
    },
    {
      id: "agent",
      type: "agent",
      position: { x: 310, y: centerY - 10 },
      data: {
        state,
        agentName: activeAgentName,
        activeTargetTitle: selectedAction?.targetTitle,
      },
    },
  ];

  targets.forEach((target, index) => {
    const isActive = target.id === activeTargetId;
    nodes.push({
      id: target.id,
      type: "target",
      position: { x: 670, y: 30 + index * spacing },
      data: {
        ...target,
        isActive,
        state: isActive ? state : "idle",
      },
    });
  });

  // Build edges
  const edges: Edge[] = [
    {
      id: "e_identity_agent",
      source: "identity",
      target: "agent",
      style: { stroke: "#94a3b8", strokeWidth: 1.8 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 14, height: 14 },
    },
  ];

  const edgeTone =
    state === "pending_approval" || state === "frozen"
      ? "#f59e0b"
      : state === "blocked"
      ? "#ef4444"
      : state === "allowed" || state === "approved"
      ? "#10b981"
      : "#94a3b8";

  targets.forEach((target) => {
    const isActive = target.id === activeTargetId && state !== "idle";
    edges.push({
      id: `e_agent_${target.id}`,
      source: "agent",
      target: target.id,
      animated: isActive,
      style: {
        stroke: isActive ? edgeTone : "#cbd5e1",
        strokeWidth: isActive ? 2.6 : 1.4,
        ...(isActive ? { strokeDasharray: "6 6" } : {}),
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: isActive ? edgeTone : "#cbd5e1",
        width: 14,
        height: 14,
      },
    });
  });

  return { nodes, edges };
}

function NavIcon({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      className={`grid h-9 w-9 place-items-center rounded-lg transition ${
        active ? "bg-slate-900 text-white" : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

function ConnectionForm({
  form,
  setForm,
  onSubmit,
  busy,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onSubmit: (event: React.FormEvent) => void;
  busy: boolean;
}) {
  const update = (key: keyof FormState, value: string) =>
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "url" && !current.name.trim() ? { name: nameFromUrl(value) } : {}),
    }));

  return (
    <form onSubmit={onSubmit} className="space-y-3 p-5">
      <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
        <label className="field-label">
          Connection name <span className="font-normal normal-case tracking-normal text-slate-400">optional for HTTP</span>
          <input
            required={form.transport === "stdio"}
            value={form.name}
            onChange={(event) => update("name", event.target.value)}
            placeholder="e.g. Linear MCP"
            className="field-input"
          />
        </label>
        <label className="field-label">
          Transport
          <select value={form.transport} onChange={(event) => update("transport", event.target.value as Transport)} className="field-input">
            <option value="streamable-http">Streamable HTTP</option>
            <option value="sse">SSE</option>
            <option value="stdio">stdio</option>
          </select>
        </label>
      </div>
      {form.transport === "stdio" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            Command
            <input required value={form.command} onChange={(event) => update("command", event.target.value)} placeholder="npx" className="field-input font-mono" />
          </label>
          <label className="field-label">
            Working directory
            <input value={form.cwd} onChange={(event) => update("cwd", event.target.value)} placeholder="/workspace" className="field-input font-mono" />
          </label>
          <label className="field-label sm:col-span-2">
            Arguments <span className="font-normal normal-case tracking-normal text-slate-400">(one per line)</span>
            <textarea
              value={form.args}
              onChange={(event) => update("args", event.target.value)}
              placeholder="-y\n@modelcontextprotocol/server-github"
              className="field-input min-h-[70px] font-mono"
            />
          </label>
        </div>
      ) : (
        <label className="field-label">
          Server URL
          <input required type="url" value={form.url} onChange={(event) => update("url", event.target.value)} placeholder="https://mcp.example.com/mcp" className="field-input font-mono" />
        </label>
      )}
      <label className="field-label">
        Environment <span className="font-normal normal-case tracking-normal text-slate-400">KEY=VALUE per line</span>
        <textarea value={form.env} onChange={(event) => update("env", event.target.value)} placeholder="GITHUB_OWNER=acme" className="field-input min-h-[76px] font-mono" />
      </label>
      <details className="advanced-auth rounded-xl border border-slate-200 bg-slate-50/70">
        <summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-extrabold uppercase tracking-[.08em] text-slate-500">Advanced: manual auth headers</summary>
        <div className="border-t border-slate-200 px-3 pb-3 pt-2">
          <p className="mb-2 text-[10px] leading-4 text-slate-500">OAuth is the recommended way to sign in. Use headers only for servers that do not support OAuth.</p>
          <textarea aria-label="Manual auth headers" value={form.auth} onChange={(event) => update("auth", event.target.value)} placeholder="Authorization=Bearer …" className="field-input min-h-[76px] font-mono" />
        </div>
      </details>
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <LockKeyhole size={12} className="text-emerald-600" />Credentials are never returned to the browser.
        </p>
        <button type="submit" disabled={busy} className="button-primary">
          <Plus size={14} />
          {busy ? "Connecting…" : form.transport === "stdio" ? "Register connection" : "Register & connect"}
        </button>
      </div>
    </form>
  );
}

async function standaloneOAuthConnect(connectionId: string, onStatus: (status: OAuthStatus) => void): Promise<void> {
  const popup = window.open("about:blank", "mcp-oauth", "popup,width=520,height=720");
  try {
    const response = await fetch(`/api/v1/connections/${connectionId}/oauth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = (await response.json()) as { authorizationUrl?: string; status?: OAuthStatus; error?: { message?: string } };
    if (!response.ok || !body.authorizationUrl) throw new Error(body.error?.message || "Unable to start OAuth sign-in.");
    if (body.status) onStatus(body.status);
    if (popup && !popup.closed) popup.location.href = body.authorizationUrl;
    else {
      window.location.assign(body.authorizationUrl);
      return;
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const statusResponse = await fetch(`/api/v1/connections/${connectionId}/oauth/status`, { cache: "no-store" });
      const statusBody = (await statusResponse.json()) as { status?: OAuthStatus };
      if (!statusResponse.ok || !statusBody.status) continue;
      onStatus(statusBody.status);
      if (statusBody.status.authorized) {
        await fetch("/api/v1/connections", { cache: "no-store" });
        await fetch(`/api/v1/connections/${connectionId}/test`, { method: "POST" });
        await fetch(`/api/v1/connections/${connectionId}/discover`, { method: "POST" });
        return;
      }
    }
  } catch (error) {
    onStatus({ supported: false, error: error instanceof Error ? error.message : "OAuth sign-in failed." });
  } finally {
    if (popup && !popup.closed) popup.close();
  }
}

function ConnectionsPanel({
  connections,
  selected,
  oauthStatuses: parentOAuthStatuses = {},
  onSelect,
  onConnect: parentOnConnect,
  onTest,
  onDiscover,
  onDelete,
  busy,
}: {
  connections: Connection[];
  selected: Connection | null;
  oauthStatuses?: Record<string, OAuthStatus>;
  onSelect: (connection: Connection) => void;
  onConnect?: () => void;
  onTest: () => void;
  onDiscover: () => void;
  onDelete: () => void;
  busy: string | null;
}) {
  const [localOAuthStatuses, setLocalOAuthStatuses] = useState<Record<string, OAuthStatus>>({});
  const oauthStatuses = { ...localOAuthStatuses, ...parentOAuthStatuses };
  const onConnect =
    parentOnConnect ||
    (() => {
      if (selected) void standaloneOAuthConnect(selected.id, (status) => setLocalOAuthStatuses((current) => ({ ...current, [selected.id]: status })));
    });
  const selectedOAuth = selected ? oauthDisplay(selected, oauthStatuses[selected.id]) : null;

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      connections
        .filter((connection) => connection.transport !== "stdio")
        .map(async (connection) => {
          try {
            const response = await fetch(`/api/v1/connections/${connection.id}/oauth/status`, { cache: "no-store" });
            const body = (await response.json()) as { status?: OAuthStatus };
            if (!cancelled && response.ok && body.status) setLocalOAuthStatuses((current) => ({ ...current, [connection.id]: body.status as OAuthStatus }));
          } catch {
            /* status remains not connected */
          }
        })
    );
    return () => {
      cancelled = true;
    };
  }, [connections]);

  return (
    <Panel className="overflow-hidden">
      <SectionHeading
        icon={<Link2 size={15} />}
        eyebrow="MCP registry"
        title="Registered connections"
        action={<span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-500">{connections.length} total</span>}
      />
      <div className="divide-y divide-slate-100">
        {connections.map((connection) => {
          const oauth = oauthDisplay(connection, oauthStatuses[connection.id]);
          return (
            <button
              type="button"
              key={connection.id}
              onClick={() => onSelect(connection)}
              className={`flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50 ${selected?.id === connection.id ? "bg-blue-50/50" : ""}`}
            >
              <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${connection.transport === "stdio" ? "bg-violet-50 text-violet-600" : "bg-cyan-50 text-cyan-600"}`}>
                {connection.transport === "stdio" ? <Terminal size={16} /> : <Server size={16} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-bold text-slate-800">{connection.name}</p>
                <p className="mt-1 truncate font-mono text-[10px] text-slate-400">
                  {connection.transport === "stdio" ? [connection.command, ...(connection.args || [])].join(" ") : connection.url}
                </p>
              </div>
              <div className="hidden items-center gap-2 sm:flex">
                {connection.hasSecrets && <KeyRound size={13} className="text-emerald-600" />}
                <StatusPill tone={oauth.tone} dot>
                  {oauth.label}
                </StatusPill>
              </div>
              <ChevronRight size={15} className="text-slate-300" />
            </button>
          );
        })}
        {connections.length === 0 && (
          <div className="p-8 text-center">
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-400">
              <Link2 size={18} />
            </div>
            <p className="mt-3 text-xs font-bold text-slate-700">No MCP connections yet</p>
            <p className="mt-1 text-[10px] text-slate-500">Register a server to discover its tools.</p>
          </div>
        )}
      </div>
      {selected && selectedOAuth && (
        <div className="border-t border-slate-200 bg-slate-50/70 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Selected connection</p>
              <p className="mt-1 text-sm font-bold text-slate-900">{selected.name}</p>
            </div>
            <button type="button" onClick={onDelete} disabled={busy === "delete"} className="button-danger">
              <Trash2 size={13} />
              Delete
            </button>
          </div>
          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-extrabold uppercase tracking-[.08em] text-slate-400">OAuth account</span>
              <StatusPill tone={selectedOAuth.tone} dot>
                {selectedOAuth.label}
              </StatusPill>
            </div>
            <p className="mt-2 text-[10px] leading-4 text-slate-500">{selectedOAuth.detail}</p>
            {selected.transport !== "stdio" && (
              <button type="button" onClick={onConnect} disabled={Boolean(busy)} className="button-primary mt-3 w-full justify-center">
                <Link2 size={13} />
                {busy === "oauth" ? "Waiting for sign-in…" : selectedOAuth.label === "connected" ? "Reconnect account" : "Connect account"}
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onTest} disabled={Boolean(busy)} className="button-secondary">
              <Zap size={13} />
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button type="button" onClick={onDiscover} disabled={Boolean(busy)} className="button-secondary">
              <RefreshCw size={13} />
              {busy === "discover" ? "Discovering…" : "Discover tools"}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function ClientConfigPanel({
  connection,
  config,
  onLoad,
  onCopy,
}: {
  connection: Connection | null;
  config: ClientConfig | null;
  onLoad: () => void;
  onCopy: (text: string) => void;
}) {
  if (!connection)
    return (
      <Panel className="flex min-h-[250px] items-center justify-center p-8 text-center">
        <div>
          <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-400">
            <Code2 size={18} />
          </div>
          <p className="mt-3 text-xs font-bold text-slate-700">Client configuration</p>
          <p className="mt-1 text-[10px] text-slate-500">Select a connection to generate secure proxy snippets.</p>
        </div>
      </Panel>
    );

  const url = config?.mcp.url || "";
  const headers = config?.mcp.headers || {};
  const headerArgs = Object.entries(headers)
    .map(([key, value]) => ` --header '${key}: ${value}'`)
    .join("");

  const snippets = config
    ? [
        {
          name: "Antigravity (.mcp.json)",
          text: JSON.stringify(
            {
              mcpServers: {
                [connection.name]: {
                  url,
                  ...(Object.keys(headers).length ? { headers } : {}),
                },
              },
            },
            null,
            2
          ),
        },
        {
          name: "Claude Code CLI",
          text: `claude mcp add --transport http${headerArgs} ${connection.name} ${url}`,
        },
        {
          name: "Cursor",
          text: JSON.stringify(config.cursor, null, 2),
        },
        {
          name: "Codex CLI",
          text: `codex mcp add ${connection.name} --url ${url}${Object.entries(headers)
            .map(([key, value]) => ` --header ${key}=${value}`)
            .join("")}`,
        },
      ]
    : [];

  return (
    <Panel className="overflow-hidden">
      <SectionHeading
        icon={<Code2 size={15} />}
        eyebrow="Client access"
        title="Generated configuration"
        action={
          <button type="button" onClick={onLoad} className="icon-button" title="Refresh configuration">
            <RefreshCw size={14} />
          </button>
        }
      />
      {!config ? (
        <div className="p-6">
          <button type="button" onClick={onLoad} className="button-primary">
            <Code2 size={14} />
            Generate snippets
          </button>
          <p className="mt-3 text-[10px] text-slate-500">Proxy credentials stay in Aegis; clients receive only the gateway URL.</p>
        </div>
      ) : (
        <div className="space-y-3 p-5">
          {snippets.map((snippet) => (
            <div key={snippet.name} className="rounded-xl border border-slate-200 bg-slate-950 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">{snippet.name}</span>
                <button
                  type="button"
                  onClick={() => onCopy(snippet.text)}
                  className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                  title="Copy snippet"
                >
                  <Copy size={13} />
                </button>
              </div>
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-5 text-cyan-200">
                {snippet.text}
              </pre>
            </div>
          ))}
          <p className="text-[10px] text-slate-500">{config.note || "The gateway enforces policy before forwarding tool calls."}</p>
        </div>
      )}
    </Panel>
  );
}

function ToolsPanel({ tools, discovery, onDiscover }: { tools: Tool[]; discovery: Discovery | null; onDiscover: () => void }) {
  return (
    <Panel className="overflow-hidden">
      <SectionHeading
        icon={<Zap size={15} />}
        eyebrow="MCP capability"
        title="Discovered tools"
        action={
          <button type="button" onClick={onDiscover} className="button-quiet">
            <RefreshCw size={12} />
            Refresh
          </button>
        }
      />
      {discovery?.serverInfo && (
        <div className="border-b border-slate-100 bg-emerald-50/60 px-5 py-3 text-[10px] text-emerald-800">
          <span className="font-bold">{discovery.serverInfo.name || "MCP server"}</span>
          {discovery.serverInfo.version && ` · v${discovery.serverInfo.version}`}
        </div>
      )}
      <div className="max-h-[275px] overflow-y-auto">
        {tools.map((tool) => (
          <div key={tool.name} className="border-b border-slate-100 px-5 py-3 last:border-0">
            <p className="font-mono text-[11px] font-bold text-slate-800">{tool.name}</p>
            <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-500">{tool.description || "No description provided by server."}</p>
          </div>
        ))}
        {tools.length === 0 && <div className="p-7 text-center text-[10px] text-slate-500">Run discovery to load this server&apos;s tools.</div>}
      </div>
    </Panel>
  );
}

function OperationsPanels({
  actions,
  audit,
  selectedId,
  setSelectedId,
  onRefresh,
}: {
  actions: Action[];
  audit: AuditEvent[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  onRefresh: () => void;
}) {
  const pending = actions.filter((action) => action.state === "pending_approval" || action.state === "frozen");

  return (
    <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr_1fr]">
      <Panel className="overflow-hidden">
        <SectionHeading
          icon={<Bot size={15} />}
          eyebrow="Live gateway stream"
          title="Agent activity"
          action={
            <button type="button" onClick={onRefresh} className="icon-button">
              <RefreshCw size={14} />
            </button>
          }
        />
        <div className="max-h-[280px] overflow-y-auto">
          {actions.slice(0, 8).map((action) => (
            <button
              type="button"
              key={action.id}
              onClick={() => setSelectedId(action.id)}
              className={`flex w-full items-center gap-3 border-b border-slate-100 px-5 py-3 text-left last:border-0 hover:bg-slate-50 ${
                action.id === selectedId ? "bg-blue-50/50" : ""
              }`}
            >
              <div
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${
                  action.state === "blocked"
                    ? "bg-red-50 text-red-600"
                    : action.state === "allowed" || action.state === "approved"
                    ? "bg-emerald-50 text-emerald-600"
                    : "bg-amber-50 text-amber-600"
                }`}
              >
                {action.state === "blocked" ? <X size={13} /> : action.state === "allowed" || action.state === "approved" ? <Check size={13} /> : <Activity size={13} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold text-slate-800">{action.tool}</p>
                <p className="mt-0.5 truncate text-[9px] text-slate-400">
                  {normalizeActorName(action.actorId)} · {action.targetTitle} · {action.timestamp}
                </p>
              </div>
              <StatusPill tone={toneForState(action.state)}>{action.state.replace("_", " ")}</StatusPill>
            </button>
          ))}
          {actions.length === 0 && <p className="p-7 text-center text-[10px] text-slate-500">Waiting for agent traffic.</p>}
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <SectionHeading
          icon={<AlertTriangle size={15} />}
          eyebrow="Human in the loop"
          title="Approval queue"
          action={
            <StatusPill tone={pending.length ? "amber" : "green"} dot>
              {pending.length} pending
            </StatusPill>
          }
        />
        <div className="max-h-[280px] overflow-y-auto">
          {pending.map((action) => (
            <button
              type="button"
              key={action.id}
              onClick={() => setSelectedId(action.id)}
              className="flex w-full items-center gap-3 border-b border-slate-100 px-5 py-3 text-left hover:bg-amber-50/40"
            >
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-600">
                <Pause size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold text-slate-800">{action.tool}</p>
                <p className="mt-0.5 truncate text-[9px] text-slate-400">
                  Risk {action.score}/100 · {action.summary}
                </p>
              </div>
              <ChevronRight size={13} className="text-slate-300" />
            </button>
          ))}
          {pending.length === 0 && <p className="p-7 text-center text-[10px] text-slate-500">No approvals waiting.</p>}
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <SectionHeading icon={<FileKey2 size={15} />} eyebrow="Immutable trail" title="Audit events" />
        <div className="max-h-[280px] overflow-y-auto">
          {audit.slice(0, 8).map((event) => (
            <div key={event.id} className="border-b border-slate-100 px-5 py-3 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold text-slate-700">{event.type.replace("action.", "")}</span>
                <span className="text-[9px] text-slate-400">{new Date(event.timestamp).toLocaleTimeString()}</span>
              </div>
              <p className="mt-1 truncate font-mono text-[9px] text-slate-400">
                {event.actionId} · {normalizeActorName(event.actorId)}
              </p>
              <p className="mt-1 line-clamp-1 text-[9px] text-slate-500">{event.reason || `Transitioned to ${event.toStatus}`}</p>
            </div>
          ))}
          {audit.length === 0 && <p className="p-7 text-center text-[10px] text-slate-500">Audit events will appear as the gateway processes calls.</p>}
        </div>
      </Panel>
    </div>
  );
}

const nodeTypes = {
  identity: IdentityNode,
  agent: AgentNode,
  target: TargetNode,
};

type SandboxRecordUi = {
  id: string;
  name: string;
  command: string[];
  mode: "observe" | "enforce" | string;
  status: string;
  interactive?: boolean;
  project?: { name: string; path: string; readOnly?: boolean };
  exitCode?: number;
  report?: { filesystem?: Array<{ kind: string; path: string }>; eventCounts?: Record<string, number> };
  createdAt: string;
  updatedAt: string;
};

type SandboxEventUi = { id: string; type: string; detail: Record<string, unknown>; ts: string };

const sandboxEventTone = (type: string): "red" | "amber" | "green" | "slate" | "blue" =>
  ({
    alert: "red",
    file_write: "amber",
    lifecycle: "green",
    enforce_rule: "red",
    net_connect: "blue",
    dns_lookup: "slate",
    process: "slate",
  }[type] as "red" | "amber" | "green" | "slate" | "blue") || "slate";

const splitCommand = (value: string): string[] =>
  (value.match(/"([^"]*)"|'([^']*)'|(\S+)/g) || []).map((part) => part.replace(/^["']|["']$/g, "")).filter(Boolean);

// Terminal WebSocket origin: same host by default; set NEXT_PUBLIC_SANDBOX_WS_URL
// (e.g. wss://sandboxes.example.com) when the dashboard is served from a
// different origin than the sandbox service — cloud deployments.
const SANDBOX_WS_BASE = process.env.NEXT_PUBLIC_SANDBOX_WS_URL?.trim() || null;

function sandboxTerminalUrl(sandboxId: string): string {
  const target = encodeURIComponent(sandboxId);
  if (SANDBOX_WS_BASE) return `${SANDBOX_WS_BASE.replace(/\/$/, "")}/sandboxes/${target}/terminal`;
  const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:${process.env.NEXT_PUBLIC_SANDBOX_WS_PORT || "8788"}/sandboxes/${target}/terminal`;
}

function SandboxTerminal({
  sandboxId,
  initialInput,
  onClosed,
  height = 430,
}: {
  sandboxId: string;
  /** Sent once when the session opens — used to auto-start an agent (e.g. "claude\n"). */
  initialInput?: string;
  onClosed: () => void;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const initialRef = useRef(initialInput);
  // Only the first initialInput per sandbox session matters; later prop
  // changes must not restart the terminal.
  if (initialRef.current === undefined && initialInput !== undefined) initialRef.current = initialInput;

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    const handleResize = () => {
      try { fit?.fit(); } catch { /* panel may be unmounting */ }
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;
      term = new Terminal({ fontSize: 11.5, cursorBlink: true, fontFamily: "var(--font-mono, monospace)", theme: { background: "#0b1020" } });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      socket = new WebSocket(sandboxTerminalUrl(sandboxId));
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        socket?.send(JSON.stringify({ t: "r", w: term?.cols || 100, h: term?.rows || 28 }));
        if (initialRef.current) socket?.send(JSON.stringify({ t: "i", d: initialRef.current }));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") term?.write(new Uint8Array(event.data));
      };
      socket.onclose = () => { term?.write("\r\n\x1b[90m— session ended —\x1b[0m\r\n"); closedRef.current(); };
      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "i", d: data }));
      });
      window.addEventListener("resize", handleResize);
    })();

    return () => {
      disposed = true;
      window.removeEventListener("resize", handleResize);
      socket?.close();
      term?.dispose();
    };
  }, [sandboxId]);

  return <div ref={hostRef} className="w-full overflow-hidden bg-[#0b1020]" style={{ height }} />;
}

function renderTimelineEvent(event: SandboxEventUi) {
  return (
    <div
      key={event.id}
      className={`mb-1.5 rounded-lg border px-3 py-2 ${
        event.type === "alert" ? "border-red-200 bg-red-50" : "border-slate-100 bg-slate-50/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <StatusPill tone={sandboxEventTone(event.type)}>{event.type.replace("_", " ")}</StatusPill>
        <span className="text-[9px] text-slate-400">{new Date(event.ts).toLocaleTimeString()}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[9px] text-slate-600">
        {event.type === "dns_lookup" && (event.detail.name as string)}
        {event.type === "net_connect" && `${event.detail.peer}:${event.detail.peerPort} (${event.detail.process || "unknown"})`}
        {event.type === "file_write" && `${event.detail.path}`}
        {event.type === "alert" && `${event.detail.kind} → ${event.detail.host}`}
        {event.type === "lifecycle" && `${event.detail.kind}${event.detail.code !== undefined ? ` (${event.detail.code})` : ""}`}
        {event.type === "process" && `${event.detail.kind === "start" ? "▲" : "▽"} ${event.detail.args}`}
        {event.type === "enforce_rule" && `${event.detail.kind} ${event.detail.ip}`}
      </p>
    </div>
  );
}

type SandboxNodeData = {
  sandbox: SandboxRecordUi;
  hasAlert: boolean;
  initialCommand?: string;
  onInspect: (id: string) => void;
  onSessionEnded: (id: string) => void;
};

const CANVAS_POSITIONS_KEY = "aegis-canvas-positions";
const canvasSlot = (slot: number) => ({ x: 40 + (slot % 2) * 660, y: 24 + Math.floor(slot / 2) * 430 });

const SANDBOX_TEMPLATES = [
  { id: "shell", label: "Shell", command: "" },
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
] as const;

/**
 * One agent workspace as a draggable canvas window: header is the drag
 * handle, the body hosts a live PTY terminal (nodrag/nowhell so clicks,
 * typing, and scrolling stay inside the terminal).
 */
function SandboxWindowNode({ data, selected }: NodeProps) {
  const { sandbox, hasAlert, initialCommand, onInspect, onSessionEnded } = data as SandboxNodeData;
  const running = sandbox.status === "running";
  return (
    <div
      className={`w-[620px] overflow-hidden rounded-xl border bg-white shadow-panel ${
        hasAlert ? "border-red-300 ring-2 ring-red-300" : selected ? "border-blue-300 ring-2 ring-blue-300" : "border-slate-200"
      }`}
    >
      <div className="flex cursor-grab items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <GripVertical size={12} className="shrink-0 text-slate-300" />
          <span className="truncate text-[11px] font-bold text-slate-800">{sandbox.name}</span>
          {sandbox.project && (
            <StatusPill tone="blue">
              <Github size={10} /> {sandbox.project.name}
              {sandbox.project.readOnly ? " · ro" : ""}
            </StatusPill>
          )}
          <StatusPill tone={sandbox.mode === "enforce" ? "blue" : "slate"}>{sandbox.mode}</StatusPill>
          {hasAlert && (
            <StatusPill tone="red">
              <AlertTriangle size={10} /> alert
            </StatusPill>
          )}
        </div>
        <button type="button" onClick={() => onInspect(sandbox.id)} className="shrink-0">
          <StatusPill tone={running ? "green" : "slate"} dot>
            {running ? "live" : sandbox.status}
          </StatusPill>
        </button>
      </div>
      <div className="nodrag nowheel">
        {running && sandbox.interactive ? (
          <SandboxTerminal
            key={sandbox.id}
            sandboxId={sandbox.id}
            initialInput={initialCommand || undefined}
            onClosed={() => onSessionEnded(sandbox.id)}
            height={330}
          />
        ) : (
          <div className="grid h-[330px] place-items-center bg-slate-50 text-center">
            <div>
              <p className="text-[11px] font-bold text-slate-600">{running ? "workspace starting…" : "stopped"}</p>
              <p className="mt-1 text-[10px] text-slate-400">Use Restart in the inspector to bring it back.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const canvasNodeTypes = { sandboxWindow: SandboxWindowNode };

function SandboxesView({ notify }: { notify: (message: string) => void }) {
  const [sandboxes, setSandboxes] = useState<SandboxRecordUi[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [events, setEvents] = useState<SandboxEventUi[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [mode, setMode] = useState<"observe" | "enforce">("observe");
  const [env, setEnv] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [stdinText, setStdinText] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectReadOnly, setProjectReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serviceUp, setServiceUp] = useState(true);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [alertIds, setAlertIds] = useState<string[]>([]);
  const initialCommands = useRef<Record<string, string>>({});
  const positions = useRef<Record<string, { x: number; y: number }>>({});

  const selected = sandboxes.find((sandbox) => sandbox.id === selectedId) || null;
  const alertCount = events.filter((event) => event.type === "alert").length;

  useEffect(() => {
    // Canvas layout survives reloads; sandbox ids are stable.
    try {
      positions.current = { ...positions.current, ...JSON.parse(window.localStorage.getItem(CANVAS_POSITIONS_KEY) || "{}") };
    } catch { /* fresh canvas */ }
  }, []);

  const refresh = useCallback(async () => {
    let list: SandboxRecordUi[] = [];
    try {
      const response = await fetch("/sandbox-api/sandboxes", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      setServiceUp(true);
      list = ((await response.json()) as { sandboxes?: SandboxRecordUi[] }).sandboxes || [];
      setSandboxes(list);
    } catch {
      setServiceUp(false);
      return;
    }
    // Alert badges: any shadow-access alert turns a node red.
    void Promise.all(
      list
        .filter((sandbox) => sandbox.status === "running")
        .map(async (sandbox) => {
          try {
            const response = await fetch(`/api/v1/sandboxes/${sandbox.id}/events?type=alert&limit=1`, { cache: "no-store" });
            if (!response.ok) return null;
            const body = (await response.json()) as { events?: unknown[] };
            return (body.events?.length || 0) > 0 ? sandbox.id : null;
          } catch {
            return null;
          }
        }),
    ).then((ids) => setAlertIds(ids.filter((id): id is string => Boolean(id))));
    const id = selectedId || list[0]?.id;
    if (!id) {
      setEvents([]);
      setLogs([]);
      return;
    }
    try {
      const [eventsResponse, logsResponse] = await Promise.all([
        fetch(`/api/v1/sandboxes/${id}/events?limit=300`, { cache: "no-store" }),
        fetch(`/sandbox-api/sandboxes/${id}/logs`, { cache: "no-store" }),
      ]);
      if (eventsResponse.ok) setEvents((((await eventsResponse.json()) as { events?: SandboxEventUi[] }).events || []).slice().reverse());
      if (logsResponse.ok) setLogs(((await logsResponse.json()) as { logs?: string[] }).logs || []);
    } catch {
      // gateway may be offline; keep last known
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Mirror sandboxes into canvas nodes; existing node positions win so
  // windows never jump when the poll refreshes their data.
  useEffect(() => {
    setNodes((previous) =>
      sandboxes.map((sandbox, index) => {
        const existing = previous.find((node) => node.id === sandbox.id);
        const position = existing?.position ?? positions.current[sandbox.id] ?? canvasSlot(index);
        return {
          id: sandbox.id,
          type: "sandboxWindow",
          position,
          data: {
            sandbox,
            hasAlert: alertIds.includes(sandbox.id),
            initialCommand: initialCommands.current[sandbox.id] ?? "",
            onInspect: (id: string) => setSelectedId(id),
            onSessionEnded: () => void refresh(),
          },
        };
      }),
    );
  }, [sandboxes, alertIds, refresh]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    let moved = false;
    for (const change of changes) {
      if (change.type === "position" && change.position && change.id) {
        positions.current[change.id] = change.position;
        moved = true;
      }
    }
    if (moved) {
      try { window.localStorage.setItem(CANVAS_POSITIONS_KEY, JSON.stringify(positions.current)); } catch { /* private mode */ }
    }
  }, []);

  const createFromTemplate = async (template: (typeof SANDBOX_TEMPLATES)[number]) => {
    setBusy(true);
    try {
      const response = await fetch("/sandbox-api/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${template.label} ${Date.now().toString(36).slice(-4)}`, command: [], mode }),
      });
      if (!response.ok) throw new Error((await response.json()).message || `HTTP ${response.status}`);
      const body = (await response.json()) as { sandbox?: SandboxRecordUi };
      const sandbox = body.sandbox;
      if (!sandbox) return;
      if (template.command) initialCommands.current[sandbox.id] = `${template.command}\n`;
      const taken = new Set(Object.values(positions.current).map((point) => `${point.x},${point.y}`));
      let slot = 0;
      while (taken.has(`${canvasSlot(slot).x},${canvasSlot(slot).y}`)) slot += 1;
      positions.current[sandbox.id] = canvasSlot(slot);
      setSelectedId(sandbox.id);
      notify(template.command ? `${template.label} starting in its sandbox window` : `Shell ready (${mode})`);
      await refresh();
    } catch (error) {
      notify(`Failed to start ${template.label}: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const createSandbox = async () => {
    const parts = splitCommand(command);
    setBusy(true);
    try {
      const response = await fetch("/sandbox-api/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name || undefined,
          // An empty command creates an interactive workspace you shell into.
          command: parts,
          mode,
          env: parseMap(env),
          ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
          ...(stdinText.trim() && parts.length ? { stdin: stdinText } : {}),
        }),
      });
      if (!response.ok) throw new Error((await response.json()).message || `HTTP ${response.status}`);
      const body = (await response.json()) as { sandbox?: SandboxRecordUi };
      if (body.sandbox) setSelectedId(body.sandbox.id);
      setName("");
      setCommand("");
      setEnv("");
      notify(parts.length ? `Sandbox started (${mode})` : `Workspace ready (${mode}) — open a terminal`);
      await refresh();
    } catch (error) {
      notify(`Sandbox failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const openProject = async () => {
    if (!projectPath.trim()) {
      notify("Enter (or browse) a project folder first");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/sandbox-api/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: projectName.trim() || undefined,
          command: [],
          mode,
          project: {
            name: projectName.trim() || projectPath.trim().split("/").filter(Boolean).pop() || "project",
            path: projectPath.trim(),
            ...(projectReadOnly ? { readOnly: true } : {}),
          },
        }),
      });
      if (!response.ok) throw new Error((await response.json()).message || `HTTP ${response.status}`);
      const body = (await response.json()) as { sandbox?: SandboxRecordUi };
      if (body.sandbox) setSelectedId(body.sandbox.id);
      notify(projectReadOnly ? "Project opened read-only" : "Project folder mounted — agent edits are real files");
      await refresh();
    } catch (error) {
      notify(`Could not open project: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const browseFolder = async () => {
    const tauri = (window as unknown as { __TAURI__?: { dialog?: { open: (options: unknown) => Promise<string | string[] | null> } } }).__TAURI__;
    if (!tauri?.dialog) {
      notify("Native picker available in the desktop app — type the path here for now");
      return;
    }
    const chosen = await tauri.dialog.open({ directory: true, multiple: false, title: "Open folder as project" });
    const folder = Array.isArray(chosen) ? chosen[0] : chosen;
    if (folder) {
      setProjectPath(folder);
      if (!projectName.trim()) setProjectName(folder.split("/").filter(Boolean).pop() || folder);
    }
  };

  const addProjectTerminal = async () => {
    if (!selected?.project) return;
    setBusy(true);
    try {
      const response = await fetch("/sandbox-api/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `${selected.project.name} — terminal`,
          command: [],
          mode: selected.mode,
          project: selected.project,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).message || `HTTP ${response.status}`);
      const body = (await response.json()) as { sandbox?: SandboxRecordUi };
      if (body.sandbox) setSelectedId(body.sandbox.id);
      notify("Terminal added to project");
      await refresh();
    } catch (error) {
      notify(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const restartSandbox = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await fetch(`/sandbox-api/sandboxes/${selected.id}/restart`, { method: "POST" });
      notify("Workspace restarted");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const deleteSandbox = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await fetch(`/sandbox-api/sandboxes/${selected.id}`, { method: "DELETE" });
      setSelectedId("");
      notify("Workspace deleted");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const stopSandbox = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await fetch(`/sandbox-api/sandboxes/${selected.id}/stop`, { method: "POST" });
      notify("Sandbox stopped");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-extrabold tracking-tight">Agent canvas</h1>
            <StatusPill tone={serviceUp ? "green" : "red"} dot>
              {serviceUp ? "Sandbox service live" : "Service offline"}
            </StatusPill>
          </div>
          <p className="mt-1 max-w-2xl text-[11px] leading-5 text-slate-500">
            Every window is an agent running inside its own monitored sandbox — drag to arrange, type to work. Connections, DNS
            lookups, processes, and file writes are recorded; shadow access turns a window red.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(["observe", "enforce"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`rounded-lg px-3 py-1.5 text-[10px] font-bold ${
                mode === value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {value === "observe" ? "Observe only" : "Enforce (block direct access)"}
            </button>
          ))}
          {SANDBOX_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={busy}
              onClick={() => void createFromTemplate(template)}
              className="button-primary"
            >
              <Plus size={13} />
              {template.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="flow-shell dot-grid relative h-[760px] min-h-[560px] overflow-hidden rounded-2xl border border-slate-200 bg-white/55 shadow-panel">
          <ReactFlow
            nodes={nodes}
            onNodesChange={onNodesChange}
            nodeTypes={canvasNodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            nodesConnectable={false}
            zoomOnDoubleClick={false}
            minZoom={0.25}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
            fitView
            fitViewOptions={{ padding: 0.1 }}
          >
            <Background color="#d7dce5" gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={() => "#cbd5e1"} maskColor="rgba(248,250,252,.8)" />
          </ReactFlow>
          {sandboxes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="max-w-sm text-center">
                <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-600">
                  <LayoutGrid size={18} />
                </div>
                <p className="mt-3 text-[13px] font-extrabold text-slate-700">Your agents will live here</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  Launch a Shell, Claude Code, or Codex above — each opens as a draggable window on this canvas, already
                  inside its monitored sandbox.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {selected ? (
            <Panel className="overflow-hidden">
              <SectionHeading
                icon={<Activity size={15} />}
                eyebrow={selected.id}
                title={selected.name}
                action={
                  <div className="flex items-center gap-2">
                    {alertCount > 0 && (
                      <StatusPill tone="red">
                        <AlertTriangle size={10} /> {alertCount}
                      </StatusPill>
                    )}
                    {selected.project && selected.status === "running" && (
                      <button type="button" disabled={busy} onClick={() => void addProjectTerminal()} className="button-primary">
                        <Plus size={12} />
                        Terminal in this project
                      </button>
                    )}
                    {selected.status === "running" && (
                      <button type="button" disabled={busy} onClick={() => void stopSandbox()} className="button-danger">
                        <Pause size={12} />
                        Stop
                      </button>
                    )}
                    {selected.interactive && selected.status !== "running" && (
                      <button type="button" disabled={busy} onClick={() => void restartSandbox()} className="button-primary">
                        <RefreshCw size={12} />
                        Restart
                      </button>
                    )}
                    {selected.interactive && (
                      <button type="button" disabled={busy} onClick={() => void deleteSandbox()} className="button-danger">
                        <Trash2 size={12} />
                        Delete
                      </button>
                    )}
                  </div>
                }
              />
              {selected.project && (
                <p className="border-b border-slate-100 px-5 py-2 font-mono text-[9.5px] text-slate-500">
                  {selected.project.readOnly ? "read-only" : "read-write"} · {selected.project.path}
                </p>
              )}
              <div className="max-h-[420px] overflow-y-auto p-3">
                {events.map((event) => renderTimelineEvent(event))}
                {events.length === 0 && <p className="p-4 text-center text-[10px] text-slate-500">Events appear as the agent works.</p>}
              </div>
              <div className="border-t border-slate-100">
                <p className="px-5 pt-3 text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Background output</p>
                <pre className="max-h-[200px] overflow-y-auto whitespace-pre-wrap px-5 py-3 font-mono text-[9.5px] leading-5 text-slate-600">
                  {logs.join("\n") || "One-shot commands (non-interactive runs) stream here."}
                </pre>
              </div>
            </Panel>
          ) : (
            <div className="space-y-4">
            <Panel>
              <SectionHeading icon={<Github size={15} />} eyebrow="Projects" title="Open folder as project" />
              <div className="space-y-3 p-5">
                <label className="block">
                  <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Project folder on this machine</span>
                  <div className="mt-1 flex gap-2">
                    <input
                      value={projectPath}
                      onChange={(event) => setProjectPath(event.target.value)}
                      placeholder="/home/you/code/my-app"
                      className="field-input font-mono"
                    />
                    <button type="button" onClick={() => void browseFolder()} className="button-secondary shrink-0">
                      Browse…
                    </button>
                  </div>
                </label>
                <label className="block">
                  <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Project name</span>
                  <input
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="my-app"
                    className="field-input mt-1"
                  />
                </label>
                <label className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                  <input
                    type="checkbox"
                    checked={projectReadOnly}
                    onChange={(event) => setProjectReadOnly(event.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  Read-only (agent can read the folder, not write it)
                </label>
                <button type="button" disabled={busy} onClick={() => void openProject()} className="button-primary w-full justify-center">
                  <Zap size={13} />
                  Open project {mode === "enforce" ? "(enforced)" : "(observed)"}
                </button>
                <p className="text-[9.5px] leading-4 text-slate-400">
                  The real folder is mounted into a sandboxed workspace — agent edits are real files owned by you, and every
                  write, process, and network call is recorded. Add more terminals to the same project from the inspector.
                </p>
              </div>
            </Panel>
            <Panel>
              <SectionHeading icon={<Plus size={15} />} eyebrow="Advanced launch" title="Custom agent run" />
              <div className="space-y-3 p-5">
                <label className="block">
                  <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Name</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="migration-agent" className="field-input mt-1" />
                </label>
                <label className="block">
                  <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Command (empty = interactive workspace)</span>
                  <input
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="tsx real-agent.ts"
                    className="field-input mt-1 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Env (KEY=VALUE per line)</span>
                  <textarea value={env} onChange={(event) => setEnv(event.target.value)} placeholder={"GEMINI_API_KEY=..."} rows={2} className="field-input mt-1 font-mono" />
                </label>
                <label className="block">
                  <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Workspace source dir (copied in)</span>
                  <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="./scripts" className="field-input mt-1 font-mono" />
                </label>
                <label className="block">
                  <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Agent input (fed to stdin, one-shot runs)</span>
                  <textarea value={stdinText} onChange={(event) => setStdinText(event.target.value)} placeholder={"list unpaid invoices\nexit"} rows={2} className="field-input mt-1 font-mono" />
                </label>
                <button type="button" disabled={busy} onClick={() => void createSandbox()} className="button-primary w-full justify-center">
                  <Zap size={13} />
                  Start sandbox
                </button>
              </div>
            </Panel>
            </div>
          )}

          <Panel className="overflow-hidden">
            <SectionHeading icon={<Box size={15} />} eyebrow="Registry" title={`${sandboxes.filter((sandbox) => sandbox.status === "running").length} running · ${sandboxes.length} total`} />
            <div className="max-h-[240px] divide-y divide-slate-100 overflow-y-auto">
              {sandboxes.map((sandbox) => (
                <button
                  key={sandbox.id}
                  type="button"
                  onClick={() => setSelectedId(sandbox.id)}
                  className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left ${selectedId === sandbox.id ? "bg-blue-50/60" : "hover:bg-slate-50"}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-bold text-slate-800">{sandbox.name}</p>
                    <p className="truncate font-mono text-[9px] text-slate-400">{sandbox.command.length ? sandbox.command.join(" ") : "interactive workspace"}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {alertIds.includes(sandbox.id) && <StatusPill tone="red" dot>alert</StatusPill>}
                    <StatusPill tone={sandbox.status === "running" ? "green" : "slate"} dot>
                      {sandbox.status}
                    </StatusPill>
                  </div>
                </button>
              ))}
              {sandboxes.length === 0 && (
                <p className="p-6 text-center text-[10px] text-slate-500">Nothing yet — launch an agent from the toolbar.</p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("topology");
  const [connections, setConnections] = useState<Connection[]>([]);
  const connectionsRef = useRef<Connection[]>([]);
  connectionsRef.current = connections;
  const [oauthStatuses, setOauthStatuses] = useState<Record<string, OAuthStatus>>({});
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formBusy, setFormBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState<IdentityData>({ name: "Loading host identity…", email: "connecting" });
  const [summary, setSummary] = useState<DbSummary>({
    customers: 100,
    billing: 250,
    bucketCount: 4,
    gitBranch: "main",
  });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const handleUnhandledError = (event: ErrorEvent) => {
      if (!event.error && (event.message === "[object Event]" || event.type === "error")) {
        event.preventDefault();
      }
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!event.reason || event.reason === "[object Event]") {
        event.preventDefault();
      }
    };
    window.addEventListener("error", handleUnhandledError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleUnhandledError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionId) || null;
  const selectedAction =
    actions.find((action) => action.id === selectedId) ||
    actions[0] || {
      id: "",
      actorId: "antigravity",
      tool: "No live action",
      target: "target_cloudflare_d1",
      targetTitle: "Cloudflare D1 (Cloud)",
      resource: "Waiting for agent traffic",
      summary: "Connect an agent or MCP client to inspect live traffic.",
      state: "idle" as GatewayState,
      score: 0,
      timestamp: "—",
    };

  const activeAgentName = useMemo(() => {
    return normalizeActorName(selectedAction?.actorId || actions[0]?.actorId || "antigravity");
  }, [selectedAction, actions]);

  const { nodes, edges } = useMemo(
    () => buildTopology(selectedAction.state, identity, connections, summary, selectedAction, activeAgentName),
    [selectedAction, identity, connections, summary, activeAgentName]
  );

  const tools = discovery?.tools || [];

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/explorer/summary", { cache: "no-store" });
      const body = (await response.json()) as {
        databases?: { customers?: number; billing?: number };
        bucket?: { objects?: unknown[] };
        repo?: { branch?: string };
      };
      if (body.databases) {
        setSummary({
          customers: body.databases.customers || 100,
          billing: body.databases.billing || 250,
          bucketCount: body.bucket?.objects?.length || 4,
          gitBranch: body.repo?.branch || "main",
        });
      }
    } catch {
      // ignore
    }
  }, []);

  const refreshOperations = useCallback(
    async (currentConns?: Connection[]) => {
      try {
        const conns = currentConns || connectionsRef.current;
        const [actionResponse, auditResponse] = await Promise.all([
          fetch("/api/v1/actions?limit=50", { cache: "no-store" }),
          fetch("/api/v1/audit?limit=50", { cache: "no-store" }),
        ]);
        const actionBody = (await actionResponse.json()) as { actions?: Record<string, unknown>[] };
        const auditBody = (await auditResponse.json()) as { events?: AuditEvent[] };
        const live = (actionBody.actions || []).map((raw) => apiAction(raw, conns));
        setActions(live);
        setAudit(auditBody.events || []);
        if (live[0]) setSelectedId((current) => current || live[0].id);
      } catch {
        setConnected(false);
      }
    },
    []
  );

  const loadOAuthStatus = useCallback(async (connectionId: string): Promise<OAuthStatus | null> => {
    try {
      const response = await fetch(`/api/v1/connections/${connectionId}/oauth/status`, { cache: "no-store" });
      const body = (await response.json()) as { status?: OAuthStatus; error?: { message?: string } };
      if (!response.ok || !body.status) throw new Error(body.error?.message || "Unable to load OAuth status.");
      setOauthStatuses((current) => ({ ...current, [connectionId]: body.status as OAuthStatus }));
      return body.status;
    } catch {
      return null;
    }
  }, []);

  const refreshConnections = useCallback(async () => {
    const response = await fetch("/api/v1/connections", { cache: "no-store" });
    const body = (await response.json()) as { connections?: Connection[]; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message || "Unable to load MCP connections.");
    const next = body.connections || [];
    setConnections(next);
    await Promise.all(next.filter((connection) => connection.transport !== "stdio").map((connection) => loadOAuthStatus(connection.id)));
    return next;
  }, [loadOAuthStatus]);

  // 1. Dedicated SSE connection lifecycle (single persistent connection, cancels safely)
  useEffect(() => {
    let source: EventSource | null = null;
    let isCancelled = false;

    try {
      source = new EventSource("/api/v1/stream");
      source.onopen = () => {
        if (!isCancelled) setConnected(true);
      };
      source.onerror = () => {
        if (!isCancelled) setConnected(false);
      };

      const onEvent = (event: Event) => {
        try {
          const value = JSON.parse((event as MessageEvent).data) as { action?: Record<string, unknown> };
          if (value.action) {
            const next = apiAction(value.action, connectionsRef.current);
            setActions((current) => [next, ...current.filter((item) => item.id !== next.id)]);
            setSelectedId((current) => current || next.id);
            void refreshOperations();
            void refreshSummary();
          }
        } catch {
          /* ignore */
        }
      };

      ["action.created", "action.updated", "action.resolved"].forEach((evt) => source?.addEventListener(evt, onEvent));
    } catch {
      setConnected(false);
    }

    return () => {
      isCancelled = true;
      if (source) {
        source.close();
        source = null;
      }
    };
  }, [refreshOperations, refreshSummary]);

  // 2. Initial data bootstrap and background refresh interval
  useEffect(() => {
    let isCancelled = false;

    const bootstrap = async () => {
      try {
        const conns = await refreshConnections();
        if (isCancelled) return;
        await Promise.all([refreshOperations(conns), refreshSummary()]);

        const hostResponse = await fetch("/api/v1/explorer/host", { cache: "no-store" });
        const hostBody = (await hostResponse.json()) as { telemetry?: { username?: string; gitEmail?: string; hostname?: string } };
        if (!isCancelled && hostBody.telemetry) {
          setIdentity({
            name: hostBody.telemetry.username || "Unknown host user",
            email: hostBody.telemetry.gitEmail || `${hostBody.telemetry.hostname || "local"}@local`,
          });
        }
      } catch {
        /* ignore */
      }
    };

    void bootstrap();

    const timer = window.setInterval(() => {
      void refreshOperations();
      void refreshSummary();
    }, 15000);

    return () => {
      isCancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshConnections, refreshOperations, refreshSummary]);

  const finishOAuthSetup = useCallback(
    async (connectionId: string) => {
      await refreshConnections();
      let testMessage = "";
      try {
        const testResponse = await fetch(`/api/v1/connections/${connectionId}/test`, { method: "POST" });
        const testBody = (await testResponse.json()) as { result?: { serverInfo?: { name?: string } }; error?: { message?: string } };
        if (!testResponse.ok) throw new Error(testBody.error?.message || "Connection test failed.");
        testMessage = `Connection healthy${testBody.result?.serverInfo?.name ? ` · ${testBody.result.serverInfo.name}` : ""}`;
      } catch (error) {
        testMessage = error instanceof Error ? error.message : "Connection test failed";
      }
      try {
        const discoverResponse = await fetch(`/api/v1/connections/${connectionId}/discover`, { method: "POST" });
        const discoverBody = (await discoverResponse.json()) as { discovery?: Discovery; error?: { message?: string } };
        if (!discoverResponse.ok || !discoverBody.discovery) throw new Error(discoverBody.error?.message || "Discovery failed.");
        setDiscovery(discoverBody.discovery);
        notify(`${testMessage}; ${discoverBody.discovery.tools?.length || 0} tools discovered`);
      } catch (error) {
        notify(`${testMessage}; ${error instanceof Error ? error.message : "Discovery failed"}`);
      }
    },
    [notify, refreshConnections]
  );

  const startOAuth = useCallback(
    async (connectionId: string) => {
      setConnectionBusy("oauth");
      const popup = window.open("about:blank", "mcp-oauth", "popup,width=520,height=720");
      try {
        const response = await fetch(`/api/v1/connections/${connectionId}/oauth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const body = (await response.json()) as { authorizationUrl?: string; status?: OAuthStatus; error?: { message?: string } };
        if (!response.ok || !body.authorizationUrl) throw new Error(body.error?.message || "Unable to start OAuth sign-in.");
        if (body.status) setOauthStatuses((current) => ({ ...current, [connectionId]: body.status as OAuthStatus }));
        if (popup && !popup.closed) popup.location.href = body.authorizationUrl;
        else {
          notify("Your browser blocked the sign-in window. Continuing in this tab…");
          window.location.assign(body.authorizationUrl);
          return;
        }
        notify("Waiting for sign-in in the browser…");
        let latest: OAuthStatus | null = body.status || null;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          latest = await loadOAuthStatus(connectionId);
          if (latest?.authorized) {
            await finishOAuthSetup(connectionId);
            return;
          }
          if (latest?.error || (latest?.supported === false && !latest.pending)) throw new Error(latest.error || "OAuth is unavailable for this MCP server.");
        }
        notify("Sign-in is still waiting. Return to this connection to check again.");
      } catch (error) {
        if (popup && !popup.closed) popup.close();
        notify(error instanceof Error ? error.message : "OAuth sign-in failed");
      } finally {
        setConnectionBusy(null);
      }
    },
    [finishOAuthSetup, loadOAuthStatus, notify]
  );

  const registerConnection = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        transport: form.transport,
        ...(form.transport === "stdio"
          ? {
              command: form.command.trim(),
              args: form.args
                .split(/\r?\n/)
                .map((arg) => arg.trim())
                .filter(Boolean),
              cwd: form.cwd.trim() || undefined,
            }
          : { url: form.url.trim() }),
        env: parseMap(form.env),
        headers: parseMap(form.auth),
      };
      const response = await fetch("/api/v1/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = (await response.json()) as { connection?: Connection; error?: { message?: string } };
      if (!response.ok || !body.connection) throw new Error(body.error?.message || "Connection registration failed.");
      const updatedConns = await refreshConnections();
      await refreshOperations(updatedConns);
      setSelectedConnectionId(body.connection.id);
      setForm(emptyForm);
      setDiscovery(null);
      setConfig(null);
      notify(form.transport === "stdio" ? "MCP connection registered" : "Connection registered — starting sign-in");
      if (form.transport !== "stdio") await startOAuth(body.connection.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Connection registration failed");
    } finally {
      setFormBusy(false);
    }
  };

  const testConnection = async () => {
    if (!selectedConnection) return;
    setConnectionBusy("test");
    try {
      const response = await fetch(`/api/v1/connections/${selectedConnection.id}/test`, { method: "POST" });
      const body = (await response.json()) as { result?: { serverInfo?: { name?: string } }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || "Connection test failed.");
      notify(`Connection healthy${body.result?.serverInfo?.name ? ` · ${body.result.serverInfo.name}` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Connection test failed");
    } finally {
      setConnectionBusy(null);
    }
  };

  const discoverConnection = async () => {
    if (!selectedConnection) return;
    setConnectionBusy("discover");
    try {
      const response = await fetch(`/api/v1/connections/${selectedConnection.id}/discover`, { method: "POST" });
      const body = (await response.json()) as { discovery?: Discovery; error?: { message?: string } };
      if (!response.ok || !body.discovery) throw new Error(body.error?.message || "Discovery failed.");
      setDiscovery(body.discovery);
      notify(`${body.discovery.tools?.length || 0} tools discovered`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Discovery failed");
    } finally {
      setConnectionBusy(null);
    }
  };

  const deleteConnection = async () => {
    if (!selectedConnection || !window.confirm(`Delete ${selectedConnection.name}?`)) return;
    setConnectionBusy("delete");
    try {
      const response = await fetch(`/api/v1/connections/${selectedConnection.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message || "Delete failed.");
      }
      const updatedConns = await refreshConnections();
      await refreshOperations(updatedConns);
      setSelectedConnectionId("");
      setDiscovery(null);
      setConfig(null);
      notify("Connection deleted");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setConnectionBusy(null);
    }
  };

  const loadConfig = async () => {
    if (!selectedConnection) return;
    const response = await fetch(`/api/v1/connections/${selectedConnection.id}/client-config`, { method: "POST", cache: "no-store" });
    const body = (await response.json()) as { config?: ClientConfig; token?: string; error?: { message?: string } };
    if (!response.ok || !body.config) {
      notify(body.error?.message || "Unable to generate configuration");
      return;
    }
    setConfig(body.config);
    if (body.token) setConnections((current) => current.map((item) => (item.id === selectedConnection.id ? { ...item, token: body.token } : item)));
    notify("Proxy token generated — copy it now");
  };

  const mutateAction = async (status: "approved" | "blocked" | "frozen") => {
    if (!selectedAction.id) return;
    const response = await fetch(`/api/v1/actions/${encodeURIComponent(selectedAction.id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, actorId: "dashboard-operator", note: `Action ${status} from control plane` }),
    });
    const body = (await response.json()) as { action?: Record<string, unknown>; error?: { message?: string } };
    if (!response.ok || !body.action) {
      notify(body.error?.message || "Resolution failed");
      return;
    }
    setActions((current) => current.map((action) => (action.id === selectedAction.id ? apiAction(body.action as Record<string, unknown>, connections) : action)));
    await refreshOperations();
    notify(`Action ${status}`);
  };

  const renderInspector = () => (
    <Panel className="overflow-hidden">
      <SectionHeading icon={<ShieldCheck size={15} />} eyebrow="Action firewall" title="Interception inspector" />
      <div className="p-5">
        <div
          className={`rounded-xl border p-4 ${
            selectedAction.state === "blocked"
              ? "border-red-200 bg-red-50/50"
              : selectedAction.state === "allowed" || selectedAction.state === "approved"
              ? "border-emerald-200 bg-emerald-50/40"
              : "border-amber-200 bg-amber-50/40"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[13px] font-bold text-slate-900">{selectedAction.tool}</p>
              <p className="mt-1 text-[10px] text-slate-500">{selectedAction.summary}</p>
            </div>
            <StatusPill tone={toneForState(selectedAction.state)} dot>
              {selectedAction.state.replace("_", " ")}
            </StatusPill>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <p className="meta-label">Target Resource</p>
              <p className="mt-1 text-[11px] font-semibold">{selectedAction.targetTitle}</p>
            </div>
            <div>
              <p className="meta-label">Client / Agent</p>
              <p className="mt-1 text-[11px] font-semibold">{normalizeActorName(selectedAction.actorId)}</p>
            </div>
            <div>
              <p className="meta-label">Risk score</p>
              <p className="mt-1 text-[11px] font-semibold">{selectedAction.score} / 100</p>
            </div>
            <div>
              <p className="meta-label">Time</p>
              <p className="mt-1 text-[11px] font-semibold">{selectedAction.timestamp}</p>
            </div>
          </div>
        </div>

        {selectedAction.id && (
          <>
            <p className="meta-label mt-5">Human override</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void mutateAction("approved")}
                disabled={selectedAction.state === "approved" || selectedAction.state === "allowed" || selectedAction.state === "blocked"}
                className="button-success"
              >
                <Check size={13} />
                Approve
              </button>
              <button
                type="button"
                onClick={() => void mutateAction("blocked")}
                disabled={selectedAction.state === "blocked" || selectedAction.state === "approved" || selectedAction.state === "allowed"}
                className="button-danger justify-center"
              >
                <X size={13} />
                Block
              </button>
            </div>
            <button
              type="button"
              onClick={() => void mutateAction(selectedAction.state === "frozen" ? "approved" : "frozen")}
              disabled={selectedAction.state === "blocked" || selectedAction.state === "approved" || selectedAction.state === "allowed"}
              className="button-secondary mt-2 w-full justify-center"
            >
              <Pause size={13} />
              {selectedAction.state === "frozen" ? "Resume action" : "Freeze action"}
            </button>
          </>
        )}
      </div>
    </Panel>
  );

  return (
    <main className="min-h-screen bg-[#fafafa] text-slate-900">
      <header className="flex min-h-[68px] items-center justify-between border-b border-slate-200 bg-white px-4 lg:px-8">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-white">
              <ShieldCheck size={17} />
            </div>
            <span className="text-[15px] font-extrabold tracking-tight">
              Ae<span className="text-blue-600">gis</span>
            </span>
            <span className="hidden rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-blue-700 sm:inline">
              Control Plane
            </span>
          </div>
          <nav className="hidden items-center gap-1 md:flex">
            <button
              type="button"
              onClick={() => setView("topology")}
              className={`rounded-lg px-3 py-2 text-xs font-bold ${
                view === "topology" ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50"
              }`}
            >
              Topology
            </button>
            <button
              type="button"
              onClick={() => setView("connections")}
              className={`rounded-lg px-3 py-2 text-xs font-bold ${
                view === "connections" ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50"
              }`}
            >
              MCP connections
            </button>
            <button
              type="button"
              onClick={() => setView("sandboxes")}
              className={`rounded-lg px-3 py-2 text-xs font-bold ${
                view === "sandboxes" ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50"
              }`}
            >
              Sandboxes
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 sm:flex">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "animate-pulse bg-emerald-500" : "bg-amber-500"}`} />
            {connected ? "Gateway operational" : "Connecting"}
          </div>
          <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-blue-500 text-[10px] font-bold text-white">
            AG
          </div>
          <button type="button" className="md:hidden" onClick={() => setView(view === "topology" ? "connections" : "topology")}>
            <Menu size={18} />
          </button>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-68px)]">
        <aside className="hidden w-[64px] flex-col items-center gap-3 border-r border-slate-200 bg-white py-5 lg:flex">
          <NavIcon active={view === "topology"}>
            {view === "topology" ? <LayoutGrid size={17} /> : <Network size={17} />}
          </NavIcon>
          <NavIcon active={view === "connections"}>
            <Link2 size={17} />
          </NavIcon>
          <NavIcon active={view === "sandboxes"}>
            <Box size={17} />
          </NavIcon>
          <NavIcon>
            <LockKeyhole size={17} />
          </NavIcon>
          <NavIcon>
            <FileKey2 size={17} />
          </NavIcon>
          <div className="mt-auto">
            <NavIcon>
              <CircleHelp size={17} />
            </NavIcon>
          </div>
        </aside>

        <section className="min-w-0 flex-1 p-4 lg:p-7">
          {view === "topology" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="text-[18px] font-extrabold tracking-tight">Agent topology</h1>
                    <StatusPill tone={connected ? "green" : "amber"} dot>
                      {connected ? "SSE connected" : "Waiting for gateway"}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Live Agent Traffic ({activeAgentName}) → Policy Firewall → Cloudflare & Enterprise Backends
                  </p>
                </div>
                <button type="button" onClick={() => setView("connections")} className="button-primary">
                  <Link2 size={14} />
                  Manage MCP connections
                </button>
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
                <div className="flow-shell dot-grid h-[680px] min-h-[580px] overflow-hidden rounded-2xl border border-slate-200 bg-white/55 shadow-panel">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    onNodeClick={(_, node) => {
                      notify(`Selected: ${node.data?.title || node.id}`);
                    }}
                    fitView
                    fitViewOptions={{ padding: 0.16 }}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    zoomOnDoubleClick={false}
                  >
                    <Background color="#d7dce5" gap={18} size={1} />
                    <Controls showInteractive={false} />
                    <MiniMap
                      nodeColor={(node) => (node.type === "agent" ? "#172033" : node.type === "target" ? "#e2e8f0" : "#cbd5e1")}
                      maskColor="rgba(248,250,252,.76)"
                    />
                  </ReactFlow>
                </div>
                {renderInspector()}
              </div>

              <OperationsPanels actions={actions} audit={audit} selectedId={selectedId} setSelectedId={setSelectedId} onRefresh={() => void refreshOperations()} />
            </div>
          ) : view === "sandboxes" ? (
            <SandboxesView notify={notify} />
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="text-[22px] font-extrabold tracking-tight">MCP connections</h1>
                    <StatusPill tone="blue">Gateway registry</StatusPill>
                  </div>
                  <p className="mt-1 max-w-2xl text-[11px] leading-5 text-slate-500">
                    Register trusted MCP servers, test their transport, discover tools, and give clients a policy-enforced gateway URL.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-500">
                  <Radio size={13} className={connected ? "text-emerald-500" : "text-amber-500"} />
                  Live agent and audit stream
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,.9fr)]">
                <Panel className="overflow-hidden">
                  <SectionHeading icon={<Plus size={15} />} eyebrow="Connection setup" title="Register an MCP server" />
                  <ConnectionForm form={form} setForm={setForm} onSubmit={(event) => void registerConnection(event)} busy={formBusy} />
                </Panel>
                <ConnectionsPanel
                  connections={connections}
                  selected={selectedConnection}
                  onSelect={(connection) => {
                    setSelectedConnectionId(connection.id);
                    setDiscovery(null);
                    setConfig(null);
                  }}
                  onTest={() => void testConnection()}
                  onDiscover={() => void discoverConnection()}
                  onDelete={() => void deleteConnection()}
                  busy={connectionBusy}
                />
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <ToolsPanel tools={tools} discovery={discovery} onDiscover={() => void discoverConnection()} />
                <ClientConfigPanel
                  connection={selectedConnection}
                  config={config}
                  onLoad={() => void loadConfig()}
                  onCopy={(text) => {
                    void navigator.clipboard?.writeText(text);
                    notify("Snippet copied");
                  }}
                />
              </div>

              <OperationsPanels actions={actions} audit={audit} selectedId={selectedId} setSelectedId={setSelectedId} onRefresh={() => void refreshOperations()} />
            </div>
          )}
        </section>
      </div>

      {toast && (
        <div className="toast">
          <Check size={13} className="text-emerald-400" />
          {toast}
        </div>
      )}
    </main>
  );
}
