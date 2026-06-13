-- Backfill the two-axis download state (#1445) from the legacy `status` column.
-- This is the exact inverse of `deriveDisplayStatus` (see download-status-registry.ts):
--   * client-only display values  → corresponding clientStatus, pipelineStage='idle'
--     (so legacy `failed` → clientStatus='failed', pipelineStage='idle')
--   * pipeline display values     → clientStatus='completed' (the client download had
--     finished) with the corresponding pipelineStage
-- The overloaded `completed` literal is disambiguated here: a legacy `completed` row is
-- pure client truth (clientStatus='completed', pipelineStage='idle'); the auto-import
-- "approved" outcome lived in the pipeline values, never in clientStatus.
UPDATE `downloads` SET `client_status` = 'queued', `pipeline_stage` = 'idle' WHERE `status` = 'queued';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'downloading', `pipeline_stage` = 'idle' WHERE `status` = 'downloading';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'paused', `pipeline_stage` = 'idle' WHERE `status` = 'paused';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'completed', `pipeline_stage` = 'idle' WHERE `status` = 'completed';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'failed', `pipeline_stage` = 'idle' WHERE `status` = 'failed';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'completed', `pipeline_stage` = 'checking' WHERE `status` = 'checking';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'completed', `pipeline_stage` = 'pending_review' WHERE `status` = 'pending_review';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'completed', `pipeline_stage` = 'importing' WHERE `status` = 'importing';--> statement-breakpoint
UPDATE `downloads` SET `client_status` = 'completed', `pipeline_stage` = 'imported' WHERE `status` = 'imported';
