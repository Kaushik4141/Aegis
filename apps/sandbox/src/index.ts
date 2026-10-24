import { serve } from "@hono/node-server";
import { Hono } from "hono";
import path from "node:path";
import { WebSocketServer } from "ws";
import { dockerAvailable, execShell } from "./docker";
import { GatewayClient } from "./gatewayClient";
import { Orchestrator } from "./orchestrator";
import type { CreateSandboxInput, SandboxEventInput } from "./types";

const PORT = Number(process.env.AEGIS_SANDBOX_PORT) || 8788;
const DATA_DIR = process.env.AEGIS_SANDBOX_DATA_DIR || path.join(process.cwd(), "data");
// Containers reach this service and the gateway through the docker host gateway.
const CONTAINER_EVENT_URL = process.env.AEGIS_SANDBOX_CONTAINER_EVENT_URL || `http://host.docker.internal:${PORT}/internal/events`;
const GATEWAY_FOR_AGENTS = process.env.AEGIS_GATEWAY_INTERNAL_URL || "http://host.docker.internal:8787/api/v1";

const app = new Hono();
const orchestrator = new Orchestrator(DATA_DIR, new GatewayClient(), CONTAINER_EVENT_URL, GATEWAY_FOR_AGENTS);

app.get("/health", async (c) => c.json({ ok: true, docker: await dockerAvailable() }));

app.post("/sandboxes", async (c) => {
  const body = await c.req.json().catch(() => null) as CreateSandboxInput | null;
  if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
  try {
    const record = await orchestrator.create(body);
    return c.json({ sandbox: record }, 201);
  } catch (error) {
    return c.json({ error: "sandbox_create_failed", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.get("/sandboxes", (c) => c.json({ sandboxes: orchestrator.list() }));

app.get("/sandboxes/:id", (c) => {
  const record = orchestrator.get(c.req.param("id"));
  return record ? c.json({ sandbox: record }) : c.json({ error: "sandbox_not_found" }, 404);
});

app.get("/sandboxes/:id/logs", (c) => {
  const logs = orchestrator.logs(c.req.param("id"));
  return logs ? c.json({ logs }) : c.json({ error: "sandbox_not_found" }, 404);
});

app.get("/sandboxes/:id/events", (c) => {
  const limit = Math.min(2000, Math.max(1, Number(c.req.query("limit")) || 500));
  const type = c.req.query("type");
  const events = orchestrator.events(c.req.param("id"), limit);
  if (!events) return c.json({ error: "sandbox_not_found" }, 404);
  return c.json({ events: type ? events.filter((event) => event.type === type) : events });
});

app.post("/sandboxes/:id/stop", async (c) => {
  const record = await orchestrator.stop(c.req.param("id"));
  return record ? c.json({ sandbox: record }) : c.json({ error: "sandbox_not_found" }, 404);
});

app.post("/sandboxes/:id/restart", async (c) => {
  const record = await orchestrator.restart(c.req.param("id"));
  return record ? c.json({ sandbox: record }) : c.json({ error: "sandbox_not_restartable" }, 404);
});

app.delete("/sandboxes/:id", async (c) => {
  const ok = await orchestrator.remove(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "sandbox_not_found" }, 404);
});

/** Event channel used by the in-container supervisor and netwatch sidecar. */
app.post("/internal/events", async (c) => {
  const body = await c.req.json().catch(() => null) as { sandboxId?: string; events?: SandboxEventInput[]; dropped?: number } | null;
  if (!body?.sandboxId || !Array.isArray(body.events)) return c.json({ error: "invalid_body" }, 400);
  const ok = await orchestrator.ingest(body.sandboxId, body.events, body.dropped);
  return ok ? c.json({ ok: true }) : c.json({ error: "sandbox_not_found" }, 404);
});

if (!(await dockerAvailable())) {
  console.error("[sandbox] Docker is not available; sandboxes cannot start. Install/start Docker and retry.");
  process.exit(1);
}

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[sandbox] Aegis sandbox service listening on http://127.0.0.1:${info.port}`);
  console.log(`[sandbox] gateway for agents: ${GATEWAY_FOR_AGENTS}`);
});

// Interactive workspaces outlive the service: reattach to labeled containers.
void orchestrator.adoptExisting().then((count) => {
  if (count > 0) console.log(`[sandbox] adopted ${count} running sandbox container(s)`);
});

/**
 * Terminal channel: WebSocket at /sandboxes/:id/terminal. Client sends JSON
 * text frames {t:"i",d:"..."} for input and {t:"r",w,h} for resize; the
 * server streams raw PTY output back as binary frames.
 */
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const match = request.url?.match(/^\/sandboxes\/([^/]+)\/terminal$/);
  if (!match) { socket.destroy(); return; }
  const id = decodeURIComponent(match[1]);
  const record = orchestrator.get(id);
  if (!record || record.status !== "running" || !record.interactive) { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => {
    let session: Awaited<ReturnType<typeof execShell>> | undefined;
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      void session?.kill();
      ws.close();
    };
    void execShell(id, {
      onOutput: (chunk) => { if (!closed) ws.send(chunk); },
      onExit: teardown,
    }).then((created) => {
      if (closed) { void created.kill(); return; }
      session = created;
      ws.on("message", (data, isBinary) => {
        if (isBinary || !session) return;
        try {
          const message = JSON.parse(String(data)) as { t?: string; d?: string; w?: number; h?: number };
          if (message.t === "i" && typeof message.d === "string") session.write(message.d);
          else if (message.t === "r" && typeof message.w === "number" && typeof message.h === "number") void session.resize(message.w, message.h);
        } catch { /* ignore malformed control frames */ }
      });
      ws.on("close", teardown);
      ws.on("error", teardown);
    }).catch((error) => {
      console.error("[sandbox] terminal exec failed:", error instanceof Error ? error.message : String(error));
      teardown();
    });
  });
});
