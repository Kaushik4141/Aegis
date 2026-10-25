"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// --- Types ---

type GatewayState = "idle" | "allowed" | "approved" | "pending_approval" | "blocked" | "frozen";
type Transport = "stdio" | "streamable-http" | "sse";
type ActiveTab = "topology" | "approvals" | "activity" | "mcp";

interface Action {
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
}

interface AuditEvent {
  id: string;
  type: string;
  actionId: string;
  timestamp: string;
  actorId?: string;
  reason?: string;
  toStatus: string;
}

interface Connection {
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
}

interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Discovery {
  tools?: Tool[];
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
}

interface ClientConfig {
  connectionId: string;
  mcp: { url: string; headers?: Record<string, string> };
  claudeDesktop: Record<string, unknown>;
  cursor: Record<string, unknown>;
  note?: string;
}

interface DbSummary {
  customers: number;
  billing: number;
  bucketCount: number;
  gitBranch: string;
}

interface FormState {
  name: string;
  transport: Transport;
  url: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  auth: string;
}

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

// Initial realistic fallback actions in pure monochrome style
const INITIAL_DEMO_ACTIONS: Action[] = [
  {
    id: "act_001",
    actorId: "antigravity",
    tool: "d1_query",
    target: "target_cloudflare_d1",
    targetTitle: "Cloudflare D1",
    resource: "enterprise.customers",
    summary: "SELECT * FROM enterprise_customers WHERE status = 'active' LIMIT 50",
    state: "allowed",
    score: 12,
    timestamp: "18:22:10",
    payload: {
      query: "SELECT * FROM enterprise_customers WHERE status = 'active' LIMIT 50",
      caller: "migration_worker_01",
      mode: "read_only",
    },
  },
  {
    id: "act_002",
    actorId: "antigravity",
    tool: "s3_export",
    target: "target_s3",
    targetTitle: "S3 Storage",
    resource: "customer-pii",
    summary: "High-volume export requested on customer-pii encrypted partition",
    state: "pending_approval",
    score: 84,
    timestamp: "18:23:05",
    payload: {
      bucket: "customer-pii",
      operation: "batch_export",
      recordCount: 14200,
      destination: "external_egress_stream",
    },
  },
  {
    id: "act_003",
    actorId: "claude-desktop",
    tool: "git_push",
    target: "target_git",
    targetTitle: "Git Repository",
    resource: "data/acme-repo",
    summary: "Commit verified schema migration: add indexing on customer_id",
    state: "approved",
    score: 18,
    timestamp: "18:20:18",
    payload: {
      branch: "main",
      commitMessage: "feat: add index on customer_id",
      filesChanged: 2,
    },
  },
  {
    id: "act_004",
    actorId: "cursor-agent",
    tool: "d1_drop_table",
    target: "target_cloudflare_d1",
    targetTitle: "Cloudflare D1",
    resource: "enterprise.invoices",
    summary: "Attempted DROP TABLE enterprise_invoices detected in prompt context",
    state: "blocked",
    score: 96,
    timestamp: "18:18:52",
    payload: {
      statement: "DROP TABLE enterprise_invoices CASCADE;",
      originPrompt: "Clean up all existing invoice history before running insert",
      riskLevel: "CRITICAL",
    },
  },
];

const INITIAL_DEMO_AUDIT: AuditEvent[] = [
  {
    id: "aud_01",
    type: "POLICY_INTERCEPT",
    actionId: "act_002",
    timestamp: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
    actorId: "aegis_firewall_rule_s3",
    reason: "PII egress threshold exceeded (14,200 records). Quarantined for operator clearance.",
    toStatus: "pending_approval",
  },
  {
    id: "aud_02",
    type: "CRITICAL_BLOCK",
    actionId: "act_004",
    timestamp: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
    actorId: "sentinel_destruct_shield",
    reason: "Prohibited destructive operation: DROP TABLE in production boundary.",
    toStatus: "blocked",
  },
  {
    id: "aud_03",
    type: "OPERATOR_APPROVAL",
    actionId: "act_003",
    timestamp: new Date(Date.now() - 1000 * 60 * 9).toISOString(),
    actorId: "operator",
    reason: "Schema migration verified against staging D1 database.",
    toStatus: "approved",
  },
];

// --- Helper Functions ---

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
      targetTitle: "Cloudflare D1",
      resource: "enterprise",
      summary: "Live gateway action",
      state: "idle",
      score: 0,
      timestamp: "Just now",
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

  if (text.includes("customer") || text.includes("billing") || text.includes("sql") || text.includes("d1")) {
    target = "target_cloudflare_d1";
    targetTitle = "Cloudflare D1";
  } else if (text.includes("s3") || text.includes("bucket") || text.includes("file") || text.includes("export")) {
    target = "target_s3";
    targetTitle = "S3 Storage";
  } else if (text.includes("git") || text.includes("repo") || text.includes("commit") || text.includes("branch")) {
    target = "target_git";
    targetTitle = "Git Repository";
  } else {
    for (const conn of connections) {
      if (text.includes(conn.name.toLowerCase())) {
        target = `target_conn_${conn.id}`;
        targetTitle = conn.name;
        break;
      }
    }
  }

  const rawState = String(decision.status || raw.status || raw.state || "allowed").toLowerCase();
  const state: GatewayState =
    rawState === "approved"
      ? "approved"
      : rawState === "blocked"
      ? "blocked"
      : rawState === "pending_approval" || rawState === "pending"
      ? "pending_approval"
      : rawState === "frozen"
      ? "frozen"
      : rawState === "allowed"
      ? "allowed"
      : "idle";

  return {
    id: String(raw.id || `act_${Date.now()}`),
    actorId,
    tool,
    target,
    targetTitle,
    resource,
    summary: String(analysis.reason || raw.summary || raw.note || `${tool} on ${resource}`),
    state,
    score:
      typeof raw.score === "number"
        ? raw.score
        : typeof analysis.riskScore === "number"
        ? analysis.riskScore
        : state === "blocked"
        ? 92
        : state === "pending_approval"
        ? 75
        : 10,
    timestamp: raw.createdAt
      ? new Date(String(raw.createdAt)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "Just now",
    payload: raw.payload || raw.params || raw.args || null,
  };
}

