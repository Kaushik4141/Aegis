import readline from "node:readline";

// Node 20.6+ can load the project's local .env without adding a runtime
// dependency. Existing shell variables remain the source of truth on older
// Node versions or when a deployment injects its environment directly.
function loadLocalEnv(): void {
  const loader = (process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (!loader) return;
  try { loader.call(process, ".env"); } catch { /* A missing or malformed .env is reported by key selection below. */ }
}

loadLocalEnv();

type JsonObject = Record<string, unknown>;
type ProviderName = "gemini" | "openai" | "anthropic";

interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

interface ToolCall {
  id: string;
  name: string;
  input: JsonObject;
}

interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

interface Completion {
  text: string;
  toolCalls: ToolCall[];
}

interface GatewayResponse {
  status: number;
  body: JsonObject;
}

interface GatewayAction extends JsonObject {
  id?: string;
  status?: string;
  decision?: { reason?: string; outcome?: string };
  resolutionNote?: string;
}

interface ToolResult {
  ok: boolean;
  value: JsonObject;
}

const gatewayBaseUrl = (process.env.SENTINEL_GATEWAY_URL || "http://localhost:8787/api/v1").replace(/\/$/, "");
const defaultHitlTimeoutMs = 120_000;
const hitlPollTimeoutMs = 10_000;
const maxAgentRounds = 8;

/** The same four enterprise capabilities exposed by the SentinelGate MCP server. */
export const sentinelTools: ToolDefinition[] = [
  {
    name: "query_customer_dw",
    description: "Run one customer warehouse SQL operation through SentinelGate policy and execution.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 10_000, description: "One SQL statement for the customer warehouse." },
        params: { type: "array", items: {}, description: "Optional positional SQL parameters." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "s3_bucket_operation",
    description: "List, read, write, or delete disk-backed S3 objects through SentinelGate policy and execution.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "read", "put", "delete"] },
        bucket: { type: "string", default: "customer-pii" },
        key: { type: "string" },
        keys: { type: "array", items: { type: "string" } },
        prefix: { type: "string" },
        body: { type: "string", description: "UTF-8 object content for put operations." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "github_repo_action",
    description: "Run a GitHub repository API operation through SentinelGate policy and execution.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", minLength: 1, maxLength: 200, description: "Human-readable GitHub operation." },
        endpoint: { type: "string", default: "/user/repos", description: "GitHub API path beginning with /." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
        body: {},
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "datadog_log_trace",
    description: "Run a Datadog logs or traces operation through SentinelGate policy and execution.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", minLength: 1, maxLength: 200, description: "Datadog operation, such as query_logs or get_trace." },
        endpoint: { type: "string", default: "https://api.datadoghq.com/api/v1/validate" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
        body: {},
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
];

const toolByName = new Map(sentinelTools.map((tool) => [tool.name, tool]));

const systemPrompt = [
  "You are the Autonomous Enterprise Agent for SentinelGate.",
  "Use the provided tools for enterprise data and operations; never invent rows, files, or execution results.",
  "Every tool is policy-gated by SentinelGate. A blocked or frozen tool call must be reported clearly and must not be retried by changing its intent.",
  "For a pending approval, wait for the gateway result and then continue. Explain real results concisely after the tool calls finish.",
  "Do not ask for credentials, API keys, or direct access. Do not claim to have performed work unless the gateway returned a successful execution result.",
].join(" ");

class ProviderError extends Error {
  constructor(public readonly provider: ProviderName, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

class GatewayError extends Error {
  constructor(message: string, public readonly unavailable = false) {
    super(message);
    this.name = "GatewayError";
  }
}

function compact<T extends JsonObject>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function jsonText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function parseObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch {
      // The caller receives a safe tool error rather than an exception containing model output.
    }
  }
  throw new Error("The model returned invalid tool arguments.");
}

function normalizeProvider(value: string): ProviderName | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "gemini" || normalized === "google") return "gemini";
  if (normalized === "openai") return "openai";
  if (normalized === "anthropic" || normalized === "claude") return "anthropic";
  return undefined;
}

function configuredProviders(): { providers: ProviderName[]; keys: Record<ProviderName, string | undefined> } {
  const keys: Record<ProviderName, string | undefined> = {
    gemini: process.env.GEMINI_API_KEY?.trim() || undefined,
    openai: process.env.OPENAI_API_KEY?.trim() || undefined,
    anthropic: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
  const requested = process.env.AGENT_PROVIDER || process.env.AUTONOMOUS_AGENT_PROVIDER;
  const defaultOrder: ProviderName[] = ["gemini", "openai", "anthropic"];
  let order = defaultOrder;
  if (requested) {
    const parsed = requested.split(",").map(normalizeProvider);
    if (parsed.some((provider) => !provider)) throw new Error(`Unknown AGENT_PROVIDER "${requested}". Use gemini, openai, or anthropic.`);
    order = [...new Set(parsed as ProviderName[])];
    order.push(...defaultOrder.filter((provider) => !order.includes(provider)));
  }
  const providers = order.filter((provider) => Boolean(keys[provider]));
  if (!providers.length) {
    throw new Error("No LLM API key configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY before running npm run agent.");
  }
  return { providers, keys };
}

function modelFor(provider: ProviderName): string {
  if (provider === "gemini") return process.env.GEMINI_MODEL || "gemini-2.0-flash";
  if (provider === "openai") return process.env.OPENAI_MODEL || "gpt-4o-mini";
  return process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
}

async function requestWithTimeout(provider: ProviderName, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AGENT_LLM_TIMEOUT_MS) || 45_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new ProviderError(provider, "network or timeout error");
  } finally {
    clearTimeout(timeout);
  }
}

function openAiTools() {
  return sentinelTools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

function openAiMessages(messages: AgentMessage[]) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((message) => message.role === "tool"
      ? { role: "tool", tool_call_id: message.toolCallId, content: message.content || "" }
      : message.role === "assistant"
        ? {
            role: "assistant",
            content: message.content || null,
            ...(message.toolCalls?.length ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: jsonText(call.input) },
              })),
            } : {}),
          }
        : { role: "user", content: message.content || "" }),
  ];
}

