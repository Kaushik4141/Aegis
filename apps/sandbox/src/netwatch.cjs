#!/usr/bin/env node
/**
 * Aegis netwatch — network observer/enforcer sidecar.
 *
 * Runs in a second container sharing the AGENT container's network namespace
 * (`--network container:<id>`) and PID namespace (`--pid container:<id>`), with
 * NET_ADMIN so enforce mode can install iptables rules.
 *
 *  - DNS: listens on 127.0.0.1:53, logs every query name, relays to the real
 *    upstream resolver, and relays the answer back untouched.
 *  - Connections: polls `ss -tunp` and emits an event for every new outbound
 *    connection (destination, port, owning process).
 *  - Enforce mode: agent processes run as uid 1000; all of their outbound
 *    traffic passes through AEGIS_BLOCK (explicit rejects: registered business
 *    systems) then AEGIS_ALLOW (loopback, Aegis gateway, allow-listed LLM
 *    endpoints learned from DNS answers), then an optional default REJECT.
 *
 * Env:
 *   AEGIS_SANDBOX_ID, AEGIS_EVENT_URL, AEGIS_UPSTREAM_DNS,
 *   AEGIS_MODE (observe|enforce), AEGIS_ENFORCE_DEFAULT (deny|allow),
 *   AEGIS_ALLOW_DOMAINS, AEGIS_BLOCK_DOMAINS (comma-separated, suffix match),
 *   AEGIS_BLOCK_IPS, AEGIS_GATEWAY_IPS (comma-separated IPs; gateway ports
 *   8787/8788/3000 are allowed), AEGIS_GATEWAY_HOSTFILE_IP (host-gateway IP
 *   from this container's /etc/hosts).
 */
"use strict";

const { execFile } = require("node:child_process");
const dgram = require("node:dgram");
const fs = require("node:fs");

const env = process.env;
const SANDBOX_ID = env.AEGIS_SANDBOX_ID || "sb_unknown";
const EVENT_URL = env.AEGIS_EVENT_URL || "";
const UPSTREAM_DNS = env.AEGIS_UPSTREAM_DNS || "1.1.1.1";
const MODE = env.AEGIS_MODE === "enforce" ? "enforce" : "observe";
const ENFORCE_DEFAULT = env.AEGIS_ENFORCE_DEFAULT === "allow" ? "allow" : "deny";
const ALLOW_DOMAINS = (env.AEGIS_ALLOW_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
const BLOCK_DOMAINS = (env.AEGIS_BLOCK_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
const BLOCK_IPS = (env.AEGIS_BLOCK_IPS || "").split(",").map((d) => d.trim()).filter(Boolean);
const GATEWAY_IPS = (env.AEGIS_GATEWAY_IPS || "").split(",").map((d) => d.trim()).filter(Boolean);
const HOST_GATEWAY_IP = env.AEGIS_GATEWAY_HOSTFILE_IP || "";

const FLUSH_MS = 400;
const POLL_MS = 1000;
const GATEWAY_PORTS = [3000, 8787, 8788];
// Matches the supervisor's agent uid so owner-based rules track agent traffic.
const AGENT_UID = String(Number(env.AEGIS_AGENT_UID) || 1000);

const queue = [];
let flushing = false;

function emit(type, detail) {
  queue.push({ type, detail, ts: new Date().toISOString() });
}

async function flush() {
  if (flushing || !EVENT_URL || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    const response = await fetch(EVENT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sandboxId: SANDBOX_ID, events: batch }),
    });
    if (!response.ok) throw new Error(`event POST returned ${response.status}`);
  } catch {
    queue.unshift(...batch.slice(0, 1000));
  } finally {
    flushing = false;
  }
}

setInterval(() => { flush().catch(() => undefined); }, FLUSH_MS);

/* --------------------------------- iptables --------------------------------- */

function ruleTool(ip) {
  return String(ip).includes(":") ? "ip6tables" : "iptables";
}

function fw(args) {
  // Mirror rules into the matching family tool; best effort on ip6tables.
  return new Promise((resolve) => {
    execFile(args[0], args.slice(1), (error) => {
      if (error) process.stderr.write(`[aegis-netwatch] ${args.join(" ")} failed: ${error.message}\n`);
      resolve(!error);
    });
  });
}

const allowedIps = new Set();
const blockedIps = new Set();

async function allowIp(ip) {
  if (!ip || allowedIps.has(ip)) return;
  allowedIps.add(ip);
  await fw([ruleTool(ip), "-I", "AEGIS_ALLOW", "1", "-d", `${ip}${ip.includes(":") ? "/128" : "/32"}`, "-j", "ACCEPT"]);
  emit("enforce_rule", { kind: "allow", ip });
}

