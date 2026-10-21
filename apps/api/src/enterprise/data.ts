import { count } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { customers, billing } from "../db/schema";

function validateStatement(sql: string): string {
  const statement = sql.trim();
  if (!statement) throw new Error("SQL query cannot be empty.");
  if (/;\s*\S/.test(statement)) throw new Error("Multiple SQL statements are not permitted.");
  return statement;
}

export async function queryEnterprise(
  sql: string,
  params: unknown[] = [],
  envDb?: D1Database,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const statement = validateStatement(sql);
  if (!/^select\b/i.test(statement) && !/^pragma\b/i.test(statement) && !/^with\b[\s\S]*\bselect\b/i.test(statement)) {
    throw new Error("Enterprise explorer only permits read-only SQL (SELECT, WITH ... SELECT, or PRAGMA).");
  }
  const { d1 } = await getDatabase(envDb);
  const prepared = params.length > 0 ? d1.prepare(statement).bind(...params) : d1.prepare(statement);
  const result = await prepared.all();
  const rows = (result.results || []) as Record<string, unknown>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

/**
 * Execute one approved warehouse statement. Explorer queries stay read-only,
 * while the action executor may run explicit DML after policy approval.
 */
export async function executeEnterpriseSql(
  sql: string,
  params: unknown[] = [],
  envDb?: D1Database,
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; changes?: number; lastInsertRowid?: number | bigint }> {
  const statement = validateStatement(sql);
  if (/^(select|pragma|with)\b/i.test(statement)) {
    return queryEnterprise(statement, params, envDb);
  }
  if (!/^(insert|update|delete|replace)\b/i.test(statement)) {
    throw new Error("Enterprise execution only permits SELECT, INSERT, UPDATE, DELETE, or REPLACE statements.");
  }
  const { d1 } = await getDatabase(envDb);
  const prepared = params.length > 0 ? d1.prepare(statement).bind(...params) : d1.prepare(statement);
  const result = await prepared.run();
  return {
    columns: [],
    rows: [],
    changes: result.meta?.changes ?? 0,
    lastInsertRowid: result.meta?.last_row_id ?? undefined,
  };
}

/**
 * Calculate the exact rows a supported UPDATE/DELETE would affect without mutating the warehouse.
 */
export async function dryRunMutation(
  sql: string,
  params: unknown[] = [],
  envDb?: D1Database,
): Promise<{ statement: string; affected: number; preview: Record<string, unknown>[] }> {
  const statement = validateStatement(sql);
  const match = statement.match(/^\s*(DELETE\s+FROM|UPDATE)\s+([A-Za-z_][\w]*)(?:\s+SET[\s\S]*?\s+WHERE\s+([\s\S]+)|\s+WHERE\s+([\s\S]+))?\s*$/i);
  if (!match) return { statement, affected: 0, preview: [] };
  const table = match[2];
  if (!/^(CUSTOMERS|BILLING)$/i.test(table)) throw new Error("Dry-run is only available for CUSTOMERS and BILLING.");
  const where = match[3] || match[4];
  const select = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""} LIMIT 20`;
  const countSql = `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const { d1 } = await getDatabase(envDb);
  const countPrepared = params.length > 0 ? d1.prepare(countSql).bind(...params) : d1.prepare(countSql);
  const countRes = await countPrepared.first<{ count: number }>();
  const preview = (await queryEnterprise(select, params, envDb)).rows;
  return { statement, affected: Number(countRes?.count ?? 0), preview };
}

export async function enterpriseCounts(envDb?: D1Database): Promise<{ customers: number; billing: number }> {
  const { db } = await getDatabase(envDb);
  const [cust] = await db.select({ value: count() }).from(customers);
  const [bill] = await db.select({ value: count() }).from(billing);
  return {
    customers: cust?.value ?? 0,
    billing: bill?.value ?? 0,
  };
}

export async function listCustomers(limit = 100, envDb?: D1Database): Promise<Record<string, unknown>[]> {
  const { db } = await getDatabase(envDb);
  const rows = await db.select().from(customers).limit(Math.min(500, Math.max(1, limit)));
  return rows as unknown as Record<string, unknown>[];
}

export async function listBilling(limit = 250, envDb?: D1Database): Promise<Record<string, unknown>[]> {
  const { db } = await getDatabase(envDb);
  const rows = await db.select().from(billing).limit(Math.min(500, Math.max(1, limit)));
  return rows as unknown as Record<string, unknown>[];
}
