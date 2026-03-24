CREATE TABLE `book_authors` (
	`book_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`book_id`, `author_id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_book_authors_book_id` ON `book_authors` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_book_authors_author_id` ON `book_authors` (`author_id`);--> statement-breakpoint
CREATE TABLE `book_narrators` (
	`book_id` integer NOT NULL,
	`narrator_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`book_id`, `narrator_id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_book_narrators_book_id` ON `book_narrators` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_book_narrators_narrator_id` ON `book_narrators` (`narrator_id`);--> statement-breakpoint
CREATE TABLE `narrators` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `narrators_slug_unique` ON `narrators` (`slug`);--> statement-breakpoint
DROP INDEX `idx_books_author_id`;--> statement-breakpoint
DROP INDEX `idx_books_title_author_unique`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
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
	`monitor_for_upgrades` integer DEFAULT false NOT NULL,
	`import_list_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_list_id`) REFERENCES `import_lists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_books`(`id`,`title`,`description`,`cover_url`,`goodreads_id`,`audible_id`,`asin`,`isbn`,`series_name`,`series_position`,`duration`,`published_date`,`genres`,`status`,`enrichment_status`,`path`,`size`,`audio_codec`,`audio_bitrate`,`audio_sample_rate`,`audio_channels`,`audio_bitrate_mode`,`audio_file_format`,`audio_file_count`,`audio_total_size`,`audio_duration`,`monitor_for_upgrades`,`import_list_id`,`created_at`,`updated_at`) SELECT `id`,`title`,`description`,`cover_url`,`goodreads_id`,`audible_id`,`asin`,`isbn`,`series_name`,`series_position`,`duration`,`published_date`,`genres`,`status`,`enrichment_status`,`path`,`size`,`audio_codec`,`audio_bitrate`,`audio_sample_rate`,`audio_channels`,`audio_bitrate_mode`,`audio_file_format`,`audio_file_count`,`audio_total_size`,`audio_duration`,`monitor_for_upgrades`,`import_list_id`,`created_at`,`updated_at` FROM `books`;--> statement-breakpoint
DROP TABLE `books`;--> statement-breakpoint
ALTER TABLE `__new_books` RENAME TO `books`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_books_status` ON `books` (`status`);--> statement-breakpoint
CREATE INDEX `idx_books_path` ON `books` (`path`);--> statement-breakpoint
CREATE INDEX `idx_books_enrichment_status` ON `books` (`enrichment_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_books_asin_unique` ON `books` (`asin`) WHERE asin IS NOT NULL;--> statement-breakpoint
ALTER TABLE `book_events` ADD `narrator_name` text;
