import { extname } from 'node:path';
import type { SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import { writeOpfSidecar } from '../utils/opf-writer.js';
import { serializeError } from '../utils/serialize-error.js';
import { toShortErrorText } from '../utils/short-error-text.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { downloadRemoteCover, isRemoteCoverUrl } from './cover-download.js';
import type { BookService } from './book.service.js';
import type { ConnectorService } from './connector.service.js';
import type { BulkJobFailure } from './bulk-job.js';

export interface ReconcileBookSidecarsArgs {
  bookId: number;
  /** Book title for the connector-refresh item (the reconcile SELECT loads it; authors are not). */
  title: string;
  /** Non-null book folder (the reconcile query guarantees `path IS NOT NULL`). */
  bookFolder: string;
  coverUrl: string | null;
  bookService: BookService;
  db: Db;
  log: FastifyBaseLogger;
  connectorService?: ConnectorService | undefined;
}

/**
 * Outcome of one book's sidecar reconcile. Deliberately NOT a bare boolean (#2159): `false` used to
 * mean both "nothing went wrong" and "something went wrong but we discarded what", which is exactly
 * how the live ENOENT case reached the operator as an anonymous `failures: 1`. The `reason` is
 * always present on the failing arm, so a caller cannot record a failure with no identity.
 */
export type SidecarReconcileOutcome = { failed: false } | { failed: true; reason: string };

/** Stable reasons for a step that failed without reporting an underlying cause. */
const GENERIC_OPF_REASON = 'OPF write failed';
const GENERIC_COVER_REASON = 'Cover download failed';

/**
 * (Re)write a single book's media-server sidecars from the DB: the `metadata.opf` and the folder
 * cover image. Returns `{ failed: true, reason }` only on a *failure* worth counting — an OPF write
 * that returns `'failed'`, or a cover download that was attempted and returned `'failed'`. Returns
 * `{ failed: false }` (success or benign skip) for: a foreign-OPF skip, a single-file-pointer path,
 * and a `coverUrl` that is `null` or already local (nothing to materialize).
 *
 * BOTH steps run in one iteration, so both can fail; that is ONE failure with ONE reason naming
 * both causes, OPF first. The ordering is load-bearing rather than cosmetic — the composed string
 * is length-bounded by `toShortErrorText` at the call site, so leading with the OPF cause means
 * truncation can never be what hides the ENOENT this issue exists to surface.
 *
 * Unlike the per-book edit triggers, reconcile writes the OPF regardless of the global
 * `tagging.writeOpf` setting — the bulk action is itself the operator's explicit opt-in.
 */
export async function reconcileBookSidecars(args: ReconcileBookSidecarsArgs): Promise<SidecarReconcileOutcome> {
  const { bookId, title, bookFolder, coverUrl, bookService, db, log, connectorService } = args;

  // Single-file pointer (path is a loose audio file, not a book directory): skip BOTH sidecars.
  // The OPF writer already guards this; the cover materialization must too, else
  // `join(<file>, 'cover.ext')` would target a path beneath a file and spuriously fail. Not a failure.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.debug({ bookId, bookFolder }, 'Sidecar reconcile skipped — single-file pointer path');
    return { failed: false };
  }

  const reasons: string[] = [];
  let wrote = false;

  // OPF: always enabled for the explicit reconcile action. 'skipped' (foreign OPF / missing book)
  // is not a failure; only a 'failed' write counts. A 'written' OPF warrants a refresh.
  // `onFailure` receives the caught VALUE — `ENOENT` lives on `.code` and undici's real diagnostic
  // on `.cause`, and neither survives a message-only channel.
  const opfCause = captureCause();
  const opfOutcome = await writeOpfSidecar({ enabled: true, bookService, bookId, bookFolder, log, onFailure: opfCause.sink });
  if (opfOutcome === 'failed') reasons.push(opfCause.describe(GENERIC_OPF_REASON));
  if (opfOutcome === 'written') wrote = true;

  // Cover: only a remote coverUrl is materialized. null / already-local → no download attempt,
  // not a failure. 'failed' (pre-rename) counts as a failure; a post-rename DB failure stays
  // 'written' (the file materialized) → a refresh, not a counted failure.
  if (coverUrl && isRemoteCoverUrl(coverUrl)) {
    const coverCause = captureCause();
    const coverOutcome = await downloadRemoteCover(bookId, bookFolder, coverUrl, db, log, coverCause.sink);
    if (coverOutcome === 'failed') reasons.push(coverCause.describe(GENERIC_COVER_REASON));
    if (coverOutcome === 'written') wrote = true;
  }

  // One refresh per book when an OPF or cover actually materialized; books that only skipped
  // (foreign OPF / single-file pointer / already-local cover) enqueue nothing. authorName is null —
  // the reconcile projection does not load authors and the field is observability-only.
  if (wrote) {
    enqueueBookRefresh(connectorService, log, 'metadata', { bookId, title, authorName: null, libraryPath: bookFolder });
  }

  if (reasons.length > 0) return { failed: true, reason: reasons.join('; ') };
  return { failed: false };
}

