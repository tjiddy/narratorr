CREATE TABLE `suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asin` text NOT NULL,
	`title` text NOT NULL,
	`author_name` text NOT NULL,
	`narrator_name` text,
	`cover_url` text,
	`duration` integer,
	`published_date` text,
	`language` text,
	`genres` text,
	`series_name` text,
	`series_position` real,
	`reason` text NOT NULL,
	`reason_context` text NOT NULL,
	`score` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`refreshed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`dismissed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_suggestions_status_score` ON `suggestions` (`status`,`score`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_suggestions_asin_unique` ON `suggestions` (`asin`);--> statement-breakpoint
DROP INDEX "authors_slug_unique";--> statement-breakpoint
DROP INDEX "idx_blacklist_info_hash";--> statement-breakpoint
DROP INDEX "idx_blacklist_book_id";--> statement-breakpoint
DROP INDEX "idx_book_events_book_id";--> statement-breakpoint
DROP INDEX "idx_book_events_event_type";--> statement-breakpoint
DROP INDEX "idx_book_events_created_at";--> statement-breakpoint
DROP INDEX "idx_book_events_download_id_event_type";--> statement-breakpoint
DROP INDEX "idx_books_author_id";--> statement-breakpoint
DROP INDEX "idx_books_status";--> statement-breakpoint
DROP INDEX "idx_books_path";--> statement-breakpoint
DROP INDEX "idx_books_enrichment_status";--> statement-breakpoint
DROP INDEX "idx_books_asin_unique";--> statement-breakpoint
DROP INDEX "idx_books_title_author_unique";--> statement-breakpoint
DROP INDEX "idx_download_clients_enabled";--> statement-breakpoint
DROP INDEX "idx_downloads_status";--> statement-breakpoint
DROP INDEX "idx_downloads_book_id";--> statement-breakpoint
DROP INDEX "idx_import_lists_enabled";--> statement-breakpoint
DROP INDEX "idx_indexers_enabled";--> statement-breakpoint
DROP INDEX "idx_notifiers_enabled";--> statement-breakpoint
DROP INDEX "idx_recycling_bin_deleted_at";--> statement-breakpoint
DROP INDEX "idx_remote_path_mappings_client";--> statement-breakpoint
DROP INDEX "idx_search_history_searched_at";--> statement-breakpoint
DROP INDEX "idx_suggestions_status_score";--> statement-breakpoint
DROP INDEX "idx_suggestions_asin_unique";--> statement-breakpoint
DROP INDEX "users_username_unique";--> statement-breakpoint
ALTER TABLE `blacklist` ALTER COLUMN "reason" TO "reason" text NOT NULL DEFAULT 'other';--> statement-breakpoint
CREATE UNIQUE INDEX `authors_slug_unique` ON `authors` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_blacklist_info_hash` ON `blacklist` (`info_hash`);--> statement-breakpoint
CREATE INDEX `idx_blacklist_book_id` ON `blacklist` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_book_events_book_id` ON `book_events` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_book_events_event_type` ON `book_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_book_events_created_at` ON `book_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_book_events_download_id_event_type` ON `book_events` (`download_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `idx_books_author_id` ON `books` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_books_status` ON `books` (`status`);--> statement-breakpoint
CREATE INDEX `idx_books_path` ON `books` (`path`);--> statement-breakpoint
CREATE INDEX `idx_books_enrichment_status` ON `books` (`enrichment_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_books_asin_unique` ON `books` (`asin`) WHERE asin IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_books_title_author_unique` ON `books` (`title`,`author_id`);--> statement-breakpoint
CREATE INDEX `idx_download_clients_enabled` ON `download_clients` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_downloads_status` ON `downloads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_downloads_book_id` ON `downloads` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_import_lists_enabled` ON `import_lists` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_indexers_enabled` ON `indexers` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_notifiers_enabled` ON `notifiers` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_recycling_bin_deleted_at` ON `recycling_bin` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_remote_path_mappings_client` ON `remote_path_mappings` (`download_client_id`);--> statement-breakpoint
CREATE INDEX `idx_search_history_searched_at` ON `search_history` (`searched_at`);--> statement-breakpoint
CREATE INDEX `idx_suggestions_status_score` ON `suggestions` (`status`,`score`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_suggestions_asin_unique` ON `suggestions` (`asin`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);