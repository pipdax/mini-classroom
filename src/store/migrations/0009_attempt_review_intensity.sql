ALTER TABLE `attempts` ADD `review_intensity` text DEFAULT 'high' NOT NULL;--> statement-breakpoint
UPDATE `attempts` SET `review_intensity` = (SELECT `review_intensity` FROM `sessions` WHERE `sessions`.`id` = `attempts`.`session_id`);
