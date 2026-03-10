ALTER TABLE `blacklist` ADD `blacklist_type` text DEFAULT 'permanent' NOT NULL;--> statement-breakpoint
ALTER TABLE `blacklist` ADD `expires_at` integer;
