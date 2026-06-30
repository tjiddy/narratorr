-- #1733 Make ASIN identity case-insensitive at the durable constraint.
--
-- The new unique index is on `upper(asin)`, so any pre-existing rows whose ASINs
-- differ only by case would collide and abort the index build. This migration is
-- REQUIRED to complete: it first quarantines such collisions, then canonicalizes
-- every surviving non-null ASIN to UPPERCASE, so the `CREATE UNIQUE INDEX` below
-- cannot fail.
--
-- Step 1 — quarantine pre-existing case collisions: for each `upper(asin)` group
-- with more than one non-null row, keep the ASIN on the lowest `id` and NULL it
-- on the rest. The rows themselves are preserved; only their (duplicate) ASIN
-- identity is dropped. NULL ASINs coexist freely under the partial index
-- (NULL <> NULL in a SQLite UNIQUE index), so the nulled losers stay insertable.
UPDATE books SET asin = NULL
WHERE asin IS NOT NULL
  AND id NOT IN (SELECT MIN(id) FROM books WHERE asin IS NOT NULL GROUP BY upper(asin));
--> statement-breakpoint
-- Step 2 — canonicalize: uppercase every surviving non-null ASIN. After step 1 no
-- two survivors share an `upper(asin)` value, so this cannot introduce a dup.
UPDATE books SET asin = upper(asin) WHERE asin IS NOT NULL;
--> statement-breakpoint
DROP INDEX `idx_books_asin_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_books_asin_unique` ON `books` (upper("asin")) WHERE asin IS NOT NULL;
