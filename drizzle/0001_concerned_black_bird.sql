CREATE TABLE `import_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`phase` text DEFAULT 'queued',
	`metadata` text NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_import_jobs_status_created` ON `import_jobs` (`status`,`created_at`);