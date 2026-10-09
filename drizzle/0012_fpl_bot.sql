-- Autonomous FPL bot (app/lib/fpl-bot). All tables are bot_* and share nothing with personal_fpl_auth.
-- Tokens are stored AES-GCM encrypted (FPL_EDGE_BOT_TOKEN_KEY); *_hash columns are SHA-256 of the plaintext
-- refresh token, used only for compare-and-swap / lease checks.
CREATE TABLE IF NOT EXISTS `bot_fpl_auth` (
	`id` text PRIMARY KEY NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`access_token_enc` text,
	`access_expires_at` text,
	`refresh_lease_until` text,
	`session_started_at` text,
	`last_ok_at` text,
	`last_error` text,
	`identity_entry` text,
	`identity_checked_at` text,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_state` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text,
	`kill` integer NOT NULL DEFAULT 0,
	`kill_reason` text,
	`gw_kill_event` integer,
	`gw_kill_reason` text,
	`dry_run_passed_at` text,
	`dry_run_entry` text,
	`last_tick_at` text,
	`last_tick_summary` text,
	`last_alert_key` text,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_lock` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text,
	`lease_until` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry` text NOT NULL,
	`gw` integer NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`mode` text,
	`decision_hash` text,
	`pre_state_hash` text,
	`target_state_hash` text,
	`payload_json` text,
	`summary` text,
	`attempt` integer NOT NULL DEFAULT 0,
	`lease_until` integer,
	`response_status` integer,
	`response_excerpt` text,
	`error` text,
	`verified_at` text,
	`created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `bot_runs_entry_gw_step_uq` ON `bot_runs` (`entry`,`gw`,`step`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry` text,
	`gw` integer NOT NULL,
	`step` text NOT NULL,
	`mode` text NOT NULL,
	`decision_hash` text,
	`summary_json` text NOT NULL,
	`created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bot_decisions_gw_created_idx` ON `bot_decisions` (`gw`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry` text NOT NULL,
	`gw` integer NOT NULL,
	`kind` text NOT NULL,
	`status` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bot_posts_created_idx` ON `bot_posts` (`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bot_errors_created_idx` ON `bot_errors` (`created_at`);