async function blockIp(ip) {
  if (!ip || blockedIps.has(ip)) return;
  blockedIps.add(ip);
  await fw([ruleTool(ip), "-I", "AEGIS_BLOCK", "1", "-d", `${ip}${ip.includes(":") ? "/128" : "/32"}`, "-j", "REJECT"]);
  emit("enforce_rule", { kind: "block", ip });
}

async function setupEnforce() {
  // Agent traffic (uid 1000): explicit blocks first, then explicit allows,
  // then (deny mode) reject everything else. Supervisor + netwatch run as
  // root and are not matched by these rules.
  for (const tool of ["iptables", "ip6tables"]) {
    await fw([tool, "-N", "AEGIS_BLOCK"]);
    await fw([tool, "-N", "AEGIS_ALLOW"]);
    await fw([tool, "-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", AGENT_UID, "-j", "AEGIS_BLOCK"]);
    await fw([tool, "-I", "OUTPUT", "2", "-m", "owner", "--uid-owner", AGENT_UID, "-j", "AEGIS_ALLOW"]);
    await fw([tool, "-A", "AEGIS_ALLOW", "-o", "lo", "-j", "ACCEPT"]);
    for (const port of GATEWAY_PORTS) {
      await fw([tool, "-A", "AEGIS_ALLOW", "-d", "127.0.0.1/32", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"]);
    }
    if (ENFORCE_DEFAULT === "deny") {
      await fw([tool, "-A", "OUTPUT", "-m", "owner", "--uid-owner", AGENT_UID, "-j", "REJECT",
        "--reject-with", tool === "ip6tables" ? "icmp6-port-unreachable" : "icmp-port-unreachable"]);
    }
  }
  const gatewayIpv4s = [...new Set([...GATEWAY_IPS, HOST_GATEWAY_IP])]
    .filter((ip) => ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  for (const ip of gatewayIpv4s) {
    for (const port of GATEWAY_PORTS) {
      await fw(["iptables", "-A", "AEGIS_ALLOW", "-d", `${ip}/32`, "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"]);
    }
  }
  for (const ip of BLOCK_IPS) await blockIp(ip);
  emit("lifecycle", { kind: "enforce_active", default: ENFORCE_DEFAULT, blockedIps: BLOCK_IPS, allowedDomains: ALLOW_DOMAINS });
}

/* ------------------------------- DNS sniffing ------------------------------- */

function parseQuestionName(buf) {
  // Minimal QNAME extraction: labels start at offset 12 of the query section.
  // `end` is the start of the answer section: past the name, QTYPE, QCLASS.
  let offset = 12;
  const labels = [];
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) { offset += 1; break; }
    if (len & 0xc0) { offset += 1; break; } // compression pointer: stop
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString("ascii"));
    offset += 1 + len;
  }
  return { name: labels.join(".").toLowerCase(), end: offset + 4 };
}

function parseAnswerIps(buf, answersStart) {
  // Walk the answer section (starting at answersStart, already past the
  // question section) collecting A (1) and AAAA (28) RDATA values.
  const ips = [];
  try {
    let offset = answersStart;
    const ancount = buf.readUInt16BE(6);
    for (let i = 0; i < ancount && offset + 12 <= buf.length; i++) {
      if (buf[offset] & 0xc0) offset += 2;
      else { while (offset < buf.length && buf[offset] !== 0) offset += 1 + buf[offset]; offset += 1; }
      const type = buf.readUInt16BE(offset);
      const rdlength = buf.readUInt16BE(offset + 8);
      const rdata = offset + 10;
      if (type === 1 && rdlength === 4) {
        ips.push(Array.from(buf.subarray(rdata, rdata + 4)).join("."));
      } else if (type === 28 && rdlength === 16) {
        const parts = [];
        for (let j = 0; j < 16; j += 2) parts.push(buf.readUInt16BE(rdata + j).toString(16));
        ips.push(parts.join(":"));
      }
      offset = rdata + rdlength;
    }
  } catch { /* malformed packet: relay anyway */ }
  return ips;
}

