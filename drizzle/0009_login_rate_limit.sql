CREATE TABLE `login_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`fail_count` integer NOT NULL DEFAULT 0,
	`window_started_at` text NOT NULL,
	`blocked_until` text,
	`updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
