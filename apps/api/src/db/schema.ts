import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("CUSTOMERS", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: text("customer_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  ssnMasked: text("ssn_masked"),
  tier: text("tier"),
  segment: text("segment").notNull(),
  region: text("region").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
});

export const billing = sqliteTable("BILLING", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: text("invoice_id").notNull().unique(),
  customerId: text("customer_id").notNull().references(() => customers.customerId),
  amountCents: integer("amount_cents").notNull(),
  amountUsd: real("amount_usd"),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull(),
  cardLast4: text("card_last4"),
  invoiceDate: text("invoice_date").notNull(),
  billingDate: text("billing_date"),
}, (table) => [
  index("idx_billing_customer").on(table.customerId),
]);

export const auditLogs = sqliteTable("AUDIT_LOGS", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  actionId: text("action_id").notNull(),
  timestamp: text("timestamp").notNull(),
  actorId: text("actor_id"),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason"),
  requestId: text("request_id"),
  metadataJson: text("metadata_json"),
}, (table) => [
  index("idx_audit_timestamp").on(table.timestamp),
  index("idx_audit_action").on(table.actionId),
]);

export const pendingActions = sqliteTable("PENDING_ACTIONS", {
  id: text("id").primaryKey(),
  actionJson: text("action_json").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_pending_status").on(table.status, table.updatedAt),
]);

export const mcpConnections = sqliteTable("MCP_CONNECTIONS", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  transport: text("transport").notNull(),
  configJson: text("config_json").notNull(),
  secretJson: text("secret_json"),
  tokenHash: text("token_hash"),
  oauthStateHash: text("oauth_state_hash"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_mcp_connections_updated").on(table.updatedAt),
]);

export const sandboxes = sqliteTable("SANDBOXES", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  commandJson: text("command_json").notNull(),
  mode: text("mode").notNull().default("observe"),
  status: text("status").notNull(),
  exitCode: integer("exit_code"),
  reportJson: text("report_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_sandboxes_updated").on(table.updatedAt),
]);

export const sandboxEvents = sqliteTable("SANDBOX_EVENTS", {
  id: text("id").primaryKey(),
  sandboxId: text("sandbox_id").notNull(),
  type: text("type").notNull(),
  detailJson: text("detail_json").notNull(),
  ts: text("ts").notNull(),
}, (table) => [
  index("idx_sandbox_events_sandbox").on(table.sandboxId, table.ts),
  index("idx_sandbox_events_type").on(table.type),
]);

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

export type Billing = typeof billing.$inferSelect;
export type InsertBilling = typeof billing.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

export type PendingAction = typeof pendingActions.$inferSelect;
export type InsertPendingAction = typeof pendingActions.$inferInsert;

export type McpConnection = typeof mcpConnections.$inferSelect;
export type InsertMcpConnection = typeof mcpConnections.$inferInsert;

export type Sandbox = typeof sandboxes.$inferSelect;
export type InsertSandbox = typeof sandboxes.$inferInsert;

export type SandboxEventRow = typeof sandboxEvents.$inferSelect;
export type InsertSandboxEvent = typeof sandboxEvents.$inferInsert;
