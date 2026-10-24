CREATE TABLE `SANDBOX_EVENTS` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`type` text NOT NULL,
	`detail_json` text NOT NULL,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sandbox_events_sandbox` ON `SANDBOX_EVENTS` (`sandbox_id`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_events_type` ON `SANDBOX_EVENTS` (`type`);--> statement-breakpoint
CREATE TABLE `SANDBOXES` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`command_json` text NOT NULL,
	`mode` text DEFAULT 'observe' NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`report_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sandboxes_updated` ON `SANDBOXES` (`updated_at`);