async function completeOpenAi(key: string, messages: AgentMessage[]): Promise<Completion> {
  const response = await requestWithTimeout("openai", "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modelFor("openai"), messages: openAiMessages(messages), tools: openAiTools(), tool_choice: "auto" }),
  });
  if (!response.ok) throw new ProviderError("openai", `HTTP ${response.status}`);
  const body = await response.json().catch(() => null) as JsonObject | null;
  const choice = body?.choices && Array.isArray(body.choices) ? body.choices[0] as JsonObject | undefined : undefined;
  const message = choice?.message && typeof choice.message === "object" ? choice.message as JsonObject : undefined;
  if (!message) throw new ProviderError("openai", "invalid model response");
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((raw, index) => {
    const item = raw as JsonObject;
    const functionCall = item.function as JsonObject | undefined;
    return { id: typeof item.id === "string" ? item.id : `openai-call-${index}`, name: String(functionCall?.name || ""), input: parseObject(functionCall?.arguments) };
  }) : [];
  return { text: typeof message.content === "string" ? message.content : "", toolCalls: calls };
}

function anthropicMessages(messages: AgentMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content || "" }] };
    }
    if (message.role === "assistant") {
      const content = [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.toolCalls || []).map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
      ];
      return { role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] };
    }
    return { role: "user", content: message.content || "" };
  });
}

async function completeAnthropic(key: string, messages: AgentMessage[]): Promise<Completion> {
  const response = await requestWithTimeout("anthropic", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: modelFor("anthropic"),
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages(messages),
      tools: sentinelTools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    }),
  });
  if (!response.ok) throw new ProviderError("anthropic", `HTTP ${response.status}`);
  const body = await response.json().catch(() => null) as JsonObject | null;
  const content = Array.isArray(body?.content) ? body.content as JsonObject[] : [];
  const text = content.filter((part) => part.type === "text").map((part) => typeof part.text === "string" ? part.text : "").join("");
  const toolCalls = content.filter((part) => part.type === "tool_use").map((part, index) => ({
    id: typeof part.id === "string" ? part.id : `anthropic-call-${index}`,
    name: typeof part.name === "string" ? part.name : "",
    input: parseObject(part.input),
  }));
  if (!text && !toolCalls.length) throw new ProviderError("anthropic", "invalid model response");
  return { text, toolCalls };
}

