"use client";

import { Background, Controls, MiniMap, ReactFlow, applyNodeChanges, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  FolderOpen,
  Github,
  GripVertical,
  LayoutGrid,
  Link2,
  Pause,
  Plus,
  RefreshCw,
  Terminal as TerminalIcon,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SANDBOX_TEMPLATES, type SandboxRecordUi, type SandboxEventUi } from "../lib/types";
import { copyText, eventSummary, eventTone, Panel, SectionHeading, StatusPill, parseMap } from "../lib/ui";
import { SandboxTerminal } from "./terminal";

type SandboxNodeData = {
  sandbox: SandboxRecordUi;
  hasAlert: boolean;
  initialCommand?: string;
  signature?: string;
  onInspect: (id: string) => void;
  onSessionEnded: (id: string) => void;
  onLink?: (message: string) => void;
};

const sandboxSignature = (sandbox: SandboxRecordUi, hasAlert: boolean, initialCommand: string): string =>
  `${sandbox.name}|${sandbox.status}|${sandbox.mode}|${sandbox.homeProfile ? 1 : 0}|${sandbox.project?.name ?? ""}|${sandbox.project?.path ?? ""}|${sandbox.project?.readOnly ? 1 : 0}|${hasAlert ? 1 : 0}|${initialCommand}`;

const CANVAS_POSITIONS_KEY = "aegis-canvas-positions";
const canvasSlot = (slot: number) => ({ x: 40 + (slot % 2) * 660, y: 24 + Math.floor(slot / 2) * 430 });

