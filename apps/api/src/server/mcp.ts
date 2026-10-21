import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getDatabase, type AppDatabase } from "../db/client";
import * as schema from "../db/schema";
import type { SentinelEnvironment } from "./types";

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

export interface McpConnectionInput {
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  secrets?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface McpConnection extends Omit<McpConnectionInput, "env" | "headers" | "secrets"> {
  id: string;
  createdAt: string;
  updatedAt: string;
  secretKeys: string[];
  hasSecrets: boolean;
}

export interface McpOAuthStatus {
  configured: boolean;
  supported: boolean;
  authorized: boolean;
  pending: boolean;
  issuer?: string;
  authorizationEndpoint?: string;
  scopes?: string[];
  tokenExpiresAt?: string;
  clientRegistration: "dynamic" | "configured" | "missing";
  error?: string;
}

export type CreatedMcpConnection = McpConnection & { token: string };

interface StoredConnection extends McpConnectionInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

type SecretEnvelope = { iv: string; tag: string; ciphertext: string };
type OAuthClient = { client_id: string; client_secret?: string; [key: string]: unknown };
type OAuthTokens = { access_token: string; token_type?: string; refresh_token?: string; expires_in?: number; scope?: string; receivedAt: string };
type OAuthDiscovery = { authorizationServerUrl: string; metadata: Record<string, unknown>; resourceMetadata?: Record<string, unknown> };
type OAuthPending = { state: string; codeVerifier: string; redirectUri: string; issuer: string; authorizationServerUrl: string; createdAt: string; resource?: string; scope?: string };
type StoredOAuth = { client?: OAuthClient; tokens?: OAuthTokens; discovery?: OAuthDiscovery; pending?: OAuthPending };
type StoredSecrets = { env?: Record<string, string>; headers?: Record<string, string>; secrets?: Record<string, string>; oauth?: StoredOAuth };
type JsonRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}

function id(): string {
  return `mcp_${crypto.randomUUID().replace(/-/g, "")}`;
}

function secretKey(): Buffer {
  const configured = process.env.SENTINEL_MCP_SECRET_KEY || process.env.MCP_SECRET_KEY;
  if (configured) return crypto.createHash("sha256").update(configured).digest();

  const dataDir = process.env.SENTINEL_DATA_DIR || path.join(process.cwd(), "data");
  const file = path.join(dataDir, ".mcp-secret-key");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const key = fs.readFileSync(file);
    if (key.length >= 32) return key.subarray(0, 32);
  } catch { /* create below */ }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  return key;
}

function encrypt(value: StoredSecrets): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") } satisfies SecretEnvelope);
}

function decrypt(raw: string | null | undefined): StoredSecrets {
  if (!raw) return {};
  try {
    const envelope = JSON.parse(raw) as SecretEnvelope;
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8")) as StoredSecrets;
  } catch {
    throw new Error("MCP connection secrets could not be decrypted; check SENTINEL_MCP_SECRET_KEY.");
  }
}

function oauthEnvironment(env: SentinelEnvironment = {}): SentinelEnvironment {
  return { ...(typeof process !== "undefined" ? process.env as SentinelEnvironment : {}), ...env };
}

function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

function issuersMatch(left: string, right: string): boolean {
  try { return normalizedUrl(left) === normalizedUrl(right); } catch { return left === right; }
}

export function mcpOAuthRedirectUri(connectionId: string, publicUrl?: string, requestUrl?: string): string {
  const configured = publicUrl?.trim() || (typeof process !== "undefined" ? process.env.SENTINEL_PUBLIC_URL?.trim() : undefined);
  const base = configured || (requestUrl ? new URL(requestUrl).origin : "http://localhost:3000");
  const parsed = new URL(base);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("SENTINEL_PUBLIC_URL must be an http(s) URL.");
  const origin = parsed.origin;
  return `${origin}/api/v1/connections/${encodeURIComponent(connectionId)}/oauth/callback`;
}

function oauthTokenExpiry(tokens: OAuthTokens): number | undefined {
  return typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
    ? Date.parse(tokens.receivedAt) + (tokens.expires_in * 1000)
    : undefined;
}

function safeOAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "OAuth operation failed.";
  const redacted = message
    .replace(/Bearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret|code_verifier)=?[^\s&,}]*/gi, "$1=[redacted]")
    .replace(/("(?:access_token|refresh_token|client_secret|code_verifier)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2");
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}

export function mcpOAuthErrorMessage(error: unknown): string { return safeOAuthError(error); }

function validateInput(input: McpConnectionInput): void {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 160) throw new Error("name is required and must be at most 160 characters.");
  if (!["stdio", "streamable-http", "sse"].includes(input.transport)) throw new Error("transport must be stdio, streamable-http, or sse.");
  if (input.transport === "stdio" && (!input.command || typeof input.command !== "string")) throw new Error("command is required for stdio connections.");
  if (input.transport !== "stdio" && (!input.url || typeof input.url !== "string" || !/^https?:\/\//i.test(input.url))) throw new Error("url must be an http(s) URL for HTTP and SSE connections.");
  if (input.args && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string"))) throw new Error("args must be an array of strings.");
  for (const values of [input.env, input.headers, input.secrets]) {
    if (values && (typeof values !== "object" || Array.isArray(values) || Object.entries(values).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) || typeof value !== "string"))) throw new Error("env, headers, and secrets must be string maps with safe keys.");
  }
}

function publicConnection(value: StoredConnection, secrets: StoredSecrets): McpConnection {
  const { env: _env, headers: _headers, secrets: _secrets, ...publicValue } = value;
  const keys = Object.keys({ ...(secrets.env || {}), ...(secrets.headers || {}), ...(secrets.secrets || {}) });
  return clone({ ...publicValue, secretKeys: keys.sort(), hasSecrets: keys.length > 0 });
}

/** Cloudflare D1-backed registry via Drizzle ORM. Connection credentials are encrypted at rest with AES-256-GCM. */
export class McpConnectionRegistry {
  private dbPromise: Promise<{ db: AppDatabase; d1: D1Database }> | null = null;

  constructor(private readonly envDb?: D1Database) {}

  private async getDb() {
    if (!this.dbPromise) {
      this.dbPromise = getDatabase(this.envDb);
    }
    return this.dbPromise;
  }

  private async read(idValue: string): Promise<{ value: StoredConnection; secrets: StoredSecrets } | null> {
    const { db } = await this.getDb();
    const [row] = await db.select().from(schema.mcpConnections).where(eq(schema.mcpConnections.id, idValue));
    if (!row) return null;
    return { value: JSON.parse(row.configJson) as StoredConnection, secrets: decrypt(row.secretJson) };
  }

  private async tokenHash(idValue: string): Promise<string | null> {
    const { db } = await this.getDb();
    const [row] = await db.select({ tokenHash: schema.mcpConnections.tokenHash }).from(schema.mcpConnections).where(eq(schema.mcpConnections.id, idValue));
    return row?.tokenHash || null;
  }

