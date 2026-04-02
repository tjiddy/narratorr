ALTER TABLE `downloads` ADD `pending_cleanup` integer;--> statement-breakpoint
CREATE INDEX `idx_downloads_pending_cleanup` ON `downloads` (`pending_cleanup`);