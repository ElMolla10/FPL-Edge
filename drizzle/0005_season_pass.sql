CREATE TABLE `season_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`season_key` text NOT NULL,
	`ends_at` text NOT NULL,
	`amount_piasters` integer NOT NULL,
	`currency` text DEFAULT 'EGP' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`paymob_intention_id` text,
	`paymob_order_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`paid_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_checkouts_paymob_order_id_unique` ON `season_checkouts` (`paymob_order_id`);
--> statement-breakpoint
CREATE TABLE `season_passes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`season_key` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`amount_piasters` integer NOT NULL,
	`currency` text DEFAULT 'EGP' NOT NULL,
	`source` text NOT NULL,
	`paymob_transaction_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_passes_paymob_transaction_id_unique` ON `season_passes` (`paymob_transaction_id`);