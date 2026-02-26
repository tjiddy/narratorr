CREATE TABLE `authors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`asin` text,
	`image_url` text,
	`bio` text,
	`monitored` integer DEFAULT false NOT NULL,
	`last_checked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_slug_unique` ON `authors` (`slug`);--> statement-breakpoint
CREATE TABLE `blacklist` (
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
CREATE TABLE `books` (
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
	`audio_codec` text,
	`audio_bitrate` integer,
	`audio_sample_rate` integer,
	`audio_channels` integer,
	`audio_bitrate_mode` text,
	`audio_file_format` text,
	`audio_file_count` integer,
	`audio_total_size` integer,
	`audio_duration` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_books_author_id` ON `books` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_books_status` ON `books` (`status`);--> statement-breakpoint
CREATE TABLE `download_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_download_clients_enabled` ON `download_clients` (`enabled`);--> statement-breakpoint
CREATE TABLE `downloads` (
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
CREATE INDEX `idx_downloads_status` ON `downloads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_downloads_book_id` ON `downloads` (`book_id`);--> statement-breakpoint
CREATE TABLE `indexers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`settings` text NOT NULL,
	`source` text,
	`source_indexer_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_indexers_enabled` ON `indexers` (`enabled`);--> statement-breakpoint
CREATE TABLE `notifiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notifiers_enabled` ON `notifiers` (`enabled`);--> statement-breakpoint
CREATE TABLE `remote_path_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`download_client_id` integer NOT NULL,
	`remote_path` text NOT NULL,
	`local_path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`download_client_id`) REFERENCES `download_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_path_mappings_client` ON `remote_path_mappings` (`download_client_id`);--> statement-breakpoint
CREATE TABLE `search_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`type` text NOT NULL,
	`results_count` integer,
	`searched_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_search_history_searched_at` ON `search_history` (`searched_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `unmatched_genres` (
	`genre` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`first_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);