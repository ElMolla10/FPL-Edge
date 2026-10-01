CREATE TABLE IF NOT EXISTS `notification_prefs` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`notify_call_changes` integer NOT NULL DEFAULT 0,
	`last_call_hash` text,
	`last_call_json` text,
	`last_email_at` text,
	`emails_sent_utc_date` text,
	`emails_sent_today` integer NOT NULL DEFAULT 0,
	`last_flag_fingerprint` text,
	`last_checked_at` text,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notification_prefs_opted_in_idx` ON `notification_prefs` (`last_checked_at`) WHERE `notify_call_changes` = 1;
