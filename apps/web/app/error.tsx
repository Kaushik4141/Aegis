"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.warn("Aegis control plane caught client event/error:", error);
  }, [error]);

  const rawMessage = error?.message;
  const isEventObject = !rawMessage || rawMessage === "[object Event]" || rawMessage === "[object Object]";
  const displayMessage = isEventObject
    ? "A gateway event stream reconnection occurred. The control plane is ready to resume."
    : rawMessage;

  return (
    <div className="flex min-h-[500px] flex-col items-center justify-center p-8 text-center bg-[#050505] font-mono text-xs">
      <div className="max-w-md rounded border border-[#222222] bg-[#0a0a0a] p-8">
        <span className="inline-block text-[10px] text-[#888888] border border-[#222222] px-2 py-0.5 rounded uppercase tracking-wider mb-3">
          [ GATEWAY NOTICE ]
        </span>
        <h2 className="text-sm font-bold text-[#ffffff] uppercase tracking-wide">
          CONTROL PLANE SYNC NOTICE
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-[#888888]">{displayMessage}</p>
        <button
          type="button"
          onClick={() => reset()}
          className="btn btn-primary mx-auto mt-6"
        >
          RESUME DASHBOARD
        </button>
      </div>
    </div>
  );
}
