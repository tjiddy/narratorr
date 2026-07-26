CREATE TABLE `companion_ebooks` (
	`book_id` integer NOT NULL,
	`status` text NOT NULL,
	`filename` text,
	`size_bytes` integer,
	`mtime_ms` integer,
	`ctime_ms` integer,
	`validation_code` text,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`selected_filename` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_companion_ebooks_status_domain" CHECK("companion_ebooks"."status" IN ('available', 'none', 'ambiguous', 'invalid', 'drm_protected')),
	CONSTRAINT "ck_companion_ebooks_file_present" CHECK("companion_ebooks"."status" NOT IN ('available', 'invalid', 'drm_protected') OR ("companion_ebooks"."filename" IS NOT NULL AND "companion_ebooks"."size_bytes" IS NOT NULL AND "companion_ebooks"."mtime_ms" IS NOT NULL AND "companion_ebooks"."ctime_ms" IS NOT NULL)),
	CONSTRAINT "ck_companion_ebooks_file_absent" CHECK("companion_ebooks"."status" NOT IN ('none', 'ambiguous') OR ("companion_ebooks"."filename" IS NULL AND "companion_ebooks"."size_bytes" IS NULL AND "companion_ebooks"."mtime_ms" IS NULL AND "companion_ebooks"."ctime_ms" IS NULL)),
	CONSTRAINT "ck_companion_ebooks_validation_code" CHECK(("companion_ebooks"."status" <> 'invalid' OR "companion_ebooks"."validation_code" IS NOT NULL) AND ("companion_ebooks"."status" = 'invalid' OR "companion_ebooks"."validation_code" IS NULL)),
	CONSTRAINT "ck_companion_ebooks_candidate_count" CHECK(typeof("companion_ebooks"."candidate_count") = 'integer' AND "companion_ebooks"."candidate_count" >= 0 AND ("companion_ebooks"."status" <> 'none' OR "companion_ebooks"."candidate_count" = 0) AND ("companion_ebooks"."status" <> 'ambiguous' OR "companion_ebooks"."candidate_count" >= 2) AND ("companion_ebooks"."status" NOT IN ('available', 'invalid', 'drm_protected') OR "companion_ebooks"."candidate_count" >= 1)),
	CONSTRAINT "ck_companion_ebooks_selection" CHECK("companion_ebooks"."selected_filename" IS NULL OR ("companion_ebooks"."status" IN ('available', 'invalid', 'drm_protected') AND "companion_ebooks"."filename" IS NOT NULL AND "companion_ebooks"."selected_filename" = "companion_ebooks"."filename")),
	CONSTRAINT "ck_companion_ebooks_multi_candidate_selection" CHECK("companion_ebooks"."status" NOT IN ('available', 'invalid', 'drm_protected') OR "companion_ebooks"."candidate_count" < 2 OR "companion_ebooks"."selected_filename" IS NOT NULL),
	CONSTRAINT "ck_companion_ebooks_fingerprint" CHECK(("companion_ebooks"."size_bytes" IS NULL OR (typeof("companion_ebooks"."size_bytes") = 'integer' AND "companion_ebooks"."size_bytes" >= 0)) AND ("companion_ebooks"."mtime_ms" IS NULL OR typeof("companion_ebooks"."mtime_ms") = 'integer') AND ("companion_ebooks"."ctime_ms" IS NULL OR typeof("companion_ebooks"."ctime_ms") = 'integer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companion_ebooks_book_id_unique` ON `companion_ebooks` (`book_id`);