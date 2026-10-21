CREATE TABLE `AUDIT_LOGS` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`action_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`actor_id` text,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text,
	`request_id` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_timestamp` ON `AUDIT_LOGS` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `AUDIT_LOGS` (`action_id`);--> statement-breakpoint
CREATE TABLE `BILLING` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`amount_usd` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`status` text NOT NULL,
	`card_last4` text,
	`invoice_date` text NOT NULL,
	`billing_date` text,
	FOREIGN KEY (`customer_id`) REFERENCES `CUSTOMERS`(`customer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `BILLING_invoice_id_unique` ON `BILLING` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_customer` ON `BILLING` (`customer_id`);--> statement-breakpoint
CREATE TABLE `CUSTOMERS` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`ssn_masked` text,
	`tier` text,
	`segment` text NOT NULL,
	`region` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `CUSTOMERS_customer_id_unique` ON `CUSTOMERS` (`customer_id`);--> statement-breakpoint
CREATE TABLE `MCP_CONNECTIONS` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`config_json` text NOT NULL,
	`secret_json` text,
	`token_hash` text,
	`oauth_state_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_connections_updated` ON `MCP_CONNECTIONS` (`updated_at`);--> statement-breakpoint
CREATE TABLE `PENDING_ACTIONS` (
	`id` text PRIMARY KEY NOT NULL,
	`action_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pending_status` ON `PENDING_ACTIONS` (`status`,`updated_at`);