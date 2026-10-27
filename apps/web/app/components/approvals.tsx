"use client";

import { Ban, Check, Clock, History, Pause, ShieldQuestion } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { actorDisplayName, type ActionRecord } from "../lib/types";
import { Panel, SectionHeading, StatusPill } from "../lib/ui";

type Tab = "pending" | "history";

export function ApprovalsView({ notify }: { notify: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("pending");
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/actions?limit=200", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      setLive(true);
      const body = (await response.json()) as { actions?: ActionRecord[] };
      setActions(body.actions || []);
    } catch {
      setLive(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const pending = actions.filter((action) => action.status === "pending_approval" || action.status === "frozen");
  const history = actions.filter((action) => action.status === "approved" || action.status === "blocked");

  const resolve = async (action: ActionRecord, verb: "approve" | "block" | "freeze") => {
    setBusy(action.id);
    try {
      const response = await fetch(`/api/v1/actions/${action.id}/${verb}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorId: "operator", reason: `${verb}d from the approvals console` }),
      });
      if (!response.ok) throw new Error((await response.json())?.error?.message || `HTTP ${response.status}`);
      notify(`Action ${verb}d`);
      await refresh();
    } catch (error) {
      notify(`Failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[18px] font-extrabold tracking-tight">Approvals</h1>
          <StatusPill tone={live ? "green" : "red"} dot>
            {live ? "live" : "gateway offline"}
          </StatusPill>
          {pending.length > 0 && (
            <StatusPill tone="amber">
              {pending.length} waiting
            </StatusPill>
          )}
        </div>
        <div className="flex gap-1.5">
          {(
            [
              { id: "pending", label: "Pending", icon: <Clock size={12} /> },
              { id: "history", label: "History", icon: <History size={12} /> },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[10px] font-bold ${
                tab === entry.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "pending" ? (
        <Panel className="overflow-hidden">
          <SectionHeading icon={<ShieldQuestion size={15} />} eyebrow="Human in the loop" title="Waiting for your decision" />
          <div className="max-h-[calc(100vh-260px)] divide-y divide-slate-100 overflow-y-auto">
            {pending.map((action) => (
              <PendingCard key={action.id} action={action} busy={busy === action.id} onResolve={resolve} />
            ))}
            {pending.length === 0 && (
              <div className="p-10 text-center">
                <Check size={22} className="mx-auto text-emerald-400" />
                <p className="mt-2 text-[11px] font-bold text-slate-600">Nothing needs you right now</p>
                <p className="mt-1 text-[10px] text-slate-400">
                  When an agent makes a risky tool call, it parks here until you decide. Trigger one from an agent window or via the MCP proxy.
                </p>
              </div>
            )}
          </div>
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <SectionHeading icon={<History size={15} />} eyebrow="Immutable trail" title="Past decisions" />
          <div className="max-h-[calc(100vh-260px)] divide-y divide-slate-100 overflow-y-auto">
            {history.map((action) => (
              <HistoryRow key={action.id} action={action} />
            ))}
            {history.length === 0 && <p className="p-10 text-center text-[10px] text-slate-500">No decisions yet.</p>}
          </div>
        </Panel>
      )}
    </div>
  );
}

function PendingCard({
  action,
  busy,
  onResolve,
}: {
  action: ActionRecord;
  busy: boolean;
  onResolve: (action: ActionRecord, verb: "approve" | "block" | "freeze") => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const risk = action.decision?.riskScore ?? 0;
  const payloadText = action.payload ? JSON.stringify(action.payload, null, 2) : "";
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-extrabold text-slate-900">{action.action}</p>
          <p className="mt-0.5 text-[10px] text-slate-500">
            {actorDisplayName(action.actorId || "agent")}
            {action.resource ? <span className="font-mono"> · {action.resource}</span> : null} · {new Date(action.createdAt).toLocaleString()}
          </p>
          {action.decision?.reason && <p className="mt-1 text-[10px] italic text-slate-500">"{action.decision.reason}"</p>}
          {action.decision?.labels && action.decision.labels.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {action.decision.labels.map((label) => (
                <StatusPill key={label} tone="amber">
                  {label}
                </StatusPill>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className={`font-mono text-[16px] font-extrabold ${risk >= 70 ? "text-red-500" : risk >= 40 ? "text-amber-500" : "text-slate-400"}`}>{risk}</p>
          <p className="text-[8px] font-bold uppercase tracking-widest text-slate-400">risk</p>
        </div>
      </div>
      {payloadText && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-2 text-[9px] font-bold uppercase tracking-wider text-blue-600 hover:underline">
          {expanded ? "Hide payload" : "Show payload"}
        </button>
      )}
      {expanded && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[9px] leading-4 text-slate-600">{payloadText}</pre>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void onResolve(action, "approve")} className="button-success">
          <Check size={12} />
          Approve
        </button>
        <button type="button" disabled={busy} onClick={() => void onResolve(action, "block")} className="button-danger">
          <Ban size={12} />
          Block
        </button>
        <button type="button" disabled={busy} onClick={() => void onResolve(action, "freeze")} className="button-secondary">
          <Pause size={12} />
          Freeze
        </button>
      </div>
    </div>
  );
}

function HistoryRow({ action }: { action: ActionRecord }) {
  const approved = action.status === "approved";
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      {approved ? <Check size={13} className="shrink-0 text-emerald-500" /> : <Ban size={13} className="shrink-0 text-red-400" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-bold text-slate-800">{action.action}</p>
        <p className="truncate text-[9.5px] text-slate-500">
          {actorDisplayName(action.actorId || "agent")} · decided {new Date(action.approvedAt || action.updatedAt).toLocaleString()}
          {action.approvedBy ? ` by ${action.approvedBy}` : ""}
        </p>
      </div>
      <StatusPill tone={approved ? "green" : "red"}>{action.status}</StatusPill>
    </div>
  );
}
