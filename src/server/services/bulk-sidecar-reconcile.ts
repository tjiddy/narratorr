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
  const { bookId, title, bookFolder, coverUrl, bookService, db, log, connectorService } = args;

  // A loose audio-file path cannot contain either sidecar.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.debug({ bookId, bookFolder }, 'Sidecar reconcile skipped — single-file pointer path');
    return { failed: false };
  }

  const reasons: string[] = [];
  let wrote = false;

  // Capture the raw failure value; .code and .cause are lost in a message-only channel.
  const opfCause = captureCause();
  const opfOutcome = await writeOpfSidecar({ enabled: true, bookService, bookId, bookFolder, log, onFailure: opfCause.sink });
  if (opfOutcome === 'failed') reasons.push(opfCause.describe(GENERIC_OPF_REASON));
  if (opfOutcome === 'written') wrote = true;

  // A post-rename DB failure still means the cover materialized and needs refresh.
  if (coverUrl && isRemoteCoverUrl(coverUrl)) {
    const coverCause = captureCause();
    const coverOutcome = await downloadRemoteCover(bookId, bookFolder, coverUrl, db, log, coverCause.sink);
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
