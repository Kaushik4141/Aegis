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
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cloud,
  Code2,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Filter,
  Github,
  KeyRound,
  Layers,
  Link2,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  User,
  X,
  XCircle,
  Zap,
} from "lucide-react";
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

interface OAuthStatus {
  configured?: boolean;
  supported?: boolean;
  authorized?: boolean;
  pending?: boolean;
  error?: string;
  tokenExpiresAt?: string;
  clientRegistration?: string;
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
      targetTitle: "Cloudflare D1 (Cloud)",
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
    targetTitle = "Cloudflare D1 (Cloud)";
  } else if (text.includes("s3") || text.includes("bucket") || text.includes("file") || text.includes("export")) {
    target = "target_s3";
    targetTitle = "Local S3 Storage";
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
    score: typeof raw.score === "number" ? raw.score : typeof analysis.riskScore === "number" ? analysis.riskScore : state === "blocked" ? 92 : state === "pending_approval" ? 75 : 10,
    timestamp: raw.createdAt ? new Date(String(raw.createdAt)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Just now",
    payload: raw.payload || raw.params || raw.args || null,
  };
}

// --- Status Badge Component ---

function StatusBadge({ state, dot = true }: { state: GatewayState; dot?: boolean }) {
  const styles: Record<GatewayState, { bg: string; text: string; border: string; dot: string; label: string }> = {
    approved: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-500", label: "Approved" },
    allowed: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-500", label: "Allowed" },
    blocked: { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", dot: "bg-rose-500", label: "Blocked" },
    pending_approval: { bg: "bg-amber-50", text: "text-amber-800", border: "border-amber-200", dot: "bg-amber-500", label: "Pending Review" },
    frozen: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", dot: "bg-blue-500", label: "Frozen" },
    idle: { bg: "bg-slate-100", text: "text-slate-600", border: "border-slate-200", dot: "bg-slate-400", label: "Idle" },
  };

  const style = styles[state] || styles.idle;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border ${style.bg} ${style.text} ${style.border}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />}
      {style.label}
    </span>
  );
}

// --- ReactFlow Custom Nodes ---

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
  icon: React.ReactNode;
  detail: string;
  isActive?: boolean;
  state?: GatewayState;
}

function IdentityFlowNode({ data }: NodeProps<Node<IdentityData>>) {
  return (
    <div className="bg-white border border-slate-300 rounded-lg shadow-sm p-3.5 w-[210px]">
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700 shrink-0">
          <User size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-900 truncate">{data.name}</p>
          <p className="text-[11px] text-slate-500 truncate">{data.email}</p>
        </div>
      </div>
      <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
        <span>Operator Session</span>
        <span className="text-emerald-600 font-medium">Local</span>
      </div>
    </div>
  );
}

