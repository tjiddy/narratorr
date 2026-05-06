CREATE TABLE `settings_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` integer DEFAULT (unixepoch()) NOT NULL
);
