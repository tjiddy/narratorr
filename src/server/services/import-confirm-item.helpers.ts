/**
 * Recording-identity classification for a confirm/staged item (#1711/#1893).
 * Reused by the staged submission runner — the dedup/hold/skip decision lives here
 * once, never duplicated. Reads only (safe to call before opening a per-item
 * transaction). The legacy direct-confirm per-item processor was removed with the
 * direct-commit path (#1902); only the shared classifier remains.
 */
import type { FastifyBaseLogger } from 'fastify';
import { type BookService } from './book.service.js';
import type { HeldReviewItem } from '../../shared/schemas/library-scan.js';
import { normalizeProductionType } from '../../core/metadata/production-type.js';
import type { ImportConfirmItem } from './library-scan.service.js';

/** The confirm dedup ASIN (#1662): the explicit top-level `asin`, else the matched metadata's. */
function resolveDedupeAsin(item: ImportConfirmItem): string | undefined {
  return item.asin ?? item.metadata?.asin;
}

/**
 * Pre-copy recording-identity classification for a confirm item (#1711). Threads
 * candidate narrators + matched ASIN + duration into the three-way `findDuplicate`:
 *  - `same-recording` → a `SkipClassification` (owned, plain not-accepted skip — NOT
 *    held). Carries the incumbent's id/title (#1822) so the caller can report
 *    "already in your library as '{title}'" instead of a silent drop.
 *  - `review`/no-signal → a `HeldReviewItem` (not copied, not enqueued).
 *  - `different-recording` (or `forceImport`) → `'proceed'`.
 */
export type SkipClassification = { skip: true; existingBookId?: number; existingTitle?: string };

/**
 * Recording-identity classification for a confirm/staged item (#1711/#1893).
 * Reused by BOTH the legacy direct-confirm `processConfirmItem` and the staged
 * submission runner — the dedup/hold/skip decision lives here once, never
 * duplicated. Reads only (safe to call before opening a per-item transaction).
 */
export async function classifyConfirmItem(
  item: ImportConfirmItem,
  bookService: BookService,
  log: FastifyBaseLogger,
): Promise<SkipClassification | 'proceed' | HeldReviewItem> {
  // Force contract (#1736), confirm-time half: `forceImport` means "bypass the confirm-time
  // BIBLIOGRAPHIC dedup (skip/hold) and proceed to copy". It does NOT promise an overwrite — the
  // copy-time on-disk collision fence in `resolveOccupiedTarget` is independent and still fails
  // closed for an occupied target (never overwrites). The two agree: force gets you past confirm,
  // but an ambiguous on-disk target is refused LOUDLY via the worker's refused terminal disposition
  // (a structured `forced-import-refused` failure + placeholder cleanup), not silently swapped.
  if (item.forceImport) return 'proceed';
  const dedupeAsin = resolveDedupeAsin(item);
  const resolution = await bookService.findDuplicate({
    title: item.title,
    ...(item.authorName ? { authors: [{ name: item.authorName }] } : {}),
    ...(dedupeAsin !== undefined && { asin: dedupeAsin }),
    ...(item.narrators !== undefined && { narrators: item.narrators }),
    ...(item.metadata?.duration !== undefined && { duration: item.metadata.duration }),
    // Production form (#1728): pass the normalized matched format so an
    // abridged-vs-unabridged confirm with no usable duration holds for review.
    ...(item.metadata?.formatType ? { productionType: normalizeProductionType(item.metadata.formatType) } : {}),
  });
  if (resolution.verdict === 'same-recording') {
    log.debug({ title: item.title, existingBookId: resolution.book?.id }, 'Skipping owned duplicate during import (same recording)');
    return {
      skip: true,
      ...(resolution.book ? { existingBookId: resolution.book.id, existingTitle: resolution.book.title } : {}),
    };
  }
  if (resolution.verdict === 'review') {
    log.info({ title: item.title, existingBookId: resolution.book?.id }, 'Holding import item for recording review');
    return {
      path: item.path,
      title: item.title,
      reason: 'recording-review-required',
      ...(resolution.book ? { existingBookId: resolution.book.id } : {}),
    };
  }
  return 'proceed';
}