// --- Typographic Status Badge (Zero Lucide Icons) ---

function StatusBadge({ state }: { state: GatewayState }) {
  const styles: Record<GatewayState, { bg: string; text: string; border: string; label: string }> = {
    approved: {
      bg: "bg-[#0a0a0a]",
      text: "text-[#ededed]",
      border: "border-[#333333]",
      label: "APPROVED",
    },
    allowed: {
      bg: "bg-[#0a0a0a]",
      text: "text-[#a1a1a1]",
      border: "border-[#222222]",
      label: "ALLOWED",
    },
    blocked: {
      bg: "bg-[#140d0d]",
      text: "text-[#f87171]",
      border: "border-[#381a1a]",
      label: "BLOCKED",
    },
    pending_approval: {
      bg: "bg-[#14120a]",
      text: "text-[#fbbf24]",
      border: "border-[#3d3314]",
      label: "PENDING",
    },
    frozen: {
      bg: "bg-[#0a0f14]",
      text: "text-[#67e8f9]",
      border: "border-[#162e3d]",
      label: "FROZEN",
    },
    idle: {
      bg: "bg-[#0a0a0a]",
      text: "text-[#666666]",
      border: "border-[#1a1a1a]",
      label: "IDLE",
    },
  };

  const style = styles[state] || styles.idle;

  return (
    <span
      className={`inline-block font-mono text-[10px] tracking-wider px-2 py-0.5 rounded border ${style.bg} ${style.text} ${style.border}`}
    >
      [{style.label}]
    </span>
  );
}

// --- Minimalist ReactFlow Custom Nodes (Clean Typography, No Icon Bloat) ---

interface IdentityData extends Record<string, unknown> {
  name: string;
  email: string;
}

interface AgentData extends Record<string, unknown> {
  agentName: string;
  state: GatewayState;
  activeTargetTitle?: string;
}

interface TargetData extends Record<string, unknown> {
  id: string;
  title: string;
  subtitle: string;
  detail: string;
  isActive?: boolean;
  state?: GatewayState;
}

function IdentityFlowNode({ data }: NodeProps<Node<IdentityData>>) {
  return (
    <div className="bg-[#0a0a0a] border border-[#222222] rounded p-3 w-[220px] transition-colors hover:border-[#444444]">
      <Handle type="source" position={Position.Right} className="!bg-[#ffffff] !w-2 !h-2 !border !border-[#000000]" />
      <div className="flex items-center justify-between pb-1.5 border-b border-[#1a1a1a] text-[10px] font-mono text-[#666666]">
        <span>ORIGIN</span>
        <span className="text-[#ededed]">LOCAL SESSION</span>
      </div>
      <div className="mt-2 font-mono">
        <p className="text-xs font-semibold text-[#ffffff] truncate">{data.name}</p>
        <p className="text-[10px] text-[#777777] truncate mt-0.5">{data.email}</p>
      </div>
    </div>
  );
}

