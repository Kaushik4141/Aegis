import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDatabase, type AppDatabase } from "../db/client";
import * as schema from "../db/schema";

export interface SandboxRecordInput {
  id: string;
  name: string;
  command: string[];
  mode: string;
  status: string;
  exitCode?: number;
  report?: unknown;
}

export interface SandboxSummary {
  id: string;
  name: string;
  command: string[];
  mode: string;
  status: string;
  exitCode?: number;
  report?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxEventRecord {
  id: string;
  sandboxId: string;
  type: string;
  detail: Record<string, unknown>;
  ts: string;
}

/**
 * Cloudflare D1 storage for sandbox lifecycle records and observed events.
 * The sandbox service owns container orchestration; the gateway owns durable
 * storage so events survive service restarts and feed the audit trail.
 */
export class SandboxStore {
  private dbPromise: Promise<{ db: AppDatabase; d1: D1Database }> | null = null;

  constructor(private readonly envDb?: D1Database) {}

  private async getDb() {
    if (!this.dbPromise) this.dbPromise = getDatabase(this.envDb);
    return this.dbPromise;
  }

  async upsert(record: SandboxRecordInput): Promise<SandboxSummary> {
    const now = new Date().toISOString();
    const { db } = await this.getDb();
    const [existing] = await db.select().from(schema.sandboxes).where(eq(schema.sandboxes.id, record.id));
    const row = {
      id: record.id,
      name: record.name,
      commandJson: JSON.stringify(record.command),
      mode: record.mode,
      status: record.status,
      exitCode: record.exitCode ?? null,
      reportJson: record.report ? JSON.stringify(record.report) : existing?.reportJson ?? null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await db.insert(schema.sandboxes).values(row).onConflictDoUpdate({
      target: schema.sandboxes.id,
      set: {
        name: row.name,
        commandJson: row.commandJson,
        mode: row.mode,
        status: row.status,
        exitCode: row.exitCode,
        reportJson: row.reportJson,
        updatedAt: row.updatedAt,
      },
    });
    return this.toSummary({ ...row, createdAt: row.createdAt, updatedAt: row.updatedAt });
  }

  async get(id: string): Promise<SandboxSummary | null> {
    const { db } = await this.getDb();
    const [row] = await db.select().from(schema.sandboxes).where(eq(schema.sandboxes.id, id));
    return row ? this.toSummary(row) : null;
  }

  async list(limit = 100): Promise<SandboxSummary[]> {
    const { db } = await this.getDb();
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = await db.select().from(schema.sandboxes).orderBy(desc(schema.sandboxes.updatedAt)).limit(safeLimit);
    return rows.map((row) => this.toSummary(row));
  }

  async insertEvent(sandboxId: string, event: { type: string; detail: Record<string, unknown>; ts: string }): Promise<SandboxEventRecord> {
    const { db } = await this.getDb();
    const record: SandboxEventRecord = {
      id: `sbev_${crypto.randomUUID()}`,
      sandboxId,
      type: event.type,
      detail: event.detail,
      ts: event.ts,
    };
    await db.insert(schema.sandboxEvents).values({
      id: record.id,
      sandboxId,
      type: record.type,
      detailJson: JSON.stringify(record.detail),
      ts: record.ts,
    });
    return record;
  }

  async listEvents(sandboxId: string, options: { type?: string; limit?: number } = {}): Promise<SandboxEventRecord[]> {
    const { db } = await this.getDb();
    const safeLimit = Math.min(2000, Math.max(1, Math.floor(options.limit ?? 500)));
    const where = options.type
      ? and(eq(schema.sandboxEvents.sandboxId, sandboxId), eq(schema.sandboxEvents.type, options.type))
      : eq(schema.sandboxEvents.sandboxId, sandboxId);
    const rows = await db.select().from(schema.sandboxEvents).where(where).orderBy(desc(schema.sandboxEvents.ts)).limit(safeLimit);
    return rows.map((row) => ({ id: row.id, sandboxId: row.sandboxId, type: row.type, detail: JSON.parse(row.detailJson), ts: row.ts }));
  }

  /** Cross-sandbox recent events, for the unified activity feed. */
  async listRecentEvents(options: { type?: string; limit?: number } = {}): Promise<SandboxEventRecord[]> {
    const { db } = await this.getDb();
    const safeLimit = Math.min(2000, Math.max(1, Math.floor(options.limit ?? 500)));
    const rows = options.type
      ? await db.select().from(schema.sandboxEvents).where(eq(schema.sandboxEvents.type, options.type)).orderBy(desc(schema.sandboxEvents.ts)).limit(safeLimit)
      : await db.select().from(schema.sandboxEvents).orderBy(desc(schema.sandboxEvents.ts)).limit(safeLimit);
    return rows.map((row) => ({ id: row.id, sandboxId: row.sandboxId, type: row.type, detail: JSON.parse(row.detailJson), ts: row.ts }));
  }

  private toSummary(row: typeof schema.sandboxes.$inferSelect): SandboxSummary {
    return {
      id: row.id,
      name: row.name,
      command: JSON.parse(row.commandJson) as string[],
      mode: row.mode,
      status: row.status,
      ...(row.exitCode === null || row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
      ...(row.reportJson ? { report: JSON.parse(row.reportJson) } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

let defaultStore: SandboxStore | undefined;

export function getSandboxStore(envDb?: D1Database): SandboxStore {
  if (!defaultStore) defaultStore = new SandboxStore(envDb);
  return defaultStore;
}
