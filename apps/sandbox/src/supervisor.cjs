#!/usr/bin/env node
/**
 * Aegis sandbox supervisor — PID 1 inside the agent container.
 *
 * Responsibilities:
 *  - run the agent command as uid 1000 (never root) in /workspace
 *  - point /etc/resolv.conf at the netwatch DNS logger on 127.0.0.1
 *  - capture stdout/stderr, process starts/exits, and workspace file changes
 *  - batch and POST every event to the sandbox service, then exit with the
 *    agent's exit code.
 *
 * Env (set by the sandbox service via `docker run -e`):
 *   AEGIS_SANDBOX_ID   sandbox id
 *   AEGIS_EVENT_URL    http://host.docker.internal:8788/internal/events
 *   AEGIS_UPSTREAM_DNS real resolver the netwatch sidecar forwards to
 *   AEGIS_MODE         observe | enforce (informational for the agent env)
 * Everything else in the environment is passed to the agent unchanged.
 */
"use strict";

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SANDBOX_ID = process.env.AEGIS_SANDBOX_ID || "sb_unknown";
const EVENT_URL = process.env.AEGIS_EVENT_URL || "";
const UPSTREAM_DNS = process.env.AEGIS_UPSTREAM_DNS || "";
const FLUSH_MS = 400;
const POLL_MS = 1000;
const MAX_LINE = 4000;

const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const command = dd >= 0 ? argv.slice(dd + 1) : [];
const AGENT_UID = 1000;
const AGENT_GID = 1000;

const queue = [];
let dropped = 0;
let flushing = false;

function emit(type, detail) {
  queue.push({ type, detail, ts: new Date().toISOString() });
  if (queue.length > 5000) { queue.splice(0, queue.length - 5000); dropped++; }
}

async function flush() {
  if (flushing || !EVENT_URL || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    const response = await fetch(EVENT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sandboxId: SANDBOX_ID, events: batch, dropped }),
    });
    if (!response.ok) throw new Error(`event POST returned ${response.status}`);
    dropped = 0;
  } catch (error) {
    queue.unshift(...batch.slice(0, 1000)); // keep the most recent events on failure
    process.stderr.write(`[aegis-supervisor] event delivery failed: ${error.message}\n`);
  } finally {
    flushing = false;
  }
}

function log(tag, text) {
  process.stdout.write(`[aegis-supervisor] ${tag}: ${text}\n`);
}

/**
 * Block until the netwatch DNS resolver is actually listening on
 * 127.0.0.1:53. Node's own resolver cannot be trusted for this probe: its
 * c-ares channel may still use the pre-rewrite resolv.conf.
 */
async function waitForDns(maxWaitMs = 8000) {
  const started = Date.now();
  const listenerUp = () => new Promise((resolve) => {
    execFile("ss", ["-uln"], (error, stdout) => resolve(!error && /:53\b/.test(stdout)));
  });
  while (Date.now() - started < maxWaitMs) {
    if (await listenerUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  process.stderr.write("[aegis-supervisor] DNS resolver did not become ready; continuing without it\n");
  return false;
}

function prepareEnvironment() {
  // All name resolution inside the sandbox flows through the netwatch DNS
  // logger so the timeline shows hostnames, not bare IPs.
  try {
    fs.writeFileSync("/etc/resolv.conf", `nameserver 127.0.0.1\noptions ndots:1 timeout:2 attempts:2\n`);
  } catch (error) {
    process.stderr.write(`[aegis-supervisor] could not set resolver: ${error.message}\n`);
  }
  for (const dir of ["/workspace", "/home/agent"]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.chownSync(dir, AGENT_UID, AGENT_GID);
    } catch { /* best effort */ }
  }
}

/* ---------------------------------- output --------------------------------- */

function watchStream(stream, channel) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    process[channel].write(chunk);
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) emit("process", { kind: "output", stream: channel, text: line.slice(0, MAX_LINE) });
  });
  stream.on("end", () => { if (buffer) emit("process", { kind: "output", stream: channel, text: buffer.slice(0, MAX_LINE) }); });
}

/* --------------------------------- processes -------------------------------- */

function parsePs(stdout) {
  const map = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const args = match[5].slice(0, 300);
    // The poller's own ps invocation would otherwise flood the timeline.
    if (args.startsWith("ps -eo")) continue;
    map.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      user: match[3],
      etimes: Number(match[4]),
      args,
    });
  }
  return map;
}

