import { EventEmitter } from "node:events";
import { desc, eq } from "drizzle-orm";
import { getDatabase, type AppDatabase } from "../db/client";
import * as schema from "../db/schema";
import type { ActionRecord, ActionStatus, AuditEvent, SentinelEnvironment, SentinelStore } from "./types";

const DEFAULT_LIMIT = 100;
const MAX_AUDIT_EVENTS = 5_000;

function copy<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-memory store for isolated unit tests.
 */
export class InMemoryStore implements SentinelStore {
  private readonly actions = new Map<string, ActionRecord>();
  private readonly audit: AuditEvent[] = [];
  private readonly events = new EventEmitter();

  async getAction(id: string): Promise<ActionRecord | null> {
    return copy(this.actions.get(id) ?? null);
  }

  async putAction(action: ActionRecord): Promise<void> {
    const value = copy(action);
    this.actions.set(action.id, value);
    this.events.emit("action.updated", copy(value));
  }

  async listActions(limit = DEFAULT_LIMIT): Promise<ActionRecord[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    return Array.from(this.actions.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, safeLimit)
      .map(copy);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(copy(event));
    if (this.audit.length > MAX_AUDIT_EVENTS) this.audit.splice(0, this.audit.length - MAX_AUDIT_EVENTS);
    this.events.emit("audit", copy(event));
  }

  async listAudit(limit = DEFAULT_LIMIT, actionId?: string): Promise<AuditEvent[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    return this.audit
      .filter((event) => !actionId || event.actionId === actionId)
      .slice(-safeLimit)
      .reverse()
      .map(copy);
  }

  on(event: "action.updated" | "audit", listener: (value: ActionRecord | AuditEvent) => void): () => void {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }
}

/**
 * Cloudflare D1 store backed by Drizzle ORM.
 */
export class D1DrizzleStore implements SentinelStore {
  private readonly events = new EventEmitter();
  private dbPromise: Promise<{ db: AppDatabase; d1: D1Database }> | null = null;

  constructor(private readonly envDb?: D1Database) {}

  private async getDb() {
    if (!this.dbPromise) {
      this.dbPromise = getDatabase(this.envDb);
    }
    return this.dbPromise;
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    const { db } = await this.getDb();
    const [row] = await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, id));
    return row ? copy(JSON.parse(row.actionJson) as ActionRecord) : null;
  }

  async putAction(action: ActionRecord): Promise<void> {
    const { db } = await this.getDb();
    await db.insert(schema.pendingActions).values({
      id: action.id,
      actionJson: JSON.stringify(action),
      status: action.status,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
    }).onConflictDoUpdate({
      target: schema.pendingActions.id,
      set: {
        actionJson: JSON.stringify(action),
        status: action.status,
        updatedAt: action.updatedAt,
      },
    });
    this.events.emit("action.updated", copy(action));
  }

  async listActions(limit = DEFAULT_LIMIT): Promise<ActionRecord[]> {
    const { db } = await this.getDb();
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const rows = await db.select()
      .from(schema.pendingActions)
      .orderBy(desc(schema.pendingActions.updatedAt))
      .limit(safeLimit);
    return rows.map((row) => copy(JSON.parse(row.actionJson) as ActionRecord));
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    const { db } = await this.getDb();
    await db.insert(schema.auditLogs).values({
      id: event.id,
      type: event.type,
      actionId: event.actionId,
      timestamp: event.timestamp,
      actorId: event.actorId || null,
      fromStatus: event.fromStatus || null,
      toStatus: event.toStatus,
      reason: event.reason || null,
      requestId: event.requestId || null,
      metadataJson: event.metadata ? JSON.stringify(event.metadata) : null,
    }).onConflictDoUpdate({
      target: schema.auditLogs.id,
      set: {
        type: event.type,
        actionId: event.actionId,
        timestamp: event.timestamp,
        actorId: event.actorId || null,
        fromStatus: event.fromStatus || null,
        toStatus: event.toStatus,
        reason: event.reason || null,
        requestId: event.requestId || null,
        metadataJson: event.metadata ? JSON.stringify(event.metadata) : null,
      },
    });
    this.events.emit("audit", copy(event));
  }

  async listAudit(limit = DEFAULT_LIMIT, actionId?: string): Promise<AuditEvent[]> {
    const { db } = await this.getDb();
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const rows = actionId
      ? await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actionId, actionId)).orderBy(desc(schema.auditLogs.timestamp)).limit(safeLimit)
      : await db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.timestamp)).limit(safeLimit);

    return rows.map((row) => ({
      id: row.id,
      type: row.type as AuditEvent["type"],
      actionId: row.actionId,
      timestamp: row.timestamp,
      actorId: row.actorId || undefined,
      fromStatus: (row.fromStatus as ActionStatus) || undefined,
      toStatus: row.toStatus as ActionStatus,
      reason: row.reason || undefined,
      requestId: row.requestId || undefined,
      metadata: row.metadataJson ? JSON.parse(row.metadataJson) : undefined,
    }));
  }

  on(event: "action.updated" | "audit", listener: (value: ActionRecord | AuditEvent) => void): () => void {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }
}

