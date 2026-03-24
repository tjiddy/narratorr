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
ALTER TABLE `books` DROP COLUMN `author_id`;--> statement-breakpoint
ALTER TABLE `books` DROP COLUMN `narrator`;--> statement-breakpoint
ALTER TABLE `book_events` ADD `narrator_name` text;