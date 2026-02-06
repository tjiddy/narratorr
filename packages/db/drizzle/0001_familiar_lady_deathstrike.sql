CREATE TABLE `blacklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`info_hash` text NOT NULL,
	`title` text NOT NULL,
	`reason` text,
	`note` text,
	`blacklisted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `search_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`type` text NOT NULL,
	`results_count` integer,
	`searched_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `authors` ADD `asin` text;--> statement-breakpoint
ALTER TABLE `authors` ADD `image_url` text;--> statement-breakpoint
ALTER TABLE `authors` ADD `bio` text;--> statement-breakpoint
ALTER TABLE `authors` ADD `monitored` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `authors` ADD `last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `books` ADD `asin` text;--> statement-breakpoint
ALTER TABLE `books` ADD `isbn` text;--> statement-breakpoint
ALTER TABLE `books` ADD `series_name` text;--> statement-breakpoint
ALTER TABLE `books` ADD `series_position` real;--> statement-breakpoint
ALTER TABLE `books` ADD `duration` integer;--> statement-breakpoint
ALTER TABLE `books` ADD `published_date` text;--> statement-breakpoint
ALTER TABLE `books` ADD `genres` text;