function geminiContents(messages: AgentMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      let response: unknown = message.content || "";
      try { response = JSON.parse(message.content || ""); } catch { /* Preserve plain tool errors as text. */ }
      return { role: "user", parts: [{ functionResponse: { name: message.name || "unknown", response } }] };
    }
    if (message.role === "assistant") {
      return {
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.toolCalls || []).map((call) => ({ functionCall: { name: call.name, args: call.input } })),
        ],
      };
    }
    return { role: "user", parts: [{ text: message.content || "" }] };
  });
}

function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!value || typeof value !== "object") return value;
  const object = value as JsonObject;
  const supported = new Set(["type", "description", "enum", "properties", "required", "items", "format", "nullable", "minItems", "maxItems"]);
  return Object.fromEntries(Object.entries(object)
    .filter(([key]) => supported.has(key))
    .map(([key, item]) => [key, key === "type" && typeof item === "string" ? item.toUpperCase() : geminiSchema(item)]));
}

async function completeGemini(key: string, messages: AgentMessage[]): Promise<Completion> {
  const model = encodeURIComponent(modelFor("gemini"));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const response = await requestWithTimeout("gemini", url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: geminiContents(messages),
      tools: [{ functionDeclarations: sentinelTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: geminiSchema(tool.parameters) })) }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!response.ok) throw new ProviderError("gemini", `HTTP ${response.status}`);
  const body = await response.json().catch(() => null) as JsonObject | null;
  const candidates = Array.isArray(body?.candidates) ? body.candidates as JsonObject[] : [];
  const content = candidates[0]?.content && typeof candidates[0].content === "object" ? candidates[0].content as JsonObject : undefined;
  const parts = Array.isArray(content?.parts) ? content.parts as JsonObject[] : [];
  const text = parts.filter((part) => typeof part.text === "string").map((part) => part.text as string).join("");
  const toolCalls = parts.filter((part) => part.functionCall && typeof part.functionCall === "object").map((part, index) => {
    const call = part.functionCall as JsonObject;
    return { id: `gemini-call-${index}`, name: typeof call.name === "string" ? call.name : "", input: parseObject(call.args || {}) };
  });
  if (!text && !toolCalls.length) throw new ProviderError("gemini", "invalid model response");
  return { text, toolCalls };
}

async function complete(provider: ProviderName, key: string, messages: AgentMessage[]): Promise<Completion> {
  if (provider === "openai") return completeOpenAi(key, messages);
  if (provider === "anthropic") return completeAnthropic(key, messages);
  return completeGemini(key, messages);
}

async function completeWithFallback(messages: AgentMessage[], providerState: { preferred?: ProviderName }, config: ReturnType<typeof configuredProviders>): Promise<{ completion: Completion; provider: ProviderName }> {
  const order = providerState.preferred
    ? [providerState.preferred, ...config.providers.filter((provider) => provider !== providerState.preferred)]
    : config.providers;
  const failures: string[] = [];
  for (const provider of order) {
    const key = config.keys[provider];
    if (!key) continue;
    try {
      return { completion: await complete(provider, key, messages), provider };
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : "request failed";
      failures.push(`${provider}: ${message}`);
    }
  }
  throw new Error(`All configured LLM providers failed (${failures.join("; ")}). Check the selected provider key or set AGENT_PROVIDER to another configured provider.`);
}

function gatewayErrorMessage(response: GatewayResponse, operation: string): string {
  const error = response.body.error;
  const errorObject = error && typeof error === "object" ? error as JsonObject : undefined;
  const execution = response.body.execution;
  const executionObject = execution && typeof execution === "object" ? execution as JsonObject : undefined;
  const message = typeof errorObject?.message === "string"
    ? errorObject.message
    : typeof executionObject?.error === "string"
      ? executionObject.error
      : `Gateway returned HTTP ${response.status}.`;
  const code = typeof errorObject?.code === "string" ? ` (${errorObject.code})` : "";
  const requestId = typeof response.body.requestId === "string" ? ` Request ID: ${response.body.requestId}.` : "";
  return `${operation} failed${code}: ${message}${requestId}`;
}

