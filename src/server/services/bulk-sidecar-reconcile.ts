import { extname } from 'node:path';
import type { SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { writeOpfSidecar } from '../utils/opf-writer.js';
import { serializeError } from '../utils/serialize-error.js';
import { downloadRemoteCover, isRemoteCoverUrl } from './cover-download.js';
import type { BookService } from './book.service.js';

export interface ReconcileBookSidecarsArgs {
  bookId: number;
  /** Non-null book folder (the reconcile query guarantees `path IS NOT NULL`). */
  bookFolder: string;
  coverUrl: string | null;
  bookService: BookService;
  db: Db;
  log: FastifyBaseLogger;
}

/**
 * (Re)write a single book's media-server sidecars from the DB: the `metadata.opf` and the folder
 * cover image. Returns `true` only on a *failure* worth counting — an OPF write that returns
 * `'failed'`, or a cover download that was attempted and returned `false`. Returns `false` (success
 * or benign skip) for: a foreign-OPF skip, a single-file-pointer path, and a `coverUrl` that is
 * `null` or already local (nothing to materialize).
 *
 * Unlike the per-book edit triggers, reconcile writes the OPF regardless of the global
 * `tagging.writeOpf` setting — the bulk action is itself the operator's explicit opt-in.
 */
export async function reconcileBookSidecars(args: ReconcileBookSidecarsArgs): Promise<boolean> {
  const { bookId, bookFolder, coverUrl, bookService, db, log } = args;

  // Single-file pointer (path is a loose audio file, not a book directory): skip BOTH sidecars.
  // The OPF writer already guards this; the cover materialization must too, else
  // `join(<file>, 'cover.ext')` would target a path beneath a file and spuriously fail. Not a failure.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.debug({ bookId, bookFolder }, 'Sidecar reconcile skipped — single-file pointer path');
    return false;
  }

  let failed = false;

  // OPF: always enabled for the explicit reconcile action. 'skipped' (foreign OPF / missing book)
  // is not a failure; only a 'failed' write counts.
  const opfOutcome = await writeOpfSidecar({ enabled: true, bookService, bookId, bookFolder, log });
  if (opfOutcome === 'failed') failed = true;

  // Cover: only a remote coverUrl is materialized. null / already-local → no download attempt,
  // not a failure. A download that was attempted but returned false IS a failure.
  if (coverUrl && isRemoteCoverUrl(coverUrl)) {
    const ok = await downloadRemoteCover(bookId, bookFolder, coverUrl, db, log);
    if (!ok) failed = true;
  }

  return failed;
}

export interface RunSidecarReconcileDeps {
  db: Db;
  bookService: BookService;
  log: FastifyBaseLogger;
  jobId: string;
  /** Eligibility predicate (`status = 'imported' AND path IS NOT NULL`). */
  where: SQL | undefined;
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
  tick: (isFailure: boolean) => void,
): Promise<void> {
  const { db, bookService, log, jobId, where } = deps;
  const rows = await db
    .select({ id: books.id, path: books.path, coverUrl: books.coverUrl })
    .from(books)
    .where(where);

  setTotal(rows.length);

  for (const row of rows) {
    if (!row.path) { tick(false); continue; } // defensive — the WHERE guarantees a non-null path
    try {
      const failure = await reconcileBookSidecars({
        bookId: row.id,
        bookFolder: row.path,
        coverUrl: row.coverUrl,
        bookService,
        db,
        log,
      });
      tick(failure);
    } catch (error: unknown) {
      log.warn({ bookId: row.id, jobId, error: serializeError(error) }, 'Bulk write-sidecars: book failed');
      tick(true);
    }
  }
}
