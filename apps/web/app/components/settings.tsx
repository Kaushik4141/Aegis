"use client";

import { ChevronRight, Code2, Copy, KeyRound, Link2, LockKeyhole, Plus, RefreshCw, Server, Settings2, Terminal, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Panel, SectionHeading, StatusPill, parseMap } from "../lib/ui";

type Transport = "stdio" | "streamable-http" | "sse";

type Connection = {
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
};

type OAuthStatus = {
  configured?: boolean;
  supported?: boolean;
  authorized?: boolean;
  pending?: boolean;
  error?: string;
  tokenExpiresAt?: string;
  clientRegistration?: string;
};

type OAuthDisplay = { label: string; tone: "red" | "amber" | "green" | "slate"; detail: string };
type Tool = { name: string; description?: string; inputSchema?: unknown };
type Discovery = { tools?: Tool[]; serverInfo?: { name?: string; version?: string }; instructions?: string };
type ClientConfig = {
  connectionId: string;
  mcp: { url: string; headers?: Record<string, string> };
  claudeDesktop: Record<string, unknown>;
  cursor: Record<string, unknown>;
  note?: string;
};

type FormState = {
  name: string;
  transport: Transport;
  url: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  auth: string;
};

const emptyForm: FormState = { name: "", transport: "streamable-http", url: "", command: "", args: "", cwd: "", env: "", auth: "" };

function nameFromUrl(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "") || "MCP server";
  } catch {
    return "MCP server";
  }
}

function oauthDisplay(connection: Connection, status?: OAuthStatus): OAuthDisplay {
  if (connection.transport === "stdio") return { label: "unavailable", tone: "slate", detail: "OAuth is not used for stdio connections." };
  if (!status) return { label: "not connected", tone: "slate", detail: "No account is connected yet." };
  if (status.pending) return { label: "signing in", tone: "amber", detail: "Waiting for sign-in to finish in the browser." };
  if (status.error || status.supported === false) return { label: "unavailable", tone: "red", detail: status.error || "This MCP server does not advertise OAuth." };
  if (status.authorized && status.tokenExpiresAt && new Date(status.tokenExpiresAt).getTime() <= Date.now())
    return { label: "needs reauth", tone: "amber", detail: "The saved OAuth session has expired." };
  if (status.authorized) return { label: "connected", tone: "green", detail: "OAuth account connected." };
  return { label: "not connected", tone: "slate", detail: "Connect an account to authorize this MCP server." };
}