function SandboxWindowNode({ data, selected }: NodeProps) {
  const { sandbox, hasAlert, initialCommand, onInspect, onSessionEnded, onLink } = data as SandboxNodeData;
  const running = sandbox.status === "running";
  return (
    <div
      className={`w-[620px] overflow-hidden rounded-xl border bg-white shadow-panel ${
        hasAlert ? "border-red-300 ring-2 ring-red-300" : selected ? "border-blue-300 ring-2 ring-blue-300" : "border-slate-200"
      }`}
    >
      <div
        className="flex cursor-grab select-none items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-3 py-2"
        title="Drag this bar to move the window"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center gap-1 rounded bg-slate-200/80 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-slate-500">
            <GripVertical size={10} />
            move
          </span>
          <span className="truncate text-[11px] font-bold text-slate-800">{sandbox.name}</span>
          {sandbox.project && (
            <StatusPill tone="blue">
              <Github size={10} /> {sandbox.project.name}
              {sandbox.project.readOnly ? " · ro" : ""}
            </StatusPill>
          )}
          {sandbox.homeProfile && <StatusPill tone="green">home</StatusPill>}
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
            onLink={onLink}
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

export function AgentsView({ notify }: { notify: (message: string) => void }) {
  const [sandboxes, setSandboxes] = useState<SandboxRecordUi[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [events, setEvents] = useState<SandboxEventUi[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [mode, setMode] = useState<"observe" | "enforce">("observe");
  const [busy, setBusy] = useState(false);
  const [serviceUp, setServiceUp] = useState(true);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [alertIds, setAlertIds] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [customModal, setCustomModal] = useState(false);
  const [linkBar, setLinkBar] = useState<string | null>(null);
  // Project modal fields
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectReadOnly, setProjectReadOnly] = useState(false);
  const [homeProfile, setHomeProfile] = useState(true);
  // Custom run modal fields
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [stdinText, setStdinText] = useState("");
  const initialCommands = useRef<Record<string, string>>({});
  const positions = useRef<Record<string, { x: number; y: number }>>({});

  const selected = sandboxes.find((sandbox) => sandbox.id === selectedId) || null;
  const alertCount = events.filter((event) => event.type === "alert").length;

  useEffect(() => {
    try {
      positions.current = { ...positions.current, ...JSON.parse(window.localStorage.getItem(CANVAS_POSITIONS_KEY) || "{}") };
    } catch {
      /* fresh canvas */
    }
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
    if (!selectedId) {
      setEvents([]);
      setLogs([]);
      return;
    }
    try {
      const [eventsResponse, logsResponse] = await Promise.all([
        fetch(`/api/v1/sandboxes/${selectedId}/events?limit=300`, { cache: "no-store" }),
        fetch(`/sandbox-api/sandboxes/${selectedId}/logs`, { cache: "no-store" }),
      ]);
      if (eventsResponse.ok) setEvents((((await eventsResponse.json()) as { events?: SandboxEventUi[] }).events || []).slice().reverse());
      if (logsResponse.ok) setLogs(((await logsResponse.json()) as { logs?: string[] }).logs || []);
    } catch {
      /* keep last known */
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Mirror sandboxes into canvas nodes. Node objects keep their identity
  // unless their data actually changed: React Flow tracks drags per node
  // instance, so replacing objects on every 3s poll would kill in-progress
  // drags.
  const dragInProgress = useRef(false);
  useEffect(() => {
    if (dragInProgress.current) return;
    setNodes((previous) =>
      sandboxes.map((sandbox, index) => {
        const existing = previous.find((node) => node.id === sandbox.id);
        const hasAlert = alertIds.includes(sandbox.id);
        const initialCommand = initialCommands.current[sandbox.id] ?? "";
        const signature = sandboxSignature(sandbox, hasAlert, initialCommand);
        if (existing && existing.data.signature === signature) return existing;
        const position = existing?.position ?? positions.current[sandbox.id] ?? canvasSlot(index);
        return {
          id: sandbox.id,
          type: "sandboxWindow",
          position,
          data: {
            sandbox,
            hasAlert,
            initialCommand,
            signature,
            onInspect: (id: string) => setSelectedId(id),
            onSessionEnded: () => void refresh(),
            onLink: (message: string) => setLinkBar(message),
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
      try {
        window.localStorage.setItem(CANVAS_POSITIONS_KEY, JSON.stringify(positions.current));
      } catch {
        /* private mode */
      }
    }
  }, []);

  const onNodeDragStart = useCallback(() => {
    dragInProgress.current = true;
  }, []);
  const onNodeDragStop = useCallback(() => {
    dragInProgress.current = false;
  }, []);

  const createSandbox = useCallback(
    async (body: Record<string, unknown>, successMessage: string) => {
      setBusy(true);
      try {
        const response = await fetch("/sandbox-api/sandboxes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode, homeProfile, ...body }),
        });
        if (!response.ok) throw new Error((await response.json()).message || `HTTP ${response.status}`);
        const result = (await response.json()) as { sandbox?: SandboxRecordUi };
        const sandbox = result.sandbox;
        if (!sandbox) return null;
        const taken = new Set(Object.values(positions.current).map((point) => `${point.x},${point.y}`));
        let slot = 0;
        while (taken.has(`${canvasSlot(slot).x},${canvasSlot(slot).y}`)) slot += 1;
        positions.current[sandbox.id] = canvasSlot(slot);
        setSelectedId(sandbox.id);
        notify(successMessage);
        await refresh();
        return sandbox;
      } catch (error) {
        notify(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [mode, homeProfile, notify, refresh],
  );

  const launchTemplate = async (template: (typeof SANDBOX_TEMPLATES)[number]) => {
    setMenuOpen(false);
    const sandbox = await createSandbox({ name: `${template.label} ${Date.now().toString(36).slice(-4)}`, command: [] }, template.command ? `${template.label} starting in its window` : `Shell ready (${mode})`);
    if (sandbox && template.command) initialCommands.current[sandbox.id] = `${template.command}\n`;
  };

  const openProject = async () => {
    if (!projectPath.trim()) {
      notify("Enter (or browse) a project folder first");
      return;
    }
    const created = await createSandbox(
      {
        name: projectName.trim() || undefined,
        command: [],
        project: {
          name: projectName.trim() || projectPath.trim().split("/").filter(Boolean).pop() || "project",
          path: projectPath.trim(),
          ...(projectReadOnly ? { readOnly: true } : {}),
        },
      },
      projectReadOnly ? "Project opened read-only" : "Project mounted — agent edits are real files",
    );
    if (created) setProjectModal(false);
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

  const runCustom = async () => {
    const parts = (command.match(/"([^"]*)"|'([^']*)'|(\S+)/g) || []).map((part) => part.replace(/^["']|["']$/g, "")).filter(Boolean);
    const created = await createSandbox(
      {
        name: name || undefined,
        command: parts,
        env: parseMap(env),
        ...(workspaceDir.trim() ? { workspace: workspaceDir.trim() } : {}),
        ...(stdinText.trim() && parts.length ? { stdin: stdinText } : {}),
      },
      parts.length ? "Sandbox started" : "Workspace ready",
    );
    if (created) setCustomModal(false);
  };

  const mutate = async (verb: "stop" | "restart" | "delete") => {
    if (!selected) return;
    setBusy(true);
    try {
      const endpoint = verb === "delete" ? `/sandbox-api/sandboxes/${selected.id}` : `/sandbox-api/sandboxes/${selected.id}/${verb}`;
      const response = await fetch(endpoint, { method: verb === "delete" ? "DELETE" : "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
      }
      if (verb === "delete") setSelectedId("");
      notify(verb === "delete" ? "Workspace deleted" : verb === "restart" ? "Workspace restarted" : "Sandbox stopped");
      await refresh();
    } catch (error) {
      notify(`Failed to ${verb} workspace: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const addProjectTerminal = async () => {
    if (!selected?.project) return;
    const sandbox = await createSandbox(
      { name: `${selected.project.name} — terminal`, command: [], project: selected.project },
      "Terminal added to project",
    );
    if (sandbox) setSelectedId(sandbox.id);
  };

  const runningCount = sandboxes.filter((sandbox) => sandbox.status === "running").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[18px] font-extrabold tracking-tight">Agents</h1>
          <StatusPill tone={serviceUp ? "green" : "red"} dot>
            {serviceUp ? "sandbox service live" : "service offline"}
          </StatusPill>
          <span className="text-[10px] text-slate-500">
            {runningCount} running · {sandboxes.length} total
          </span>
        </div>
        <div className="relative">
          <button type="button" disabled={busy} onClick={() => setMenuOpen((open) => !open)} className="button-primary">
            <Plus size={13} />
            New
            <ChevronDown size={12} />
          </button>
          {menuOpen && (
            <>
              <button type="button" className="fixed inset-0 z-20 cursor-default" onClick={() => setMenuOpen(false)} aria-label="Close menu" />
              <div className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-panel">
                {SANDBOX_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => void launchTemplate(template)}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[11px] font-bold text-slate-700 hover:bg-slate-50"
                  >
                    {template.command ? <Bot size={14} className="text-blue-500" /> : <TerminalIcon size={14} className="text-slate-400" />}
                    {template.label}
                  </button>
                ))}
                <div className="border-t border-slate-100" />
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setProjectModal(true);
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[11px] font-bold text-slate-700 hover:bg-slate-50"
                >
                  <FolderOpen size={14} className="text-violet-500" />
                  Open folder as project…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setCustomModal(true);
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[11px] font-bold text-slate-700 hover:bg-slate-50"
                >
                  <Zap size={14} className="text-amber-500" />
                  Custom run…
                </button>
                <div className="border-t border-slate-100 px-4 py-2.5">
                  <p className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">New workspaces run in</p>
                  <div className="mt-1.5 flex gap-1.5">
                    {(["observe", "enforce"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setMode(value)}
                        className={`rounded-lg px-2.5 py-1 text-[10px] font-bold ${mode === value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
                      >
                        {value === "observe" ? "Observe" : "Enforce"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {linkBar && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <Link2 size={14} className="shrink-0 text-amber-600" />
          <input
            readOnly
            value={linkBar}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-amber-200 bg-white px-2 py-1 font-mono text-[10px] text-slate-700"
          />
          <button type="button" onClick={() => void copyText(linkBar).then((copied) => copied && setLinkBar(null))} className="button-primary shrink-0">
            Copy
          </button>
          <button type="button" onClick={() => setLinkBar(null)} className="shrink-0 text-slate-400 hover:text-slate-600">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flow-shell dot-grid relative h-[calc(100vh-190px)] min-h-[560px] overflow-hidden rounded-2xl border border-slate-200 bg-white/55 shadow-panel">
        <ReactFlow
          nodes={nodes}
          onNodesChange={onNodesChange}
          nodeTypes={canvasNodeTypes}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
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
                Launch a Shell, Claude Code, Codex, or Antigravity — each opens as a draggable window, already inside its monitored sandbox.
              </p>
            </div>
          </div>
        )}
      </div>

      {selected && (
        <>
          {/* No full-screen backdrop: it would block dragging windows while
              the inspector is open. The drawer floats; close it with the ✕. */}
          <div className="fixed right-4 top-[84px] bottom-4 z-40 w-[360px] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-panel">
            <SectionHeading
              icon={<Activity size={15} />}
              eyebrow={selected.id}
              title={selected.name}
              action={
                <button type="button" onClick={() => setSelectedId("")} className="text-slate-400 hover:text-slate-600">
                  <X size={15} />
                </button>
              }
            />
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-5 py-2.5">
              <StatusPill tone={selected.status === "running" ? "green" : "slate"} dot>
                {selected.status}
              </StatusPill>
              <StatusPill tone={selected.mode === "enforce" ? "blue" : "slate"}>{selected.mode}</StatusPill>
              {selected.project && <StatusPill tone="violet">{selected.project.readOnly ? "project · ro" : "project"}</StatusPill>}
              {selected.homeProfile && <StatusPill tone="green">home</StatusPill>}
              {alertCount > 0 && (
                <StatusPill tone="red">
                  <AlertTriangle size={10} /> {alertCount}
                </StatusPill>
              )}
            </div>
            {selected.project && (
              <p className="border-b border-slate-100 px-5 py-2 font-mono text-[9.5px] text-slate-500">
                {selected.project.readOnly ? "read-only" : "read-write"} · {selected.project.path}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 px-5 py-2.5">
              {selected.status === "running" && (
                <button type="button" disabled={busy} onClick={() => void mutate("stop")} className="button-danger">
                  <Pause size={12} />
                  Stop
                </button>
              )}
              {selected.interactive && selected.status !== "running" && (
                <button type="button" disabled={busy} onClick={() => void mutate("restart")} className="button-primary">
                  <RefreshCw size={12} />
                  Restart
                </button>
              )}
              {selected.interactive && selected.status === "running" && selected.project && (
                <button type="button" disabled={busy} onClick={() => void addProjectTerminal()} className="button-primary">
                  <Plus size={12} />
                  Terminal
                </button>
              )}
              {selected.interactive && (
                <button type="button" disabled={busy} onClick={() => void mutate("delete")} className="button-danger">
                  <Trash2 size={12} />
                  Delete
                </button>
              )}
            </div>
            <div className="max-h-[380px] overflow-y-auto p-3">
              {events.map((event) => (
                <div
                  key={event.id}
                  className={`mb-1.5 rounded-lg border px-3 py-2 ${event.type === "alert" ? "border-red-200 bg-red-50" : "border-slate-100 bg-slate-50/60"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <StatusPill tone={eventTone(event.type)}>{event.type.replace("_", " ")}</StatusPill>
                    <span className="text-[9px] text-slate-400">{new Date(event.ts).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[9px] text-slate-600">{eventSummary(event.type, event.detail)}</p>
                </div>
              ))}
              {events.length === 0 && <p className="p-4 text-center text-[10px] text-slate-500">Events appear as the agent works.</p>}
            </div>
            <div className="border-t border-slate-100">
              <p className="px-5 pt-3 text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Background output</p>
              <pre className="max-h-[180px] overflow-y-auto whitespace-pre-wrap px-5 py-3 font-mono text-[9.5px] leading-5 text-slate-600">
                {logs.join("\n") || "One-shot commands (non-interactive runs) stream here."}
              </pre>
            </div>
          </div>
        </>
      )}

      {projectModal && (
        <Modal title="Open folder as project" onClose={() => setProjectModal(false)} onSubmit={() => void openProject()} busy={busy} submitLabel="Open project">
          <label className="block">
            <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Project folder on this machine</span>
            <div className="mt-1 flex gap-2">
              <input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/home/you/code/my-app" className="field-input font-mono" />
              <button type="button" onClick={() => void browseFolder()} className="button-secondary shrink-0">
                Browse…
              </button>
            </div>
          </label>
          <label className="block">
            <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Project name</span>
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="my-app" className="field-input mt-1" />
          </label>
          <label className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
            <input type="checkbox" checked={projectReadOnly} onChange={(event) => setProjectReadOnly(event.target.checked)} className="h-3.5 w-3.5" />
            Read-only (agent can read the folder, not write it)
          </label>
          <label className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
            <input type="checkbox" checked={homeProfile} onChange={(event) => setHomeProfile(event.target.checked)} className="h-3.5 w-3.5" />
            Make it feel like home (shell rc, git identity, agent logins &amp; skills, global packages, ssh-agent)
          </label>
          <p className="text-[9.5px] leading-4 text-slate-400">
            The real folder is mounted into a sandboxed workspace — agent edits are real files owned by you, and every write, process, and network call is
            recorded.
          </p>
        </Modal>
      )}

      {customModal && (
        <Modal title="Custom agent run" onClose={() => setCustomModal(false)} onSubmit={() => void runCustom()} busy={busy} submitLabel="Start sandbox">
          <label className="block">
            <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="migration-agent" className="field-input mt-1" />
          </label>
          <label className="block">
            <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Command (empty = interactive workspace)</span>
            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="tsx real-agent.ts" className="field-input mt-1 font-mono" />
          </label>
          <label className="block">
            <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Env (KEY=VALUE per line)</span>
            <textarea value={env} onChange={(event) => setEnv(event.target.value)} placeholder={"GEMINI_API_KEY=..."} rows={2} className="field-input mt-1 font-mono" />
          </label>
          <label className="block">
            <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Workspace source dir (copied in)</span>
            <input value={workspaceDir} onChange={(event) => setWorkspaceDir(event.target.value)} placeholder="./scripts" className="field-input mt-1 font-mono" />
          </label>
          <label className="block">
            <span className="text-[9px] font-extrabold uppercase tracking-[.14em] text-slate-400">Agent input (stdin, one-shot runs)</span>
            <textarea value={stdinText} onChange={(event) => setStdinText(event.target.value)} placeholder={"list unpaid invoices\nexit"} rows={2} className="field-input mt-1 font-mono" />
          </label>
          <label className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
            <input type="checkbox" checked={homeProfile} onChange={(event) => setHomeProfile(event.target.checked)} className="h-3.5 w-3.5" />
            Make it feel like home
          </label>
        </Modal>
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  onSubmit,
  busy,
  submitLabel,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <>
      <button type="button" className="fixed inset-0 z-50 cursor-default bg-slate-900/40" onClick={onClose} aria-label="Close" />
      <div className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2">
        <Panel className="overflow-hidden">
          <SectionHeading
            icon={<FolderOpen size={15} />}
            eyebrow="Launch"
            title={title}
            action={
              <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
                <X size={15} />
              </button>
            }
          />
          <div className="space-y-3 p-5">
            {children}
            <button type="button" disabled={busy} onClick={onSubmit} className="button-primary w-full justify-center">
              <Check size={13} />
              {submitLabel}
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}
