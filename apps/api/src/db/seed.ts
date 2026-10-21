import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { count } from "drizzle-orm";
import { getDatabase } from "./client";
import { customers, billing, mcpConnections, auditLogs, pendingActions } from "./schema";

export async function seedD1Database(envDb?: D1Database): Promise<{ seeded: boolean; customers: number; billing: number }> {
  const { db, d1 } = await getDatabase(envDb);

  const [customerCountResult] = await db.select({ value: count() }).from(customers);
  const existingCustomers = customerCountResult?.value ?? 0;

  if (existingCustomers < 100) {
    const customerRows: Array<typeof customers.$inferInsert> = [];
    for (let i = 1; i <= 100; i += 1) {
      const n = String(i).padStart(3, "0");
      customerRows.push({
        id: i,
        customerId: `cus_${n}`,
        name: ["Avery", "Jordan", "Taylor", "Morgan"][i % 4] + ` Customer ${n}`,
        email: `customer${n}@acme.example`,
        phone: `+1-555-${String(1000 + i).slice(-4)}`,
        ssnMasked: `***-**-${String(1000 + i).slice(-4)}`,
        tier: i % 4 === 0 ? "enterprise" : i % 3 === 0 ? "pro" : "growth",
        segment: i % 4 === 0 ? "enterprise" : "growth",
        region: ["us-east-1", "us-west-2", "eu-west-1"][i % 3],
        status: "active",
        createdAt: new Date(Date.UTC(2024, 0, i)).toISOString(),
      });
    }

    // Insert in small chunks (5 rows) to stay well within Cloudflare D1's variable limit (<100 variables)
    for (let i = 0; i < customerRows.length; i += 5) {
      const chunk = customerRows.slice(i, i + 5);
      await db.insert(customers).values(chunk).onConflictDoNothing();
    }
  }

  const [billingCountResult] = await db.select({ value: count() }).from(billing);
  const existingBilling = billingCountResult?.value ?? 0;

  if (existingBilling < 250) {
    const billingRows: Array<typeof billing.$inferInsert> = [];
    for (let i = 1; i <= 250; i += 1) {
      const customer = `cus_${String(((i - 1) % 100) + 1).padStart(3, "0")}`;
      const cents = 12500 + ((i * 731) % 87500);
      const date = new Date(Date.UTC(2025, i % 12, ((i - 1) % 28) + 1)).toISOString().slice(0, 10);
      billingRows.push({
        id: i,
        invoiceId: `inv_${String(i).padStart(5, "0")}`,
        customerId: customer,
        amountCents: cents,
        amountUsd: cents / 100,
        currency: "USD",
        status: i % 11 === 0 ? "pending" : "paid",
        cardLast4: String(1000 + ((i * 37) % 8999)).slice(-4),
        invoiceDate: date,
        billingDate: date,
      });
    }

    for (let i = 0; i < billingRows.length; i += 5) {
      const chunk = billingRows.slice(i, i + 5);
      await db.insert(billing).values(chunk).onConflictDoNothing();
    }
  }

  // Migrate any previous local SQLite audit/connections data if present
  const oldAuditPath = path.resolve(process.cwd(), "data/sentinel_audit.sqlite");
  if (fs.existsSync(oldAuditPath)) {
    try {
      const legacyDb = new Database(oldAuditPath, { readonly: true });
      const legacyConns = legacyDb.prepare("SELECT * FROM MCP_CONNECTIONS").all() as Array<Record<string, unknown>>;
      for (const conn of legacyConns) {
        await db.insert(mcpConnections).values({
          id: conn.id as string,
          name: conn.name as string,
          transport: conn.transport as string,
          configJson: conn.config_json as string,
          secretJson: (conn.secret_json as string) || null,
          tokenHash: (conn.token_hash as string) || null,
          oauthStateHash: (conn.oauth_state_hash as string) || null,
          createdAt: conn.created_at as string,
          updatedAt: conn.updated_at as string,
        }).onConflictDoNothing();
      }
      legacyDb.close();
    } catch {
      // Legacy SQLite file might not have the tables or already migrated
    }
  }

  const [finalCust] = await db.select({ value: count() }).from(customers);
  const [finalBill] = await db.select({ value: count() }).from(billing);

  return {
    seeded: true,
    customers: finalCust?.value ?? 0,
    billing: finalBill?.value ?? 0,
  };
}

// Allow running directly via tsx / node
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  seedD1Database()
    .then((result) => {
      console.log(`[D1 Seed] Complete: ${result.customers} customers, ${result.billing} billing invoices.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[D1 Seed] Error:", err);
      process.exit(1);
    });
}
