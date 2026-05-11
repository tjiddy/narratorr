DROP INDEX `idx_series_members_local_unique`;--> statement-breakpoint
ALTER TABLE `series_members` ADD `alternate_asins` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_members_local_unique` ON `series_members` (`series_id`,`normalized_title`,`position_raw`,`author_name`) WHERE provider_book_id IS NULL;