ALTER TABLE `memory_states` ADD `review_progress` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `review_intensity` text DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `time_zone` text;