import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorReason } from '../../core/connectors/types.js';
import type { ConnectorService } from '../services/connector.service.js';
import type { BookService } from '../services/book.service.js';
import type { RetagResult } from '../services/tagging.service.js';
import { fireAndForget } from './fire-and-forget.js';

/** The single book the refresh targets — mirrors `ConnectorImportItem`'s narratorr-side fields. */
export interface BookRefreshItem {
  bookId: number;
  title: string;
  /** Optional / nullable — observability-only (a caller without an author loaded passes `null`). */
  authorName?: string | null;
  /** The book's final folder path on disk (the same field import/rename pass). */
  libraryPath: string;
}

/**
 * Fire-and-forget a connector refresh for a single book after a post-import file mutation
 * (merge, convert, OPF/cover sidecar write, re-tag). Centralized so every trigger site
 * constructs the same item and fires identically (DRY) rather than copying the
 * `fireAndForget` + item-construction boilerplate.
 *
 * - **Never awaited**: a rejecting `notifyRefresh` is logged but never blocks or fails the
 *   operation that triggered it (the merge/convert/edit/reconcile/retag still succeeded).
 * - **No-op when no connectors**: the guard here plus `notifyRefresh`'s own early-return when
 *   no connectors are enabled make firing free when ABS/Plex isn't configured.
 */
export function enqueueBookRefresh(
  connectorService: ConnectorService | undefined,
  log: FastifyBaseLogger,
  reason: ConnectorReason,
  book: BookRefreshItem,
): void {
  if (!connectorService) return;
  fireAndForget(
    connectorService.notifyRefresh(reason, [book]),
    log,
    `Failed to enqueue connector refresh (${reason})`,
  );
}

/**
 * Fire the post-re-tag `'metadata'` refresh from the {@link RetagResult}'s pre-mutation
 * {@link BookRefreshItem}. This is the single home for the re-tag refresh decision shared by the
 * standalone route (`POST /api/books/:id/retag`) and the bulk re-tag job, so the two stay in
 * lockstep. Gated on `tagged > 0` (≥1 file actually rewritten) and a usable refresh item — the item
 * is built from the book loaded *before* the tag write, so a transient post-re-tag reload failure
 * can never drop the refresh.
 */
export function enqueueRetagRefresh(
  connectorService: ConnectorService | undefined,
  log: FastifyBaseLogger,
  result: RetagResult,
): void {
  if (result.tagged > 0 && result.refreshItem) {
    enqueueBookRefresh(connectorService, log, 'metadata', result.refreshItem);
  }
}

/**
 * Load the book by id and {@link enqueueBookRefresh} for it — reserved for genuinely-optional
 * refreshes where only the bookId is in hand and the title/author must be re-read. Post-mutation
 * triggers that already hold the pre-mutation state (convert, re-tag) must NOT use this: a reload
 * failure here is a silent no-op, which would drop a refresh those paths can avoid. Best-effort: no
 * connector, a missing book, a book without a path, or a reload failure is a no-op (the load failure
 * must never be miscounted as an operation failure by the caller's progress accounting). When a
 * connector IS configured, a reload miss is logged at `debug` so a dropped refresh is diagnosable —
 * logging only `{ bookId, reason }` (never the caught error) keeps clear of `narratorr/no-raw-error-logging`.
 */
export async function enqueueBookRefreshById(
  connectorService: ConnectorService | undefined,
  bookService: BookService,
  log: FastifyBaseLogger,
  reason: ConnectorReason,
  bookId: number,
): Promise<void> {
  if (!connectorService) return;
  const book = await bookService.getById(bookId).catch(() => null);
  if (!book?.path) {
    log.debug({ bookId, reason }, 'Connector refresh skipped: book reload missed or has no path');
    return;
  }
  enqueueBookRefresh(connectorService, log, reason, {
    bookId, title: book.title, authorName: book.authors?.[0]?.name ?? null, libraryPath: book.path,
  });
}
