import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupSandbox, containerIp, copyIntoWorkspace, ensureImage, exitCode, hostGatewayIp, imageName, isRunning, listAegisSandboxes, removeWorkspaceVolume, runAgent, runNetwatch, startSandbox, stopSandbox, stopSandboxKeep } from "./docker";
import { GatewayClient } from "./gatewayClient";
import type { CreateSandboxInput, SandboxEventInput, SandboxRecord } from "./types";

const here = fileURLToPath(new URL(".", import.meta.url));

const LOG_RING = 500;
const EVENT_RING = 2000;
const DEFAULT_ALLOW_DOMAINS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "registry.npmjs.org",
];

interface SandboxRuntime {
  record: SandboxRecord;
  logs: string[];
  events: SandboxEventInput[];
  pollTimer?: NodeJS.Timeout;
  /** Home-profile env (PATH additions, ssh-agent socket) applied to exec shells. */
  profileEnv?: Record<string, string>;
  /** Loopback ports inside the container, forwarded from laptop localhost. */
  forwarders: Map<number, net.Server>;
  containerIp?: string;
}

/**
 * Curated slices of the user's laptop brought into a workspace: shell rc and
 * git identity (read-only), agent configs/logins (shared read-write so login
 * persists), global package dirs (read-only, put on PATH), and the ssh-agent
 * socket (use keys without copying them). Only mounts things that exist.
 */
async function homeProfileMounts(): Promise<{ mounts: string[]; env: Record<string, string> }> {
  const home = process.env.HOME || "/home";
  const mounts: string[] = [];
  const pathParts: string[] = [];
  const exists = async (candidate: string) => (await fs.promises.stat(candidate).catch(() => null)) !== null;

  for (const [source, dest] of [
    [path.join(home, ".gitconfig"), "/home/agent/.gitconfig"],
    [path.join(home, ".bashrc"), "/home/agent/.bashrc"],
    [path.join(home, ".profile"), "/home/agent/.profile"],
  ] as const) {
    if (await exists(source)) mounts.push(`${source}:${dest}:ro`);
  }
  // Agent configs are shared read-write: log in once on the canvas, use it in
  // every workspace; skills and settings stay in sync with the laptop.
  for (const dir of [".claude", ".codex", ".gemini", ".antigravity"]) {
    const source = path.join(home, dir);
    if (await exists(source)) mounts.push(`${source}:/home/agent/${dir}`);
  }
  // Global packages are usable (ro) and first on PATH; installs inside the
  // workspace don't dirty the laptop.
  for (const [source, dest, bin] of [
    [path.join(home, ".local"), "/home/agent/.local", "/home/agent/.local/bin"],
    [path.join(home, ".npm-global"), "/home/agent/.npm-global", "/home/agent/.npm-global/bin"],
  ] as const) {
    if (await exists(source)) {
      mounts.push(`${source}:${dest}:ro`);
      pathParts.push(bin);
    }
  }
  const env: Record<string, string> = {};
  if (pathParts.length) env.AEGIS_EXTRA_PATH = pathParts.join(":");
  const sshSocket = process.env.SSH_AUTH_SOCK;
  if (sshSocket && (await exists(sshSocket))) {
    mounts.push(`${sshSocket}:/home/agent/.ssh/agent.sock`);
    env.SSH_AUTH_SOCK = "/home/agent/.ssh/agent.sock";
  }
  return { mounts, env };
}

