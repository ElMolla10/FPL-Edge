ALTER TABLE `users` ADD `is_owner` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `entitlement_status` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `entitlement_expires_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `stripe_customer_id` text;