CREATE TABLE `population_percentiles` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`event_finished` integer NOT NULL,
	`total_players` integer NOT NULL,
	`curve` text NOT NULL,
	`omitted_samples` integer NOT NULL,
	`sampled_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