export const MemoryStore = InMemoryStore;

export interface UpstashStoreOptions {
  url: string;
  token: string;
  namespace?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Dependency-free Upstash REST adapter.
 */
export class UpstashStore implements SentinelStore {
  private readonly url: string;
  private readonly token: string;
  private readonly namespace: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UpstashStoreOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.token = options.token;
    this.namespace = options.namespace || "default";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private key(kind: string, id?: string): string {
    return id ? `sentinelgate:${this.namespace}:${kind}:${id}` : `sentinelgate:${this.namespace}:${kind}`;
  }

  private async command<T = unknown>(command: Array<string | number>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
    } catch (error) {
      throw new Error(`Upstash request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!response.ok || body.error) throw new Error(`Upstash command failed: ${body.error || response.statusText}`);
    return body.result as T;
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    const result = await this.command<string | null>(["GET", this.key("action", id)]);
    return result ? (JSON.parse(result) as ActionRecord) : null;
  }

  async putAction(action: ActionRecord): Promise<void> {
    const actionKey = this.key("action", action.id);
    const indexKey = this.key("actions");
    await this.command(["SET", actionKey, JSON.stringify(action)]);
    await this.command(["LPUSH", indexKey, action.id]);
    await this.command(["LTRIM", indexKey, 0, 999]);
  }

  async listActions(limit = DEFAULT_LIMIT): Promise<ActionRecord[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const ids = (await this.command<string[]>(["LRANGE", this.key("actions"), 0, Math.max(0, safeLimit * 3 - 1)])) || [];
    const uniqueIds = [...new Set(ids)].slice(0, safeLimit);
    const values = await Promise.all(uniqueIds.map((id) => this.getAction(id)));
    return values.filter((value): value is ActionRecord => Boolean(value));
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    const key = this.key("audit");
    await this.command(["RPUSH", key, JSON.stringify(event)]);
    await this.command(["LTRIM", key, -MAX_AUDIT_EVENTS, -1]);
  }

  async listAudit(limit = DEFAULT_LIMIT, actionId?: string): Promise<AuditEvent[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const values = (await this.command<string[]>(["LRANGE", this.key("audit"), -safeLimit, -1])) || [];
    const events = values
      .map((value) => JSON.parse(value) as AuditEvent)
      .filter((event) => !actionId || event.actionId === actionId);
    return events.reverse();
  }

  on(): () => void {
    return () => undefined;
  }
}

export function createStore(
  env: SentinelEnvironment = {},
  options: { fetchImpl?: typeof fetch; namespace?: string; d1?: D1Database } = {},
): SentinelStore {
  if (env.SENTINEL_STORE === "memory") return new InMemoryStore();
  if (env.SENTINEL_STORE === "upstash" || (!env.SENTINEL_STORE && env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)) {
    return new UpstashStore({
      url: env.UPSTASH_REDIS_REST_URL as string,
      token: env.UPSTASH_REDIS_REST_TOKEN as string,
      namespace: options.namespace || env.SENTINEL_REDIS_NAMESPACE,
      fetchImpl: options.fetchImpl,
    });
  }
  // Default store is Cloudflare D1 with Drizzle ORM
  return new D1DrizzleStore(options.d1);
}
