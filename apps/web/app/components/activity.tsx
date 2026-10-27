"use client";

import { Activity, Radio } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { actorDisplayName, type FeedItem } from "../lib/types";
import { Panel, SectionHeading, StatusPill, eventSummary } from "../lib/ui";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "tool_calls", label: "Tool calls" },
  { id: "alerts", label: "Alerts" },
  { id: "network", label: "Network" },
  { id: "files", label: "Files & processes" },
] as const;

const statusTone = (status?: string): "red" | "amber" | "green" | "slate" | "blue" =>
  ({
    blocked: "red",
    frozen: "amber",
    pending_approval: "amber",
    approved: "green",
    allowed: "green",
  }[status || ""] as "red" | "amber" | "green" | "slate" | "blue") || "slate";

export function ActivityView() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [live, setLive] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/feed?filter=${filter}&limit=200`, { cache: "no-store" });
      if (!response.ok) throw new Error("feed unavailable");
      setLive(true);
      const body = (await response.json()) as { items?: FeedItem[] };
      setItems(body.items || []);
    } catch {
      setLive(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[18px] font-extrabold tracking-tight">Activity</h1>
          <StatusPill tone={live ? "green" : "red"} dot>
            {live ? "live" : "gateway offline"}
          </StatusPill>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              className={`rounded-lg px-3 py-1.5 text-[10px] font-bold ${
                filter === entry.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <Panel className="overflow-hidden">
        <SectionHeading icon={<Radio size={15} />} eyebrow="Everything your agents are doing" title="Live feed" />
        <div className="max-h-[calc(100vh-260px)] divide-y divide-slate-100 overflow-y-auto">
          {items.map((item) => (
            <FeedRow key={`${item.kind}-${item.id}`} item={item} />
          ))}
          {items.length === 0 && (
            <p className="p-10 text-center text-[10px] text-slate-500">
              Nothing yet — launch an agent or run a tool call and it appears here instantly.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const time = new Date(item.ts).toLocaleTimeString();
  if (item.kind === "action") {
    return (
      <div className="flex items-center gap-3 px-5 py-3">
        <span className="w-[62px] shrink-0 font-mono text-[9px] text-slate-400">{time}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-bold text-slate-800">
            <span className="text-blue-600">{actorDisplayName(item.actor)}</span> → {item.title}
            {item.resource ? <span className="font-mono text-[9px] text-slate-400"> · {item.resource}</span> : null}
          </p>
          {item.labels && item.labels.length > 0 && (
            <p className="mt-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600">{item.labels.join(" · ")}</p>
          )}
        </div>
        <StatusPill tone={statusTone(item.status)}>{(item.status || "").replace("_", " ")}</StatusPill>
        {typeof item.riskScore === "number" && (
          <span className={`w-8 shrink-0 text-right font-mono text-[10px] font-bold ${item.riskScore >= 70 ? "text-red-500" : item.riskScore >= 40 ? "text-amber-500" : "text-slate-400"}`}>
            {item.riskScore}
          </span>
        )}
      </div>
    );
  }
  const isAlert = item.type === "alert";
  return (
    <div className={`flex items-center gap-3 px-5 py-2.5 ${isAlert ? "bg-red-50/60" : ""}`}>
      <span className="w-[62px] shrink-0 font-mono text-[9px] text-slate-400">{time}</span>
      <Activity size={12} className={`shrink-0 ${isAlert ? "text-red-500" : "text-slate-300"}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-bold text-slate-700">
          <span className="text-slate-500">{actorDisplayName(item.actor)}</span> · {item.type?.replace("_", " ")}
        </p>
        <p className="truncate font-mono text-[9px] text-slate-500">{item.detail ? eventSummary(item.type || "", item.detail) : ""}</p>
      </div>
      {isAlert && <StatusPill tone="red">shadow access</StatusPill>}
    </div>
  );
}
