import dns from "node:dns/promises";
import type { McpConnectionRegistry } from "./mcp";
import type { SentinelEnvironment } from "./types";

const IP_CACHE_TTL_MS = 60_000;
const ipCache = new Map<string, { ips: string[]; at: number }>();

function hostFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Hosts that agents must reach only through the gateway: every registered
 * upstream connection plus any operator-configured watchlist entries.
 */
export async function shadowWatchlist(registry: McpConnectionRegistry, env: SentinelEnvironment): Promise<string[]> {
  const hosts = new Set<string>();
  try {
    for (const connection of await registry.list()) {
      if (typeof connection.url === "string") {
        const host = hostFromUrl(connection.url);
        if (host && host !== "localhost" && host !== "127.0.0.1") hosts.add(host);
      }
    }
  } catch { /* registry unavailable: fall back to env watchlist */ }
  for (const entry of (env.SENTINEL_SHADOW_WATCHLIST || "").split(",")) {
    const host = entry.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
}

async function resolvedIps(host: string): Promise<string[]> {
  const cached = ipCache.get(host);
  if (cached && Date.now() - cached.at < IP_CACHE_TTL_MS) return cached.ips;
  let ips: string[] = [];
  try {
    const records = await dns.lookup(host, { all: true });
    ips = records.map((record) => record.address);
  } catch { /* unresolvable host still matches on dns_lookup events */ }
  ipCache.set(host, { ips, at: Date.now() });
  return ips;
}

function nameMatches(candidate: string, hosts: string[]): string | undefined {
  const value = candidate.toLowerCase();
  return hosts.find((host) => value === host || value.endsWith(`.${host}`));
}

export interface ShadowAccessMatch {
  kind: "dns_lookup" | "net_connect";
  host: string;
  detail: Record<string, unknown>;
}

/**
 * Detect direct (non-gateway) access to registered business systems:
 *  - a DNS lookup for a watched host, or
 *  - an outbound connection to an IP a watched host resolves to.
 */
export async function detectShadowAccess(
  event: { type: string; detail: Record<string, unknown> },
  hosts: string[],
): Promise<ShadowAccessMatch | null> {
  if (!hosts.length) return null;
  if (event.type === "dns_lookup" && typeof event.detail.name === "string") {
    const host = nameMatches(event.detail.name, hosts);
    if (host) return { kind: "dns_lookup", host, detail: event.detail };
    return null;
  }
  if (event.type === "net_connect" && typeof event.detail.peer === "string") {
    const peer = event.detail.peer as string;
    for (const host of hosts) {
      const ips = await resolvedIps(host);
      if (ips.includes(peer)) return { kind: "net_connect", host, detail: event.detail };
    }
  }
  return null;
}
