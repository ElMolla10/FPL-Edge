CREATE INDEX IF NOT EXISTS `sessions_expires_at_idx` ON `sessions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `login_rate_limits_window_started_at_idx` ON `login_rate_limits` (`window_started_at`);
