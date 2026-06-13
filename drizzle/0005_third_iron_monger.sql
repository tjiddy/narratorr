-- SQLite cannot ADD a NOT NULL column to an existing (populated) table without a
-- non-null DEFAULT, and a constant default would collide with the UNIQUE index. So
-- add the column as nullable, backfill every existing row with a prefixed random
-- opaque id, then enforce uniqueness. New rows always supply publicId from the app
-- (schema declares it NOT NULL); this migration only seeds rows that predate it.
ALTER TABLE `authors` ADD `public_id` text;--> statement-breakpoint
UPDATE `authors` SET `public_id` = 'au_' || lower(hex(randomblob(16))) WHERE `public_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `authors_public_id_unique` ON `authors` (`public_id`);--> statement-breakpoint
ALTER TABLE `books` ADD `public_id` text;--> statement-breakpoint
UPDATE `books` SET `public_id` = 'bk_' || lower(hex(randomblob(16))) WHERE `public_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `books_public_id_unique` ON `books` (`public_id`);--> statement-breakpoint
ALTER TABLE `downloads` ADD `public_id` text;--> statement-breakpoint
UPDATE `downloads` SET `public_id` = 'dl_' || lower(hex(randomblob(16))) WHERE `public_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `downloads_public_id_unique` ON `downloads` (`public_id`);--> statement-breakpoint
ALTER TABLE `narrators` ADD `public_id` text;--> statement-breakpoint
UPDATE `narrators` SET `public_id` = 'nr_' || lower(hex(randomblob(16))) WHERE `public_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `narrators_public_id_unique` ON `narrators` (`public_id`);--> statement-breakpoint
ALTER TABLE `series` ADD `public_id` text;--> statement-breakpoint
UPDATE `series` SET `public_id` = 'sr_' || lower(hex(randomblob(16))) WHERE `public_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `series_public_id_unique` ON `series` (`public_id`);
