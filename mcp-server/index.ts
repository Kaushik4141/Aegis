import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const gatewayBaseUrl = (process.env.SENTINEL_GATEWAY_URL || "http://localhost:8787/api/v1").replace(/\/$/, "");
const defaultHitlTimeoutMs = 120_000;
const hitlPollTimeoutMs = 10_000;

type JsonObject = Record<string, unknown>;

interface GatewayResponse {
  status: number;
  body: JsonObject;
}

interface GatewayAction {
  id?: string;
  status?: string;
  decision?: { reason?: string; outcome?: string };
  execution?: { executed?: boolean; error?: string; [key: string]: unknown };
  [key: string]: unknown;
}

function compact<T extends JsonObject>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

async function gitUserEmail(): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["config", "--get", "user.email"], { cwd: process.cwd() });
    const email = result.stdout.trim();
    return email || null;
  } catch {
    return null;
  }
}

async function hostMetadata(): Promise<JsonObject> {
  let username: string | null = null;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER || process.env.USERNAME || null;
  }

  return {
    host: {
      username,
      gitEmail: await gitUserEmail(),
      cwd: process.cwd(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      pid: process.pid,
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || null,
      sentinelStore: process.env.SENTINEL_STORE || null,
      isCi: Boolean(process.env.CI),
      gatewayConfigured: Boolean(process.env.SENTINEL_GATEWAY_URL),
      githubConfigured: Boolean(process.env.GITHUB_TOKEN),
      datadogConfigured: Boolean(process.env.DD_API_KEY),
      jevConfigured: Boolean(process.env.JEV_API_KEY),
    },
  };
}

async function callGateway(endpoint: string, init: RequestInit = {}): Promise<GatewayResponse> {
  let response: Response;
  try {
    response = await fetch(`${gatewayBaseUrl}${endpoint}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(process.env.SENTINEL_ADMIN_TOKEN ? { authorization: `Bearer ${process.env.SENTINEL_ADMIN_TOKEN}` } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`SentinelGate gateway is unavailable at ${gatewayBaseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await response.text();
  let body: JsonObject = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonObject;
    } catch {
      body = { raw };
    }
  }
  return { status: response.status, body };
}

function gatewayFailure(response: GatewayResponse, operation: string): Error {
  const error = response.body.error;
  const errorObject = error && typeof error === "object" ? error as JsonObject : undefined;
  const execution = response.body.execution;
  const executionObject = execution && typeof execution === "object" ? execution as JsonObject : undefined;
  const message = typeof errorObject?.message === "string"
    ? errorObject.message
    : typeof executionObject?.error === "string"
      ? executionObject.error
      : typeof response.body.raw === "string"
        ? response.body.raw
        : `Gateway returned HTTP ${response.status}.`;
  const code = typeof errorObject?.code === "string" ? ` (${errorObject.code})` : "";
  const requestId = typeof response.body.requestId === "string" ? ` Request ID: ${response.body.requestId}.` : "";
  return new Error(`${operation} failed${code}: ${message}${requestId}`);
}

function actionFrom(body: JsonObject): GatewayAction {
  const action = body.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("Gateway response did not include an action record.");
  }
  return action as GatewayAction;
}

function hitlTimeoutMs(): number {
  const configured = Number(process.env.MCP_HITL_TIMEOUT_MS || defaultHitlTimeoutMs);
  return Number.isFinite(configured) ? Math.min(300_000, Math.max(1_000, configured)) : defaultHitlTimeoutMs;
}

async function waitForResolution(actionId: string): Promise<GatewayAction> {
  const deadline = Date.now() + hitlTimeoutMs();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const response = await callGateway(`/actions/${encodeURIComponent(actionId)}/wait?timeoutMs=${Math.min(hitlPollTimeoutMs, remaining)}`);
    if (response.status < 200 || response.status >= 300) throw gatewayFailure(response, "Waiting for HITL resolution");
    const action = response.body.action && typeof response.body.action === "object"
      ? response.body.action as GatewayAction
      : undefined;
    if (action && ["approved", "blocked", "frozen", "allowed"].includes(String(action.status))) return action;
  }
  throw new Error(`HITL approval timed out after ${hitlTimeoutMs()}ms. Action ${actionId} remains pending; approve or block it in the SentinelGate dashboard.`);
}

async function executeThroughGateway(action: GatewayAction, toolName: string): Promise<JsonObject> {
  const actionId = typeof action.id === "string" ? action.id : undefined;
  if (!actionId) throw new Error(`Gateway did not return an action id for ${toolName}.`);
  const response = await callGateway(`/actions/${encodeURIComponent(actionId)}/execute`, {
    method: "POST",
    body: JSON.stringify({ dryRun: false }),
  });
  const execution = response.body.execution && typeof response.body.execution === "object"
    ? response.body.execution as JsonObject
    : undefined;
  if (response.status < 200 || response.status >= 300 || execution?.executed !== true) {
    throw gatewayFailure(response, `Executing ${toolName}`);
  }
  return compact({
    tool: toolName,
    requestId: response.body.requestId,
    action: response.body.action,
    decision: action.decision,
    execution,
  });
}

