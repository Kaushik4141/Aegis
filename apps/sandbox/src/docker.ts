import { execFile } from "node:child_process";
import path from "node:path";
import Dockerode from "dockerode";

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

/** Build context is the sandbox app dir: instrumentation is COPYed in. */
export async function ensureImage(appRoot: string): Promise<void> {
  const existing = await docker(["images", "-q", IMAGE_TAG]);
  if (existing.trim()) return;
  await docker(["build", "-t", IMAGE_TAG, "-f", path.join(appRoot, "images", "Dockerfile"), appRoot], { timeoutMs: 600_000 });
}

export function imageName(containerId: string): { agent: string; netwatch: string } {
  return { agent: `aegis-sb-${containerId}`, netwatch: `aegis-sb-${containerId}-net` };
}

/** Daemon-side workspace volume: identical behavior on local and remote Docker. */
export function workspaceVolume(containerId: string): string {
  return `aegis-ws-${containerId}`;
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
  command: string[];
  env: Record<string, string>;
  eventUrl: string;
  upstreamDns: string;
  mode: "observe" | "enforce";
  gatewayUrl: string;
  agentStdin?: string;
  nameLabel: string;
  interactive: boolean;
  commandLabel: string;
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { agent } = imageName(options.id);
  const args = [
    "run", "-d", "--name", agent,
    "--label", `aegis.sandbox=${options.id}`,
    "--label", `aegis.name=${options.nameLabel}`,
    "--label", `aegis.mode=${options.mode}`,
    "--label", `aegis.interactive=${options.interactive ? "1" : "0"}`,
    "--label", `aegis.command=${options.commandLabel}`,
    "--add-host=host.docker.internal:host-gateway",
    // Named volume (auto-created by the daemon) instead of a host bind mount:
    // identical on local and remote daemons, and nothing on the service host
    // is ever exposed to the sandbox.
    "-v", `${workspaceVolume(options.id)}:/workspace`,
    "-w", "/workspace",
    "-e", `AEGIS_SANDBOX_ID=${options.id}`,
    "-e", `AEGIS_EVENT_URL=${options.eventUrl}`,
    "-e", `AEGIS_MODE=${options.mode}`,
    "-e", `AEGIS_GATEWAY_URL=${options.gatewayUrl}`,
    // Agents inside the sandbox reach the Aegis gateway through the docker
    // host gateway; inject the standard env unless the caller set one.
    "-e", `SENTINEL_GATEWAY_URL=${options.env.SENTINEL_GATEWAY_URL || options.gatewayUrl}`,
    "--stop-signal", "SIGTERM",
  ];
  if (options.agentStdin) args.push("-e", `AEGIS_AGENT_STDIN=${options.agentStdin}`);
  for (const [key, value] of Object.entries(options.env)) {
    args.push("-e", `${key}=${value}`);
  }
  // supervisor.cjs is baked into the image (see images/Dockerfile).
  args.push(IMAGE_TAG, "node", "/aegis/supervisor.cjs", "--", ...options.command);
  await docker(args);
}

