-- Backfill any NULL reasons before applying NOT NULL constraint
UPDATE `blacklist` SET `reason` = 'other' WHERE `reason` IS NULL;--> statement-breakpoint
-- SQLite doesn't support ALTER COLUMN — rebuild the table with NOT NULL on reason
CREATE TABLE `blacklist_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`info_hash` text NOT NULL,
	`title` text NOT NULL,
	`reason` text DEFAULT 'other' NOT NULL,
	`note` text,
	`blacklisted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`blacklist_type` text DEFAULT 'permanent' NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `blacklist_new` SELECT `id`, `book_id`, `info_hash`, `title`, `reason`, `note`, `blacklisted_at`, `blacklist_type`, `expires_at` FROM `blacklist`;--> statement-breakpoint
DROP TABLE `blacklist`;--> statement-breakpoint
ALTER TABLE `blacklist_new` RENAME TO `blacklist`;--> statement-breakpoint
CREATE INDEX `idx_blacklist_info_hash` ON `blacklist` (`info_hash`);--> statement-breakpoint
CREATE INDEX `idx_blacklist_book_id` ON `blacklist` (`book_id`);