function domainMatches(name, list) {
  return list.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

function startDns() {
  const server = dgram.createSocket("udp4");

  server.on("message", (message, addr) => {
    let name = "";
    let questionEnd = 12;
    try {
      const parsed = parseQuestionName(message);
      name = parsed.name;
      questionEnd = parsed.end;
    } catch { /* relay anyway */ }
    if (name && !name.endsWith(".in-addr.arpa") && shouldEmitDns(name)) emit("dns_lookup", { name });

    // One upstream socket per query keeps concurrent clients correctly paired.
    const relay = dgram.createSocket("udp4");
    const timer = setTimeout(() => relay.close(), 5000);
    relay.on("message", async (answer) => {
      clearTimeout(timer);
      try {
        const ips = parseAnswerIps(answer, questionEnd);
        if (name && ips.length && MODE === "enforce") {
          // Install allow/block rules BEFORE the client sees the answer, so
          // the first connect attempt is already governed by policy.
          if (domainMatches(name, ALLOW_DOMAINS)) await Promise.all(ips.map((ip) => allowIp(ip)));
          if (domainMatches(name, BLOCK_DOMAINS)) await Promise.all(ips.map((ip) => blockIp(ip)));
        }
      } catch { /* still relay the answer */ }
      server.send(answer, addr.port, addr.address);
      relay.close();
    });
    relay.on("error", () => { clearTimeout(timer); try { relay.close(); } catch { /* gone */ } });
    relay.bind(0, () => relay.send(message, 53, UPSTREAM_DNS));
  });

  server.on("error", (error) => {
    process.stderr.write(`[aegis-netwatch] dns server error: ${error.message}\n`);
  });
  server.bind(53, "127.0.0.1");
}

/* ----------------------------- connection watch ----------------------------- */

function parseSsLine(line) {
  // ss -tunp columns: Netid State Recv-Q Send-Q Local Peer Process
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 6) return null;
  const state = tokens[1];
  const peerRaw = tokens[5];
  const processInfo = tokens.slice(6).join(" ");
  const lastColon = peerRaw.lastIndexOf(":");
  if (lastColon === -1) return null;
  const peer = peerRaw.slice(0, lastColon).replace(/^\[|\]$/g, "");
  const peerPort = Number(peerRaw.slice(lastColon + 1));
  const pidMatch = processInfo.match(/pid=(\d+)/);
  const nameMatch = processInfo.match(/\(\("([^"]+)"/);
  return { state: state.toLowerCase(), local: tokens[4], peer, peerPort, pid: pidMatch ? Number(pidMatch[1]) : undefined, process: nameMatch ? nameMatch[1] : undefined };
}

const seenConnections = new Set();
const recentDns = new Map(); // name -> last emit ts (dedupe A/AAAA bursts)
const WATCHED_STATES = new Set(["estab", "established", "syn-sent", "time-wait", "close-wait", "fin-wait-1", "fin-wait-2", "last-ack", "close"]);
let channelPeer = ""; // host:port of the event channel itself, excluded from events

function shouldEmitDns(name) {
  const now = Date.now();
  const last = recentDns.get(name) || 0;
  if (now - last < 700) return false;
  recentDns.set(name, now);
  return true;
}

function pollConnections() {
  execFile("ss", ["-tunp"], (error, stdout) => {
    if (error) return;
    for (const line of stdout.split("\n").slice(1)) {
      const info = parseSsLine(line);
      if (!info) continue;
      // TIME_WAIT and friends outlive even sub-second connections, so a
      // missed ESTABLISHED socket is still caught on a later poll.
      if (!WATCHED_STATES.has(info.state)) continue;
      if (info.peer === "127.0.0.1" || info.peer === "::1" || info.peer === "*") continue;
      if (info.pid === process.pid) continue; // netwatch's own sockets
      const peerKey = `${info.peer}:${info.peerPort}`;
      if (channelPeer && peerKey === channelPeer) continue; // supervisor -> service channel
      const key = `${peerKey}|${info.pid || 0}`;
      if (seenConnections.has(key)) continue;
      seenConnections.add(key);
      emit("net_connect", {
        peer: info.peer,
        peerPort: info.peerPort,
        process: info.process,
        pid: info.pid,
        state: info.state,
      });
    }
  });
}

/* ----------------------------------- main ----------------------------------- */

async function main() {
  try {
    if (EVENT_URL) {
      const url = new URL(EVENT_URL);
      const host = url.hostname;
      // The event channel usually rides host.docker.internal; read the IP the
      // runtime injected into our own /etc/hosts.
      let ip = host;
      if (host.includes("host.docker.internal")) {
        if (HOST_GATEWAY_IP) {
          ip = HOST_GATEWAY_IP;
        } else {
          try {
            const hosts = fs.readFileSync("/etc/hosts", "utf8");
            const entry = hosts.split("\n").find((l) => l.includes("host.docker.internal"));
            ip = entry ? entry.trim().split(/\s+/)[0] : host;
          } catch { /* fall back to the hostname */ }
        }
      }
      channelPeer = `${ip}:${url.port || 80}`;
    }
  } catch { /* best effort */ }

  startDns();
  setInterval(pollConnections, 300);
  pollConnections();
  if (MODE === "enforce") await setupEnforce();
  process.stderr.write(`[aegis-netwatch] watching sandbox ${SANDBOX_ID} (mode=${MODE}, default=${ENFORCE_DEFAULT})\n`);
}

main().catch((error) => {
  process.stderr.write(`[aegis-netwatch] fatal: ${error.message}\n`);
  process.exit(1);
});
