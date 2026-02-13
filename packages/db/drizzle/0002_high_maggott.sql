PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_blacklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`info_hash` text NOT NULL,
	`title` text NOT NULL,
	`reason` text,
	`note` text,
	`blacklisted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_blacklist`("id", "book_id", "info_hash", "title", "reason", "note", "blacklisted_at") SELECT "id", "book_id", "info_hash", "title", "reason", "note", "blacklisted_at" FROM `blacklist`;--> statement-breakpoint
DROP TABLE `blacklist`;--> statement-breakpoint
ALTER TABLE `__new_blacklist` RENAME TO `blacklist`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`author_id` integer,
	`narrator` text,
	`description` text,
	`cover_url` text,
	`goodreads_id` text,
	`audible_id` text,
	`asin` text,
	`isbn` text,
	`series_name` text,
	`series_position` real,
	`duration` integer,
	`published_date` text,
	`genres` text,
	`status` text DEFAULT 'wanted' NOT NULL,
	`enrichment_status` text DEFAULT 'pending' NOT NULL,
	`path` text,
	`size` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_books`("id", "title", "author_id", "narrator", "description", "cover_url", "goodreads_id", "audible_id", "asin", "isbn", "series_name", "series_position", "duration", "published_date", "genres", "status", "enrichment_status", "path", "size", "created_at", "updated_at") SELECT "id", "title", "author_id", "narrator", "description", "cover_url", "goodreads_id", "audible_id", "asin", "isbn", "series_name", "series_position", "duration", "published_date", "genres", "status", "enrichment_status", "path", "size", "created_at", "updated_at" FROM `books`;--> statement-breakpoint
DROP TABLE `books`;--> statement-breakpoint
ALTER TABLE `__new_books` RENAME TO `books`;--> statement-breakpoint
CREATE INDEX `idx_books_author_id` ON `books` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_books_status` ON `books` (`status`);--> statement-breakpoint
CREATE TABLE `__new_downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`indexer_id` integer,
	`download_client_id` integer,
	`title` text NOT NULL,
	`protocol` text DEFAULT 'torrent' NOT NULL,
	`info_hash` text,
	`download_url` text,
	`size` integer,
	`seeders` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`external_id` text,
	`error_message` text,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`download_client_id`) REFERENCES `download_clients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_downloads`("id", "book_id", "indexer_id", "download_client_id", "title", "protocol", "info_hash", "download_url", "size", "seeders", "status", "progress", "external_id", "error_message", "added_at", "completed_at") SELECT "id", "book_id", "indexer_id", "download_client_id", "title", "protocol", "info_hash", "download_url", "size", "seeders", "status", "progress", "external_id", "error_message", "added_at", "completed_at" FROM `downloads`;--> statement-breakpoint
DROP TABLE `downloads`;--> statement-breakpoint
ALTER TABLE `__new_downloads` RENAME TO `downloads`;--> statement-breakpoint
CREATE INDEX `idx_downloads_status` ON `downloads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_downloads_book_id` ON `downloads` (`book_id`);