export interface RunNetwatchOptions {
  id: string;
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
  // netwatch.cjs is baked into the image.
  const args = [
    "run", "-d", "--name", netwatch,
    "--label", `aegis.sandbox=${options.id}`,
    "--network", `container:${agent}`,
    "--pid", `container:${agent}`,
    "--cap-add", "NET_ADMIN",
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

/**
 * Seed a running sandbox workspace from a host directory: stream the contents
 * in via `docker cp` and hand them to the agent user. Works identically
 * against remote daemons — the bytes travel over the docker API.
 */
export async function copyIntoWorkspace(id: string, sourceDir: string): Promise<void> {
  const { agent } = imageName(id);
  await docker(["cp", `${sourceDir}/.`, `${agent}:/workspace/`], { timeoutMs: 300_000 });
  await docker(["exec", "-u", "0", agent, "chown", "-R", "1000:1000", "/workspace"]).catch(() => undefined);
}

export async function removeWorkspaceVolume(id: string): Promise<void> {
  await docker(["volume", "rm", workspaceVolume(id)]).catch(() => undefined);
}

export interface AdoptedSandbox {
  id: string;
  name: string;
  mode: "observe" | "enforce";
  interactive: boolean;
  command: string[];
  running: boolean;
}

/**
 * Rebuild sandbox records from labeled containers after a service restart.
 * Interactive workspaces outlive the service; without adoption their
 * terminals and lifecycle controls would be orphaned.
 */
export async function listAegisSandboxes(): Promise<AdoptedSandbox[]> {
  const output = await docker(["ps", "-a", "--filter", "label=aegis.sandbox", "--format", "{{.Names}}\t{{.State}}\t{{.Label \"aegis.name\"}}\t{{.Label \"aegis.mode\"}}\t{{.Label \"aegis.interactive\"}}\t{{.Label \"aegis.command\"}}"]);
  const adopted: AdoptedSandbox[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [containerName, state, name, mode, interactive, command] = line.split("\t");
    if (!containerName?.startsWith("aegis-sb-") || containerName.endsWith("-net")) continue;
    adopted.push({
      id: containerName.replace(/^aegis-sb-/, ""),
      name: name || containerName,
      mode: mode === "enforce" ? "enforce" : "observe",
      interactive: interactive === "1",
      command: command ? command.split(" ").filter(Boolean) : [],
      running: state === "running",
    });
  }
  return adopted;
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

/**
 * Persistent lifecycle: stop keeps both containers (workspace, installed
 * agents, and logins survive); restart brings the pair back in order — the
 * netwatch sidecar shares the agent's network namespace, so the agent starts
 * first. A stopped-then-started container re-runs its original command.
 */
export async function stopSandboxKeep(id: string): Promise<void> {
  const { agent, netwatch } = imageName(id);
  await docker(["stop", "-t", "12", netwatch]).catch(() => undefined);
  await docker(["stop", "-t", "12", agent]).catch(() => undefined);
}

export async function startSandbox(id: string): Promise<void> {
  const { agent, netwatch } = imageName(id);
  await docker(["start", agent]);
  await docker(["start", netwatch]).catch(async () => {
    // A stale sidecar (e.g. removed behind our back) is recreated as-is.
    await docker(["rm", "-f", netwatch]).catch(() => undefined);
  });
}

/* ------------------------------ terminal exec ------------------------------ */

/**
 * Docker API client for exec/PTY streams. DOCKER_HOST selects the daemon:
 *   unset | unix:///...  → local socket (default /var/run/docker.sock)
 *   tcp://host:port      → remote or tunneled daemon
 *   ssh://user@host      → use `ssh -L` + tcp:// instead (dockerode's ssh
 *                          transport needs the optional ssh2 native module)
 */
export function dockerDaemon(): Dockerode {
  const host = process.env.DOCKER_HOST?.trim();
  if (!host) return new Dockerode();
  if (host.startsWith("unix://")) {
    return new Dockerode({ socketPath: host.replace("unix://", "") });
  }
  if (host.startsWith("tcp://") || host.startsWith("http://")) {
    const url = new URL(host.replace("tcp://", "http://"));
    return new Dockerode({
      host: url.hostname,
      port: url.port ? Number(url.port) : 2375,
      protocol: "http",
    });
  }
  // Anything else (ssh://, npipe://): let dockerode try, with a clear error.
  console.warn(`[sandbox] unsupported DOCKER_HOST "${host}" for exec streams; tunnel it and use tcp://`);
  return new Dockerode();
}

let dockerApi: Dockerode | undefined;

function api(): Dockerode {
  if (!dockerApi) dockerApi = dockerDaemon();
  return dockerApi;
}

export interface ExecSession {
  write(input: string): void;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
}

/**
 * Attach an interactive PTY shell (`bash`) inside the agent container. Used
 * by the dashboard terminal: output is streamed raw (TTY exec has no
 * multiplexing headers), input and resize are pushed by the caller.
 */
export async function execShell(
  id: string,
  handlers: { onOutput: (chunk: Buffer) => void; onExit: () => void },
): Promise<ExecSession> {
  const { agent } = imageName(id);
  const container = api().getContainer(agent);
  const execOptions: Dockerode.ExecCreateOptions = {
    Cmd: ["bash"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    WorkingDir: "/workspace",
    User: "1000:1000",
    Env: ["HOME=/home/agent", "TERM=xterm-256color"],
  };
  // dockerode creates the exec on container.exec(options); the bundled
  // typings model the legacy callback form, so retype the call explicitly.
  const execInstance = await (container.exec as unknown as (options: Dockerode.ExecCreateOptions) => Promise<Dockerode.Exec>)(execOptions);
  const stream = await execInstance.start({ hijack: true, stdin: true, Tty: true });
  stream.on("data", (chunk: Buffer) => handlers.onOutput(chunk));
  stream.on("end", () => handlers.onExit());
  stream.on("error", () => handlers.onExit());
  return {
    write: (input: string) => { stream.write(input); },
    resize: async (cols: number, rows: number) => {
      await execInstance.resize({ h: rows, w: cols }).catch(() => undefined);
    },
    kill: async () => {
      stream.destroy?.();
    },
  };
}
