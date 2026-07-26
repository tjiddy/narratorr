import { z } from 'zod';
import { isCompanionEbookExposed } from '../../companion-ebook-exposure.js';
import type { BookStatus } from '../book.js';
import type { CompanionEbookStatus } from '../companion-ebook.js';

// ============================================================================
// Public API v1 — companion ebook (#1961, plan §8)
// ============================================================================
//
// The public companion-ebook DTO and the ONE mapper that decides whether a
// stored observation is exposed. Both v1 producers — the metadata-search
// `library` annotation and the top-level book DTO — import from here; neither
// re-spells an exposure term, the `sizeBytes` guard, or the `'epub'` literal.

/**
 * The public companion value: `{ format: 'epub', sizeBytes }` when the book
 * advertises a companion ebook, `null` otherwise. `.strict()` per the v1
 * owned-schema convention (`compat-surface-zod-strip-not-strict`'s inverse), so
 * a projector regression that leaks a path/filename fails serialization rather
 * than shipping it.
 *
 * `format` is a single-value literal on purpose: `companion_ebooks` has no
 * `format` column and none is added — a single-value enum carries no
 * information, and the literal is emitted ONLY by `toCompanionEbookV1` below.
 */
export const companionEbookV1Schema = z
  .object({
    format: z.literal('epub'),
    sizeBytes: z.number(),
  })
  .strict()
  .nullable();

/** The non-null half of `companionEbookV1Schema` — producers type the mapped
 *  value as `CompanionEbookV1 | null`, matching the schema exactly. */
export type CompanionEbookV1 = NonNullable<z.infer<typeof companionEbookV1Schema>>;

/**
 * The minimal structural shape the mapper reads from an observation row. The
 * server's `CompanionEbookRow` (`src/server/services/types.ts`) is structurally
 * assignable to this, so `src/shared` stays server-import-free — the same
 * technique `BookV1Source` uses in `./books.ts`.
 */
export interface CompanionEbookSource {
  status: CompanionEbookStatus;
  sizeBytes: number | null;
}

/**
 * The SINGLE home of the exposure→DTO decision (#1961 AC 10a). Pure and
 * synchronous: it takes no path, touches no filesystem, and issues no query.
 *
 * Two gates, in order:
 *
 * 1. `isCompanionEbookExposed` (`src/shared/companion-ebook-exposure.ts`) — the
 *    frozen three-term predicate (`enabled` && `imported` && `available`).
 *    Routing every producer through here is what makes all three terms bind by
 *    construction. The `imported` term is load-bearing: `library-scan.service.ts`
 *    flips `imported → missing` without clearing `books.path` and without
 *    touching the companion row, so a stale `available` observation on a
 *    non-`imported` book must project `null`.
 * 2. The `sizeBytes` guard. The column is `number | null` in `$inferSelect`; an
 *    `available` row with a null size is unreachable through
 *    `ck_companion_ebooks_file_present` but expressible in the type, so it maps
 *    to `null` — never `?? 0`, never a cast, never a throw. The check is
 *    `!= null`, NOT truthiness, so `sizeBytes: 0` round-trips as `0`.
 *
 * An absent observation (`null`/`undefined`) is `null`, never a throw.
 */
export function toCompanionEbookV1(input: {
  enabled: boolean;
  bookStatus: BookStatus;
  observation: CompanionEbookSource | null | undefined;
}): CompanionEbookV1 | null {
  const { enabled, bookStatus, observation } = input;
  if (!isCompanionEbookExposed({ enabled, bookStatus, observationStatus: observation?.status })) {
    return null;
  }
  const sizeBytes = observation?.sizeBytes;
  if (sizeBytes == null) return null;
  return { format: 'epub', sizeBytes };
}