  async verifyToken(idValue: string, token: string | undefined): Promise<boolean> {
    const stored = await this.tokenHash(idValue);
    if (!stored || !token) return false;
    const supplied = crypto.createHash("sha256").update(token).digest("hex");
    const left = Buffer.from(stored, "hex");
    const right = Buffer.from(supplied, "hex");
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  async list(): Promise<McpConnection[]> {
    const { db } = await this.getDb();
    const rows = await db.select().from(schema.mcpConnections).orderBy(desc(schema.mcpConnections.updatedAt));
    return rows.map((row) => publicConnection(JSON.parse(row.configJson) as StoredConnection, decrypt(row.secretJson)));
  }

  async get(idValue: string): Promise<McpConnection | null> {
    const item = await this.read(idValue);
    return item ? publicConnection(item.value, item.secrets) : null;
  }

  async getWithSecrets(idValue: string): Promise<{ value: StoredConnection; secrets: StoredSecrets } | null> {
    return this.read(idValue);
  }

  async create(input: McpConnectionInput): Promise<CreatedMcpConnection> {
    validateInput(input);
    const now = new Date().toISOString();
    const token = `sg_mcp_${crypto.randomBytes(24).toString("base64url")}`;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const { env: _env, headers: _headers, secrets: _secrets, ...safeInput } = clone(input);
    const value: StoredConnection = { ...safeInput, id: id(), createdAt: now, updatedAt: now };
    const secrets: StoredSecrets = { env: input.env, headers: input.headers, secrets: input.secrets };
    const { db } = await this.getDb();
    await db.insert(schema.mcpConnections).values({
      id: value.id,
      name: value.name,
      transport: value.transport,
      configJson: JSON.stringify(value),
      secretJson: Object.keys(secrets).length ? encrypt(secrets) : null,
      tokenHash,
      createdAt: now,
      updatedAt: now,
    });
    return { ...publicConnection(value, secrets), token };
  }

  async rotateToken(idValue: string): Promise<string | null> {
    if (!(await this.read(idValue))) return null;
    const token = `sg_mcp_${crypto.randomBytes(24).toString("base64url")}`;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const { db } = await this.getDb();
    await db.update(schema.mcpConnections).set({
      tokenHash,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.mcpConnections.id, idValue));
    return token;
  }

  async update(idValue: string, patch: Partial<McpConnectionInput>): Promise<McpConnection | null> {
    const current = await this.read(idValue);
    if (!current) return null;
    const { env: _env, headers: _headers, secrets: _secrets, ...safePatch } = clone(patch);
    const value = { ...current.value, ...safePatch, id: idValue, createdAt: current.value.createdAt, updatedAt: new Date().toISOString() } as StoredConnection;
    validateInput(value);
    const secrets: StoredSecrets = patch.env || patch.headers || patch.secrets
      ? { env: patch.env, headers: patch.headers, secrets: patch.secrets, oauth: current.secrets.oauth }
      : current.secrets;
    const { db } = await this.getDb();
    await db.update(schema.mcpConnections).set({
      name: value.name,
      transport: value.transport,
      configJson: JSON.stringify(value),
      secretJson: Object.keys(secrets).length ? encrypt(secrets) : null,
      updatedAt: value.updatedAt,
    }).where(eq(schema.mcpConnections.id, idValue));
    activeConnections.delete(idValue);
    return publicConnection(value, secrets);
  }

  async delete(idValue: string): Promise<boolean> {
    const { db } = await this.getDb();
    const res = await db.delete(schema.mcpConnections).where(eq(schema.mcpConnections.id, idValue));
    activeConnections.delete(idValue);
    return true;
  }

  private async saveSecrets(idValue: string, secrets: StoredSecrets, stateHash?: string | null): Promise<void> {
    const { db } = await this.getDb();
    const hash = stateHash === undefined ? await this.oauthStateHash(idValue) : stateHash;
    await db.update(schema.mcpConnections).set({
      secretJson: Object.keys(secrets).length ? encrypt(secrets) : null,
      oauthStateHash: hash,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.mcpConnections.id, idValue));
    activeConnections.delete(idValue);
  }

  private async oauthStateHash(idValue: string): Promise<string | null> {
    const { db } = await this.getDb();
    const [row] = await db.select({ hash: schema.mcpConnections.oauthStateHash }).from(schema.mcpConnections).where(eq(schema.mcpConnections.id, idValue));
    return row?.hash || null;
  }

  async getOAuth(idValue: string): Promise<StoredOAuth | null> {
    const item = await this.read(idValue);
    return item ? clone(item.secrets.oauth || {}) : null;
  }

  async saveOAuth(idValue: string, oauth: StoredOAuth): Promise<boolean> {
    const item = await this.read(idValue);
    if (!item) return false;
    const stateHash = oauth.pending ? crypto.createHash("sha256").update(oauth.pending.state).digest("hex") : null;
    await this.saveSecrets(idValue, { ...item.secrets, oauth }, stateHash);
    return true;
  }

  async consumeOAuthState(idValue: string, state: string): Promise<{ value: StoredConnection; secrets: StoredSecrets; pending: OAuthPending } | null> {
    const item = await this.read(idValue);
    if (!item) return null;
    const pending = item.secrets.oauth?.pending;
    if (!pending || pending.state !== state) return null;
    const nextSecrets: StoredSecrets = { ...item.secrets, oauth: { ...item.secrets.oauth, pending: undefined } };
    const { db } = await this.getDb();
    await db.update(schema.mcpConnections).set({
      secretJson: encrypt(nextSecrets),
      oauthStateHash: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.mcpConnections.id, idValue));
    activeConnections.delete(idValue);
    return { value: item.value, secrets: nextSecrets, pending };
  }

  async peekOAuthState(idValue: string, state: string, ttlMs = DEFAULT_OAUTH_STATE_TTL_MS): Promise<OAuthPending | null> {
    const item = await this.read(idValue);
    if (!item) return null;
    const pending = item.secrets.oauth?.pending;
    if (!pending || pending.state !== state) return null;
    const createdAt = Date.parse(pending.createdAt);
    if (!Number.isFinite(createdAt) || createdAt + ttlMs < Date.now()) return null;
    return clone(pending);
  }

  async oauthStatus(idValue: string): Promise<{ oauth: StoredOAuth; hasManualCredentials: boolean } | null> {
    const item = await this.read(idValue);
    if (!item) return null;
    return { oauth: clone(item.secrets.oauth || {}), hasManualCredentials: Object.keys({ ...(item.secrets.headers || {}), ...(item.secrets.secrets || {}) }).length > 0 };
  }
}

let defaultRegistry: McpConnectionRegistry | undefined;
export function getMcpConnectionRegistry(envDb?: D1Database): McpConnectionRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new McpConnectionRegistry(envDb);
  }
  return defaultRegistry;
}

