CREATE INDEX `idx_books_author_id` ON `books` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_books_status` ON `books` (`status`);--> statement-breakpoint
CREATE INDEX `idx_download_clients_enabled` ON `download_clients` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_downloads_status` ON `downloads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_downloads_book_id` ON `downloads` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_indexers_enabled` ON `indexers` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_search_history_searched_at` ON `search_history` (`searched_at`);