/**
 * A one-shot `onFailure` sink plus its reader. `describe` formats whatever the step reported through
 * the shared formatter, or falls back to `generic` when the step never called the sink at all (an
 * older/mocked writer, or a failure arm with nothing to report).
 */
function captureCause(): { sink: (cause: unknown) => void; describe: (generic: string) => string } {
  let cause: unknown;
  let reported = false;
  return {
    sink: (value: unknown) => { cause = value; reported = true; },
    describe: (generic: string) => (reported ? toShortErrorText(cause) : generic),
  };
}

export interface RunSidecarReconcileDeps {
  db: Db;
  bookService: BookService;
  log: FastifyBaseLogger;
  jobId: string;
  /** Eligibility predicate (`status = 'imported' AND path IS NOT NULL`). */
  where: SQL | undefined;
  connectorService?: ConnectorService | undefined;
}

/**
 * Bulk-job body for the library reconcile: iterate eligible books and (re)write each book's
 * sidecars. Extracted from `BulkOperationService` (it is over the file line cap) — mirrors the
 * `bulk-job.ts` split. `setTotal`/`tick` are the BulkJob progress callbacks; a thrown per-book
 * error counts as a failure but never aborts the run.
 */
export async function runSidecarReconcile(
  deps: RunSidecarReconcileDeps,
  setTotal: (n: number) => void,
  tick: (isFailure: boolean, detail?: BulkJobFailure) => void,
): Promise<void> {
  const { db, bookService, log, jobId, where, connectorService } = deps;
  const rows = await db
    .select({ id: books.id, path: books.path, coverUrl: books.coverUrl, title: books.title })
    .from(books)
    .where(where);

  setTotal(rows.length);

  for (const row of rows) {
    if (!row.path) { tick(false); continue; } // defensive — the WHERE guarantees a non-null path
    try {
      const outcome = await reconcileBookSidecars({
        bookId: row.id,
        title: row.title,
        bookFolder: row.path,
        coverUrl: row.coverUrl,
        bookService,
        db,
        log,
        connectorService,
      });
      // Exactly one tick and at most one detail per book, however many steps failed. The composed
      // reason goes back through the shared formatter so the FINAL string is the one that gets
      // redacted and length-bounded (AC11/AC13 step 4).
      if (outcome.failed) {
        tick(true, { bookId: row.id, title: row.title, error: toShortErrorText(outcome.reason) });
      } else {
        tick(false);
      }
    } catch (error: unknown) {
      log.warn({ bookId: row.id, jobId, error: serializeError(error) }, 'Bulk write-sidecars: book failed');
      tick(true, { bookId: row.id, title: row.title, error: toShortErrorText(error) });
    }
  }
}