const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type ActiveConnection = { client: Client; transport: Transport; connecting?: Promise<Client> };
const activeConnections = new Map<string, ActiveConnection>();

async function discoverOAuth(connection: StoredConnection, fetchImpl: typeof fetch): Promise<OAuthDiscovery> {
  if (!connection.url || connection.transport === "stdio") throw new Error("OAuth is available only for HTTP or SSE MCP connections.");
  const info = await discoverOAuthServerInfo(connection.url, { fetchFn: fetchImpl as never });
  if (!info.authorizationServerMetadata) throw new Error("The MCP server did not publish OAuth authorization metadata.");
  if (!issuersMatch(info.authorizationServerMetadata.issuer, info.authorizationServerUrl)) {
    throw new Error("OAuth issuer does not match the discovered authorization server.");
  }
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata: info.authorizationServerMetadata as unknown as Record<string, unknown>,
    resourceMetadata: info.resourceMetadata as unknown as Record<string, unknown> | undefined,
  };
}

function clientFromEnvironment(env: SentinelEnvironment, redirectUri: string): OAuthClient | undefined {
  const clientId = env.OAUTH_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  return {
    client_id: clientId,
    ...(env.OAUTH_CLIENT_SECRET ? { client_secret: env.OAUTH_CLIENT_SECRET } : {}),
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: env.OAUTH_CLIENT_SECRET ? undefined : "none",
  };
}

