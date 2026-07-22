CREATE TABLE `import_submission_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`item_payload` text,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`disposition` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`book_id` integer,
	`existing_book_id` integer,
	`existing_title` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `import_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`existing_book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_import_submission_items_ordinal_unique` ON `import_submission_items` (`submission_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_import_submission_items_submission_disposition` ON `import_submission_items` (`submission_id`,`disposition`);--> statement-breakpoint
CREATE TABLE `import_submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_submission_id` text NOT NULL,
	`payload_digest` text NOT NULL,
	`source` text NOT NULL,
	`mode` text,
	`expected_count` integer NOT NULL,
	`status` text DEFAULT 'receiving' NOT NULL,
	`received_count` integer DEFAULT 0 NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`accepted_count` integer DEFAULT 0 NOT NULL,
	`held_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_submissions_client_submission_id_unique` ON `import_submissions` (`client_submission_id`);--> statement-breakpoint
CREATE INDEX `idx_import_submissions_status_updated` ON `import_submissions` (`status`,`updated_at`);