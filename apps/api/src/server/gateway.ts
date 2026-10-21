import { cors } from "hono/cors";
import { Hono } from "hono";
import type { Context } from "hono";
import { makeId, writeAudit } from "./audit";
import { createPolicyEvaluator, normalizePolicyDecision } from "./policy";
import { createStore } from "./store";
import { analyzeAction, executeAction } from "../enterprise/executor";
import { enterpriseCounts, listBilling, listCustomers, queryEnterprise } from "../enterprise/data";
import { ensureRepo, gitDiff, gitLog, gitStatus } from "../enterprise/git";
import { pendingActionsFor } from "../enterprise/pending";
import { ensureBucket, listObjects } from "../enterprise/storage";
import { hostTelemetry, scanSecrets } from "../enterprise/telemetry";
import {
  callMcpTool,
  closeMcpClient,
  completeMcpOAuth,
  discoverMcpConnection,
  getMcpOAuthStatus,
  getMcpClient,
  getMcpConnectionRegistry,
  mcpClientConfig,
  mcpOAuthErrorMessage,
  startMcpOAuth,
  mcpJsonRpcError,
  testMcpConnection,
  type McpConnectionInput,
} from "./mcp";
import type {
  ActionRecord,
  ActionRequest,
  ActionStatus,
  PolicyOutcome,
  SentinelEnvironment,
  SentinelGatewayOptions,
  SentinelStore,
} from "./types";

type GatewayEnv = { Variables: { requestId: string } };

class GatewayError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 422 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function limitFrom(value: string | undefined): number {
  const parsed = Number(value ?? 100);
  return Number.isFinite(parsed) ? Math.min(500, Math.max(1, Math.floor(parsed))) : 100;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(422, "invalid_body", message);
  return value as Record<string, unknown>;
}

async function jsonBody(c: Context<GatewayEnv>): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new GatewayError(415, "json_required", "Send a JSON request body with Content-Type: application/json.");
  }
  try {
    return asObject(await c.req.json(), "The request body must be a JSON object.");
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

async function optionalJsonBody(c: Context<GatewayEnv>): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type") && !c.req.header("content-length")) return {};
  return jsonBody(c);
}

