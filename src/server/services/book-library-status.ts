import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { CompanionEbookRow } from './types.js';
import type { LibraryStatusByAsin } from './book.service.js';
import { findCompanionEbooksByBookIds } from './companion-ebook.repository.js';
import { toCompanionEbookV1 } from '@shared/schemas/v1/companion-ebook.js';

/**
 * Batch ASIN → library-status lookup for the v1 metadata-search cross-reference
 * (#1537). Given the result ASINs of a metadata search, returns a Map keyed by
 * the UPPERCASED ASIN with `{ bookId: <bk_ publicId>, status, companionEbook }`
 * for each owned book — so the caller does a plain
 * `.get(result.asin?.toUpperCase())`.
 *
 * Case-insensitive by design: ASINs are NOT globally normalized in narratorr
 * (the parser uppercases, but API validators only `.trim()` and add-by-ASIN
 * stores as-is), so an exact `IN` would silently miss a case-drifted stored
 * ASIN and wrongly show every such book as "not owned". We match on
 * `upper(asin)` — matching `idx_books_asin_unique`, which is
 * `upper("asin") WHERE asin IS NOT NULL`, and matching what `:367` and `:484`
 * already do. (An earlier revision used `lower(asin)` and cited a
 * `book-list.service` precedent; that was the wrong precedent, and it made this
 * query unable to use the index at all.)
 *
 * **`asin IS NOT NULL` in the predicate is NOT redundant.** SQLite will only use a
 * PARTIAL index when the query restates its condition, even where the condition is
 * logically implied. Measured with EXPLAIN QUERY PLAN against the real schema:
 * `lower(asin) IN (…)` → `SCAN books`; `upper(asin) IN (…)` → **still** `SCAN books`;
 * `upper(asin) IN (…) AND asin IS NOT NULL` → `SEARCH books USING INDEX
 * idx_books_asin_unique`. Dropping either half silently returns this to a full scan
 * of `books` on every metadata search.
 *
 * The query is bounded by the small search result set (currently ≤10), so no
 * chunking is needed — but guard the empty list so we never emit `IN ()`.
 *
 * Null-ASIN owned books cannot match (the index is partial); that limitation is
 * accepted and documented in #1537, so the added predicate encodes an existing
 * invariant rather than changing behaviour.
 *
 * **Companion ebooks (#1961).** `companionEnabled` is supplied BY THE CALLER —
 * this service takes no `SettingsService`, matching the convention
 * `isCompanionEbookEligible` already sets. When it is false, or when no row
 * matched, NO companion query is issued and every value carries
 * `companionEbook: null`. Otherwise observations are batch-loaded by numeric
 * `books.id` through `findCompanionEbooksByBookIds` (already chunked at 480),
 * so the whole annotation costs one books select plus
 * `ceil(matched / 480)` companion selects — never one per result.
 *
 * The select therefore also projects the numeric `books.id` (the companion FK).
 * It does NOT project `books.path`: the exposure predicate takes exactly
 * `{ enabled, bookStatus, observationStatus }` and must never grow a live/path
 * term (see `src/shared/companion-ebook-exposure.ts`). The projection is built
 * inside this method body, never as a module-level constant
 * (`drizzle-schema-toplevel-deref-breaks-partial-mocks`).
 */
export async function findLibraryStatusByAsins(
  db: Db,
  asins: string[],
  options: { companionEnabled: boolean },
): Promise<Map<string, LibraryStatusByAsin>> {
  const map = new Map<string, LibraryStatusByAsin>();
  if (asins.length === 0) return map;

  const uppered = asins.map((a) => a.toUpperCase());
  const rows = await db
    .select({ id: books.id, bookId: books.publicId, status: books.status, asin: books.asin })
    .from(books)
    // `upper()`, and the redundant-looking `asin IS NOT NULL`, are BOTH required to hit
    // `idx_books_asin_unique` — see the note above the method. Measured with
    // EXPLAIN QUERY PLAN: `lower(asin) IN (…)` and `upper(asin) IN (…)` both SCAN;
    // only `upper(asin) IN (…) AND asin IS NOT NULL` produces
    // `SEARCH books USING INDEX idx_books_asin_unique`.
    .where(and(inArray(sql`upper(${books.asin})`, uppered), isNotNull(books.asin)));

  const matchedIds = rows.filter((r) => r.asin != null).map((r) => r.id);
  const companionByBookId: Map<number, CompanionEbookRow> =
    options.companionEnabled && matchedIds.length > 0
      ? await findCompanionEbooksByBookIds(db, matchedIds)
      : new Map();

  for (const row of rows) {
    if (row.asin == null) continue;
    const status = row.status as BookStatus;
    map.set(row.asin.toUpperCase(), {
      bookId: row.bookId,
      status,
      // The exposure→DTO decision lives in exactly one place (#1961 AC 10a) —
      // no term, no size guard, and no `'epub'` literal is re-spelled here.
      companionEbook: toCompanionEbookV1({
        enabled: options.companionEnabled,
        bookStatus: status,
        observation: companionByBookId.get(row.id),
      }),
    });
  }
  return map;
}
