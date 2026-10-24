import { execFile } from "node:child_process";
import path from "node:path";

export const IMAGE_TAG = "aegis-sandbox-base:latest";

function docker(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: options.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args.join(" ")} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function ensureImage(imagesDir: string): Promise<void> {
  const existing = await docker(["images", "-q", IMAGE_TAG]);
  if (existing.trim()) return;
  await docker(["build", "-t", IMAGE_TAG, "-f", path.join(imagesDir, "Dockerfile"), imagesDir], { timeoutMs: 600_000 });
}

export function imageName(containerId: string): { agent: string; netwatch: string } {
  return { agent: `aegis-sb-${containerId}`, netwatch: `aegis-sb-${containerId}-net` };
}

export async function isRunning(container: string): Promise<boolean> {
  try {
    const state = await docker(["inspect", "-f", "{{.State.Running}}", container]);
    return state.trim() === "true";
  } catch {
    return false;
  }
}

export async function exitCode(container: string): Promise<number | undefined> {
  try {
    const code = await docker(["inspect", "-f", "{{.State.ExitCode}}", container]);
    const value = Number(code.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface RunAgentOptions {
  id: string;
  workspaceDir: string;
  command: string[];
  env: Record<string, string>;
  supervisorPath: string;
  eventUrl: string;
  upstreamDns: string;
  mode: "observe" | "enforce";
  gatewayUrl: string;
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { agent } = imageName(options.id);
  const args = [
    "run", "-d", "--name", agent,
    "--add-host=host.docker.internal:host-gateway",
    "-v", `${options.workspaceDir}:/workspace`,
    "-v", `${options.supervisorPath}:/aegis/supervisor.cjs:ro`,
    "-w", "/workspace",
    "-e", `AEGIS_SANDBOX_ID=${options.id}`,
    "-e", `AEGIS_EVENT_URL=${options.eventUrl}`,
    "-e", `AEGIS_MODE=${options.mode}`,
    "-e", `AEGIS_GATEWAY_URL=${options.gatewayUrl}`,
    "--stop-signal", "SIGTERM",
  ];
  for (const [key, value] of Object.entries(options.env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(IMAGE_TAG, "node", "/aegis/supervisor.cjs", "--", ...options.command);
  await docker(args);
}

export interface RunNetwatchOptions {
  id: string;
  netwatchPath: string;
  eventUrl: string;
  upstreamDns: string;
  mode: "observe" | "enforce";
  enforceDefault: "allow" | "deny";
  allowDomains: string[];
  blockDomains: string[];
  blockIps: string[];
  gatewayIps: string[];
  hostGatewayIp?: string;
}

export async function runNetwatch(options: RunNetwatchOptions): Promise<void> {
  const { agent, netwatch } = imageName(options.id);
  // The sidecar shares the agent's network namespace, so --add-host is not
  // allowed here; the host-gateway IP is read from the agent container.
  const args = [
    "run", "-d", "--name", netwatch,
    "--network", `container:${agent}`,
    "--pid", `container:${agent}`,
    "--cap-add", "NET_ADMIN",
    "-v", `${options.netwatchPath}:/aegis/netwatch.cjs:ro`,
    "-e", `AEGIS_SANDBOX_ID=${options.id}`,
    "-e", `AEGIS_EVENT_URL=${options.eventUrl}`,
    "-e", `AEGIS_UPSTREAM_DNS=${options.upstreamDns}`,
    "-e", `AEGIS_MODE=${options.mode}`,
    "-e", `AEGIS_ENFORCE_DEFAULT=${options.enforceDefault}`,
    "-e", `AEGIS_ALLOW_DOMAINS=${options.allowDomains.join(",")}`,
    "-e", `AEGIS_BLOCK_DOMAINS=${options.blockDomains.join(",")}`,
    "-e", `AEGIS_BLOCK_IPS=${options.blockIps.join(",")}`,
    "-e", `AEGIS_GATEWAY_IPS=${options.gatewayIps.join(",")}`,
  ];
  if (options.hostGatewayIp) args.push("-e", `AEGIS_GATEWAY_HOSTFILE_IP=${options.hostGatewayIp}`);
  args.push(IMAGE_TAG, "node", "/aegis/netwatch.cjs");
  await docker(args);
}

/** The IP docker injected as host.docker.internal into the agent container. */
export async function hostGatewayIp(container: string): Promise<string> {
  try {
    const hosts = await docker(["exec", container, "cat", "/etc/hosts"]);
    const entry = hosts.split("\n").find((line) => line.includes("host.docker.internal"));
    const ip = entry ? entry.trim().split(/\s+/)[0] : "";
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : "";
  } catch {
    return "";
  }
}

export interface SandboxDiffEntry {
  kind: "added" | "changed" | "deleted";
  path: string;
}

export async function stopSandbox(id: string): Promise<SandboxDiffEntry[]> {
  const { agent, netwatch } = imageName(id);
  const diffEntries: SandboxDiffEntry[] = [];
  try {
    const diff = await docker(["diff", agent], { timeoutMs: 30_000 });
    for (const line of diff.split("\n")) {
      if (!line.trim()) continue;
      const kindChar = line[0];
      const kind = kindChar === "A" ? "added" : kindChar === "C" ? "changed" : kindChar === "D" ? "deleted" : undefined;
      if (kind) diffEntries.push({ kind, path: line.slice(1).trim() });
    }
  } catch { /* container may already be gone */ }
  await docker(["rm", "-f", netwatch]).catch(() => undefined);
  await docker(["stop", "-t", "12", agent]).catch(() => undefined);
  await docker(["rm", "-f", agent]).catch(() => undefined);
  return diffEntries;
}

export async function cleanupSandbox(id: string): Promise<void> {
  const { agent, netwatch } = imageName(id);
  await docker(["rm", "-f", netwatch]).catch(() => undefined);
  await docker(["rm", "-f", agent]).catch(() => undefined);
}
