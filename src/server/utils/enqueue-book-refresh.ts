import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorReason } from '../../core/connectors/types.js';
import type { ConnectorService } from '../services/connector.service.js';
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
