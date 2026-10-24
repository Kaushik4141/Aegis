/**
 * Push sandbox records and events to the Aegis gateway, which owns durable
 * storage (D1), shadow-access detection, and the audit trail. Delivery is
 * best-effort with retries: monitoring must never block execution.
 */
import type { SandboxEventInput } from "./types";

export interface GatewayClientOptions {
  baseUrl?: string;
  adminToken?: string;
  fetchImpl?: typeof fetch;
}

export class GatewayClient {
  constructor(private readonly options: GatewayClientOptions = {}) {}

  private get baseUrl(): string {
    return (this.options.baseUrl || process.env.AEGIS_GATEWAY_URL || "http://127.0.0.1:8787/api/v1").replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.options.adminToken || process.env.SENTINEL_ADMIN_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  private async post(path: string, body: unknown, attempt = 0): Promise<void> {
    const fetchImpl = this.options.fetchImpl || fetch;
    try {
      const response = await fetchImpl(`${this.options.baseUrl || this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`gateway returned ${response.status}`);
    } catch (error) {
      if (attempt >= 2) {
        console.warn(`[sandbox] gateway push failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      await this.post(path, body, attempt + 1);
    }
  }

  announceSandbox(record: {
    id: string;
    name: string;
    command: string[];
    mode: string;
    status: string;
    exitCode?: number;
    report?: unknown;
  }): Promise<void> {
    return this.post("/sandboxes", record);
  }

  pushEvents(sandboxId: string, events: SandboxEventInput[]): Promise<void> {
    if (!events.length) return Promise.resolve();
    return this.post(`/sandboxes/${encodeURIComponent(sandboxId)}/events`, { events });
  }

  /** Hosts of registered upstream connections, used as the block/watch list. */
  async connectionHosts(): Promise<string[]> {
    const fetchImpl = this.options.fetchImpl || fetch;
    try {
      const response = await fetchImpl(`${this.baseUrl}/connections`, { headers: this.headers() });
      if (!response.ok) return [];
      const body = (await response.json()) as { connections?: Array<Record<string, unknown>> };
      const hosts = new Set<string>();
      for (const connection of body.connections || []) {
        const url = typeof connection.url === "string" ? connection.url : undefined;
        if (!url) continue;
        try { hosts.add(new URL(url).hostname.toLowerCase()); } catch { /* skip malformed */ }
      }
      const extra = (process.env.SENTINEL_SHADOW_WATCHLIST || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      for (const host of extra) hosts.add(host);
      return [...hosts].filter((host) => host && host !== "localhost" && host !== "127.0.0.1");
    } catch {
      const extra = (process.env.SENTINEL_SHADOW_WATCHLIST || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      return extra;
    }
  }
}