function AgentFlowNode({ data }: NodeProps<Node<AgentData>>) {
  const isAlert = data.state === "pending_approval" || data.state === "blocked" || data.state === "frozen";

  return (
    <div className={`bg-white border rounded-lg shadow-sm p-3.5 w-[230px] transition-colors ${isAlert ? "border-amber-400 ring-2 ring-amber-100" : "border-slate-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-md bg-slate-900 flex items-center justify-center text-white shrink-0">
          <Bot size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-900 truncate">{data.agentName}</p>
            {isAlert && <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />}
          </div>
          <p className="text-[11px] text-slate-500 truncate">{data.activeTargetTitle ? `Target: ${data.activeTargetTitle}` : "Active Client"}</p>
        </div>
      </div>
      <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between">
        <span className="text-[11px] text-slate-500">Firewall status</span>
        <StatusBadge state={data.state} />
      </div>
    </div>
  );
}

function TargetFlowNode({ data }: NodeProps<Node<TargetData>>) {
  const isAlert = data.isActive && (data.state === "pending_approval" || data.state === "blocked");

  return (
    <div className={`bg-white border rounded-lg shadow-sm p-3 w-[240px] transition-all ${data.isActive ? "border-blue-500 ring-2 ring-blue-50" : "border-slate-300"} ${isAlert ? "border-amber-400 ring-2 ring-amber-100" : ""}`}>
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <div className="flex items-start gap-2.5">
        <div className={`w-7 h-7 rounded-md border flex items-center justify-center shrink-0 mt-0.5 ${data.isActive ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
          {data.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1">
            <p className="text-xs font-semibold text-slate-900 truncate">{data.title}</p>
            {data.isActive && <span className="text-[10px] font-medium text-blue-600 bg-blue-50 px-1 rounded">Active</span>}
          </div>
          <p className="text-[11px] text-slate-500 truncate">{data.subtitle}</p>
          <div className="mt-1.5 text-[11px] text-slate-600 font-mono bg-slate-50 p-1 rounded border border-slate-100 truncate">
            {data.detail}
          </div>
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

// --- Main Application Component ---

export default function Home() {
  const [tab, setTab] = useState<ActiveTab>("topology");
  const [connections, setConnections] = useState<Connection[]>([]);
  const connectionsRef = useRef<Connection[]>([]);
  connectionsRef.current = connections;

  const [actions, setActions] = useState<Action[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [connected, setConnected] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  // Filtering & search
  const [searchQuery, setSearchQuery] = useState("");
  const [filterState, setFilterState] = useState<string>("all");

  // Host identity & DB counts
  const [identity, setIdentity] = useState<IdentityData>({ name: "Host Developer", email: "local@workspace" });
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
  const [oauthStatuses, setOauthStatuses] = useState<Record<string, OAuthStatus>>({});

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
        if (body.actions) {
          const parsed = body.actions.map((raw) => apiAction(raw, connsToUse));
          setActions(parsed);
          setSelectedId((curr) => (curr && parsed.some((p) => p.id === curr) ? curr : parsed[0]?.id || ""));
        }
      }

      if (auditRes.ok) {
        const body = (await auditRes.json()) as { audit?: AuditEvent[] };
        if (body.audit) setAudit(body.audit);
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
    showToast("Dashboard data updated", "success");
  };

  // Dedicated SSE Connection Lifecycle
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
          const hostBody = (await hostRes.json()) as { telemetry?: { username?: string; gitEmail?: string; hostname?: string } };
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
        showToast(body.error?.message || "Failed to resolve action", "error");
        return;
      }
      setActions((curr) => curr.map((a) => (a.id === actionId ? apiAction(body.action as Record<string, unknown>, connections) : a)));
      await refreshOperations();
      showToast(`Action ${status}`, status === "approved" ? "success" : "info");
    } catch {
      showToast("Network request failed", "error");
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
      const updated = await refreshConnections();
      setSelectedConnectionId(body.connection.id);
      showToast("Server registered successfully", "success");
    } catch {
      showToast("Network error while creating connection", "error");
    } finally {
      setFormBusy(false);
    }
  };

  // Delete Connection
  const deleteConnection = async (id: string) => {
    if (!confirm("Are you sure you want to remove this connection?")) return;
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

  // Test Connection
  const testConnection = async (id: string) => {
    setConnectionBusy("test");
    try {
      const res = await fetch(`/api/v1/connections/${id}/test`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (res.ok) {
        showToast("Connection test succeeded", "success");
      } else {
        showToast(body.error?.message || "Test failed", "error");
      }
    } catch {
      showToast("Connection test failed", "error");
    } finally {
      setConnectionBusy(null);
    }
  };

  // Discover Tools
  const discoverTools = async (id: string) => {
    setConnectionBusy("discover");
    try {
      const res = await fetch(`/api/v1/connections/${id}/discover`, { method: "POST" });
      const body = (await res.json()) as { discovery?: Discovery; error?: { message?: string } };
      if (res.ok && body.discovery) {
        setDiscovery(body.discovery);
        showToast(`Discovered ${body.discovery.tools?.length || 0} tools`, "success");
      } else {
        showToast(body.error?.message || "Tool discovery failed", "error");
      }
    } catch {
      showToast("Discovery request failed", "error");
    } finally {
      setConnectionBusy(null);
    }
  };

  // Load Config
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
        subtitle: "sentinelgate-d1 · APAC",
        icon: <Database size={14} />,
        detail: `${summary.customers} customers · ${summary.billing} invoices`,
      },
      {
        id: "target_s3",
        title: "S3 Storage",
        subtitle: "customer-pii bucket",
        icon: <Cloud size={14} />,
        detail: `${summary.bucketCount} export files`,
      },
      {
        id: "target_git",
        title: "Git Repository",
        subtitle: "data/acme-repo",
        icon: <Github size={14} />,
        detail: `Branch: ${summary.gitBranch}`,
      },
      {
        id: "target_telemetry",
        title: "Host System",
        subtitle: "system metrics & environment",
        icon: <Activity size={14} />,
        detail: "Protected host boundary",
      },
    ];

    // Add registered MCP connections
    for (const conn of connections) {
      targets.push({
        id: `target_conn_${conn.id}`,
        title: conn.name,
        subtitle: conn.transport,
        icon: <Server size={14} />,
        detail: conn.transport === "stdio" ? conn.command || "cli" : conn.url || "endpoint",
      });
    }

    const spacing = 105;
    const totalHeight = targets.length * spacing;
    const centerY = Math.max(120, totalHeight / 2 - 20);

    const calculatedNodes: Node[] = [
      {
        id: "identity",
        type: "identity",
        position: { x: 30, y: centerY },
        data: identity,
      },
      {
        id: "agent",
        type: "agent",
        position: { x: 290, y: centerY - 5 },
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
        position: { x: 580, y: 30 + index * spacing },
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
        style: { stroke: "#94a3b8", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 12, height: 12 },
      },
    ];

    targets.forEach((target) => {
      const isActive = target.id === activeTargetId && currentState !== "idle";
      const edgeColor =
        currentState === "pending_approval" || currentState === "frozen"
          ? "#d97706"
          : currentState === "blocked"
          ? "#e11d48"
          : currentState === "allowed" || currentState === "approved"
          ? "#16a34a"
          : "#cbd5e1";

      calculatedEdges.push({
        id: `e_agent_${target.id}`,
        source: "agent",
        target: target.id,
        animated: isActive,
        style: {
          stroke: isActive ? edgeColor : "#e2e8f0",
          strokeWidth: isActive ? 2 : 1.2,
          ...(isActive ? { strokeDasharray: "4 4" } : {}),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isActive ? edgeColor : "#cbd5e1",
          width: 12,
          height: 12,
        },
      });
    });

    return { nodes: calculatedNodes, edges: calculatedEdges };
  }, [connections, identity, selectedAction, summary]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Header */}
      <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded bg-slate-900 text-white flex items-center justify-center font-bold">
              <Shield size={16} />
            </div>
            <div>
              <span className="text-sm font-semibold tracking-tight text-slate-900">Aegis</span>
              <span className="text-xs text-slate-500 ml-2 hidden sm:inline">Action Firewall & Control Plane</span>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setTab("topology")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === "topology" ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              Topology
            </button>
            <button
              type="button"
              onClick={() => setTab("approvals")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                tab === "approvals" ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              Approvals
              {pendingActions.length > 0 && (
                <span className="bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                  {pendingActions.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setTab("activity")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === "activity" ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              Activity & Audit
            </button>
            <button
              type="button"
              onClick={() => setTab("mcp")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === "mcp" ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              MCP Servers ({connections.length})
            </button>
          </nav>
        </div>

        {/* Header Right Metadata & Actions */}
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded">
            <Database size={13} className="text-slate-400" />
            <span>Cloudflare D1:</span>
            <span className="font-mono text-slate-700 font-medium">{summary.customers} customers</span>
          </div>

          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span className="hidden sm:inline">{connected ? "Gateway live" : "Connecting…"}</span>
          </div>

          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
            title="Refresh state"
          >
            <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
        {tab === "topology" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-base font-semibold text-slate-900">System Topology</h1>
                <p className="text-xs text-slate-500">Live request routing from client agents through the policy firewall to protected targets.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTab("approvals")}
                  className="btn btn-secondary text-xs"
                >
                  <AlertTriangle size={13} className="text-amber-600" />
                  View Approvals ({pendingActions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTab("mcp")}
                  className="btn btn-primary text-xs"
                >
                  <Plus size={13} />
                  Add MCP Server
                </button>
              </div>
            </div>

            {/* Split: Canvas and Inspector */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* ReactFlow Canvas */}
              <div className="lg:col-span-8 bg-white border border-slate-200 rounded-lg shadow-sm h-[580px] flow-shell relative overflow-hidden">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodeClick={(_, node) => {
                    const matched = actions.find((a) => a.target === node.id);
                    if (matched) setSelectedId(matched.id);
                  }}
                  fitView
                  fitViewOptions={{ padding: 0.18 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  zoomOnDoubleClick={false}
                >
                  <Background color="#cbd5e1" gap={20} size={1} />
                  <Controls showInteractive={false} />
                  <MiniMap maskColor="rgba(241, 245, 249, 0.7)" />
                </ReactFlow>
              </div>

              {/* Triage / Inspector Panel */}
              <div className="lg:col-span-4 bg-white border border-slate-200 rounded-lg shadow-sm p-4 flex flex-col h-[580px]">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={16} className="text-slate-700" />
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-700">Action Inspector</h2>
                  </div>
                  {selectedAction && <StatusBadge state={selectedAction.state} />}
                </div>

                {selectedAction ? (
                  <div className="flex-1 overflow-y-auto pt-3 space-y-4">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{selectedAction.tool}</p>
                      <p className="text-xs text-slate-600 mt-1 leading-relaxed">{selectedAction.summary}</p>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 border border-slate-200 rounded-md p-2.5">
                      <div>
                        <span className="text-[11px] text-slate-400 block">Target</span>
                        <span className="font-medium text-slate-800">{selectedAction.targetTitle}</span>
                      </div>
                      <div>
                        <span className="text-[11px] text-slate-400 block">Agent / Client</span>
                        <span className="font-medium text-slate-800">{normalizeActorName(selectedAction.actorId)}</span>
                      </div>
                      <div>
                        <span className="text-[11px] text-slate-400 block">Risk Score</span>
                        <span className={`font-semibold ${selectedAction.score >= 70 ? "text-rose-600" : "text-emerald-600"}`}>
                          {selectedAction.score} / 100
                        </span>
                      </div>
                      <div>
                        <span className="text-[11px] text-slate-400 block">Time</span>
                        <span className="font-medium text-slate-800">{selectedAction.timestamp}</span>
                      </div>
                    </div>

                    {selectedAction.payload ? (
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-medium text-slate-600">Payload Data</span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(JSON.stringify(selectedAction.payload, null, 2));
                              showToast("Payload copied to clipboard", "success");
                            }}
                            className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"
                          >
                            <Copy size={11} /> Copy JSON
                          </button>
                        </div>
                        <pre className="text-[11px] font-mono bg-slate-900 text-slate-100 p-3 rounded-md overflow-x-auto max-h-48 leading-tight">
                          {JSON.stringify(selectedAction.payload, null, 2)}
                        </pre>
                      </div>
                    ) : null}

                    {/* Decision Action Buttons */}
                    <div className="pt-2 border-t border-slate-100 mt-auto">
                      <p className="text-xs font-medium text-slate-700 mb-2">Human Control Action</p>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => mutateAction(selectedAction.id, "approved")}
                          disabled={selectedAction.state === "approved" || selectedAction.state === "allowed"}
                          className="btn btn-success text-xs"
                        >
                          <Check size={14} /> Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => mutateAction(selectedAction.id, "blocked")}
                          disabled={selectedAction.state === "blocked"}
                          className="btn btn-danger text-xs"
                        >
                          <X size={14} /> Block
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => mutateAction(selectedAction.id, selectedAction.state === "frozen" ? "approved" : "frozen")}
                        className="btn btn-secondary text-xs w-full mt-2"
                      >
                        <Pause size={13} />
                        {selectedAction.state === "frozen" ? "Resume Action" : "Freeze Action"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-slate-400">
                    <Shield size={28} className="mb-2 stroke-1" />
                    <p className="text-xs">Select any node or stream item to inspect details.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Pending Approvals */}
        {tab === "approvals" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-base font-semibold text-slate-900">Pending Approvals</h1>
                <p className="text-xs text-slate-500">Autonomous actions held by policy awaiting human verification.</p>
              </div>
              <span className="text-xs text-slate-500 bg-white border border-slate-200 px-2 py-1 rounded">
                {pendingActions.length} actions waiting
              </span>
            </div>

            {pendingActions.length > 0 ? (
              <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden divide-y divide-slate-100">
                {pendingActions.map((action) => (
                  <div key={action.id} className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:bg-slate-50/60 transition-colors">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-8 h-8 rounded bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700 shrink-0 mt-0.5">
                        <AlertTriangle size={15} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-slate-900">{action.tool}</p>
                          <StatusBadge state={action.state} />
                          <span className="text-xs font-medium text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-100">
                            Risk: {action.score}/100
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 mt-1">{action.summary}</p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                          <span>Target: <b className="text-slate-700 font-medium">{action.targetTitle}</b></span>
                          <span>Client: <b className="text-slate-700 font-medium">{normalizeActorName(action.actorId)}</b></span>
                          <span>Time: {action.timestamp}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                      <button
                        type="button"
                        onClick={() => mutateAction(action.id, "approved")}
                        className="btn btn-success text-xs flex-1 sm:flex-initial"
                      >
                        <Check size={13} /> Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => mutateAction(action.id, "blocked")}
                        className="btn btn-danger text-xs flex-1 sm:flex-initial"
                      >
                        <X size={13} /> Block
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-lg p-12 text-center">
                <CheckCircle2 size={32} className="mx-auto text-emerald-600 mb-2 stroke-1" />
                <h3 className="text-sm font-semibold text-slate-900">All Clear</h3>
                <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                  No actions are currently pending approval. All incoming agent actions are processed deterministically.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Activity & Audit Trail */}
        {tab === "activity" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h1 className="text-base font-semibold text-slate-900">Activity & Audit Trail</h1>
                <p className="text-xs text-slate-500">Live stream of intercepted requests and immutable audit ledger.</p>
              </div>

              {/* Filters */}
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search actions…"
                    className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:border-blue-500 w-48"
                  />
                </div>
                <select
                  value={filterState}
                  onChange={(e) => setFilterState(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white text-slate-700 focus:outline-none"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="blocked">Blocked</option>
                  <option value="allowed">Allowed / Approved</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Actions Stream */}
              <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden flex flex-col">
                <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                  <span className="text-xs font-semibold text-slate-700">Live Gateway Actions ({filteredActions.length})</span>
                </div>
                <div className="divide-y divide-slate-100 max-h-[500px] overflow-y-auto">
                  {filteredActions.length > 0 ? (
                    filteredActions.map((action) => (
                      <div
                        key={action.id}
                        onClick={() => {
                          setSelectedId(action.id);
                          setTab("topology");
                        }}
                        className={`p-3 text-xs cursor-pointer hover:bg-slate-50 transition-colors flex items-center justify-between gap-3 ${
                          action.id === selectedId ? "bg-blue-50/40" : ""
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-900">{action.tool}</span>
                            <span className="text-[11px] text-slate-500">· {action.targetTitle}</span>
                          </div>
                          <p className="text-slate-600 truncate mt-0.5">{action.summary}</p>
                          <span className="text-[10px] text-slate-400 mt-1 block">
                            {normalizeActorName(action.actorId)} · {action.timestamp}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <StatusBadge state={action.state} />
                          <ChevronRight size={13} className="text-slate-300" />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-xs text-slate-500">No actions matched your filter.</div>
                  )}
                </div>
              </div>

              {/* Audit Ledger */}
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden flex flex-col">
                <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                  <span className="text-xs font-semibold text-slate-700">Audit Events ({audit.length})</span>
                  <span className="text-[11px] text-slate-400 font-mono">Immutable</span>
                </div>
                <div className="divide-y divide-slate-100 max-h-[500px] overflow-y-auto">
                  {audit.length > 0 ? (
                    audit.map((evt) => (
                      <div key={evt.id} className="p-3 text-xs">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-mono font-medium text-slate-800">{evt.type}</span>
                          <span className="text-slate-400">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <p className="text-slate-600 mt-1 text-[11px] leading-relaxed">
                          {evt.reason || `Transitioned to ${evt.toStatus}`}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                          <span>ID: {evt.actionId.slice(0, 14)}…</span>
                          {evt.actorId && <span>· by {evt.actorId}</span>}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-xs text-slate-500">No audit events recorded yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: MCP Connections & Tool Registry */}
        {tab === "mcp" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-base font-semibold text-slate-900">Model Context Protocol Servers</h1>
                <p className="text-xs text-slate-500">Register and govern MCP servers, inspect discovered tools, and configure client endpoints.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Left Column: Register Form */}
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg shadow-sm p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-700 mb-3 flex items-center gap-1.5">
                  <Plus size={14} /> Register New MCP Server
                </h2>

                <form onSubmit={registerConnection} className="space-y-3">
                  <div>
                    <label className="form-label">Server Name</label>
                    <input
                      type="text"
                      required={form.transport === "stdio"}
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. GitHub MCP or Cloudflare"
                      className="form-input"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="form-label">Transport</label>
                      <select
                        value={form.transport}
                        onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })}
                        className="form-input"
                      >
                        <option value="streamable-http">Streamable HTTP</option>
                        <option value="sse">SSE</option>
                        <option value="stdio">stdio</option>
                      </select>
                    </div>
                    {form.transport !== "stdio" ? (
                      <div>
                        <label className="form-label">Server URL</label>
                        <input
                          type="url"
                          required
                          value={form.url}
                          onChange={(e) => setForm({ ...form, url: e.target.value })}
                          placeholder="https://…"
                          className="form-input font-mono text-xs"
                        />
                      </div>
                    ) : (
                      <div>
                        <label className="form-label">Command</label>
                        <input
                          type="text"
                          required
                          value={form.command}
                          onChange={(e) => setForm({ ...form, command: e.target.value })}
                          placeholder="npx"
                          className="form-input font-mono text-xs"
                        />
                      </div>
                    )}
                  </div>

                  {form.transport === "stdio" && (
                    <div>
                      <label className="form-label">Arguments (one per line)</label>
                      <textarea
                        value={form.args}
                        onChange={(e) => setForm({ ...form, args: e.target.value })}
                        placeholder="-y&#10;@modelcontextprotocol/server-github"
                        rows={2}
                        className="form-input font-mono text-xs"
                      />
                    </div>
                  )}

                  <div>
                    <label className="form-label">Environment Variables (KEY=VALUE per line)</label>
                    <textarea
                      value={form.env}
                      onChange={(e) => setForm({ ...form, env: e.target.value })}
                      placeholder="API_KEY=secret_value"
                      rows={2}
                      className="form-input font-mono text-xs"
                    />
                  </div>

                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={formBusy}
                      className="btn btn-primary text-xs w-full"
                    >
                      {formBusy ? "Registering…" : "Register MCP Connection"}
                    </button>
                  </div>
                </form>
              </div>

              {/* Right Column: Connection List & Details */}
              <div className="lg:col-span-7 space-y-4">
                <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
                  <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                    <span className="text-xs font-semibold text-slate-700">Registered MCP Gateways</span>
                    <span className="text-xs text-slate-500">{connections.length} active</span>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {connections.length > 0 ? (
                      connections.map((c) => (
                        <div
                          key={c.id}
                          className={`p-3.5 transition-colors ${
                            selectedConnection?.id === c.id ? "bg-blue-50/30" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700 shrink-0">
                                {c.transport === "stdio" ? <Terminal size={14} /> : <Server size={14} />}
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-semibold text-slate-900">{c.name}</span>
                                  <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded border border-slate-200">
                                    {c.transport}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-500 font-mono mt-0.5 truncate max-w-sm">
                                  {c.transport === "stdio" ? `${c.command} ${(c.args || []).join(" ")}` : c.url}
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedConnectionId(c.id);
                                  testConnection(c.id);
                                }}
                                disabled={connectionBusy === "test"}
                                className="btn btn-secondary text-xs px-2 py-1"
                              >
                                Test
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedConnectionId(c.id);
                                  discoverTools(c.id);
                                }}
                                disabled={connectionBusy === "discover"}
                                className="btn btn-secondary text-xs px-2 py-1"
                              >
                                Tools
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedConnectionId(c.id);
                                  loadConfig(c.id);
                                }}
                                className="btn btn-secondary text-xs px-2 py-1"
                              >
                                Config
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteConnection(c.id)}
                                className="p-1 text-slate-400 hover:text-rose-600 rounded ml-1"
                                title="Remove connection"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="p-8 text-center text-xs text-slate-500">
                        No external MCP servers registered yet.
                      </div>
                    )}
                  </div>
                </div>

                {/* Discovered Tools Display */}
                {discovery && (
                  <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-4">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-100 mb-3">
                      <span className="text-xs font-semibold text-slate-800">
                        Discovered Tools ({discovery.tools?.length || 0})
                      </span>
                      <button
                        type="button"
                        onClick={() => setDiscovery(null)}
                        className="text-slate-400 hover:text-slate-700"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {discovery.tools?.map((t) => (
                        <div key={t.name} className="p-2 border border-slate-100 rounded bg-slate-50 text-xs">
                          <span className="font-mono font-medium text-slate-900">{t.name}</span>
                          {t.description && <p className="text-[11px] text-slate-600 mt-0.5">{t.description}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Client Configuration Drawer */}
                {config && (
                  <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-4">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-100 mb-2">
                      <span className="text-xs font-semibold text-slate-800">Client Integration Snippet</span>
                      <button
                        type="button"
                        onClick={() => setConfig(null)}
                        className="text-slate-400 hover:text-slate-700"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-500 mb-2">Paste into your IDE or `.mcp.json` file:</p>
                    <pre className="text-[11px] font-mono bg-slate-900 text-slate-100 p-3 rounded-md overflow-x-auto max-h-44">
                      {JSON.stringify(config.claudeDesktop || config.mcp, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-slate-900 text-white text-xs px-3.5 py-2.5 rounded-md shadow-lg flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
          {toast.type === "success" ? (
            <CheckCircle2 size={14} className="text-emerald-400" />
          ) : toast.type === "error" ? (
            <AlertCircle size={14} className="text-rose-400" />
          ) : (
            <Shield size={14} className="text-blue-400" />
          )}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
