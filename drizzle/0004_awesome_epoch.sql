DROP INDEX `idx_downloads_status`;--> statement-breakpoint
DROP INDEX `idx_downloads_status_completed`;--> statement-breakpoint
CREATE INDEX `idx_downloads_status` ON `downloads` (`client_status`,`pipeline_stage`);--> statement-breakpoint
CREATE INDEX `idx_downloads_status_completed` ON `downloads` (`client_status`,`completed_at`);--> statement-breakpoint
ALTER TABLE `downloads` DROP COLUMN `status`;