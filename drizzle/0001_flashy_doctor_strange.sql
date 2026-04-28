DROP INDEX `idx_blacklist_info_hash`;--> statement-breakpoint
DROP INDEX `idx_blacklist_guid`;--> statement-breakpoint
-- Pre-cleanup: sequential survival dedupe so the partial unique indexes can be created.
-- Pass 1: keep max(id) per info_hash among rows where info_hash is set.
DELETE FROM blacklist
WHERE info_hash IS NOT NULL
  AND id NOT IN (
    SELECT MAX(id) FROM blacklist WHERE info_hash IS NOT NULL GROUP BY info_hash
  );--> statement-breakpoint
-- Pass 2: keep max(id) per guid among the rows that survived pass 1.
DELETE FROM blacklist
WHERE guid IS NOT NULL
  AND id NOT IN (
    SELECT MAX(id) FROM blacklist WHERE guid IS NOT NULL GROUP BY guid
  );--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_info_hash_unique` ON `blacklist` (`info_hash`) WHERE info_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_guid_unique` ON `blacklist` (`guid`) WHERE guid IS NOT NULL;