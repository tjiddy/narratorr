CREATE TABLE `series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`provider_series_id` text,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`description` text,
	`image_url` text,
	`last_fetched_at` integer,
	`last_fetch_status` text,
	`last_fetch_error` text,
	`next_fetch_after` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_provider_series_id_unique` ON `series` (`provider`,`provider_series_id`) WHERE provider_series_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_series_normalized_name` ON `series` (`provider`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `idx_series_next_fetch_after` ON `series` (`next_fetch_after`);--> statement-breakpoint
CREATE TABLE `series_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`book_id` integer,
	`provider_book_id` text,
	`title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`author_name` text,
	`position_raw` text,
	`position` real,
	`published_date` text,
	`cover_url` text,
	`duration` integer,
	`publisher` text,
	`source` text DEFAULT 'provider' NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_members_provider_book_unique` ON `series_members` (`series_id`,`provider_book_id`) WHERE provider_book_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_members_local_unique` ON `series_members` (`series_id`,`normalized_title`,`position_raw`) WHERE provider_book_id IS NULL;--> statement-breakpoint
CREATE INDEX `idx_series_members_series_id` ON `series_members` (`series_id`);--> statement-breakpoint
CREATE INDEX `idx_series_members_book_id` ON `series_members` (`book_id`);