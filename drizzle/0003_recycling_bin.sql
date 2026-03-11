CREATE TABLE `recycling_bin` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`title` text NOT NULL,
	`author_name` text,
	`author_asin` text,
	`narrator` text,
	`description` text,
	`cover_url` text,
	`asin` text,
	`isbn` text,
	`series_name` text,
	`series_position` real,
	`duration` integer,
	`published_date` text,
	`genres` text,
	`monitor_for_upgrades` integer DEFAULT false NOT NULL,
	`original_path` text NOT NULL,
	`recycle_path` text NOT NULL,
	`deleted_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_recycling_bin_deleted_at` ON `recycling_bin` (`deleted_at`);