async function runGatewayTool(toolName: string, resource: string, payload: JsonObject): Promise<JsonObject> {
  const metadata = await hostMetadata();
  const username = (metadata.host as JsonObject).username;
  const intercept = await callGateway("/intercept", {
    method: "POST",
    body: JSON.stringify({
      action: toolName,
      actorId: `mcp:${typeof username === "string" ? username : "unknown"}`,
      resource,
      payload,
       metadata: compact({ ...metadata, client: "stdio-mcp", executeOnResolve: true }),
    }),
  });
  if (intercept.status < 200 || intercept.status >= 300) throw gatewayFailure(intercept, `Intercepting ${toolName}`);

  let action = actionFrom(intercept.body);
  const status = String(action.status);
  if (status === "pending_approval") {
    if (typeof action.id !== "string") throw new Error(`Gateway returned a pending ${toolName} action without an id.`);
    action = await waitForResolution(action.id);
  }
  if (action.status === "blocked") {
    throw new Error(`Gateway blocked ${toolName}: ${typeof action.resolutionNote === "string" ? action.resolutionNote : action.decision?.reason || "the policy denied this action."}`);
  }
  if (action.status === "frozen") {
    throw new Error(`Gateway froze ${toolName} for review: ${typeof action.resolutionNote === "string" ? action.resolutionNote : action.decision?.reason || "security review is required."}`);
  }
  if (action.status !== "allowed" && action.status !== "approved") {
    throw new Error(`Gateway did not authorize ${toolName}; action status is ${action.status || "unknown"}.`);
  }
   if (action.execution && action.execution.executed === true) {
     return compact({ tool: toolName, action, decision: action.decision, execution: action.execution });
   }
   return executeThroughGateway(action, toolName);
}

function success(result: JsonObject) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const queryCustomerDwSchema = {
  sql: z.string().min(1).max(10_000).describe("One read or approved write SQL statement for the customer warehouse."),
  user_prompt_context: z.string().max(4000).optional(),
  params: z.array(z.unknown()).optional().describe("Positional SQL parameters."),
};

const s3BucketOperationSchema = {
  action: z.enum(["list", "read", "export_all", "delete"]).describe("Bucket operation to request through SentinelGate."),
  bucket: z.string().default("customer-pii"),
  key: z.string().optional(),
  keys: z.array(z.string()).optional(),
  prefix: z.string().optional(),
  body: z.string().optional().describe("UTF-8 object content for put operations."),
  user_prompt_context: z.string().max(4000).optional(),
};

const githubRepoActionSchema = {
  action: z.enum(["list_repos", "create_issue", "push_code"]),
  repo: z.string().optional(),
  force: z.boolean().optional(),
  payload: z.unknown().optional(),
  user_prompt_context: z.string().max(4000).optional(),
};

const datadogLogTraceSchema = {
  service: z.string().min(1).max(200),
  trace_payload: z.string().max(20_000),
  env_context: z.string().max(4000),
  user_prompt_context: z.string().max(4000).optional(),
  endpoint: z.string().default("https://api.datadoghq.com/api/v1/validate"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  body: z.unknown().optional(),
};

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "sentinelgate-mcp", version: "0.1.0" },
    { instructions: "All enterprise operations are intercepted, policy evaluated, and executed by the local SentinelGate gateway." },
  );

  server.registerTool("query_customer_dw", {
    title: "Query customer data warehouse",
    description: "Run a customer warehouse SQL operation through SentinelGate policy and execution.",
    inputSchema: queryCustomerDwSchema,
  }, async (input) => {
    try {
     return success(await runGatewayTool("query_customer_dw", "customer-data-warehouse", compact({ operation: "query", sql: input.sql, params: input.params, user_prompt_context: input.user_prompt_context })));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("s3_bucket_operation", {
    title: "Operate on an S3 bucket",
    description: "List, read, write, or delete disk-backed S3 objects through SentinelGate policy and execution.",
    inputSchema: s3BucketOperationSchema,
  }, async (input) => {
    try {
       if (input.action !== "list" && input.action !== "export_all" && !input.key && !input.keys?.length) throw new Error(`${input.action} requires key or keys.`);
       return success(await runGatewayTool("s3_bucket_operation", `s3://${input.bucket}`, compact({ ...input, operation: input.action, user_prompt_context: input.user_prompt_context })));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("github_repo_action", {
    title: "Run a GitHub repository action",
    description: "Call a GitHub API repository operation through SentinelGate policy and execution.",
    inputSchema: githubRepoActionSchema,
  }, async (input) => {
    try {
     const endpoint = input.action === "list_repos" ? "/user/repos" : `/repos/${input.repo || ""}/issues`;
     return success(await runGatewayTool("github_repo_action", endpoint, compact({ operation: input.action, endpoint, method: input.action === "create_issue" ? "POST" : "GET", body: input.payload, force: input.force, repo: input.repo, user_prompt_context: input.user_prompt_context })));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("datadog_log_trace", {
    title: "Query Datadog logs or traces",
    description: "Run a Datadog telemetry operation through SentinelGate policy and execution.",
    inputSchema: datadogLogTraceSchema,
  }, async (input) => {
    try {
     return success(await runGatewayTool("datadog_log_trace", input.endpoint, compact({ ...input, operation: "trace", body: input.trace_payload, user_prompt_context: input.user_prompt_context })));
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}

export async function startServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    process.stderr.write(`SentinelGate MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
