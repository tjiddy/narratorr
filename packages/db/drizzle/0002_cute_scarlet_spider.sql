CREATE TABLE `unmatched_genres` (
	`genre` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`first_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch()) NOT NULL
);