async function ensureOAuthClient(
  connection: StoredConnection,
  oauth: StoredOAuth,
  discovery: OAuthDiscovery,
  redirectUri: string,
  env: SentinelEnvironment,
  fetchImpl: typeof fetch,
): Promise<OAuthClient> {
  if (oauth.client?.client_id) return oauth.client;
  const configured = clientFromEnvironment(env, redirectUri);
  if (configured) return configured;
  const metadata = discovery.metadata as any;
  if (!metadata.registration_endpoint) throw new Error("OAuth requires OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET or a dynamic registration endpoint.");
  const registered = await registerClient(discovery.authorizationServerUrl, {
    metadata,
    clientMetadata: {
      redirect_uris: [redirectUri],
      client_name: env.OAUTH_CLIENT_NAME || "SentinelGate MCP Gateway",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    scope: (discovery.resourceMetadata?.scopes_supported as string[] | undefined)?.join(" "),
    fetchFn: fetchImpl as never,
  });
  return registered as unknown as OAuthClient;
}

export async function startMcpOAuth(
  connectionId: string,
  options: { env?: SentinelEnvironment; fetchImpl?: typeof fetch; publicUrl?: string; requestUrl?: string; scope?: string } = {},
): Promise<{ authorizationUrl: string; redirectUri: string; status: McpOAuthStatus }> {
  const env = oauthEnvironment(options.env);
  const registry = getMcpConnectionRegistry(options.env?.ENTERPRISE_DB_PATH as any);
  const item = await registry.getWithSecrets(connectionId);
  if (!item) throw new Error("MCP connection not found.");
  const redirectUri = mcpOAuthRedirectUri(connectionId, options.publicUrl || env.SENTINEL_PUBLIC_URL, options.requestUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const discovery = await discoverOAuth(item.value, fetchImpl);
  const current = item.secrets.oauth || {};
  const client = await ensureOAuthClient(item.value, current, discovery, redirectUri, env, fetchImpl);
  const state = crypto.randomBytes(32).toString("base64url");
  const requestedScope = options.scope?.trim() || (discovery.resourceMetadata?.scopes_supported as string[] | undefined)?.join(" ");
  const resource = typeof discovery.resourceMetadata?.resource === "string" ? discovery.resourceMetadata.resource : undefined;
  const auth = await startAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.metadata as any,
    clientInformation: client as any,
    redirectUrl: redirectUri,
    scope: requestedScope,
    state,
    resource,
  });
  const pending: OAuthPending = {
    state,
    codeVerifier: auth.codeVerifier,
    redirectUri,
    issuer: (discovery.metadata.issuer as string),
    authorizationServerUrl: discovery.authorizationServerUrl,
    createdAt: new Date().toISOString(),
    ...(resource ? { resource } : {}),
    ...(requestedScope ? { scope: requestedScope } : {}),
  };
  await registry.saveOAuth(connectionId, { ...current, client, discovery, pending });
  return {
    authorizationUrl: auth.authorizationUrl.toString(),
    redirectUri,
    status: await oauthStatusFor(connectionId, discovery, env),
  };
}

export async function completeMcpOAuth(
  connectionId: string,
  params: { state?: string; code?: string; error?: string; errorDescription?: string; issuer?: string },
  options: { env?: SentinelEnvironment; fetchImpl?: typeof fetch; requestUrl?: string } = {},
): Promise<{ ok: true; status: McpOAuthStatus }> {
  if (!params.state) throw new Error("OAuth callback state is required.");
  const runtimeEnv = oauthEnvironment(options.env);
  const ttlMs = Number(runtimeEnv.SENTINEL_OAUTH_STATE_TTL_MS) || DEFAULT_OAUTH_STATE_TTL_MS;
  const registry = getMcpConnectionRegistry();
  const pending = await registry.peekOAuthState(connectionId, params.state, ttlMs);
  if (!pending) throw new Error("OAuth callback state is invalid or has expired.");
  if (options.requestUrl) {
    const actual = new URL(options.requestUrl);
    const expected = new URL(pending.redirectUri);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
      throw new Error("OAuth callback redirect URI does not match the authorization request.");
    }
  }
  if (params.issuer && !issuersMatch(params.issuer, pending.issuer)) throw new Error("OAuth issuer validation failed.");
  const consumed = await registry.consumeOAuthState(connectionId, params.state);
  if (!consumed) throw new Error("OAuth callback state is invalid or has expired.");
  if (params.error) throw new Error(`OAuth authorization failed: ${params.errorDescription || params.error}`);
  if (!params.code) throw new Error("OAuth callback code is required.");
  const oauth = consumed.secrets.oauth || {};
  if (!oauth.client?.client_id) throw new Error("OAuth client information is missing.");
  const discovery = oauth.discovery;
  if (!discovery || !issuersMatch(discovery.metadata.issuer as string, consumed.pending.issuer)) throw new Error("OAuth issuer metadata is invalid.");
  const tokens = await exchangeAuthorization(consumed.pending.authorizationServerUrl, {
    metadata: discovery.metadata as any,
    clientInformation: oauth.client as any,
    authorizationCode: params.code,
    codeVerifier: consumed.pending.codeVerifier,
    redirectUri: consumed.pending.redirectUri,
    resource: consumed.pending.resource,
    fetchFn: (options.fetchImpl || fetch) as never,
  });
  const storedTokens: OAuthTokens = {
    ...(tokens as unknown as OAuthTokens),
    receivedAt: new Date().toISOString(),
  };
  await registry.saveOAuth(connectionId, { ...oauth, tokens: storedTokens, pending: undefined });
  return { ok: true, status: await oauthStatusFor(connectionId, discovery, runtimeEnv) };
}