async function callGateway(endpoint: string, init: RequestInit = {}): Promise<GatewayResponse> {
  let response: Response;
  try {
    response = await fetch(`${gatewayBaseUrl}${endpoint}`, {
      ...init,
      headers: { accept: "application/json", "content-type": "application/json", ...(init.headers || {}) },
    });
  } catch {
    throw new GatewayError(`SentinelGate gateway is unavailable at ${gatewayBaseUrl}. Start it with npm run dev and try again.`, true);
  }
  const body = await response.json().catch(() => ({})) as unknown;
  return { status: response.status, body: body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : {} };
}

function actionFrom(body: JsonObject): GatewayAction {
  if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) throw new GatewayError("SentinelGate returned no action record.");
  return body.action as GatewayAction;
}

function hitlTimeoutMs(): number {
  const configured = Number(process.env.AGENT_HITL_TIMEOUT_MS || defaultHitlTimeoutMs);
  return Number.isFinite(configured) ? Math.min(300_000, Math.max(1_000, configured)) : defaultHitlTimeoutMs;
}

async function waitForResolution(actionId: string): Promise<GatewayAction> {
  const timeout = hitlTimeoutMs();
  const deadline = Date.now() + timeout;
  process.stdout.write(`[HITL] Action ${actionId} is awaiting SentinelGate approval. Waiting for a dashboard decision...\n`);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const response = await callGateway(`/actions/${encodeURIComponent(actionId)}/wait?timeoutMs=${Math.min(hitlPollTimeoutMs, remaining)}`);
    if (response.status < 200 || response.status >= 300) throw new GatewayError(gatewayErrorMessage(response, "Waiting for HITL resolution"));
    const action = response.body.action && typeof response.body.action === "object" ? response.body.action as GatewayAction : undefined;
    if (action && ["approved", "blocked", "frozen", "allowed"].includes(String(action.status))) return action;
  }
  throw new GatewayError(`HITL approval timed out after ${timeout}ms. Action ${actionId} remains pending; approve or block it in the SentinelGate dashboard.`);
}

function validateToolInput(name: string, input: JsonObject): void {
  if (!toolByName.has(name)) throw new Error(`Unknown tool requested: ${name}.`);
  if (name === "query_customer_dw" && (typeof input.query !== "string" || !input.query.trim())) throw new Error("query_customer_dw requires a non-empty query.");
  if (name === "s3_bucket_operation") {
    if (!["list", "read", "put", "delete"].includes(String(input.operation))) throw new Error("s3_bucket_operation requires operation list, read, put, or delete.");
    if (input.operation !== "list" && !input.key && !(Array.isArray(input.keys) && input.keys.length)) throw new Error(`${input.operation} requires key or keys.`);
    if (input.operation === "put" && typeof input.body !== "string") throw new Error("put requires a string body.");
  }
  if ((name === "github_repo_action" || name === "datadog_log_trace") && typeof input.operation !== "string") throw new Error(`${name} requires operation.`);
  if (name === "github_repo_action" && input.endpoint !== undefined && (typeof input.endpoint !== "string" || !input.endpoint.startsWith("/"))) throw new Error("github_repo_action endpoint must be a GitHub API path beginning with /.");
}

