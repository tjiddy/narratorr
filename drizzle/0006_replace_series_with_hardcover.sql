-- Replace Audible-relationships-backed series cache with Hardcover-backed shape.
-- Destructive: drops the legacy `series` and `series_members` rows entirely
-- (operator-accepted per the issue spec). On the next series-card GET with a
-- Hardcover key configured, the cache lazily repopulates from Hardcover.

DROP INDEX IF EXISTS `idx_series_members_provider_book_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_series_members_local_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_series_members_series_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_series_members_book_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_series_provider_series_id_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_series_normalized_name`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_series_next_fetch_after`;--> statement-breakpoint
DROP TABLE IF EXISTS `series_members`;--> statement-breakpoint
DROP TABLE IF EXISTS `series`;--> statement-breakpoint
CREATE TABLE `series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hardcover_series_id` integer,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`author_name` text,
	`description` text,
	`image_url` text,
	`last_fetched_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_hardcover_series_id_unique` ON `series` (`hardcover_series_id`) WHERE hardcover_series_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_series_normalized_name` ON `series` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `series_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`book_id` integer,
	`hardcover_book_id` integer,
	`slug` text,
	`image_url` text,
	`title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`author_name` text,
	`position` real,
	`source` text DEFAULT 'hardcover' NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_members_hardcover_book_unique` ON `series_members` (`series_id`,`hardcover_book_id`) WHERE hardcover_book_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_members_local_unique` ON `series_members` (`series_id`,`book_id`) WHERE hardcover_book_id IS NULL;--> statement-breakpoint
CREATE INDEX `idx_series_members_series_id` ON `series_members` (`series_id`);--> statement-breakpoint
CREATE INDEX `idx_series_members_book_id` ON `series_members` (`book_id`);
