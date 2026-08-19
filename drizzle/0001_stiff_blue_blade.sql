CREATE TABLE `import_list_exclusions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asin` text,
	`title` text NOT NULL,
	`author_name` text,
	`author_slug` text,
	`import_list_id` integer,
	`import_list_name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_list_id`) REFERENCES `import_lists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_import_list_exclusions_asin` ON `import_list_exclusions` (`asin`);--> statement-breakpoint
CREATE INDEX `idx_import_list_exclusions_author_slug` ON `import_list_exclusions` (`author_slug`);--> statement-breakpoint
CREATE INDEX `idx_import_list_exclusions_import_list_id` ON `import_list_exclusions` (`import_list_id`);