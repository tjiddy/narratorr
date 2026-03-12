CREATE TABLE `import_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`settings` text NOT NULL,
	`sync_interval_minutes` integer DEFAULT 1440 NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`last_sync_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_import_lists_enabled` ON `import_lists` (`enabled`);--> statement-breakpoint
ALTER TABLE `books` ADD `import_list_id` integer REFERENCES `import_lists`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_books_asin_unique` ON `books` (`asin`) WHERE asin IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_books_title_author_unique` ON `books` (`title`, `author_id`);