let knownProcesses = null;
function pollProcesses() {
  execFile("ps", ["-eo", "pid,ppid,user,etimes,args", "--no-headers"], (error, stdout) => {
    if (error) return;
    const current = parsePs(stdout);
    if (!knownProcesses) {
      knownProcesses = current;
      return;
    }
    for (const [pid, info] of current) {
      if (!knownProcesses.has(pid)) emit("process", { kind: "start", ...info });
    }
    for (const [pid, info] of knownProcesses) {
      if (!current.has(pid)) emit("process", { kind: "exit", pid: pid, args: info.args });
    }
    knownProcesses = current;
  });
}

/* ----------------------------------- files ---------------------------------- */

function watchTree(root) {
  const pending = new Map();
  try {
    fs.watch(root, { recursive: true }, (event, filename) => {
      const rel = filename ? path.join(path.basename(root), String(filename)) : path.basename(root);
      if (pending.has(rel)) clearTimeout(pending.get(rel));
      pending.set(rel, setTimeout(() => {
        pending.delete(rel);
        let size;
        try { size = fs.statSync(path.join(path.dirname(root), rel)).size; } catch { size = undefined; }
        emit("file_write", { path: rel, event, size });
      }, 300));
    });
  } catch (error) {
    process.stderr.write(`[aegis-supervisor] watch failed for ${root}: ${error.message}\n`);
  }
}

/* ----------------------------------- main ----------------------------------- */

function main() {
  // An empty command means "interactive workspace": hold the container open
  // with a keepalive process; the user works via exec terminal sessions.
  const isInteractive = command.length === 0;
  const effectiveCommand = isInteractive ? ["sleep", "infinity"] : command;
  prepareEnvironment();
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("AEGIS_") && key !== "AEGIS_MODE" && key !== "AEGIS_GATEWAY_URL") delete childEnv[key];
  }
  childEnv.HOME = "/home/agent";
  childEnv.USER = "agent";
  childEnv.TERM = childEnv.TERM || "xterm";

  log("start", `${isInteractive ? "(interactive workspace)" : effectiveCommand.join(" ")} (sandbox ${SANDBOX_ID})`);
  emit("lifecycle", { kind: "started", command: isInteractive ? [] : effectiveCommand, interactive: isInteractive, mode: process.env.AEGIS_MODE || "observe" });

  const pollTimer = setInterval(pollProcesses, POLL_MS);
  const flushTimer = setInterval(() => { flush().catch(() => undefined); }, FLUSH_MS);
  pollProcesses(); // establish the process baseline before the agent starts
  watchTree("/workspace");
  watchTree("/home/agent");

  void waitForDns().then(() => {
    const child = spawn(effectiveCommand[0], effectiveCommand.slice(1), {
      cwd: "/workspace",
      env: childEnv,
      uid: AGENT_UID,
      gid: AGENT_GID,
      stdio: ["pipe", "pipe", "pipe"],
    }).on("error", (error) => {
      emit("lifecycle", { kind: "exit", code: 127, error: `spawn failed: ${error.message}` });
      process.exit(127);
    });

    // Interactive REPL agents are driven by feeding their startup lines; the
    // stream is closed after so agents that read stdin to EOF also finish.
    const startupStdin = process.env.AEGIS_AGENT_STDIN;
    if (startupStdin !== undefined) {
      child.stdin.write(startupStdin.endsWith("\n") ? startupStdin : `${startupStdin}\n`);
      child.stdin.end();
    }

    watchStream(child.stdout, "stdout");
    watchStream(child.stderr, "stderr");

    let stopping = false;
    async function shutdown(signal) {
      if (stopping) return;
      stopping = true;
      clearInterval(pollTimer);
      clearInterval(flushTimer);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5000).unref();
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    child.on("close", async (code, signal) => {
      clearInterval(pollTimer);
      emit("lifecycle", { kind: "exit", code: code === null ? null : code, signal: signal || undefined });
      log("exit", `code=${code} signal=${signal || "none"}`);
      await flush();
      setTimeout(() => process.exit(code === null || code === undefined ? 1 : code), 200).unref();
    });
  });
}

main();