async function oauthStatusFor(connectionId: string, discovery?: OAuthDiscovery, env: SentinelEnvironment = {}): Promise<McpOAuthStatus> {
  const registry = getMcpConnectionRegistry();
  const stored = await registry.oauthStatus(connectionId);
  if (!stored) throw new Error("MCP connection not found.");
  const oauth = stored.oauth;
  const tokens = oauth.tokens;
  const expiry = tokens ? oauthTokenExpiry(tokens) : undefined;
  const runtimeEnv = oauthEnvironment(env);
  const configured = Boolean(oauth.client?.client_id || runtimeEnv.OAUTH_CLIENT_ID);
  const metadata = discovery?.metadata || oauth.discovery?.metadata;
  return {
    configured,
    supported: Boolean(metadata),
    authorized: Boolean(tokens?.access_token || tokens?.refresh_token),
    pending: Boolean(oauth.pending),
    ...(metadata?.issuer ? { issuer: metadata.issuer as string } : {}),
    ...(metadata?.authorization_endpoint ? { authorizationEndpoint: metadata.authorization_endpoint as string } : {}),
    ...(oauth.discovery?.resourceMetadata?.scopes_supported ? { scopes: oauth.discovery.resourceMetadata.scopes_supported as string[] } : {}),
    ...(expiry ? { tokenExpiresAt: new Date(expiry).toISOString() } : {}),
    clientRegistration: oauth.client?.client_id ? (oauth.client?.client_secret ? "configured" : "dynamic") : "missing",
  };
}

export async function getMcpOAuthStatus(
  connectionId: string,
  options: { env?: SentinelEnvironment; fetchImpl?: typeof fetch } = {},
): Promise<McpOAuthStatus> {
  const registry = getMcpConnectionRegistry();
  const item = await registry.getWithSecrets(connectionId);
  if (!item) throw new Error("MCP connection not found.");
  if (item.value.transport === "stdio") return { ...(await oauthStatusFor(connectionId, undefined, options.env)), supported: false, clientRegistration: "missing" };
  try {
    const discovery = await discoverOAuth(item.value, options.fetchImpl || fetch);
    const oauth = item.secrets.oauth || {};
    if (!oauth.discovery || JSON.stringify(oauth.discovery) !== JSON.stringify(discovery)) await registry.saveOAuth(connectionId, { ...oauth, discovery });
    return await oauthStatusFor(connectionId, discovery, options.env);
  } catch (error) {
    const status = await oauthStatusFor(connectionId, undefined, options.env);
    return { ...status, supported: false, error: safeOAuthError(error) };
  }
}

async function oauthHeaders(connectionId: string, item: { value: StoredConnection; secrets: StoredSecrets }, env: SentinelEnvironment, fetchImpl: typeof fetch): Promise<Record<string, string>> {
  const oauth = item.secrets.oauth;
  if (!oauth?.tokens?.access_token) return {};
  let tokens = oauth.tokens;
  const expiry = oauthTokenExpiry(tokens);
  if (tokens.refresh_token && expiry !== undefined && expiry <= Date.now() + 30_000) {
    const discovery = oauth.discovery || await discoverOAuth(item.value, fetchImpl);
    const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.metadata as any,
      clientInformation: oauth.client as any,
      refreshToken: tokens.refresh_token,
      resource: discovery.resourceMetadata?.resource as string | undefined,
      fetchFn: fetchImpl as never,
    });
    tokens = { ...(refreshed as unknown as OAuthTokens), receivedAt: new Date().toISOString() };
    const registry = getMcpConnectionRegistry();
    await registry.saveOAuth(connectionId, { ...oauth, discovery, tokens });
  }
  return { Authorization: `Bearer ${tokens.access_token}` };
}