export class Orchestrator {
  private readonly runtimes = new Map<string, SandboxRuntime>();
  private imageReady: Promise<void> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly gateway: GatewayClient = new GatewayClient(),
    private readonly eventUrl: string,
    private readonly gatewayUrlForAgents: string,
  ) {}

  private get sandboxDir(): string {
    return path.join(this.dataDir, "sandboxes");
  }

  private async ensureImage(): Promise<void> {
    let pending = this.imageReady;
    if (!pending) {
      // Build context is the app root so the Dockerfile can COPY the
      // supervisor and netwatch scripts into the image.
      pending = ensureImage(path.join(here, "..")).catch((error: unknown) => {
        this.imageReady = null;
        throw error;
      });
      this.imageReady = pending;
    }
    await pending;
  }

  private upstreamDns(): string {
    try {
      const resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
      const match = resolv.match(/^nameserver\s+(\S+)/m);
      if (match && /^\d+\.\d+\.\d+\.\d+$/.test(match[1]) && !match[1].startsWith("127.")) return match[1];
    } catch { /* fall through */ }
    return "1.1.1.1";
  }

  /** Env applied to terminal sessions (PATH additions, ssh-agent socket). */
  envFor(id: string): Record<string, string> {
    return this.runtimes.get(id)?.profileEnv || {};
  }

  list(): SandboxRecord[] {
    return [...this.runtimes.values()].map((runtime) => runtime.record).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Adopt sandboxes whose containers survived a service restart. Docker
   * container labels carry the identity; in-memory rings (logs, recent
   * events) start empty while the gateway keeps the durable event history.
   */
  async adoptExisting(): Promise<number> {
    let adopted = 0;
    try {
      for (const found of await listAegisSandboxes()) {
        if (this.runtimes.has(found.id)) continue;
        const now = new Date().toISOString();
        const record: SandboxRecord = {
          id: found.id,
          name: found.name,
          command: found.command,
          mode: found.mode,
          status: found.running ? "running" : "stopped",
          interactive: found.interactive,
          ...(found.project ? { project: found.project } : {}),
          ...(found.home ? { homeProfile: true } : {}),
          createdAt: now,
          updatedAt: now,
        };
        const runtime: SandboxRuntime = { record, logs: [], events: [], forwarders: new Map() };
        if (found.home && !process.env.DOCKER_HOST) runtime.profileEnv = (await homeProfileMounts()).env;
        this.runtimes.set(found.id, runtime);
        if (found.running) runtime.pollTimer = setInterval(() => void this.watch(found.id), 5000);
        await this.gateway.announceSandbox({ id: found.id, name: record.name, command: record.command, mode: record.mode, status: record.status });
        adopted += 1;
      }
    } catch (error) {
      console.warn("[sandbox] container adoption failed:", error instanceof Error ? error.message : String(error));
    }
    return adopted;
  }

  get(id: string): SandboxRecord | null {
    return this.runtimes.get(id)?.record ?? null;
  }

  logs(id: string): string[] | null {
    return this.runtimes.get(id)?.logs ?? null;
  }

  events(id: string, limit = 500): SandboxEventInput[] | null {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    return runtime.events.slice(-limit);
  }

  /**
   * Agent CLIs run their OAuth callback servers on loopback inside the
   * container; the laptop browser cannot reach them. Forward laptop
   * 127.0.0.1:<port> -> container:<port> so the browser round-trip completes
   * (the same trick VS Code port-forwarding pulls).
   */
  private async ensureForwarder(id: string, port: number): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.forwarders.has(port)) return;
    runtime.containerIp ||= (await containerIp(id)) || undefined;
    if (!runtime.containerIp) {
      console.warn(`[sandbox] no container IP for ${id}; cannot forward :${port}`);
      return;
    }
    const upstream = runtime.containerIp;
    const server = net.createServer((client) => {
      const target = net.connect(port, upstream);
      client.pipe(target);
      target.pipe(client);
      const drop = () => { client.destroy(); target.destroy(); };
      client.on("error", drop);
      target.on("error", drop);
    });
    server.on("error", (error) => {
      console.warn(`[sandbox] forwarder :${port} for ${id} failed: ${error.message}`);
      runtime.forwarders.delete(port);
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`[sandbox] forwarding laptop:${port} -> container ${id}:${port}`);
    });
    runtime.forwarders.set(port, server);
  }

  private closeForwarders(runtime: SandboxRuntime): void {
    for (const [port, server] of runtime.forwarders) {
      server.close(() => undefined);
      runtime.forwarders.delete(port);
      console.log(`[sandbox] closed forwarder :${port}`);
    }
  }

  /** Called by the HTTP service when a container posts an event batch. */
  async ingest(id: string, events: SandboxEventInput[], dropped?: number): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return false;
    runtime.record.updatedAt = new Date().toISOString();
    for (const event of events) {
      if (event.type === "process" && event.detail.kind === "output") {
        const text = `[${new Date(event.ts).toLocaleTimeString()}] ${event.detail.stream === "stderr" ? "!" : " "}${event.detail.text}`;
        runtime.logs.push(text);
        if (runtime.logs.length > LOG_RING) runtime.logs.splice(0, runtime.logs.length - LOG_RING);
        continue;
      }
      if (event.type === "lifecycle" && event.detail.kind === "exit") {
        const code = typeof event.detail.code === "number" ? event.detail.code : undefined;
        runtime.record.exitCode = code;
        runtime.record.status = "exited";
      }
      if (event.type === "port_listen" && typeof event.detail.port === "number") {
        void this.ensureForwarder(id, event.detail.port);
      }
      runtime.events.push(event);
      if (runtime.events.length > EVENT_RING) runtime.events.splice(0, runtime.events.length - EVENT_RING);
    }
    if (dropped) runtime.logs.push(`[aegis] ${dropped} event(s) dropped under pressure`);
    await this.gateway.pushEvents(id, events);
    return true;
  }

  async create(input: CreateSandboxInput): Promise<SandboxRecord> {
    const command = Array.isArray(input.command) ? input.command.filter((part) => typeof part === "string") : [];
    if (input.name && (typeof input.name !== "string" || input.name.length > 160)) throw new Error("name must be a string of at most 160 characters.");
    if (input.stdin !== undefined && (typeof input.stdin !== "string" || input.stdin.length > 8000)) throw new Error("stdin must be a string of at most 8000 characters.");
    // An empty command creates an interactive workspace: a keepalive process
    // plus exec terminals; the user works inside it like a normal machine.
    const interactive = command.length === 0;
    await this.ensureImage();
    if (input.workspace) {
      const source = path.resolve(input.workspace);
      const stat = await fs.promises.stat(source).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`workspace path is not a directory: ${source}`);
    }
    // Bind-mounted projects only make sense against a local daemon: the
    // path must exist on the machine running the containers.
    if (input.project) {
      if (process.env.DOCKER_HOST) throw new Error("Project folders require a local Docker daemon (no DOCKER_HOST).");
      if (!input.project.name?.trim() || input.project.name.length > 120) throw new Error("project.name is required (max 120 chars).");
      const projectPath = path.resolve(input.project.path);
      const stat = await fs.promises.stat(projectPath).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`project folder not found: ${projectPath}`);
      input.project = { ...input.project, path: projectPath };
    }

    const blockDomains = await this.gateway.connectionHosts();
    const blockIps: string[] = [];
    for (const host of blockDomains) {
      try {
        const addresses = await dns.lookup(host, { family: 4, all: true });
        for (const address of addresses) blockIps.push(address.address);
      } catch { /* unresolvable hosts still match by domain via DNS sniffing */ }
    }
    const gatewayIps = ["host.docker.internal"];
    const allowDomains = [
      ...DEFAULT_ALLOW_DOMAINS,
      ...(process.env.AEGIS_SANDBOX_ALLOW_DOMAINS || "").split(",").map((d) => d.trim()).filter(Boolean),
    ];

    const id = `sb_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = new Date().toISOString();
    const mode: "observe" | "enforce" = input.mode === "enforce" ? "enforce" : "observe";
    const enforceDefault = input.enforceDefault === "allow" ? "allow" : "deny";

    const record: SandboxRecord = {
      id,
      name: input.name || (input.project ? input.project.name : `sandbox-${id.slice(3, 11)}`),
      command,
      mode,
      status: "running",
      interactive,
      ...(input.project ? { project: input.project } : {}),
      ...(input.homeProfile ? { homeProfile: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const runtime: SandboxRuntime = { record, logs: [], events: [], forwarders: new Map() };
    this.runtimes.set(id, runtime);

    // Home-profile mounts are local-daemon only (paths live on the laptop).
    const home = input.homeProfile && !process.env.DOCKER_HOST ? await homeProfileMounts() : { mounts: [], env: {} };
    if (input.homeProfile && process.env.DOCKER_HOST) {
      console.warn("[sandbox] homeProfile ignored: requires a local Docker daemon");
    }
    runtime.profileEnv = home.env;

    try {
      await runAgent({
        id,
        command: interactive ? [] : command,
        env: { ...(input.env || {}), ...home.env },
        eventUrl: this.eventUrl,
        upstreamDns: this.upstreamDns(),
        mode,
        gatewayUrl: this.gatewayUrlForAgents,
        ...(input.stdin !== undefined && !interactive ? { agentStdin: input.stdin } : {}),
        nameLabel: record.name,
        interactive,
        commandLabel: command.join(" ").slice(0, 300),
        ...(input.project
          ? { projectPath: input.project.path, readOnly: Boolean(input.project.readOnly), projectLabel: input.project.name }
          : {}),
        ...(home.mounts.length ? { extraMounts: home.mounts } : {}),
        // Match the laptop user so mounted project files stay user-owned.
        agentUid: typeof process.getuid === "function" ? process.getuid() : 1000,
      });
      const gatewayIp = await hostGatewayIp(`aegis-sb-${id}`);
      await runNetwatch({
        id,
        eventUrl: this.eventUrl,
        upstreamDns: this.upstreamDns(),
        mode,
        enforceDefault,
        allowDomains,
        blockDomains,
        blockIps,
        gatewayIps,
        hostGatewayIp: gatewayIp,
        agentUid: typeof process.getuid === "function" ? process.getuid() : 1000,
      });
      if (input.workspace) await copyIntoWorkspace(id, path.resolve(input.workspace));
    } catch (error) {
      await cleanupSandbox(id).catch(() => undefined);
      record.status = "stopped";
      record.updatedAt = new Date().toISOString();
      throw error;
    }

    runtime.pollTimer = setInterval(() => void this.watch(id), 5000);
    await this.gateway.announceSandbox({ id, name: record.name, command: record.command, mode, status: "running" });
    return cloneRecord(record);
  }

  private async watch(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.record.status !== "running") return;
    const { agent } = imageName(id);
    if (await isRunning(agent)) return;
    clearInterval(runtime.pollTimer);
    this.closeForwarders(runtime);
    if (runtime.record.interactive) {
      // Interactive workspaces keep their containers for restart; the report
      // is only a snapshot, never a teardown.
      runtime.record.status = "stopped";
      runtime.record.updatedAt = new Date().toISOString();
      await this.gateway.announceSandbox({ id, name: runtime.record.name, command: runtime.record.command, mode: runtime.record.mode, status: "stopped" });
      return;
    }
    // One-shot run exited without a lifecycle event reaching us (hard kill).
    runtime.record.status = "exited";
    runtime.record.exitCode = await exitCode(agent);
    runtime.record.updatedAt = new Date().toISOString();
    await this.finalize(id, "exited");
  }

  async stop(id: string): Promise<SandboxRecord | null> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    if (runtime.pollTimer) clearInterval(runtime.pollTimer);
    if (runtime.record.status === "running") {
      runtime.record.status = "stopped";
      runtime.record.exitCode = await exitCode(`aegis-sb-${id}`).catch(() => undefined);
    }
    runtime.record.updatedAt = new Date().toISOString();
    this.closeForwarders(runtime);
    if (runtime.record.interactive) {
      await stopSandboxKeep(id);
      await this.gateway.announceSandbox({ id, name: runtime.record.name, command: runtime.record.command, mode: runtime.record.mode, status: "stopped" });
    } else {
      await this.finalize(id, "stopped");
    }
    return cloneRecord(runtime.record);
  }

  async restart(id: string): Promise<SandboxRecord | null> {
    const runtime = this.runtimes.get(id);
    if (!runtime || !runtime.record.interactive) return null;
    await startSandbox(id);
    runtime.record.status = "running";
    runtime.record.exitCode = undefined;
    runtime.record.updatedAt = new Date().toISOString();
    runtime.pollTimer = setInterval(() => void this.watch(id), 5000);
    await this.gateway.announceSandbox({ id, name: runtime.record.name, command: runtime.record.command, mode: runtime.record.mode, status: "running" });
    return cloneRecord(runtime.record);
  }

  async remove(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return false;
    if (runtime.pollTimer) clearInterval(runtime.pollTimer);
    this.closeForwarders(runtime);
    const filesystem = await stopSandbox(id);
    const eventCounts: Record<string, number> = {};
    for (const event of runtime.events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    runtime.record.status = "stopped";
    runtime.record.report = { filesystem, eventCounts };
    this.runtimes.delete(id);
    await removeWorkspaceVolume(id);
    await this.gateway.announceSandbox({ id, name: runtime.record.name, command: runtime.record.command, mode: runtime.record.mode, status: "deleted", report: runtime.record.report });
    return true;
  }

  private async finalize(id: string, status: "exited" | "stopped"): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.closeForwarders(runtime);
    const filesystem = await stopSandbox(id);
    const eventCounts: Record<string, number> = {};
    for (const event of runtime.events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    runtime.record.status = status;
    runtime.record.report = { filesystem, eventCounts };
    runtime.record.updatedAt = new Date().toISOString();
    await this.gateway.announceSandbox({
      id,
      name: runtime.record.name,
      command: runtime.record.command,
      mode: runtime.record.mode,
      status,
      exitCode: runtime.record.exitCode,
      report: runtime.record.report,
    });
  }
}

function cloneRecord(record: SandboxRecord): SandboxRecord {
  return JSON.parse(JSON.stringify(record)) as SandboxRecord;
}