function stringField(body: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new GatewayError(422, "invalid_body", `${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > 500) throw new GatewayError(422, "invalid_body", `${key} must be a string of at most 500 characters.`);
  return value;
}

function bearerToken(c: Context<GatewayEnv>, header = "authorization"): string | undefined {
  const authorization = c.req.header(header);
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim() || undefined;
  return authorization?.trim() || undefined;
}

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
  return result === 0;
}

function configuredOrigins(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : (value || "").split(",");
  return values.map((origin) => origin.trim()).filter((origin) => origin && origin !== "*");
}

function recordRequest(body: Record<string, unknown>, idFactory: () => string): ActionRequest & { id: string } {
  const action = stringField(body, "action", true) as string;
  const id = stringField(body, "id") || idFactory();
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(id)) throw new GatewayError(422, "invalid_body", "id must contain only letters, numbers, dot, underscore, colon, or hyphen.");
  const metadata = body.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new GatewayError(422, "invalid_body", "metadata must be a JSON object.");
  }
  return {
    id,
    action,
    actorId: stringField(body, "actorId"),
    resource: stringField(body, "resource"),
    payload: body.payload,
    metadata: metadata as Record<string, unknown> | undefined,
  };
}

function statusForOutcome(outcome: PolicyOutcome): ActionStatus {
  if (outcome === "allow") return "allowed";
  if (outcome === "require_approval") return "pending_approval";
  if (outcome === "block") return "blocked";
  return "frozen";
}

function eventTypeForStatus(status: ActionStatus): "action.intercepted" | "action.approved" | "action.blocked" | "action.frozen" | "action.unfrozen" {
  if (status === "approved") return "action.approved";
  if (status === "blocked") return "action.blocked";
  if (status === "frozen") return "action.frozen";
  if (status === "pending_approval") return "action.unfrozen";
  return "action.intercepted";
}

async function transition(
  store: SentinelStore,
  action: ActionRecord,
  status: ActionStatus,
  now: () => Date,
  requestId: string,
  actorId: string | undefined,
  reason: string,
  note?: string,
): Promise<ActionRecord> {
  const fromStatus = action.status;
  const updated: ActionRecord = {
    ...action,
    status,
    updatedAt: nowIso(now),
    resolutionNote: note || action.resolutionNote,
    ...(status === "approved" ? { approvedAt: nowIso(now), approvedBy: actorId || "system" } : {}),
  };
  await store.putAction(updated);
  await writeAudit(store, {
    type: eventTypeForStatus(status),
    action: updated,
    fromStatus,
    toStatus: status,
    actorId,
    reason,
    requestId,
    timestamp: updated.updatedAt,
  });
  return updated;
}

export function createSentinelGate(options: SentinelGatewayOptions = {}) {
  const env: SentinelEnvironment = options.env || (typeof process !== "undefined" ? (process.env as SentinelEnvironment) : {});
  const store = options.store || createStore(env, { fetchImpl: options.fetchImpl, namespace: options.redisNamespace });
  const evaluate = createPolicyEvaluator(env, { fetchImpl: options.fetchImpl, evaluator: options.policyEvaluator });
  const idFactory = options.idFactory || (() => makeId("act"));
  const now = options.now || (() => new Date());
  const app = new Hono<GatewayEnv>();
  const pending = pendingActionsFor(store);
  const mcpConnections = getMcpConnectionRegistry();
  const adminToken = env.SENTINEL_ADMIN_TOKEN?.trim() || undefined;
  const originAllowlist = configuredOrigins(options.cors && typeof options.cors === "object" ? options.cors.origin : undefined).concat(
    configuredOrigins(env.SENTINEL_CORS_ORIGIN),
  );

  const isAllowedOrigin = (origin: string): boolean => {
    if (originAllowlist.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && (parsed.protocol === "http:" || parsed.protocol === "https:");
    } catch { return false; }
  };

  if (options.cors !== false) {
    const origin = (requestOrigin: string) => isAllowedOrigin(requestOrigin) ? requestOrigin : undefined;
    app.use("*", cors({
      origin,
      allowHeaders: options.cors?.allowHeaders || ["Content-Type", "Authorization", "X-Request-ID", "X-MCP-Connection-Token", "X-Sentinel-Admin-Token"],
      allowMethods: options.cors?.allowMethods || ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 86_400,
    }));
  }

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") || makeId("req");
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: { code: "origin_not_allowed", message: "The request origin is not allowed." }, requestId: c.get("requestId") }, 403);
    }
    if (c.req.method === "OPTIONS" || c.req.path === "/health" || c.req.path === "/api/v1/health") return next();
    const pathParts = c.req.path.split("/").filter(Boolean);
    const isOAuthCallback = pathParts.length >= 4 && pathParts[pathParts.length - 2] === "oauth" && pathParts[pathParts.length - 1] === "callback";
    if (isOAuthCallback) return next();
    const mcpIndex = pathParts.indexOf("mcp");
    const connectionId = mcpIndex >= 0 && pathParts[mcpIndex + 1] && pathParts[mcpIndex + 1] !== "connections"
      ? pathParts[mcpIndex + 1]
      : undefined;
    const suppliedAdmin = bearerToken(c) || c.req.header("x-sentinel-admin-token")?.trim();
    const suppliedConnection = bearerToken(c, "x-mcp-connection-token") || c.req.header("x-mcp-connection-token")?.trim();
    if (connectionId) {
      const isConnVerified = await mcpConnections.verifyToken(connectionId, suppliedConnection || suppliedAdmin);
      const authorized = (adminToken && safeEqual(adminToken, suppliedAdmin)) || isConnVerified;
      if (!authorized) {
        return c.json(mcpJsonRpcError(null, -32001, "MCP authentication required."), 401);
      }
      return next();
    }
    if (adminToken && !safeEqual(adminToken, suppliedAdmin)) {
      throw new GatewayError(401, "authentication_required", "A valid SentinelGate admin bearer token is required.");
    }
    return next();
  });

  app.onError((error, c) => {
    const requestId = c.get("requestId");
    const gatewayError = error instanceof GatewayError ? error : undefined;
    const status = gatewayError?.status || 503;
    const code = gatewayError?.code || "gateway_error";
    const message = gatewayError?.message || "SentinelGate could not complete the request.";
    if (!gatewayError) console.error(`[SentinelGate ${requestId}]`, error);
    return c.json({ error: { code, message, ...(gatewayError?.details === undefined ? {} : { details: gatewayError.details }) }, requestId }, status);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "SentinelGate route not found." }, requestId: c.get("requestId") }, 404));

  app.get("/health", (c) => c.json({ ok: true, service: "sentinelgate", timestamp: nowIso(now) }));

  const intercept = async (c: Context<GatewayEnv>) => {
    const body = await jsonBody(c);
    const request = recordRequest(body, idFactory);
    if (await store.getAction(request.id)) throw new GatewayError(409, "duplicate_action", `Action ${request.id} already exists.`);

    const decision = normalizePolicyDecision(await evaluate(request));
    const status = statusForOutcome(decision.outcome);
    const timestamp = nowIso(now);
    const analysis = await analyzeAction(request);
    const action: ActionRecord = { ...request, status, decision, analysis, createdAt: timestamp, updatedAt: timestamp };
    await store.putAction(action);
    await writeAudit(store, {
      type: "action.intercepted",
      action,
      toStatus: status,
      actorId: request.actorId,
      reason: decision.reason,
      requestId: c.get("requestId"),
      timestamp,
    });
    let resolved = action;
    if (status === "blocked") {
      return c.json({ ok: false, action, decision, error: { code: "blocked", message: action.resolutionNote || decision.reason }, requestId: c.get("requestId") }, 403);
    }
    if (status === "pending_approval" || status === "frozen") {
      resolved = await pending.waitForResolution(action.id, Number(env.SENTINEL_HITL_TIMEOUT_MS) || 120_000) || action;
      if (resolved.status === "pending_approval" || resolved.status === "frozen") return c.json({ ok: false, action: resolved, decision, error: { code: "approval_timeout", message: "Human approval timed out; action remains pending." }, requestId: c.get("requestId") }, 202);
      if (resolved.status === "blocked") {
        return c.json({ ok: false, action: resolved, decision, error: { code: resolved.status, message: resolved.resolutionNote || "SentinelGate rejected this action." }, requestId: c.get("requestId") }, 403);
      }
    }
    const shouldExecute = Boolean((resolved.metadata as Record<string, unknown> | undefined)?.executeOnResolve);
    if (shouldExecute && (resolved.status === "allowed" || resolved.status === "approved")) {
      const execution = await executeAction(resolved, { dryRun: false, fetchImpl: options.fetchImpl });
      resolved = { ...resolved, execution, updatedAt: nowIso(now) };
      await store.putAction(resolved);
      return c.json({ ok: execution.executed, action: resolved, decision: resolved.decision, execution, requestId: c.get("requestId") }, execution.error ? 422 : 200);
    }
    return c.json({ ok: true, action: resolved, decision: resolved.decision, requestId: c.get("requestId") }, 200);
  };

  app.post("/actions/intercept", intercept);
  app.post("/actions", intercept);
  app.post("/intercept", intercept);

  app.get("/actions", async (c) => c.json({ actions: await store.listActions(limitFrom(c.req.query("limit"))), requestId: c.get("requestId") }));
  app.get("/actions/:id", async (c) => {
    const action = await store.getAction(c.req.param("id"));
    if (!action) throw new GatewayError(404, "action_not_found", "Action not found.");
    return c.json({ action, requestId: c.get("requestId") });
  });
  app.get("/audit", async (c) => c.json({ events: await store.listAudit(limitFrom(c.req.query("limit")), c.req.query("actionId")), requestId: c.get("requestId") }));

  // Enterprise explorer routes backed by Cloudflare D1
  app.get("/explorer/customers", async (c) => c.json({ rows: await listCustomers(limitFrom(c.req.query("limit"))), requestId: c.get("requestId") }));
  app.get("/explorer/billing", async (c) => c.json({ rows: await listBilling(limitFrom(c.req.query("limit"))), requestId: c.get("requestId") }));
  app.get("/explorer/sql", async (c) => c.json({ result: await queryEnterprise(c.req.query("sql") || "SELECT * FROM CUSTOMERS LIMIT 25"), requestId: c.get("requestId") }));
  app.get("/explorer/s3", async (c) => c.json({ bucket: c.req.query("bucket") || "customer-pii", objects: await listObjects(c.req.query("bucket") || "customer-pii", c.req.query("prefix") || ""), requestId: c.get("requestId") }));
  app.get("/explorer/git", async (c) => c.json({ status: await gitStatus(), diff: await gitDiff(), log: await gitLog(), requestId: c.get("requestId") }));
  app.get("/explorer/host", (c) => c.json({ telemetry: hostTelemetry(), requestId: c.get("requestId") }));
  app.get("/explorer/secrets", async (c) => c.json({ findings: await scanSecrets(typeof c.req.query("root") === "string" ? c.req.query("root") : process.cwd()), requestId: c.get("requestId") }));
  app.get("/explorer/summary", async (c) => c.json({ databases: await enterpriseCounts(), bucket: { name: "customer-pii", objects: await listObjects("customer-pii") }, repo: await gitStatus(), telemetry: hostTelemetry(), requestId: c.get("requestId") }));

  app.post("/actions/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const current = await store.getAction(id);
    if (!current) throw new GatewayError(404, "action_not_found", "Action not found.");
    const body = await optionalJsonBody(c);
    const requested = stringField(body, "status") || stringField(body, "choice") || stringField(body, "resolution");
    const status: ActionStatus = requested === "approve" || requested === "approved" || requested === "allow" ? "approved" : requested === "block" || requested === "blocked" || requested === "deny" ? "blocked" : requested === "freeze" || requested === "frozen" ? "frozen" : "pending_approval";
    if (status === "pending_approval") throw new GatewayError(422, "invalid_resolution", "status must be approved, blocked, or frozen.");
    if (current.status === status) return c.json({ ok: true, action: current, requestId: c.get("requestId") });
    if (current.status !== "pending_approval" && current.status !== "frozen") throw new GatewayError(409, "invalid_transition", `Action is already ${current.status}.`);
    const actorId = stringField(body, "actorId") || stringField(body, "resolvedBy") || "system";
    const updatedBase = body.payload === undefined ? current : { ...current, payload: body.payload };
    const updated = await transition(store, updatedBase, status, now, c.get("requestId"), actorId, stringField(body, "reason") || `Action resolved as ${status}.`, stringField(body, "note"));
    return c.json({ ok: true, action: updated, requestId: c.get("requestId") });
  });

  app.post("/actions/:id/execute", async (c) => {
    const id = c.req.param("id");
    const action = await store.getAction(id);
    if (!action) throw new GatewayError(404, "action_not_found", "Action not found.");
    const body = await optionalJsonBody(c);
    const dryRun = body.dryRun === undefined ? true : body.dryRun !== false;
    if (!dryRun && action.status !== "approved" && action.status !== "allowed") throw new GatewayError(409, "approval_required", "Only approved or allowed actions may execute.");
    const execution = await executeAction(action, { dryRun, fetchImpl: options.fetchImpl });
    const updated = { ...action, execution, updatedAt: nowIso(now) };
    await store.putAction(updated);
    return c.json({ ok: execution.executed || execution.dryRun, action: updated, execution, requestId: c.get("requestId") }, execution.error ? 422 : 200);
  });

  app.get("/actions/:id/wait", async (c) => {
    const resolved = await pending.waitForResolution(c.req.param("id"), Number(c.req.query("timeoutMs")) || 30_000);
    return c.json({ resolved: Boolean(resolved), action: resolved, requestId: c.get("requestId") }, resolved ? 200 : 202);
  });

  app.get("/stream", (c) => {
    const encoder = new TextEncoder();
    let unsubscribe: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        send("ready", { timestamp: nowIso(now) });
        unsubscribe = pending.subscribe((action, type = "action.updated") => send(type, { action, timestamp: nowIso(now) }));
        heartbeat = setInterval(() => send("heartbeat", { timestamp: nowIso(now) }), 15_000);
      },
      cancel() { unsubscribe(); if (heartbeat) clearInterval(heartbeat); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
  });

  // MCP connection registry and proxy
  const mcpBody = async (c: Context<GatewayEnv>): Promise<Record<string, unknown>> => {
    try {
      const value = await c.req.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new GatewayError(400, "invalid_json", "The request body must be a JSON object.");
    }
  };
  const connectionInput = (body: Record<string, unknown>): McpConnectionInput => ({
    name: body.name as string,
    transport: body.transport as McpConnectionInput["transport"],
    command: body.command as string | undefined,
    args: body.args as string[] | undefined,
    cwd: body.cwd as string | undefined,
    url: body.url as string | undefined,
    env: body.env as Record<string, string> | undefined,
    headers: body.headers as Record<string, string> | undefined,
    secrets: body.secrets as Record<string, string> | undefined,
    metadata: body.metadata as Record<string, unknown> | undefined,
  });

  const listConnections = async (c: Context<GatewayEnv>) => c.json({ connections: await mcpConnections.list(), requestId: c.get("requestId") });
  const createConnection = async (c: Context<GatewayEnv>) => {
    try {
      const created = await mcpConnections.create(connectionInput(await mcpBody(c)));
      const { token, ...connection } = created;
      return c.json({ connection, token, requestId: c.get("requestId") }, 201);
    } catch (error) {
      throw new GatewayError(422, "invalid_connection", error instanceof Error ? error.message : "Invalid MCP connection.");
    }
  };
  app.get("/connections", listConnections);
  app.post("/connections", createConnection);
  app.get("/mcp/connections", listConnections);
  app.post("/mcp/connections", createConnection);
  app.get("/connections/:id", async (c) => {
    const connection = await mcpConnections.get(c.req.param("id"));
    if (!connection) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    return c.json({ connection, requestId: c.get("requestId") });
  });
  app.get("/mcp/connections/:id", async (c) => {
    const connection = await mcpConnections.get(c.req.param("id"));
    if (!connection) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    return c.json({ connection, requestId: c.get("requestId") });
  });
  const updateConnection = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    try {
      const body = await mcpBody(c);
      const patch = Object.fromEntries(Object.entries(connectionInput(body)).filter(([, value]) => value !== undefined)) as Partial<McpConnectionInput>;
      const connection = await mcpConnections.update(connectionId, patch);
      if (!connection) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
      return c.json({ connection, requestId: c.get("requestId") });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(422, "invalid_connection", error instanceof Error ? error.message : "Invalid MCP connection.");
    }
  };
  const deleteConnection = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId || !(await mcpConnections.get(connectionId))) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    await closeMcpClient(connectionId);
    if (!(await mcpConnections.delete(connectionId))) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    return c.json({ ok: true, requestId: c.get("requestId") });
  };
  app.put("/connections/:id", updateConnection);
  app.patch("/connections/:id", updateConnection);
  app.delete("/connections/:id", deleteConnection);
  app.put("/mcp/connections/:id", updateConnection);
  app.patch("/mcp/connections/:id", updateConnection);
  app.delete("/mcp/connections/:id", deleteConnection);
  const discoverConnection = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    try { return c.json({ discovery: await discoverMcpConnection(connectionId, env, options.fetchImpl), requestId: c.get("requestId") }); }
    catch (error) { throw new GatewayError(502, "upstream_error", error instanceof Error ? error.message : "MCP discovery failed."); }
  };
  const testConnection = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    try { return c.json({ result: await testMcpConnection(connectionId, env, options.fetchImpl), requestId: c.get("requestId") }); }
    catch (error) { throw new GatewayError(502, "upstream_error", error instanceof Error ? error.message : "MCP connection test failed."); }
  };
  const clientConfig = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    const connection = await mcpConnections.get(connectionId);
    if (!connection) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    const origin = new URL(c.req.url).origin;
    const token = await mcpConnections.rotateToken(connection.id);
    return c.json({ config: mcpClientConfig(connection.id, `${origin}/api/v1`, token || undefined), token, requestId: c.get("requestId") });
  };
  app.post("/connections/:id/test", testConnection);
  app.post("/connections/:id/discover", discoverConnection);
  app.get("/connections/:id/discover", discoverConnection);
  app.get("/connections/:id/client-config", clientConfig);
  app.post("/connections/:id/client-config", clientConfig);
  app.get("/connections/:id/config", clientConfig);
  app.post("/mcp/connections/:id/test", testConnection);
  app.post("/mcp/connections/:id/discover", discoverConnection);
  app.get("/mcp/connections/:id/discover", discoverConnection);
  app.get("/mcp/connections/:id/client-config", clientConfig);
  app.post("/mcp/connections/:id/client-config", clientConfig);
  app.get("/mcp/connections/:id/config", clientConfig);

  const oauthStart = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId || !(await mcpConnections.get(connectionId))) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    const body = await optionalJsonBody(c);
    const scope = stringField(body, "scope");
    try {
      const result = await startMcpOAuth(connectionId, {
        env,
        fetchImpl: options.fetchImpl,
        publicUrl: env.SENTINEL_PUBLIC_URL,
        requestUrl: c.req.header("x-sentinel-original-url") || c.req.url,
        scope,
      });
      return c.json({ authorizationUrl: result.authorizationUrl, redirectUri: result.redirectUri, status: result.status, requestId: c.get("requestId") });
    } catch (error) {
      throw new GatewayError(422, "oauth_start_failed", mcpOAuthErrorMessage(error));
    }
  };
  const oauthStatus = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    try { return c.json({ status: await getMcpOAuthStatus(connectionId, { env, fetchImpl: options.fetchImpl }), requestId: c.get("requestId") }); }
    catch (error) { throw new GatewayError(404, "connection_not_found", error instanceof Error ? error.message : "MCP connection not found."); }
  };
  const oauthCallback = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("id");
    if (!connectionId) throw new GatewayError(404, "connection_not_found", "MCP connection not found.");
    try {
      const result = await completeMcpOAuth(connectionId, {
        state: c.req.query("state"),
        code: c.req.query("code"),
        error: c.req.query("error"),
        errorDescription: c.req.query("error_description"),
        issuer: c.req.query("iss"),
      }, { env, fetchImpl: options.fetchImpl, requestUrl: c.req.header("x-sentinel-original-url") || c.req.url });
      return c.json({ ok: true, status: result.status, requestId: c.get("requestId") });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "OAuth callback could not be completed.";
      const message = /state|redirect|issuer|required/i.test(rawMessage) ? mcpOAuthErrorMessage(error) : "OAuth callback exchange failed.";
      const status = /state|redirect|issuer|required/.test(message) ? 400 : 502;
      return c.json({ error: { code: "oauth_callback_failed", message }, requestId: c.get("requestId") }, status as 400 | 502);
    }
  };
  app.post("/connections/:id/oauth/start", oauthStart);
  app.get("/connections/:id/oauth/status", oauthStatus);
  app.get("/connections/:id/oauth/callback", oauthCallback);
  app.post("/mcp/connections/:id/oauth/start", oauthStart);
  app.get("/mcp/connections/:id/oauth/status", oauthStatus);
  app.get("/mcp/connections/:id/oauth/callback", oauthCallback);

  const mcpProxy = async (c: Context<GatewayEnv>) => {
    const connectionId = c.req.param("connectionId");
    if (!connectionId) return c.json(mcpJsonRpcError(null, -32001, "MCP connection not found."), 404);
    if (!(await mcpConnections.get(connectionId))) return c.json(mcpJsonRpcError(null, -32001, "MCP connection not found."), 404);
    let request: Record<string, unknown>;
    try { request = await c.req.json() as Record<string, unknown>; }
    catch { return c.json(mcpJsonRpcError(null, -32700, "Parse error."), 400); }
    const requestId = request.id;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return c.json(mcpJsonRpcError(requestId, -32600, "Invalid Request."), 400);
    if (requestId === undefined && request.method.startsWith("notifications/")) return c.body(null, 202);
    try {
      if (request.method === "initialize") {
        const upstream = await getMcpClient(connectionId, env, options.fetchImpl);
        return c.json({ jsonrpc: "2.0", id: requestId ?? null, result: { protocolVersion: "2024-11-05", capabilities: upstream.getServerCapabilities() || { tools: { listChanged: false } }, serverInfo: upstream.getServerVersion() || { name: "sentinelgate-proxy", version: "0.1.0" }, ...(upstream.getInstructions() ? { instructions: upstream.getInstructions() } : {}) } });
      }
      if (request.method === "ping") return c.json({ jsonrpc: "2.0", id: requestId ?? null, result: {} });
      if (request.method === "tools/list") {
        const discovery = await discoverMcpConnection(connectionId, env, options.fetchImpl);
        return c.json({ jsonrpc: "2.0", id: requestId ?? null, result: { tools: discovery.tools || [] } });
      }
      if (request.method === "tools/call") {
        const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
        const name = typeof params.name === "string" ? params.name : "";
        if (!name) return c.json(mcpJsonRpcError(requestId, -32602, "tools/call requires params.name."), 400);
        const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
        const actionRequest: ActionRequest & { id: string } = { id: idFactory(), action: `mcp:${name}`, actorId: c.req.header("x-mcp-client") || "mcp-client", resource: `mcp://${connectionId}/${name}`, payload: { connectionId, tool: name, arguments: args }, metadata: { mcp: true, connectionId, executeOnResolve: false } };
        const decision = normalizePolicyDecision(await evaluate(actionRequest));
        let status = statusForOutcome(decision.outcome);
        const timestamp = nowIso(now);
        const analysis = await analyzeAction(actionRequest);
        let action: ActionRecord = { ...actionRequest, status, decision, analysis, createdAt: timestamp, updatedAt: timestamp };
        await store.putAction(action);
        await writeAudit(store, { type: "action.intercepted", action, toStatus: status, actorId: action.actorId, reason: decision.reason, requestId: c.get("requestId"), timestamp });
        if (status === "blocked") return c.json(mcpJsonRpcError(requestId, -32003, decision.reason, { actionId: action.id, status }), 403);
        if (status === "pending_approval" || status === "frozen") {
          const resolved = await pending.waitForResolution(action.id, Number(env.SENTINEL_HITL_TIMEOUT_MS) || 120_000);
          if (!resolved) return c.json(mcpJsonRpcError(requestId, -32002, "Human approval timed out.", { actionId: action.id, status }), 202);
          action = resolved;
          status = action.status;
          if (status === "blocked" || status === "frozen") return c.json(mcpJsonRpcError(requestId, -32003, action.resolutionNote || "MCP tool call was not approved.", { actionId: action.id, status }), 403);
        }
        const result = await callMcpTool(connectionId, name, args, env, options.fetchImpl);
        return c.json({ jsonrpc: "2.0", id: requestId ?? null, result });
      }
      return c.json(mcpJsonRpcError(requestId, -32601, `Method not found: ${request.method}`), 404);
    } catch (error) {
      return c.json(mcpJsonRpcError(requestId, -32000, error instanceof Error ? error.message : "MCP upstream request failed."), 502);
    }
  };
  app.post("/mcp/:connectionId", mcpProxy);
  app.get("/mcp/:connectionId", (c) => new Response(`event: ready\ndata: ${JSON.stringify({ connectionId: c.req.param("connectionId") })}\n\n`, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }));

  const approve = async (c: Context<GatewayEnv>) => {
    const id = c.req.param("id");
    if (!id) throw new GatewayError(404, "action_not_found", "Action not found.");
    const current = await store.getAction(id);
    if (!current) throw new GatewayError(404, "action_not_found", "Action not found.");
    const body = await optionalJsonBody(c);
    if (current.status === "approved") return c.json({ ok: true, action: current, requestId: c.get("requestId") });
    if (current.status !== "pending_approval") throw new GatewayError(409, "invalid_transition", `Only pending actions can be approved; current status is ${current.status}.`);
    const actorId = stringField(body, "approvedBy") || stringField(body, "actorId") || "system";
    const updated = await transition(store, current, "approved", now, c.get("requestId"), actorId, "Explicit approval received.", stringField(body, "note"));
    return c.json({ ok: true, action: updated, requestId: c.get("requestId") });
  };

  const block = async (c: Context<GatewayEnv>) => {
    const id = c.req.param("id");
    if (!id) throw new GatewayError(404, "action_not_found", "Action not found.");
    const current = await store.getAction(id);
    if (!current) throw new GatewayError(404, "action_not_found", "Action not found.");
    const body = await optionalJsonBody(c);
    if (current.status === "blocked") return c.json({ ok: true, action: current, requestId: c.get("requestId") });
    if (current.status === "approved") throw new GatewayError(409, "invalid_transition", "An approved action cannot be blocked.");
    const actorId = stringField(body, "actorId") || "system";
    const reason = stringField(body, "reason") || "Action blocked by an operator.";
    const updated = await transition(store, current, "blocked", now, c.get("requestId"), actorId, reason);
    return c.json({ ok: true, action: updated, requestId: c.get("requestId") });
  };

  const freeze = async (c: Context<GatewayEnv>) => {
    const id = c.req.param("id");
    if (!id) throw new GatewayError(404, "action_not_found", "Action not found.");
    const current = await store.getAction(id);
    if (!current) throw new GatewayError(404, "action_not_found", "Action not found.");
    const body = await optionalJsonBody(c);
    if (current.status === "frozen") return c.json({ ok: true, action: current, requestId: c.get("requestId") });
    if (current.status === "approved" || current.status === "blocked") throw new GatewayError(409, "invalid_transition", `A ${current.status} action cannot be frozen.`);
    const actorId = stringField(body, "actorId") || "system";
    const reason = stringField(body, "reason") || "Action frozen for review.";
    const updated = await transition(store, current, "frozen", now, c.get("requestId"), actorId, reason);
    return c.json({ ok: true, action: updated, requestId: c.get("requestId") });
  };

  const unfreeze = async (c: Context<GatewayEnv>) => {
    const id = c.req.param("id");
    if (!id) throw new GatewayError(404, "action_not_found", "Action not found.");
    const current = await store.getAction(id);
    if (!current) throw new GatewayError(404, "action_not_found", "Action not found.");
    const body = await optionalJsonBody(c);
    if (current.status !== "frozen") throw new GatewayError(409, "invalid_transition", `Only frozen actions can be unfrozen; current status is ${current.status}.`);
    const actorId = stringField(body, "actorId") || "system";
    const updated = await transition(store, current, "pending_approval", now, c.get("requestId"), actorId, stringField(body, "reason") || "Action returned to approval review.");
    return c.json({ ok: true, action: updated, requestId: c.get("requestId") });
  };

  app.post("/actions/:id/approve", approve);
  app.post("/actions/:id/block", block);
  app.post("/actions/:id/freeze", freeze);
  app.post("/actions/:id/unfreeze", unfreeze);

  return app;
}

export type SentinelGate = ReturnType<typeof createSentinelGate>;
export const createGateway = createSentinelGate;
