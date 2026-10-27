"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../lib/ui";

export const SANDBOX_WS_BASE = process.env.NEXT_PUBLIC_SANDBOX_WS_URL?.trim() || null;

export function sandboxTerminalUrl(sandboxId: string): string {
  const target = encodeURIComponent(sandboxId);
  if (SANDBOX_WS_BASE) return `${SANDBOX_WS_BASE.replace(/\/$/, "")}/sandboxes/${target}/terminal`;
  const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:${process.env.NEXT_PUBLIC_SANDBOX_WS_PORT || "8788"}/sandboxes/${target}/terminal`;
}

export function SandboxTerminal({
  sandboxId,
  initialInput,
  onClosed,
  onLink,
  height = 430,
}: {
  sandboxId: string;
  /** Sent once when the session opens — used to auto-start an agent (e.g. "claude\n"). */
  initialInput?: string;
  onClosed: () => void;
  /** Status channel for clipboard fallbacks and link handling. */
  onLink?: (uri: string) => void;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const linkRef = useRef(onLink);
  linkRef.current = onLink;
  const initialRef = useRef(initialInput);
  // Only the first initialInput per sandbox session matters; later prop
  // changes must not restart the terminal.
  if (initialRef.current === undefined && initialInput !== undefined) initialRef.current = initialInput;
  const [copiedFlash, setCopiedFlash] = useState(false);

  /**
   * Copy from the terminal: the active selection when there is one, otherwise
   * the most recent non-empty output lines.
   */
  const copyFromTerminal = useCallback(async (fallbackToRecent: boolean) => {
    const term = termRef.current;
    if (!term) return;
    let text = term.getSelection();
    if (!text && fallbackToRecent) {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = Math.max(0, buffer.length - 80); i < buffer.length; i++) {
        const line = buffer.getLine(i)?.translateToString(true);
        if (line?.trim()) lines.push(line);
      }
      text = lines.join("\n");
    }
    if (!text) return;
    const copied = await copyText(text);
    if (copied) {
      setCopiedFlash(true);
      window.setTimeout(() => setCopiedFlash(false), 1200);
    } else {
      linkRef.current?.("Copy blocked here — select the text in the terminal, then use Ctrl+Shift+C or your browser's copy menu.");
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    const handleResize = () => {
      try {
        fit?.fit();
      } catch {
        /* panel may be unmounting */
      }
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !hostRef.current) return;
      term = new Terminal({ fontSize: 11.5, cursorBlink: true, fontFamily: "var(--font-mono, monospace)", theme: { background: "#0b1020" } });
      termRef.current = term;
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(
        new WebLinksAddon(async (_event, uri) => {
          const opened = window.open(uri, "_blank");
          if (!opened) {
            const copied = await copyText(uri);
            linkRef.current?.(copied ? `Link copied — paste into your browser: ${uri}` : `Open this link in your browser: ${uri}`);
          }
        }),
      );
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
          const selection = term?.getSelection();
          if (selection) {
            void copyText(selection).then((copied) => {
              if (!copied) linkRef.current?.("Copy blocked — select and copy manually: " + selection);
            });
            return false;
          }
        }
        return true;
      });
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
      socket.onclose = () => {
        term?.write("\r\n\x1b[90m— session ended —\x1b[0m\r\n");
        closedRef.current();
      };
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
      termRef.current = null;
    };
  }, [sandboxId]);

  return (
    <div className="relative w-full bg-[#0b1020]" style={{ height }}>
      <div ref={hostRef} className="h-full w-full overflow-hidden" />
      <button
        type="button"
        title="Copy selection (or recent output)"
        onClick={() => void copyFromTerminal(true)}
        className="absolute right-2 top-1.5 z-10 rounded-md border border-slate-700/70 bg-slate-900/80 p-1.5 text-slate-400 hover:text-slate-100"
      >
        {copiedFlash ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
    </div>
  );
}
