ALTER TABLE `downloads` ADD `client_status` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `downloads` ADD `pipeline_stage` text DEFAULT 'idle' NOT NULL;