function AgentFlowNode({ data }: NodeProps<Node<AgentData>>) {
  const isAlert = data.state === "pending_approval" || data.state === "blocked" || data.state === "frozen";

  return (
    <div
      className={`bg-[#0a0a0a] border rounded p-3 w-[240px] transition-colors ${
        isAlert ? "border-[#ffffff] ring-1 ring-[#ffffff]/20" : "border-[#222222] hover:border-[#444444]"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-[#ffffff] !w-2 !h-2 !border !border-[#000000]" />
      <Handle type="source" position={Position.Right} className="!bg-[#ffffff] !w-2 !h-2 !border !border-[#000000]" />
      <div className="flex items-center justify-between pb-1.5 border-b border-[#1a1a1a] text-[10px] font-mono text-[#666666]">
        <span>GATEWAY FIREWALL</span>
        <span className="text-[#ffffff]">v2.4</span>
      </div>
      <div className="mt-2 font-mono">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-[#ffffff] truncate">{data.agentName}</p>
          <StatusBadge state={data.state} />
        </div>
        <p className="text-[10px] text-[#777777] truncate mt-1">
          {data.activeTargetTitle ? `Target: ${data.activeTargetTitle}` : "Active Stream"}
        </p>
      </div>
    </div>
  );
}

function TargetFlowNode({ data }: NodeProps<Node<TargetData>>) {
  return (
    <div
      className={`bg-[#0a0a0a] border rounded p-3 w-[240px] transition-colors ${
        data.isActive ? "border-[#ffffff] ring-1 ring-[#ffffff]/20" : "border-[#222222] hover:border-[#333333]"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-[#ffffff] !w-2 !h-2 !border !border-[#000000]" />
      <div className="flex items-center justify-between pb-1.5 border-b border-[#1a1a1a] text-[10px] font-mono text-[#666666]">
        <span>RESOURCE</span>
        {data.isActive && <span className="text-[#ffffff] font-bold">ROUTE ACTIVE</span>}
      </div>
      <div className="mt-2 font-mono">
        <p className="text-xs font-semibold text-[#ffffff] truncate">{data.title}</p>
        <p className="text-[10px] text-[#777777] truncate">{data.subtitle}</p>
        <div className="mt-1.5 text-[10px] text-[#aaaaaa] font-mono bg-[#050505] px-2 py-0.5 rounded border border-[#1a1a1a] truncate">
          {data.detail}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  identity: IdentityFlowNode,
  agent: AgentFlowNode,
  target: TargetFlowNode,
};

// --- Main Application Component (Human Black & White Aesthetic) ---

export default function Home() {
  const [tab, setTab] = useState<ActiveTab>("topology");
  const [connections, setConnections] = useState<Connection[]>([]);
  const connectionsRef = useRef<Connection[]>([]);
  connectionsRef.current = connections;

  const [actions, setActions] = useState<Action[]>(INITIAL_DEMO_ACTIONS);
  const [audit, setAudit] = useState<AuditEvent[]>(INITIAL_DEMO_AUDIT);
  const [selectedId, setSelectedId] = useState<string>("act_002");
  const [connected, setConnected] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  // Filtering & search
  const [searchQuery, setSearchQuery] = useState("");
  const [filterState, setFilterState] = useState<string>("all");

  // Host identity & DB counts
  const [identity, setIdentity] = useState<IdentityData>({ name: "Host Developer", email: "developer@workspace" });
  const [summary, setSummary] = useState<DbSummary>({
    customers: 100,
    billing: 250,
    bucketCount: 4,
    gitBranch: "main",
  });

  // Connection management
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formBusy, setFormBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);

  // Toast notification
  const [toast, setToast] = useState<{ message: string; type?: "info" | "success" | "error" } | null>(null);

  const showToast = useCallback((message: string, type: "info" | "success" | "error" = "info") => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  // Selected Action
  const selectedAction = useMemo(() => {
    return actions.find((a) => a.id === selectedId) || actions[0] || null;
  }, [actions, selectedId]);

  // Selected Connection
  const selectedConnection = useMemo(() => {
    return connections.find((c) => c.id === selectedConnectionId) || connections[0] || null;
  }, [connections, selectedConnectionId]);

  // Pending Actions
  const pendingActions = useMemo(() => {
    return actions.filter((a) => a.state === "pending_approval" || a.state === "frozen");
  }, [actions]);

  // Filtered Actions for Activity Tab
  const filteredActions = useMemo(() => {
    return actions.filter((action) => {
      const matchesSearch =
        searchQuery === "" ||
        action.tool.toLowerCase().includes(searchQuery.toLowerCase()) ||
        action.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
        action.targetTitle.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesFilter =
        filterState === "all" ||
        (filterState === "pending" && (action.state === "pending_approval" || action.state === "frozen")) ||
        (filterState === "blocked" && action.state === "blocked") ||
        (filterState === "allowed" && (action.state === "allowed" || action.state === "approved"));

      return matchesSearch && matchesFilter;
    });
  }, [actions, searchQuery, filterState]);

  // --- API Functions ---

  const refreshOperations = useCallback(async (currentConns?: Connection[]) => {
    const connsToUse = currentConns || connectionsRef.current;
    try {
      const [actionsRes, auditRes] = await Promise.all([
        fetch("/api/v1/actions?limit=25", { cache: "no-store" }),
        fetch("/api/v1/audit?limit=25", { cache: "no-store" }),
      ]);

      if (actionsRes.ok) {
        const body = (await actionsRes.json()) as { actions?: Record<string, unknown>[] };
        if (body.actions && body.actions.length > 0) {
          const parsed = body.actions.map((raw) => apiAction(raw, connsToUse));
          setActions(parsed);
          setSelectedId((curr) => (curr && parsed.some((p) => p.id === curr) ? curr : parsed[0]?.id || ""));
        }
      }

      if (auditRes.ok) {
        const body = (await auditRes.json()) as { audit?: AuditEvent[] };
        if (body.audit && body.audit.length > 0) setAudit(body.audit);
      }
    } catch {
      /* ignore fetch errors during background polling */
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const [cusRes, billRes] = await Promise.all([
        fetch("/api/v1/explorer/customers?limit=1", { cache: "no-store" }),
        fetch("/api/v1/explorer/billing?limit=1", { cache: "no-store" }),
      ]);

      let customers = 100;
      let billing = 250;

      if (cusRes.ok) {
        const body = (await cusRes.json()) as { total?: number };
        if (typeof body.total === "number") customers = body.total;
      }
      if (billRes.ok) {
        const body = (await billRes.json()) as { total?: number };
        if (typeof body.total === "number") billing = body.total;
      }

      setSummary((curr) => ({ ...curr, customers, billing }));
    } catch {
      /* ignore */
    }
  }, []);

  const refreshConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/connections", { cache: "no-store" });
      if (!res.ok) return [];
      const body = (await res.json()) as { connections?: Connection[] };
      const next = body.connections || [];
      setConnections(next);
      return next;
    } catch {
      return [];
    }
  }, []);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refreshOperations(), refreshSummary(), refreshConnections()]);
    setIsRefreshing(false);
    showToast("Workspace refreshed", "success");
  };

  // SSE Lifecycle
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

  // Initial Bootstrap & Polling
  useEffect(() => {
    let isCancelled = false;

    const bootstrap = async () => {
      const conns = await refreshConnections();
      if (isCancelled) return;
      await Promise.all([refreshOperations(conns), refreshSummary()]);

      try {
        const hostRes = await fetch("/api/v1/explorer/host", { cache: "no-store" });
        if (hostRes.ok) {
          const hostBody = (await hostRes.json()) as {
            telemetry?: { username?: string; gitEmail?: string; hostname?: string };
          };
          if (!isCancelled && hostBody.telemetry) {
            setIdentity({
              name: hostBody.telemetry.username || "Host User",
              email: hostBody.telemetry.gitEmail || `${hostBody.telemetry.hostname || "local"}@machine`,
            });
          }
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

  // Action Mutate (Approve, Block, Freeze)
  const mutateAction = async (actionId: string, status: "approved" | "blocked" | "frozen") => {
    try {
      const res = await fetch(`/api/v1/actions/${encodeURIComponent(actionId)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, actorId: "operator", note: `Action ${status} by operator` }),
      });
      const body = (await res.json()) as { action?: Record<string, unknown>; error?: { message?: string } };
      if (!res.ok || !body.action) {
        setActions((curr) =>
          curr.map((a) => (a.id === actionId ? { ...a, state: status } : a))
        );
        showToast(`Action ${status}`, status === "approved" ? "success" : "info");
        return;
      }
      setActions((curr) =>
        curr.map((a) => (a.id === actionId ? apiAction(body.action as Record<string, unknown>, connections) : a))
      );
      await refreshOperations();
      showToast(`Action ${status}`, status === "approved" ? "success" : "info");
    } catch {
      setActions((curr) =>
        curr.map((a) => (a.id === actionId ? { ...a, state: status } : a))
      );
      showToast(`Action ${status}`, status === "approved" ? "success" : "info");
    }
  };

  // Connection Registration
  const registerConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim() || "MCP Server",
        transport: form.transport,
      };

      if (form.transport === "stdio") {
        payload.command = form.command.trim();
        payload.args = form.args.split("\n").map((a) => a.trim()).filter(Boolean);
        if (form.cwd.trim()) payload.cwd = form.cwd.trim();
      } else {
        payload.url = form.url.trim();
      }

      if (form.env.trim()) {
        const envObj: Record<string, string> = {};
        form.env.split("\n").forEach((line) => {
          const [k, ...v] = line.split("=");
          if (k) envObj[k.trim()] = v.join("=").trim();
        });
        payload.env = envObj;
      }

      const res = await fetch("/api/v1/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = (await res.json()) as { connection?: Connection; error?: { message?: string } };
      if (!res.ok || !body.connection) {
        showToast(body.error?.message || "Failed to create connection", "error");
        return;
      }

      setForm(emptyForm);
      await refreshConnections();
      setSelectedConnectionId(body.connection.id);
      showToast("Server registered", "success");
    } catch {
      showToast("Registration network error", "error");
    } finally {
      setFormBusy(false);
    }
  };

  const deleteConnection = async (id: string) => {
    if (!confirm("Remove this MCP connection?")) return;
    setConnectionBusy("delete");
    try {
      const res = await fetch(`/api/v1/connections/${id}`, { method: "DELETE" });
      if (res.ok) {
        await refreshConnections();
        showToast("Connection removed", "info");
      }
    } finally {
      setConnectionBusy(null);
    }
  };

  const testConnection = async (id: string) => {
    setConnectionBusy("test");
    try {
      const res = await fetch(`/api/v1/connections/${id}/test`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (res.ok) {
        showToast("Connection test passed", "success");
      } else {
        showToast(body.error?.message || "Test failed", "error");
      }
    } catch {
      showToast("Connection test failed", "error");
    } finally {
      setConnectionBusy(null);
    }
  };

  const discoverTools = async (id: string) => {
    setConnectionBusy("discover");
    try {
      const res = await fetch(`/api/v1/connections/${id}/discover`, { method: "POST" });
      const body = (await res.json()) as { discovery?: Discovery; error?: { message?: string } };
      if (res.ok && body.discovery) {
        setDiscovery(body.discovery);
        showToast(`Discovered ${body.discovery.tools?.length || 0} tools`, "success");
      } else {
        showToast(body.error?.message || "Discovery failed", "error");
      }
    } catch {
      showToast("Discovery request failed", "error");
    } finally {
      setConnectionBusy(null);
    }
  };

  const loadConfig = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/connections/${id}/config`, { method: "POST" });
      const body = (await res.json()) as { config?: ClientConfig };
      if (res.ok && body.config) {
        setConfig(body.config);
      }
    } catch {
      /* ignore */
    }
  };

  // --- Topology Node & Edge Builder ---

  const { nodes, edges } = useMemo(() => {
    const activeTargetId = selectedAction?.target || "target_cloudflare_d1";
    const currentState = selectedAction?.state || "idle";

    const targets: TargetData[] = [
      {
        id: "target_cloudflare_d1",
        title: "Cloudflare D1",
        subtitle: "sentinelgate-d1",
        detail: `${summary.customers} customers · ${summary.billing} invoices`,
      },
      {
        id: "target_s3",
        title: "S3 Storage",
        subtitle: "customer-pii",
        detail: `${summary.bucketCount} export files`,
      },
      {
        id: "target_git",
        title: "Git Repository",
        subtitle: "data/acme-repo",
        detail: `branch: ${summary.gitBranch}`,
      },
      {
        id: "target_telemetry",
        title: "Host System",
        subtitle: "telemetry boundary",
        detail: "Protected host boundary",
      },
    ];

    for (const conn of connections) {
      targets.push({
        id: `target_conn_${conn.id}`,
        title: conn.name,
        subtitle: conn.transport,
        detail: conn.transport === "stdio" ? conn.command || "cli" : conn.url || "endpoint",
      });
    }

    const spacing = 100;
    const totalHeight = targets.length * spacing;
    const centerY = Math.max(90, totalHeight / 2 - 20);

    const calculatedNodes: Node[] = [
      {
        id: "identity",
        type: "identity",
        position: { x: 20, y: centerY },
        data: identity,
      },
      {
        id: "agent",
        type: "agent",
        position: { x: 280, y: centerY - 5 },
        data: {
          agentName: normalizeActorName(selectedAction?.actorId),
          state: currentState,
          activeTargetTitle: selectedAction?.targetTitle,
        },
      },
    ];

    targets.forEach((target, index) => {
      const isActive = target.id === activeTargetId;
      calculatedNodes.push({
        id: target.id,
        type: "target",
        position: { x: 560, y: 20 + index * spacing },
        data: {
          ...target,
          isActive,
          state: isActive ? currentState : "idle",
        },
      });
    });

    const calculatedEdges: Edge[] = [
      {
        id: "e_identity_agent",
        source: "identity",
        target: "agent",
        style: { stroke: "#ffffff", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#ffffff", width: 10, height: 10 },
      },
    ];

    targets.forEach((target) => {
      const isActive = target.id === activeTargetId && currentState !== "idle";
      const edgeColor =
        currentState === "pending_approval" || currentState === "frozen"
          ? "#ffffff"
          : currentState === "blocked"
          ? "#f87171"
          : "#666666";

      calculatedEdges.push({
        id: `e_agent_${target.id}`,
        source: "agent",
        target: target.id,
        animated: isActive,
        style: {
          stroke: isActive ? edgeColor : "#222222",
          strokeWidth: isActive ? 2 : 1,
          ...(isActive ? { strokeDasharray: "4 4" } : {}),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isActive ? edgeColor : "#222222",
          width: 10,
          height: 10,
        },
      });
    });

    return { nodes: calculatedNodes, edges: calculatedEdges };
  }, [connections, identity, selectedAction, summary]);

  return (
    <div className="min-h-screen flex flex-col bg-[#050505] text-[#ededed] font-sans selection:bg-[#ffffff] selection:text-[#000000]">
      {/* Header - Confident Monochrome Typography */}
      <header className="h-13 bg-[#080808] border-b border-[#222222] px-5 sm:px-8 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm font-bold tracking-widest text-[#ffffff] uppercase">
              AEGIS
            </span>
            <span className="text-[11px] font-mono text-[#666666] tracking-wider uppercase hidden sm:inline">
              / CONTROL PLANE
            </span>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center gap-1 font-mono text-xs">
            <button
              type="button"
              onClick={() => setTab("topology")}
              className={`px-3 py-1.5 rounded transition-colors ${
                tab === "topology"
                  ? "bg-[#ffffff] text-[#000000] font-bold"
                  : "text-[#888888] hover:text-[#ededed] hover:bg-[#111111]"
              }`}
            >
              TOPOLOGY
            </button>
            <button
              type="button"
              onClick={() => setTab("approvals")}
              className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                tab === "approvals"
                  ? "bg-[#ffffff] text-[#000000] font-bold"
                  : "text-[#888888] hover:text-[#ededed] hover:bg-[#111111]"
              }`}
            >
              APPROVALS
              {pendingActions.length > 0 && (
                <span className={`text-[10px] px-1.5 rounded font-mono ${
                  tab === "approvals" ? "bg-[#000000] text-[#ffffff]" : "bg-[#222222] text-[#ffffff]"
                }`}>
                  {pendingActions.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setTab("activity")}
              className={`px-3 py-1.5 rounded transition-colors ${
                tab === "activity"
                  ? "bg-[#ffffff] text-[#000000] font-bold"
                  : "text-[#888888] hover:text-[#ededed] hover:bg-[#111111]"
              }`}
            >
              AUDIT LOG
            </button>
            <button
              type="button"
              onClick={() => setTab("mcp")}
              className={`px-3 py-1.5 rounded transition-colors ${
                tab === "mcp"
                  ? "bg-[#ffffff] text-[#000000] font-bold"
                  : "text-[#888888] hover:text-[#ededed] hover:bg-[#111111]"
              }`}
            >
              MCP SERVERS ({connections.length})
            </button>
          </nav>
        </div>

        {/* Right Status Info */}
        <div className="flex items-center gap-4 font-mono text-xs text-[#888888]">
          <div className="hidden md:flex items-center gap-2">
            <span>D1:</span>
            <span className="text-[#ededed]">{summary.customers} customers</span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[#ffffff]" : "bg-[#666666]"}`} />
            <span className="text-[#ededed]">{connected ? "ONLINE" : "OFFLINE"}</span>
          </div>

          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="text-[11px] px-2 py-1 border border-[#222222] hover:border-[#444444] text-[#ededed] rounded transition-colors"
          >
            {isRefreshing ? "SYNCING..." : "SYNC"}
          </button>
        </div>
      </header>

      {/* Main View Area */}
      <main className="flex-1 p-5 sm:p-8 max-w-7xl w-full mx-auto">
        {/* Tab 1: Topology */}
        {tab === "topology" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h1 className="text-base font-bold text-[#ffffff] font-mono tracking-tight uppercase">
                  SYSTEM TOPOLOGY
                </h1>
                <p className="text-xs text-[#888888] font-mono mt-0.5">
                  Autonomous request interception through policy firewall to secured boundaries.
                </p>
              </div>

              <div className="flex items-center gap-2 font-mono text-xs">
                <button
                  type="button"
                  onClick={() => setTab("approvals")}
                  className="btn btn-secondary text-xs"
                >
                  VIEW APPROVALS ({pendingActions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTab("mcp")}
                  className="btn btn-primary text-xs"
                >
                  + ADD MCP SERVER
                </button>
              </div>
            </div>

            {/* Split Canvas & Inspector */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* ReactFlow Canvas */}
              <div className="lg:col-span-8 bg-[#080808] border border-[#222222] rounded h-[580px] flow-shell relative overflow-hidden">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodeClick={(_, node) => {
                    const matched = actions.find((a) => a.target === node.id);
                    if (matched) setSelectedId(matched.id);
                  }}
                  fitView
                  fitViewOptions={{ padding: 0.16 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  zoomOnDoubleClick={false}
                >
                  <Background color="#161616" gap={20} size={1} />
                  <Controls showInteractive={false} />
                  <MiniMap maskColor="rgba(8, 8, 8, 0.85)" />
                </ReactFlow>
              </div>

              {/* Action Inspector */}
              <div className="lg:col-span-4 bg-[#0a0a0a] border border-[#222222] rounded p-4 flex flex-col h-[580px] font-mono text-xs">
                <div className="flex items-center justify-between pb-3 border-b border-[#1c1c1c]">
                  <span className="font-bold text-[#ffffff] tracking-wider uppercase text-[11px]">
                    ACTION INSPECTOR
                  </span>
                  {selectedAction && <StatusBadge state={selectedAction.state} />}
                </div>

                {selectedAction ? (
                  <div className="flex-1 overflow-y-auto pt-3 space-y-3.5">
                    <div>
                      <span className="text-[10px] text-[#666666] uppercase block">OPERATION</span>
                      <p className="text-sm font-bold text-[#ffffff] mt-0.5">{selectedAction.tool}</p>
                      <p className="text-[11px] text-[#888888] mt-1 bg-[#050505] p-2.5 rounded border border-[#1a1a1a] leading-relaxed">
                        {selectedAction.summary}
                      </p>
                    </div>

                    {/* Risk Gauge */}
                    <div className="bg-[#050505] p-2.5 rounded border border-[#1a1a1a]">
                      <div className="flex items-center justify-between text-[11px] mb-1.5">
                        <span className="text-[#666666]">POLICY RISK SCORE</span>
                        <span className="text-[#ffffff] font-bold">{selectedAction.score} / 100</span>
                      </div>
                      <div className="h-1 w-full bg-[#1c1c1c] rounded overflow-hidden">
                        <div
                          className="h-full bg-[#ffffff] transition-all"
                          style={{ width: `${Math.max(6, selectedAction.score)}%` }}
                        />
                      </div>
                    </div>

                    {/* Metadata Table */}
                    <div className="grid grid-cols-2 gap-2 text-[11px] bg-[#050505] p-2.5 rounded border border-[#1a1a1a]">
                      <div>
                        <span className="text-[9px] text-[#666666] uppercase block">TARGET</span>
                        <span className="text-[#ffffff] truncate block">{selectedAction.targetTitle}</span>
                      </div>
                      <div>
                        <span className="text-[9px] text-[#666666] uppercase block">ACTOR</span>
                        <span className="text-[#ffffff] truncate block">
                          {normalizeActorName(selectedAction.actorId)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[9px] text-[#666666] uppercase block">RESOURCE</span>
                        <span className="text-[#888888] truncate block text-[10px]">{selectedAction.resource}</span>
                      </div>
                      <div>
                        <span className="text-[9px] text-[#666666] uppercase block">TIME</span>
                        <span className="text-[#888888] truncate block text-[10px]">{selectedAction.timestamp}</span>
                      </div>
                    </div>

                    {/* Payload JSON */}
                    {selectedAction.payload ? (
                      <div>
                        <div className="flex items-center justify-between mb-1 text-[10px]">
                          <span className="text-[#666666] uppercase font-bold">PAYLOAD DUMP</span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(JSON.stringify(selectedAction.payload, null, 2));
                              showToast("Payload copied to clipboard", "success");
                            }}
                            className="text-[#888888] hover:text-[#ffffff] uppercase"
                          >
                            [ COPY JSON ]
                          </button>
                        </div>
                        <pre className="text-[10px] font-mono bg-[#050505] text-[#ededed] p-2.5 rounded border border-[#1a1a1a] overflow-x-auto max-h-36 leading-relaxed">
                          {JSON.stringify(selectedAction.payload, null, 2)}
                        </pre>
                      </div>
                    ) : null}

                    {/* Decision Actions */}
                    <div className="pt-3 border-t border-[#1c1c1c] space-y-2 mt-auto">
                      <span className="text-[10px] text-[#666666] uppercase font-bold block">
                        HUMAN OVERRIDE
                      </span>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => mutateAction(selectedAction.id, "approved")}
                          disabled={selectedAction.state === "approved" || selectedAction.state === "allowed"}
                          className="btn btn-primary text-xs"
                        >
                          APPROVE
                        </button>
                        <button
                          type="button"
                          onClick={() => mutateAction(selectedAction.id, "blocked")}
                          disabled={selectedAction.state === "blocked"}
                          className="btn btn-secondary text-xs hover:border-[#f87171] hover:text-[#f87171]"
                        >
                          BLOCK
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          mutateAction(selectedAction.id, selectedAction.state === "frozen" ? "approved" : "frozen")
                        }
                        className="btn btn-secondary w-full text-xs"
                      >
                        {selectedAction.state === "frozen" ? "RESUME ACTION" : "FREEZE PIPELINE"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-[#666666]">
                    <p className="text-[11px]">Select any flow node to inspect.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Approvals */}
        {tab === "approvals" && (
          <div className="space-y-4 font-mono text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-[#222222]">
              <div>
                <h1 className="text-base font-bold text-[#ffffff] uppercase">
                  PENDING APPROVALS ({pendingActions.length})
                </h1>
                <p className="text-xs text-[#888888] mt-0.5">
                  Autonomous actions quarantined awaiting human verification.
                </p>
              </div>
              <span className="text-[11px] border border-[#222222] px-2.5 py-1 text-[#ededed]">
                POLICY ENGINE ACTIVE
              </span>
            </div>

            {pendingActions.length > 0 ? (
              <div className="space-y-2">
                {pendingActions.map((action) => (
                  <div
                    key={action.id}
                    className="p-4 bg-[#0a0a0a] border border-[#222222] rounded flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5">
                        <span className="font-bold text-[#ffffff]">{action.tool}</span>
                        <StatusBadge state={action.state} />
                        <span className="text-[10px] text-[#888888] border border-[#222222] px-1.5 py-0.5 rounded">
                          RISK {action.score}/100
                        </span>
                      </div>
                      <p className="text-[#888888] text-[11px] mt-1.5 leading-relaxed">{action.summary}</p>
                      <div className="flex items-center gap-4 mt-2 text-[10px] text-[#666666]">
                        <span>TARGET: <b className="text-[#ededed]">{action.targetTitle}</b></span>
                        <span>CLIENT: <b className="text-[#ededed]">{normalizeActorName(action.actorId)}</b></span>
                        <span>TIME: {action.timestamp}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => mutateAction(action.id, "approved")}
                        className="btn btn-primary text-xs"
                      >
                        APPROVE
                      </button>
                      <button
                        type="button"
                        onClick={() => mutateAction(action.id, "blocked")}
                        className="btn btn-secondary text-xs hover:border-[#f87171] hover:text-[#f87171]"
                      >
                        BLOCK
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-12 text-center border border-[#222222] rounded bg-[#0a0a0a] text-[#888888]">
                <p className="text-sm font-bold text-[#ffffff]">ALL CLEAR</p>
                <p className="text-xs text-[#666666] mt-1">No actions currently quarantined in queue.</p>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Activity & Audit Log */}
        {tab === "activity" && (
          <div className="space-y-4 font-mono text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#222222]">
              <div>
                <h1 className="text-base font-bold text-[#ffffff] uppercase">
                  ACTIVITY & AUDIT LOG
                </h1>
                <p className="text-xs text-[#888888] mt-0.5">
                  Append-only immutable verification record.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="FILTER ACTIONS..."
                  className="form-input text-xs w-48 !py-1.5"
                />
                <select
                  value={filterState}
                  onChange={(e) => setFilterState(e.target.value)}
                  className="form-input text-xs w-36 !py-1.5"
                >
                  <option value="all">ALL STATUSES</option>
                  <option value="pending">PENDING</option>
                  <option value="blocked">BLOCKED</option>
                  <option value="allowed">ALLOWED</option>
                </select>
              </div>
            </div>

            <div className="border border-[#222222] rounded bg-[#0a0a0a] divide-y divide-[#1a1a1a] overflow-hidden">
              {filteredActions.length > 0 ? (
                filteredActions.map((action) => (
                  <div
                    key={action.id}
                    onClick={() => {
                      setSelectedId(action.id);
                      setTab("topology");
                    }}
                    className={`p-3.5 cursor-pointer hover:bg-[#111111] transition-colors flex items-center justify-between gap-3 ${
                      action.id === selectedId ? "bg-[#141414] border-l-2 border-l-[#ffffff]" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-[#ffffff]">{action.tool}</span>
                        <span className="text-[10px] text-[#666666]">/ {action.targetTitle}</span>
                      </div>
                      <p className="text-[#888888] text-[11px] truncate mt-1">{action.summary}</p>
                      <span className="text-[10px] text-[#555555] mt-1 block">
                        {action.id} · {normalizeActorName(action.actorId)} · {action.timestamp}
                      </span>
                    </div>
                    <StatusBadge state={action.state} />
                  </div>
                ))
              ) : (
                <div className="p-8 text-center text-[#666666]">No matching actions found.</div>
              )}
            </div>
          </div>
        )}

        {/* Tab 4: MCP Servers */}
        {tab === "mcp" && (
          <div className="space-y-4 font-mono text-xs">
            <div className="pb-3 border-b border-[#222222]">
              <h1 className="text-base font-bold text-[#ffffff] uppercase">
                MODEL CONTEXT PROTOCOL REGISTRY
              </h1>
              <p className="text-xs text-[#888888] mt-0.5">
                Configure external MCP servers, discover tool definitions, and export configs.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Form */}
              <div className="lg:col-span-5 bg-[#0a0a0a] border border-[#222222] rounded p-4 space-y-3">
                <span className="font-bold text-[#ffffff] text-[11px] tracking-wider uppercase block">
                  REGISTER NEW MCP SERVER
                </span>

                <form onSubmit={registerConnection} className="space-y-3">
                  <div>
                    <label className="form-label">SERVER NAME</label>
                    <input
                      type="text"
                      required={form.transport === "stdio"}
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. github-server"
                      className="form-input"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="form-label">TRANSPORT</label>
                      <select
                        value={form.transport}
                        onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })}
                        className="form-input"
                      >
                        <option value="streamable-http">streamable-http</option>
                        <option value="sse">sse</option>
                        <option value="stdio">stdio (CLI)</option>
                      </select>
                    </div>
                    {form.transport !== "stdio" ? (
                      <div>
                        <label className="form-label">ENDPOINT URL</label>
                        <input
                          type="url"
                          required
                          value={form.url}
                          onChange={(e) => setForm({ ...form, url: e.target.value })}
                          placeholder="https://..."
                          className="form-input text-xs"
                        />
                      </div>
                    ) : (
                      <div>
                        <label className="form-label">COMMAND</label>
                        <input
                          type="text"
                          required
                          value={form.command}
                          onChange={(e) => setForm({ ...form, command: e.target.value })}
                          placeholder="npx"
                          className="form-input text-xs"
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="form-label">ENVIRONMENT (KEY=VAL)</label>
                    <textarea
                      value={form.env}
                      onChange={(e) => setForm({ ...form, env: e.target.value })}
                      placeholder="API_KEY=value"
                      rows={2}
                      className="form-input text-xs"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={formBusy}
                    className="btn btn-primary w-full text-xs"
                  >
                    {formBusy ? "REGISTERING..." : "REGISTER SERVER"}
                  </button>
                </form>
              </div>

              {/* Connections list */}
              <div className="lg:col-span-7 space-y-3">
                <div className="border border-[#222222] rounded bg-[#0a0a0a] divide-y divide-[#1a1a1a] overflow-hidden">
                  <div className="p-3 bg-[#080808] text-[10px] text-[#666666] uppercase flex justify-between">
                    <span>ACTIVE GATEWAYS</span>
                    <span>{connections.length} SERVERS</span>
                  </div>
                  {connections.length > 0 ? (
                    connections.map((c) => (
                      <div key={c.id} className="p-3.5 flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[#ffffff]">{c.name}</span>
                            <span className="text-[10px] text-[#888888] border border-[#222222] px-1.5 py-0.5 rounded">
                              {c.transport}
                            </span>
                          </div>
                          <p className="text-[11px] text-[#666666] mt-1 truncate max-w-sm">
                            {c.transport === "stdio" ? `${c.command} ${(c.args || []).join(" ")}` : c.url}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => testConnection(c.id)}
                            className="btn btn-secondary text-xs !py-1 !px-2.5"
                          >
                            TEST
                          </button>
                          <button
                            type="button"
                            onClick={() => discoverTools(c.id)}
                            className="btn btn-secondary text-xs !py-1 !px-2.5"
                          >
                            TOOLS
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteConnection(c.id)}
                            className="text-[#666666] hover:text-[#f87171] text-xs px-2 py-1"
                          >
                            [DEL]
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-[#666666]">
                      No external MCP servers registered yet.
                    </div>
                  )}
                </div>

                {discovery && (
                  <div className="border border-[#222222] rounded bg-[#0a0a0a] p-3.5">
                    <div className="flex justify-between items-center pb-2 border-b border-[#1a1a1a] mb-2 font-bold text-[#ffffff]">
                      <span>DISCOVERED TOOLS ({discovery.tools?.length || 0})</span>
                      <button type="button" onClick={() => setDiscovery(null)} className="text-[#888888] hover:text-[#ffffff]">
                        [CLOSE]
                      </button>
                    </div>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {discovery.tools?.map((t) => (
                        <div key={t.name} className="p-2 bg-[#050505] rounded border border-[#1a1a1a]">
                          <span className="font-bold text-[#ffffff]">{t.name}</span>
                          {t.description && <p className="text-[10px] text-[#777777] mt-0.5">{t.description}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#0a0a0a] border border-[#333333] text-[#ffffff] text-xs font-mono px-4 py-2.5 rounded shadow-2xl">
          {toast.message}
        </div>
      )}
    </div>
  );
}
