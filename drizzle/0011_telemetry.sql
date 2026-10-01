CREATE TABLE IF NOT EXISTS `telemetry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`event` text NOT NULL,
	`user_hash` text,
	`meta` text NOT NULL DEFAULT '{}',
	`path` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `telemetry_events_event_ts_idx` ON `telemetry_events` (`event`,`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `telemetry_events_user_hash_idx` ON `telemetry_events` (`user_hash`);
