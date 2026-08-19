import { extname } from 'node:path';
import { eq, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import { writeOpfSidecarWithinAdmissionLock } from '../utils/opf-writer.js';
import { serializeError } from '../utils/serialize-error.js';
import { toShortErrorText } from '../utils/short-error-text.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { downloadRemoteCoverWithinAdmissionLock, isRemoteCoverUrl } from './cover-download.js';
import { withBookAdmissionLock } from './book-admission.js';
import type { BookService } from './book.service.js';
import type { ConnectorService } from './connector.service.js';
import type { BulkJobFailure } from './bulk-job.js';

export interface ReconcileBookSidecarsArgs {
  bookId: number;
  title: string;
  bookFolder: string;
  coverUrl: string | null;
  bookService: BookService;
  db: Db;
  log: FastifyBaseLogger;
  connectorService?: ConnectorService | undefined;
}

// Every failure carries an operator-visible reason.
export type SidecarReconcileOutcome = { failed: false } | { failed: true; reason: string };

const GENERIC_OPF_REASON = 'OPF write failed';
const GENERIC_COVER_REASON = 'Cover download failed';

/**
 * Benign sidecar skips succeed; combine actual failures OPF-first so truncation preserves that cause.
 * This explicit bulk action writes OPF regardless of tagging.writeOpf.
 */
export async function reconcileBookSidecars(args: ReconcileBookSidecarsArgs): Promise<SidecarReconcileOutcome> {
  const { bookId, bookFolder, log } = args;

  // A loose audio-file path cannot contain either sidecar. Returns before acquiring anything.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.debug({ bookId, bookFolder }, 'Sidecar reconcile skipped — single-file pointer path');
    return { failed: false };
  }

  // ONE acquisition covers both writes: they target the same folder, and a rename landing between
  // them would leave the OPF and the cover in different folders.
  return withBookAdmissionLock(bookId, () => reconcileWithinAdmissionLock(args));
}

/**
 * Caller must hold the admission lock for `args.bookId`.
 *
 * The folder and cover URL are re-read here, not taken from the batch query: that query is a
 * pre-lock snapshot by construction, so a book renamed since it ran would otherwise have its OPF
 * skipped by the writer's own ownership check while the cover half still landed in the vacated
 * folder — two sidecars, two folders (AC3 / AC12).
 */
async function reconcileWithinAdmissionLock(args: ReconcileBookSidecarsArgs): Promise<SidecarReconcileOutcome> {
  const { bookId, title, bookService, db, log, connectorService } = args;

  const fresh = await readFreshSidecarTarget(db, bookId);
  if (!fresh) {
    log.debug({ bookId, snapshotFolder: args.bookFolder }, 'Sidecar reconcile skipped — the book owns no book folder now');
    return { failed: false };
  }
  const { bookFolder, coverUrl } = fresh;

  const reasons: string[] = [];
  let wrote = false;

  // Capture the raw failure value; .code and .cause are lost in a message-only channel.
  const opfCause = captureCause();
  const opfOutcome = await writeOpfSidecarWithinAdmissionLock({ enabled: true, bookService, bookId, bookFolder, log, onFailure: opfCause.sink });
  if (opfOutcome === 'failed') reasons.push(opfCause.describe(GENERIC_OPF_REASON));
  if (opfOutcome === 'written') wrote = true;

  // A post-rename DB failure still means the cover materialized and needs refresh.
  if (coverUrl && isRemoteCoverUrl(coverUrl)) {
    const coverCause = captureCause();
    const coverOutcome = await downloadRemoteCoverWithinAdmissionLock(bookId, bookFolder, coverUrl, db, log, coverCause.sink);
    if (coverOutcome === 'failed') reasons.push(coverCause.describe(GENERIC_COVER_REASON));
    if (coverOutcome === 'written') wrote = true;
  }

  // Authors are not loaded; authorName is observability-only.
  if (wrote) {
    enqueueBookRefresh(connectorService, log, 'metadata', { bookId, title, authorName: null, libraryPath: bookFolder });
  }

  if (reasons.length > 0) return { failed: true, reason: reasons.join('; ') };
  return { failed: false };
}

/** Null when the row vanished, lost its path, or now points at a loose audio file. */
async function readFreshSidecarTarget(
  db: Db,
  bookId: number,
): Promise<{ bookFolder: string; coverUrl: string | null } | null> {
  const rows = await db
    .select({ path: books.path, coverUrl: books.coverUrl })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  const row = rows[0];
  if (!row?.path || AUDIO_EXTENSIONS.has(extname(row.path).toLowerCase())) return null;
  return { bookFolder: row.path, coverUrl: row.coverUrl };
}

// Older or mocked writers may report failure without invoking the sink.
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

// Per-book errors count as failures but never abort the run.
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
    if (!row.path) { tick(false); continue; } // SQL guarantees path; retain runtime defense.
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
      // Emit one redacted, length-bounded failure per book even if both steps fail.
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