async function transportFor(connectionId: string, connection: StoredConnection, storedSecrets: StoredSecrets, runtimeEnv: SentinelEnvironment, fetchImpl: typeof fetch): Promise<Transport> {
  const processEnv = { ...getDefaultEnvironment(), ...(storedSecrets.env || {}), ...(storedSecrets.secrets || {}) };
  const headers = { ...(storedSecrets.headers || {}), ...(storedSecrets.secrets || {}) };
  if (connection.transport === "stdio") {
    const params: StdioServerParameters = { command: connection.command as string, args: connection.args, cwd: connection.cwd, env: processEnv, stderr: "pipe" } as StdioServerParameters;
    return new StdioClientTransport(params);
  }
  const oauth = await oauthHeaders(connectionId, { value: connection, secrets: storedSecrets }, oauthEnvironment(runtimeEnv), fetchImpl);
  const requestHeaders = { ...headers, ...oauth };
  const requestInit: RequestInit = Object.keys(requestHeaders).length ? { headers: requestHeaders } : {};
  if (connection.transport === "sse") return new SSEClientTransport(new URL(connection.url as string), { requestInit });
  return new StreamableHTTPClientTransport(new URL(connection.url as string), { requestInit });
}

export async function getMcpClient(connectionId: string, runtimeEnv: SentinelEnvironment = {}, fetchImpl: typeof fetch = fetch): Promise<Client> {
  const registry = getMcpConnectionRegistry();
  const item = await registry.getWithSecrets(connectionId);
  if (!item) throw new Error("MCP connection not found.");
  const existing = activeConnections.get(connectionId);
  const existingTokens = item.secrets.oauth?.tokens;
  const existingExpiry = existingTokens ? oauthTokenExpiry(existingTokens) : undefined;
  if (existing && !(existingTokens?.refresh_token && existingExpiry !== undefined && existingExpiry <= Date.now() + 30_000)) {
    return existing.connecting || existing.client;
  }
  if (existing) await closeMcpClient(connectionId);
  const client = new Client({ name: "sentinelgate-proxy", version: "0.1.0" });
  const transport = await transportFor(connectionId, item.value, item.secrets, runtimeEnv, fetchImpl);
  const active: ActiveConnection = { client, transport };
  active.connecting = client.connect(transport).then(() => { active.connecting = undefined; return client; }).catch((error) => { activeConnections.delete(connectionId); throw error; });
  activeConnections.set(connectionId, active);
  return active.connecting;
}

export async function closeMcpClient(connectionId: string): Promise<void> {
  const active = activeConnections.get(connectionId);
  activeConnections.delete(connectionId);
  if (active) await active.client.close().catch(() => undefined);
}

export async function discoverMcpConnection(connectionId: string, runtimeEnv: SentinelEnvironment = {}, fetchImpl: typeof fetch = fetch): Promise<JsonRecord> {
  const client = await getMcpClient(connectionId, runtimeEnv, fetchImpl);
  const tools = await client.listTools();
  return { tools: tools.tools, serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities(), instructions: client.getInstructions() };
}

export async function testMcpConnection(connectionId: string, runtimeEnv: SentinelEnvironment = {}, fetchImpl: typeof fetch = fetch): Promise<JsonRecord> {
  const client = await getMcpClient(connectionId, runtimeEnv, fetchImpl);
  await client.ping();
  return { ok: true, serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities() };
}

export async function callMcpTool(connectionId: string, name: string, args: JsonRecord, runtimeEnv: SentinelEnvironment = {}, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const client = await getMcpClient(connectionId, runtimeEnv, fetchImpl);
  return client.callTool({ name, arguments: args });
}

export function mcpClientConfig(connectionId: string, requestOrigin: string, token?: string): JsonRecord {
  const base = requestOrigin.replace(/\/$/, "");
  const url = `${base}/mcp/${encodeURIComponent(connectionId)}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const server = { url, ...(headers ? { headers } : {}) };
  return {
    connectionId,
    mcp: { url, transport: "streamable-http", ...(headers ? { headers } : {}) },
    claudeDesktop: { mcpServers: { [`sentinelgate-${connectionId}`]: server } },
    cursor: { mcpServers: { [`sentinelgate-${connectionId}`]: server } },
    note: token ? "This client token is shown only during explicit configuration generation. Store it as a secret." : "Generate a client token to authorize the proxy endpoint.",
  };
}

export function mcpJsonRpcError(id: unknown, code: number, message: string, data?: unknown): JsonRecord {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
