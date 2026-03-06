CREATE TABLE `book_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`download_id` integer,
	`book_title` text NOT NULL,
	`author_name` text,
	`event_type` text NOT NULL,
	`source` text DEFAULT 'auto' NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`download_id`) REFERENCES `downloads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_book_events_book_id` ON `book_events` (`book_id`);--> statement-breakpoint
CREATE INDEX `idx_book_events_event_type` ON `book_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_book_events_created_at` ON `book_events` (`created_at`);