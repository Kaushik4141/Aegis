"use client";

import { Bot, Check, Clock, LayoutGrid, Radio, Settings2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActivityView } from "./components/activity";
import { AgentsView } from "./components/canvas";
import { ApprovalsView } from "./components/approvals";
import { SettingsView } from "./components/settings";
import type { View } from "./lib/types";

const NAV: Array<{ id: View; label: string; icon: React.ReactNode }> = [
  { id: "agents", label: "Agents", icon: <LayoutGrid size={16} /> },
  { id: "activity", label: "Activity", icon: <Radio size={16} /> },
  { id: "approvals", label: "Approvals", icon: <Clock size={16} /> },
];

// --- Main Application Component ---

export default function Home() {
  const [view, setView] = useState<View>("agents");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const handleUnhandledError = (event: ErrorEvent) => {
      if (!event.error && (event.message === "[object Event]" || event.type === "error")) {
        event.preventDefault();
      }
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!event.reason || event.reason === "[object Promise]") {
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

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  return (
    <main className="min-h-screen bg-[#fafafa] text-slate-900">
      <header className="sticky top-0 z-20 flex min-h-[64px] items-center justify-between border-b border-slate-200 bg-white px-4 lg:px-8">
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
            {NAV.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setView(entry.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${
                  view === entry.id ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50"
                }`}
              >
                {entry.icon}
                {entry.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Header Right Metadata & Actions */}
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-blue-500 text-[10px] font-bold text-white">AG</div>
          <button
            type="button"
            onClick={() => setView("settings")}
            title="Settings — MCP connections & infrastructure"
            className={`grid h-9 w-9 place-items-center rounded-lg ${view === "settings" ? "bg-slate-100 text-slate-900" : "text-slate-400 hover:bg-slate-50 hover:text-slate-600"}`}
          >
            <Settings2 size={17} />
          </button>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-64px)]">
        <aside className="hidden w-[64px] flex-col items-center gap-3 border-r border-slate-200 bg-white py-5 lg:flex">
          {NAV.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setView(entry.id)}
              title={entry.label}
              className={`grid h-9 w-9 place-items-center rounded-lg ${
                view === entry.id ? "bg-slate-100 text-slate-900" : "text-slate-400 hover:bg-slate-50 hover:text-slate-600"
              }`}
            >
              {entry.icon}
            </button>
          ))}
          <div className="mt-auto grid h-9 w-9 place-items-center text-slate-300" title="Agent safety">
            <Bot size={17} />
          </div>
        </aside>

        <section className="min-w-0 flex-1 p-4 lg:p-7">
          {view === "agents" && <AgentsView notify={notify} />}
          {view === "activity" && <ActivityView />}
          {view === "approvals" && <ApprovalsView notify={notify} />}
          {view === "settings" && <SettingsView notify={notify} />}
        </section>
      </div>

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
