import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@db/schema.js';
import { inferGenresFromTitleMarkers, mergeInferredGenres } from '@core/metadata/genres.js';
import type { BookService } from '../services/book.service.js';
import { withBookAdmissionLock } from '../utils/book-admission-lock.js';
import { parseClearedFields } from '../utils/cleared-fields.js';
import { serializeError } from '../utils/serialize-error.js';

/** Every column the marker decision reads; the discovery scan adds `id` to it. */
interface MarkerRow {
  title: string;
  subtitle: string | null;
  seriesName: string | null;
  genres: string[] | null;
  userClearedFields: string | null;
}

/** The value a marker pass would write for this row, or null when it would write nothing. */
function planGenres(row: MarkerRow, log: FastifyBaseLogger, bookId: number): string[] | null {
  if (parseClearedFields(row.userClearedFields, log, bookId).includes('genres')) return null;
  const merged = mergeInferredGenres(
    row.genres,
    inferGenresFromTitleMarkers(row.title, row.subtitle, row.seriesName),
  );
  return merged.changed ? merged.genres ?? null : null;
}

/**
 * Caller must hold the admission lock for `bookId`. Re-reads the row inside the section and
 * recomputes from the fresh values: the batch query is a pre-lock snapshot by construction, so a
 * book whose genres, title or tombstones changed since it ran must win over what the scan saw.
 */
async function revalidateThenMerge(
  bookId: number,
  db: Db,
  bookService: BookService,
  log: FastifyBaseLogger,
): Promise<'updated' | 'skipped'> {
  const rows = await db
    .select({
      title: books.title,
      subtitle: books.subtitle,
      seriesName: books.seriesName,
      genres: books.genres,
      userClearedFields: books.userClearedFields,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  const fresh = rows[0];
  const genres = fresh ? planGenres(fresh, log, bookId) : null;
  if (!genres) {
    log.debug({ bookId }, 'Genre marker sweep: book changed since the batch query — skipping');
    return 'skipped';
  }

  // Not `{ userAsserted: true }`: the sweep is not an operator edit and must not recompute
  // tombstones from its own write. The plain arm also brings the genre telemetry and update log.
  await bookService.update(bookId, { genres });
  return 'updated';
}

/**
 * Reconcile every book's genres with the litRPG-family markers its own title, subtitle or series
 * name carries (#2535). Idempotent, and deliberately re-run on every boot rather than once: it is
 * the catch-all for the genre-write paths this feature does not instrument — OPF overlay, Fix Match,
 * bulk edits — which would otherwise stay permanently uncovered.
 */
export async function runGenreMarkerSweep(
  db: Db,
  bookService: BookService,
  log: FastifyBaseLogger,
): Promise<void> {
  // One unindexed full scan per process start, accepted deliberately. A marker sits anywhere inside
  // the text, so a SQL prefilter would need leading-wildcard fragments SQLite cannot serve from a
  // B-tree index: it would examine exactly the same rows while risking dropping a marked book on any
  // fragment narrower than the regex. Matching therefore happens in JS, against the same authority
  // every other write path uses.
  const candidates = await db
    .select({
      id: books.id,
      title: books.title,
      subtitle: books.subtitle,
      seriesName: books.seriesName,
      genres: books.genres,
      userClearedFields: books.userClearedFields,
    })
    .from(books);

  // Two JS gates before any lock: the marker match, then the merge pre-check that drops an
  // already-converged row. Both are an optimization only — the in-lock recompute stays
  // authoritative — but they are what makes a converged library acquire zero locks per boot.
  const marked = candidates.filter((row) => planGenres(row, log, row.id) !== null);

  if (marked.length === 0) {
    log.debug({ scanned: candidates.length }, 'Genre marker sweep: no books need inferred genres');
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const book of marked) {
    try {
      // Per book inside the loop, never once around the sweep: one acquisition around the whole
      // batch would hold every marked book in the library for the length of the run.
      const outcome = await withBookAdmissionLock(book.id, () =>
        revalidateThenMerge(book.id, db, bookService, log));
      if (outcome === 'updated') updated++;
      else skipped++;
    } catch (error: unknown) {
      failed++;
      log.warn(
        { error: serializeError(error), bookId: book.id },
        'Genre marker sweep: unexpected error while merging inferred genres',
      );
    }
  }

  // `updated` is the operator's cue that a bulk sidecar reconcile is worth running: genres only
  // reach the OPF when a sidecar is written, and this sweep deliberately writes no files.
  log.info(
    { updated, skipped, failed, candidates: marked.length, scanned: candidates.length },
    'Genre marker sweep complete',
  );
}