async function standaloneOAuthConnect(connectionId: string, onStatus: (status: OAuthStatus) => void): Promise<void> {
  const popup = window.open("about:blank", "mcp-oauth", "popup,width=520,height=720");
  try {
    const response = await fetch(`/api/v1/connections/${connectionId}/oauth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = (await response.json()) as { authorizationUrl?: string; status?: OAuthStatus; error?: { message?: string } };
    if (!response.ok || !body.authorizationUrl) throw new Error(body.error?.message || "Unable to start OAuth sign-in.");
    if (body.status) onStatus(body.status);
    if (popup && !popup.closed) popup.location.href = body.authorizationUrl;
    else {
      window.location.assign(body.authorizationUrl);
      return;
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const statusResponse = await fetch(`/api/v1/connections/${connectionId}/oauth/status`, { cache: "no-store" });
      const statusBody = (await statusResponse.json()) as { status?: OAuthStatus };
      if (!statusResponse.ok || !statusBody.status) continue;
      onStatus(statusBody.status);
      if (statusBody.status.authorized) {
        await fetch("/api/v1/connections", { cache: "no-store" });
        await fetch(`/api/v1/connections/${connectionId}/test`, { method: "POST" });
        await fetch(`/api/v1/connections/${connectionId}/discover`, { method: "POST" });
        return;
      }
    }
  } catch (error) {
    onStatus({ supported: false, error: error instanceof Error ? error.message : "OAuth sign-in failed." });
  } finally {
    if (popup && !popup.closed) popup.close();
  }
}

export function SettingsView({ notify }: { notify: (message: string) => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [oauthStatuses, setOauthStatuses] = useState<Record<string, OAuthStatus>>({});
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formBusy, setFormBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);

  const selected = connections.find((connection) => connection.id === selectedId) || null;
  const tools = discovery?.tools || [];

  const refreshConnections = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/connections", { cache: "no-store" });
      if (!response.ok) throw new Error(bodyError(await response.json()));
      const body = (await response.json()) as { connections?: Connection[] };
      setConnections(body.connections || []);
      setSelectedId((current) => current || body.connections?.[0]?.id || "");
    } catch (error) {
      notify(`Connections unavailable: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }, [notify]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      connections
        .filter((connection) => connection.transport !== "stdio")
        .map(async (connection) => {
          try {
            const response = await fetch(`/api/v1/connections/${connection.id}/oauth/status`, { cache: "no-store" });
            const body = (await response.json()) as { status?: OAuthStatus };
            if (!cancelled && response.ok && body.status) setOauthStatuses((current) => ({ ...current, [connection.id]: body.status as OAuthStatus }));
          } catch {
            /* status remains not connected */
          }
        })
    );
    return () => {
      cancelled = true;
    };
  }, [connections]);

  const registerConnection = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim() || undefined,
        transport: form.transport,
        ...(form.transport === "stdio"
          ? { command: form.command.trim(), args: form.args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean), cwd: form.cwd.trim() || undefined }
          : { url: form.url.trim() }),
        env: parseMap(form.env),
        headers: parseMap(form.auth),
      };
      const response = await fetch("/api/v1/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(bodyError(await response.json()));
      const created = (await response.json()) as { token?: string; connection?: Connection };
      if (created.token) void copyTextQuiet(created.token);
      notify(created.token ? "Registered — proxy token copied to clipboard (shown once)" : "Connection registered");
      setForm(emptyForm);
      await refreshConnections();
    } catch (error) {
      notify(`Registration failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      setFormBusy(false);
    }
  };

  const withSelected = async (verb: "test" | "discover", busyLabel: string) => {
    if (!selected) return;
    setConnectionBusy(busyLabel);
    try {
      const response = await fetch(`/api/v1/connections/${selected.id}/${verb}`, { method: "POST" });
      const body = (await response.json()) as { discovery?: Discovery; result?: unknown; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
      if (verb === "discover" && body.discovery) {
        setDiscovery(body.discovery);
        notify(`Discovered ${body.discovery.tools?.length || 0} tools`);
      } else {
        notify("Connection test passed");
      }
    } catch (error) {
      notify(`${busyLabel === "test" ? "Test" : "Discover"} failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      setConnectionBusy(null);
    }
  };

  const deleteConnection = async () => {
    if (!selected) return;
    setConnectionBusy("delete");
    try {
      const response = await fetch(`/api/v1/connections/${selected.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(bodyError(await response.json()));
      setSelectedId("");
      setDiscovery(null);
      setConfig(null);
      notify("Connection deleted");
      await refreshConnections();
    } catch (error) {
      notify(`Delete failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      setConnectionBusy(null);
    }
  };

  const loadConfig = async () => {
    if (!selected) return;
    try {
      const response = await fetch(`/api/v1/connections/${selected.id}/client-config`, { method: "POST" });
      const body = (await response.json()) as { config?: ClientConfig };
      if (body.config) setConfig(body.config);
    } catch {
      notify("Could not generate configuration");
    }
  };

  const connectAccount = () => {
    if (!selected) return;
    void standaloneOAuthConnect(selected.id, (status) => setOauthStatuses((current) => ({ ...current, [selected.id]: status })));
  };

  const selectedOAuth = selected ? oauthDisplay(selected, oauthStatuses[selected.id]) : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <h1 className="text-[18px] font-extrabold tracking-tight">Settings</h1>
        <StatusPill tone="slate">infrastructure</StatusPill>
      </div>
      <p className="max-w-2xl text-[11px] leading-5 text-slate-500">
        Upstream MCP connections are the systems your agents may reach through the policy-enforced proxy. Registered hosts automatically join the
        shadow-access watchlist — direct connections from sandboxes alert (or are blocked in enforce mode).
      </p>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel className="overflow-hidden">
          <SectionHeading icon={<Plus size={15} />} eyebrow="Registry" title="Register an MCP server" />
          <form onSubmit={(event) => void registerConnection(event)} className="space-y-3 p-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
              <label className="field-label">
                Connection name <span className="font-normal normal-case tracking-normal text-slate-400">optional for HTTP</span>
                <input
                  required={form.transport === "stdio"}
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="e.g. Linear MCP"
                  className="field-input"
                />
              </label>
              <label className="field-label">
                Transport
                <select value={form.transport} onChange={(event) => setForm((current) => ({ ...current, transport: event.target.value as Transport }))} className="field-input">
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE</option>
                  <option value="stdio">stdio</option>
                </select>
              </label>
            </div>
            {form.transport === "stdio" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="field-label">
                  Command
                  <input required value={form.command} onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))} placeholder="npx" className="field-input font-mono" />
                </label>
                <label className="field-label">
                  Working directory
                  <input value={form.cwd} onChange={(event) => setForm((current) => ({ ...current, cwd: event.target.value }))} placeholder="/workspace" className="field-input font-mono" />
                </label>
                <label className="field-label sm:col-span-2">
                  Arguments <span className="font-normal normal-case tracking-normal text-slate-400">(one per line)</span>
                  <textarea
                    value={form.args}
                    onChange={(event) => setForm((current) => ({ ...current, args: event.target.value }))}
                    placeholder={"-y\n@modelcontextprotocol/server-github"}
                    className="field-input min-h-[70px] font-mono"
                  />
                </label>
              </div>
            ) : (
              <label className="field-label">
                Server URL
                <input
                  required
                  type="url"
                  value={form.url}
                  onChange={(event) => setForm((current) => ({ ...current, url: event.target.value, ...(current.name.trim() ? {} : { name: nameFromUrl(event.target.value) }) }))}
                  placeholder="https://mcp.example.com/mcp"
                  className="field-input font-mono"
                />
              </label>
            )}
            <label className="field-label">
              Environment <span className="font-normal normal-case tracking-normal text-slate-400">KEY=VALUE per line</span>
              <textarea value={form.env} onChange={(event) => setForm((current) => ({ ...current, env: event.target.value }))} placeholder="GITHUB_OWNER=acme" className="field-input min-h-[76px] font-mono" />
            </label>
            <details className="advanced-auth rounded-xl border border-slate-200 bg-slate-50/70">
              <summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-extrabold uppercase tracking-[.08em] text-slate-500">
                Advanced: manual auth headers
              </summary>
              <div className="border-t border-slate-200 px-3 pb-3 pt-2">
                <p className="mb-2 text-[10px] leading-4 text-slate-500">OAuth is the recommended way to sign in. Use headers only for servers that do not support OAuth.</p>
                <textarea
                  aria-label="Manual auth headers"
                  value={form.auth}
                  onChange={(event) => setForm((current) => ({ ...current, auth: event.target.value }))}
                  placeholder="Authorization=Bearer …"
                  className="field-input min-h-[76px] font-mono"
                />
              </div>
            </details>
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <LockKeyhole size={12} className="text-emerald-600" />
                Credentials are never returned to the browser.
              </p>
              <button type="submit" disabled={formBusy} className="button-primary">
                <Plus size={14} />
                {formBusy ? "Connecting…" : form.transport === "stdio" ? "Register connection" : "Register & connect"}
              </button>
            </div>
          </form>
        </Panel>

        <div className="space-y-4">
          <Panel className="overflow-hidden">
            <SectionHeading
              icon={<Link2 size={15} />}
              eyebrow="MCP registry"
              title="Registered connections"
              action={<span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-500">{connections.length} total</span>}
            />
            <div className="divide-y divide-slate-100">
              {connections.map((connection) => {
                const oauth = oauthDisplay(connection, oauthStatuses[connection.id]);
                return (
                  <button
                    type="button"
                    key={connection.id}
                    onClick={() => {
                      setSelectedId(connection.id);
                      setDiscovery(null);
                      setConfig(null);
                    }}
                    className={`flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50 ${selected?.id === connection.id ? "bg-blue-50/50" : ""}`}
                  >
                    <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${connection.transport === "stdio" ? "bg-violet-50 text-violet-600" : "bg-cyan-50 text-cyan-600"}`}>
                      {connection.transport === "stdio" ? <Terminal size={16} /> : <Server size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-bold text-slate-800">{connection.name}</p>
                      <p className="mt-1 truncate font-mono text-[10px] text-slate-400">
                        {connection.transport === "stdio" ? [connection.command, ...(connection.args || [])].join(" ") : connection.url}
                      </p>
                    </div>
                    <div className="hidden items-center gap-2 sm:flex">
                      {connection.hasSecrets && <KeyRound size={13} className="text-emerald-600" />}
                      <StatusPill tone={oauth.tone} dot>
                        {oauth.label}
                      </StatusPill>
                    </div>
                    <ChevronRight size={15} className="text-slate-300" />
                  </button>
                );
              })}
              {connections.length === 0 && (
                <div className="p-8 text-center">
                  <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-400">
                    <Link2 size={18} />
                  </div>
                  <p className="mt-3 text-xs font-bold text-slate-700">No MCP connections yet</p>
                  <p className="mt-1 text-[10px] text-slate-500">Register a server to discover its tools.</p>
                </div>
              )}
            </div>
            {selected && selectedOAuth && (
              <div className="border-t border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Selected connection</p>
                    <p className="mt-1 text-sm font-bold text-slate-900">{selected.name}</p>
                  </div>
                  <button type="button" onClick={() => void deleteConnection()} disabled={connectionBusy === "delete"} className="button-danger">
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>
                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-extrabold uppercase tracking-[.08em] text-slate-400">OAuth account</span>
                    <StatusPill tone={selectedOAuth.tone} dot>
                      {selectedOAuth.label}
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-[10px] leading-4 text-slate-500">{selectedOAuth.detail}</p>
                  {selected.transport !== "stdio" && (
                    <button type="button" onClick={connectAccount} disabled={Boolean(connectionBusy)} className="button-primary mt-3 w-full justify-center">
                      <Link2 size={13} />
                      {connectionBusy === "oauth" ? "Waiting for sign-in…" : selectedOAuth.label === "connected" ? "Reconnect account" : "Connect account"}
                    </button>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void withSelected("test", "test")} disabled={Boolean(connectionBusy)} className="button-secondary">
                    <Zap size={13} />
                    {connectionBusy === "test" ? "Testing…" : "Test connection"}
                  </button>
                  <button type="button" onClick={() => void withSelected("discover", "discover")} disabled={Boolean(connectionBusy)} className="button-secondary">
                    <RefreshCw size={13} />
                    {connectionBusy === "discover" ? "Discovering…" : "Discover tools"}
                  </button>
                </div>
              </div>
            )}
          </Panel>

          {selected && discovery && (
            <Panel className="overflow-hidden">
              <SectionHeading icon={<Zap size={15} />} eyebrow="MCP capability" title="Discovered tools" />
              {discovery.serverInfo && (
                <div className="border-b border-slate-100 bg-emerald-50/60 px-5 py-3 text-[10px] text-emerald-800">
                  <span className="font-bold">{discovery.serverInfo.name || "MCP server"}</span>
                  {discovery.serverInfo.version && ` · v${discovery.serverInfo.version}`}
                </div>
              )}
              <div className="max-h-[275px] overflow-y-auto">
                {tools.map((tool) => (
                  <div key={tool.name} className="border-b border-slate-100 px-5 py-3 last:border-0">
                    <p className="font-mono text-[11px] font-bold text-slate-800">{tool.name}</p>
                    <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-500">{tool.description || "No description provided by server."}</p>
                  </div>
                ))}
                {tools.length === 0 && <div className="p-7 text-center text-[10px] text-slate-500">No tools discovered.</div>}
              </div>
            </Panel>
          )}

          <ClientConfigPanel connection={selected} config={config} onLoad={() => void loadConfig()} onCopy={(text) => {
            void navigator.clipboard?.writeText(text).catch(() => undefined);
            notify("Snippet copied");
          }} />
        </div>
      </div>
    </div>
  );
}

function ClientConfigPanel({
  connection,
  config,
  onLoad,
  onCopy,
}: {
  connection: Connection | null;
  config: ClientConfig | null;
  onLoad: () => void;
  onCopy: (text: string) => void;
}) {
  if (!connection)
    return (
      <Panel className="flex min-h-[250px] items-center justify-center p-8 text-center">
        <div>
          <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-400">
            <Code2 size={18} />
          </div>
          <p className="mt-3 text-xs font-bold text-slate-700">Client configuration</p>
          <p className="mt-1 text-[10px] text-slate-500">Select a connection to generate secure proxy snippets.</p>
        </div>
      </Panel>
    );

  const url = config?.mcp.url || "";
  const headers = config?.mcp.headers || {};
  const headerArgs = Object.entries(headers)
    .map(([key, value]) => ` --header '${key}: ${value}'`)
    .join("");
  const snippets = config
    ? [
        {
          name: "Antigravity (.mcp.json)",
          text: JSON.stringify({ mcpServers: { [connection.name]: { url, ...(Object.keys(headers).length ? { headers } : {}) } } }, null, 2),
        },
        { name: "Claude Code CLI", text: `claude mcp add --transport http${headerArgs} ${connection.name} ${url}` },
        { name: "Cursor", text: JSON.stringify(config.cursor, null, 2) },
        {
          name: "Codex CLI",
          text: `codex mcp add ${connection.name} --url ${url}${Object.entries(headers)
            .map(([key, value]) => ` --header ${key}=${value}`)
            .join("")}`,
        },
      ]
    : [];

  return (
    <Panel className="overflow-hidden">
      <SectionHeading
        icon={<Code2 size={15} />}
        eyebrow="Client access"
        title="Generated configuration"
        action={
          <button type="button" onClick={onLoad} className="icon-button" title="Refresh configuration">
            <RefreshCw size={14} />
          </button>
        }
      />
      {!config ? (
        <div className="p-6">
          <button type="button" onClick={onLoad} className="button-primary">
            <Settings2 size={14} />
            Generate snippets
          </button>
          <p className="mt-3 text-[10px] text-slate-500">Proxy credentials stay in Aegis; clients receive only the gateway URL.</p>
        </div>
      ) : (
        <div className="space-y-3 p-5">
          {snippets.map((snippet) => (
            <div key={snippet.name} className="rounded-xl border border-slate-200 bg-slate-950 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">{snippet.name}</span>
                <button type="button" onClick={() => onCopy(snippet.text)} className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white" title="Copy snippet">
                  <Copy size={13} />
                </button>
              </div>
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-5 text-cyan-200">{snippet.text}</pre>
            </div>
          ))}
          <p className="text-[10px] text-slate-500">{config.note || "The gateway enforces policy before forwarding tool calls."}</p>
        </div>
      )}
    </Panel>
  );
}

function bodyError(body: unknown): string {
  const error = (body as { error?: { message?: string } })?.error;
  return error?.message || "request failed";
}

async function copyTextQuiet(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* best effort */
  }
}
