"use client";

import { useEffect } from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log client error safely
    console.warn("SentinelGate control plane caught client event/error:", error);
  }, [error]);

  const rawMessage = error?.message;
  const isEventObject = !rawMessage || rawMessage === "[object Event]" || rawMessage === "[object Object]";
  const displayMessage = isEventObject
    ? "A gateway event stream reconnection occurred. The control plane is ready to resume."
    : rawMessage;

  return (
    <div className="flex min-h-[500px] flex-col items-center justify-center p-8 text-center">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-panel">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-blue-50 text-blue-600">
          <ShieldAlert size={22} />
        </div>
        <h2 className="mt-4 text-base font-extrabold text-slate-900">Control Plane Sync Notice</h2>
        <p className="mt-2 text-xs leading-5 text-slate-500">{displayMessage}</p>
        <button
          type="button"
          onClick={() => reset()}
          className="button-primary mx-auto mt-5"
        >
          <RefreshCw size={14} />
          Resume Dashboard
        </button>
      </div>
    </div>
  );
}