async function runGatewayTool(name: string, input: JsonObject): Promise<ToolResult> {
  try {
    validateToolInput(name, input);
    const resource = name === "query_customer_dw" ? "customer-data-warehouse"
      : name === "s3_bucket_operation" ? `s3://${String(input.bucket || "customer-pii")}`
        : name === "github_repo_action" ? String(input.endpoint || "/user/repos")
          : String(input.endpoint || "https://api.datadoghq.com/api/v1/validate");
    const payload = name === "query_customer_dw"
      ? compact({ operation: "query", sql: input.query, params: input.params })
      : input;
    const intercepted = await callGateway("/intercept", {
      method: "POST",
      body: JSON.stringify({ action: name, actorId: "terminal-agent", resource, payload, metadata: { client: "real-agent", executeOnResolve: true } }),
    });
    if (intercepted.status < 200 || intercepted.status >= 300) throw new GatewayError(gatewayErrorMessage(intercepted, `Intercepting ${name}`));
    let action = actionFrom(intercepted.body);
    if (action.status === "pending_approval") {
      if (typeof action.id !== "string") throw new GatewayError(`SentinelGate returned a pending ${name} action without an id.`);
      action = await waitForResolution(action.id);
    }
    if (action.status === "blocked") throw new GatewayError(`SentinelGate blocked ${name}: ${action.resolutionNote || action.decision?.reason || "the policy denied this action."}`);
    if (action.status === "frozen") throw new GatewayError(`SentinelGate froze ${name} for review: ${action.resolutionNote || action.decision?.reason || "security review is required."}`);
    if (action.status !== "allowed" && action.status !== "approved") throw new GatewayError(`SentinelGate did not authorize ${name}; action status is ${action.status || "unknown"}.`);
    if (typeof action.id !== "string") throw new GatewayError(`SentinelGate returned no action id for ${name}.`);
    if (action.execution && typeof action.execution === "object" && (action.execution as JsonObject).executed === true) return { ok: true, value: compact({ tool: name, action, decision: action.decision, execution: action.execution }) };
    const executed = await callGateway(`/actions/${encodeURIComponent(action.id)}/execute`, {
      method: "POST",
      body: JSON.stringify({ dryRun: false }),
    });
    const execution = executed.body.execution && typeof executed.body.execution === "object" ? executed.body.execution as JsonObject : undefined;
    if (executed.status < 200 || executed.status >= 300 || execution?.executed !== true) throw new GatewayError(gatewayErrorMessage(executed, `Executing ${name}`));
    return { ok: true, value: compact({ tool: name, requestId: executed.body.requestId, decision: action.decision, execution }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tool call failed.";
    return { ok: false, value: { tool: name, error: message, ...(error instanceof GatewayError && error.unavailable ? { gatewayUnavailable: true } : {}) } };
  }
}

function printToolResult(call: ToolCall, result: ToolResult): void {
  if (result.ok) process.stdout.write(`\n[${call.name}]\n${jsonText(result.value)}\n`);
  else process.stderr.write(`\n[SentinelGate blocked/error: ${call.name}] ${String(result.value.error)}\n`);
}

async function runTurn(input: string, config: ReturnType<typeof configuredProviders>, providerState: { preferred?: ProviderName }): Promise<void> {
  const messages: AgentMessage[] = [{ role: "user", content: input }];
  for (let round = 0; round < maxAgentRounds; round += 1) {
    const response = await completeWithFallback(messages, providerState, config);
    if (providerState.preferred !== response.provider) {
      process.stdout.write(`[agent] Provider: ${response.provider}\n`);
      providerState.preferred = response.provider;
    }
    if (response.completion.text) process.stdout.write(`${response.completion.text}\n`);
    if (!response.completion.toolCalls.length) return;
    messages.push({ role: "assistant", content: response.completion.text, toolCalls: response.completion.toolCalls });
    for (const call of response.completion.toolCalls) {
      const result = await runGatewayTool(call.name, call.input);
      printToolResult(call, result);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: jsonText(result.value) });
    }
  }
  process.stderr.write(`[agent] Stopped after ${maxAgentRounds} tool rounds. Ask a follow-up question to continue.\n`);
}

async function main(): Promise<void> {
  const config = configuredProviders();
  const providerState: { preferred?: ProviderName } = {};
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  input.setPrompt("Ask Autonomous Enterprise Agent > ");
  process.stdout.write("Autonomous Enterprise Agent ready. Type exit or quit to stop.\n");
  try {
    while (true) {
      const line = await new Promise<string>((resolve) => input.question("Ask Autonomous Enterprise Agent > ", resolve));
      const request = line.trim();
      if (!request) continue;
      if (["exit", "quit"].includes(request.toLowerCase())) break;
      try {
        await runTurn(request, config, providerState);
      } catch (error) {
        process.stderr.write(`[agent error] ${error instanceof Error ? error.message : "The request failed."}\n`);
      }
    }
  } finally {
    input.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[agent error] ${error instanceof Error ? error.message : "Unable to start the agent."}\n`);
  process.exitCode = 1;
});
