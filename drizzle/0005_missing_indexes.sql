CREATE INDEX `idx_books_path` ON `books` (`path`);--> statement-breakpoint
CREATE INDEX `idx_books_enrichment_status` ON `books` (`enrichment_status`);--> statement-breakpoint
CREATE INDEX `idx_book_events_download_id_event_type` ON `book_events` (`download_id`, `event_type`);--> statement-breakpoint
CREATE INDEX `idx_blacklist_info_hash` ON `blacklist` (`info_hash`);--> statement-breakpoint
CREATE INDEX `idx_blacklist_book_id` ON `blacklist` (`book_id`);
