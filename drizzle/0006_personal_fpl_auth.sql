CREATE TABLE `personal_fpl_auth` (
	`id` text PRIMARY KEY NOT NULL,
	`refresh_token` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
