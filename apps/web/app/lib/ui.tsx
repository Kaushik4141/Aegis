"use client";

import type { ReactNode } from "react";

export const badgeClass = (tone: "red" | "amber" | "green" | "slate" | "blue" | "violet") =>
  ({
    red: "bg-red-50 text-red-700 ring-red-100",
    amber: "bg-amber-50 text-amber-700 ring-amber-100",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    slate: "bg-slate-100 text-slate-600 ring-slate-200",
    blue: "bg-blue-50 text-blue-700 ring-blue-100",
    violet: "bg-violet-50 text-violet-700 ring-violet-100",
  }[tone]);

export function StatusPill({
  children,
  tone = "slate",
  dot = false,
}: {
  children: ReactNode;
  tone?: "red" | "amber" | "green" | "slate" | "blue" | "violet";
  dot?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] ring-1 ${badgeClass(tone)}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-slate-200 bg-white shadow-panel ${className}`}>{children}</section>;
}

export function SectionHeading({
  icon,
  eyebrow,
  title,
  action,
}: {
  icon?: ReactNode;
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
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

export function parseMap(value: string): Record<string, string> | undefined {
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

/**
 * Copy text in any host webview: the async clipboard API is denied in some
 * embedded browsers, so fall back to the legacy execCommand path.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* embedded webview may deny the async API */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

export const eventTone = (type: string): "red" | "amber" | "green" | "slate" | "blue" =>
  ({
    alert: "red",
    file_write: "amber",
    lifecycle: "green",
    enforce_rule: "red",
    net_connect: "blue",
    dns_lookup: "slate",
    process: "slate",
    port_listen: "blue",
    port_close: "slate",
  }[type] as "red" | "amber" | "green" | "slate" | "blue") || "slate";

export function eventSummary(type: string, detail: Record<string, unknown>): string {
  switch (type) {
    case "dns_lookup":
      return String(detail.name || "");
    case "net_connect":
      return `${detail.peer}:${detail.peerPort} (${detail.process || "unknown"})`;
    case "file_write":
      return String(detail.path || "");
    case "alert":
      return `${detail.kind} → ${detail.host}`;
    case "lifecycle":
      return `${detail.kind}${detail.code !== undefined ? ` (${detail.code})` : ""}`;
    case "process":
      return `${detail.kind === "start" ? "▲" : "▽"} ${detail.args}`;
    case "enforce_rule":
      return `${detail.kind} ${detail.ip ?? ""}${detail.port ?? ""}`;
    case "port_listen":
      return `loopback :${detail.port} — forwarded to laptop`;
    case "port_close":
      return `loopback :${detail.port} closed`;
    default:
      return JSON.stringify(detail).slice(0, 120);
  }
}
